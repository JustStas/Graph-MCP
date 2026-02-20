from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from graph_mcp.auth import auth_manager
from graph_mcp.exceptions import AuthenticationError, GraphAPIError
from graph_mcp.rate_limiter import get_rate_limiter

logger = logging.getLogger(__name__)

BASE_URL = "https://graph.microsoft.com/v1.0"


class GraphClient:
    async def _request(
        self,
        method: str,
        path: str,
        params: dict[str, str] | None = None,
        json_body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        limiter = get_rate_limiter()
        await limiter.acquire()

        token = await auth_manager.get_valid_access_token()
        req_headers = {"Authorization": f"Bearer {token}"}
        if headers:
            req_headers.update(headers)

        url = f"{BASE_URL}{path}" if path.startswith("/") else f"{BASE_URL}/{path}"

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(
                method, url, params=params, json=json_body, headers=req_headers
            )

        # Handle 429 rate limiting
        if resp.status_code == 429:
            retry_after = float(resp.headers.get("Retry-After", "0")) or None
            delay = limiter.handle_429(retry_after)
            logger.warning("Rate limited. Retrying in %.1fs", delay)
            await asyncio.sleep(delay)

            token = await auth_manager.get_valid_access_token()
            req_headers["Authorization"] = f"Bearer {token}"
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.request(
                    method, url, params=params, json=json_body, headers=req_headers
                )
            if resp.status_code == 429:
                raise GraphAPIError("Rate limit exceeded after retry", 429)

        # Handle 401 with token refresh
        if resp.status_code == 401:
            success = await auth_manager.refresh_access_token()
            if not success:
                raise AuthenticationError("Session expired. Please log in again.")

            token = await auth_manager.get_valid_access_token()
            req_headers["Authorization"] = f"Bearer {token}"
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.request(
                    method, url, params=params, json=json_body, headers=req_headers
                )
            if resp.status_code == 401:
                raise AuthenticationError("Session expired. Please log in again.")

        if resp.status_code >= 400:
            try:
                error_body = resp.json()
                msg = error_body.get("error", {}).get("message", resp.text)
            except Exception:
                msg = resp.text
            raise GraphAPIError(f"{resp.status_code}: {msg}", resp.status_code)

        limiter.reset_backoff()

        if resp.status_code == 204:
            return None
        return resp.json()

    async def get(
        self,
        path: str,
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        return await self._request("GET", path, params=params, headers=headers)

    async def post(
        self,
        path: str,
        json_body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        return await self._request(
            "POST", path, params=params, json_body=json_body, headers=headers
        )

    async def patch(
        self,
        path: str,
        json_body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        return await self._request("PATCH", path, json_body=json_body, headers=headers)

    async def delete(
        self,
        path: str,
        headers: dict[str, str] | None = None,
    ) -> Any:
        return await self._request("DELETE", path, headers=headers)


graph_client = GraphClient()
