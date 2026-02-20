from __future__ import annotations

import json
import logging
import time
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from graph_mcp.config import CONFIG_DIR, TOKEN_FILE

logger = logging.getLogger(__name__)

KEY_FILE = CONFIG_DIR / ".key"


def _get_or_create_encryption_key() -> str:
    """Load encryption key from config dir, or generate one on first use."""
    if KEY_FILE.is_file():
        return KEY_FILE.read_text().strip()
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key().decode()
    KEY_FILE.write_text(key)
    KEY_FILE.chmod(0o600)
    logger.debug("Generated new encryption key at %s", KEY_FILE)
    return key


class TokenStore:
    def __init__(self) -> None:
        self._token_data: dict[str, Any] | None = None
        self._encryption_key: str = ""

    def configure(self, encryption_key: str = "") -> None:
        self._encryption_key = encryption_key or _get_or_create_encryption_key()
        self._load_from_disk()

    def _load_from_disk(self) -> None:
        if not TOKEN_FILE.is_file():
            return
        try:
            fernet = Fernet(self._encryption_key.encode())
            encrypted = TOKEN_FILE.read_bytes()
            decrypted = fernet.decrypt(encrypted)
            self._token_data = json.loads(decrypted)
            logger.debug("Loaded tokens from %s", TOKEN_FILE)
        except (InvalidToken, json.JSONDecodeError, Exception) as e:
            logger.warning("Failed to load tokens from disk: %s", e)
            self._token_data = None

    def _save_to_disk(self) -> None:
        if not self._encryption_key or not self._token_data:
            return
        try:
            fernet = Fernet(self._encryption_key.encode())
            data = json.dumps(self._token_data).encode()
            encrypted = fernet.encrypt(data)
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            TOKEN_FILE.write_bytes(encrypted)
            TOKEN_FILE.chmod(0o600)
            logger.debug("Saved tokens to %s", TOKEN_FILE)
        except Exception as e:
            logger.warning("Failed to save tokens to disk: %s", e)

    def store(self, token_response: dict[str, Any]) -> None:
        self._token_data = {
            "access_token": token_response["access_token"],
            "refresh_token": token_response.get("refresh_token", ""),
            "expires_at": time.time() + token_response.get("expires_in", 3600),
            "scope": token_response.get("scope", ""),
        }
        self._save_to_disk()

    def get_access_token(self) -> str | None:
        if self._token_data:
            return self._token_data.get("access_token")
        return None

    def get_refresh_token(self) -> str | None:
        if self._token_data:
            return self._token_data.get("refresh_token")
        return None

    def is_access_token_expired(self, buffer: int = 300) -> bool:
        if not self._token_data:
            return True
        expires_at = self._token_data.get("expires_at", 0)
        return time.time() >= (expires_at - buffer)

    def is_authenticated(self) -> bool:
        if not self._token_data:
            return False
        if not self.is_access_token_expired():
            return True
        return bool(self.get_refresh_token())

    def clear(self) -> None:
        self._token_data = None
        if TOKEN_FILE.is_file():
            TOKEN_FILE.unlink()
        logger.debug("Cleared tokens")


token_store = TokenStore()
