from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import secrets
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import httpx

from graph_mcp.config import settings
from graph_mcp.exceptions import AuthenticationError
from graph_mcp.token_store import token_store

logger = logging.getLogger(__name__)


class AuthManager:
    def __init__(self) -> None:
        self._pending_flows: dict[str, str] = {}  # state -> code_verifier
        self._refresh_lock = asyncio.Lock()

    def _generate_pkce(self) -> tuple[str, str]:
        verifier = secrets.token_urlsafe(64)[:128]
        digest = hashlib.sha256(verifier.encode("ascii")).digest()
        challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
        return verifier, challenge

    def build_auth_url(self) -> tuple[str, str]:
        """Build authorization URL. Returns (url, state)."""
        verifier, challenge = self._generate_pkce()
        state = secrets.token_urlsafe(32)
        self._pending_flows[state] = verifier

        params = {
            "client_id": settings.azure_client_id,
            "response_type": "code",
            "redirect_uri": settings.graph_redirect_uri,
            "scope": " ".join(settings.scopes),
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
        url = f"{settings.authorize_endpoint}?{urllib.parse.urlencode(params)}"
        return url, state

    async def exchange_code(self, code: str, state: str) -> dict[str, Any]:
        verifier = self._pending_flows.pop(state, None)
        if not verifier:
            raise AuthenticationError(
                "Invalid state parameter — possible CSRF attack"
            )

        data = {
            "client_id": settings.azure_client_id,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": settings.graph_redirect_uri,
            "code_verifier": verifier,
        }

        async with httpx.AsyncClient() as client:
            resp = await client.post(settings.token_endpoint, data=data)

        if resp.status_code != 200:
            error_detail = resp.json().get("error_description", resp.text)
            raise AuthenticationError(f"Token exchange failed: {error_detail}")

        token_data = resp.json()
        token_store.store(token_data)
        return token_data

    async def refresh_access_token(self) -> bool:
        async with self._refresh_lock:
            refresh_token = token_store.get_refresh_token()
            if not refresh_token:
                return False

            # Double-check after acquiring lock
            if not token_store.is_access_token_expired():
                return True

            data = {
                "client_id": settings.azure_client_id,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "scope": " ".join(settings.scopes),
            }

            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.post(settings.token_endpoint, data=data)

                if resp.status_code != 200:
                    logger.warning("Token refresh failed: %s", resp.text)
                    token_store.clear()
                    return False

                token_data = resp.json()
                token_store.store(token_data)
                return True
            except Exception as e:
                logger.warning("Token refresh error: %s", e)
                return False

    async def get_valid_access_token(self) -> str:
        if token_store.is_access_token_expired():
            success = await self.refresh_access_token()
            if not success:
                raise AuthenticationError(
                    "Not authenticated. Please log in first."
                )

        token = token_store.get_access_token()
        if not token:
            raise AuthenticationError("Not authenticated. Please log in first.")
        return token

    async def login(self, timeout: int = 120) -> dict[str, Any]:
        if not settings.azure_client_id:
            raise AuthenticationError(
                "AZURE_CLIENT_ID is not configured. "
                "Run 'graph-mcp setup' first."
            )

        auth_url, state = self.build_auth_url()
        result: dict[str, Any] = {}
        error_holder: list[str] = []

        parsed_redirect = urllib.parse.urlparse(settings.graph_redirect_uri)
        port = parsed_redirect.port or 3000
        callback_path = parsed_redirect.path or "/auth/callback"

        class CallbackHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                if parsed.path != callback_path:
                    self.send_response(404)
                    self.end_headers()
                    return

                params = urllib.parse.parse_qs(parsed.query)

                if "error" in params:
                    error_holder.append(params["error"][0])
                    desc = params.get("error_description", ["Unknown error"])[0]
                    error_holder.append(desc)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.end_headers()
                    self.wfile.write(
                        b"<html><body><h1>Authentication failed.</h1>"
                        b"<p>You can close this tab.</p></body></html>"
                    )
                    return

                code = params.get("code", [None])[0]
                cb_state = params.get("state", [None])[0]
                if code and cb_state:
                    result["code"] = code
                    result["state"] = cb_state

                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(
                    b"<html><body><h1>Authentication successful!</h1>"
                    b"<p>You can close this tab.</p></body></html>"
                )

            def log_message(self, format: str, *args: Any) -> None:
                pass  # suppress HTTP server logs

        server = HTTPServer(("localhost", port), CallbackHandler)
        server.timeout = timeout

        def serve_once() -> None:
            server.handle_request()

        webbrowser.open(auth_url)
        await asyncio.to_thread(serve_once)
        server.server_close()

        if error_holder:
            raise AuthenticationError(
                f"OAuth error: {error_holder[0]}"
                f" — {error_holder[1] if len(error_holder) > 1 else ''}"
            )

        if "code" not in result:
            raise AuthenticationError("Login timed out or was cancelled.")

        return await self.exchange_code(result["code"], result["state"])

    def logout(self) -> None:
        token_store.clear()
        self._pending_flows.clear()


auth_manager = AuthManager()
