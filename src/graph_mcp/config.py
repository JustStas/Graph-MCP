from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings

CONFIG_DIR = Path.home() / ".graph-mcp"
TOKEN_FILE = CONFIG_DIR / "tokens.enc"


class Settings(BaseSettings):
    azure_client_id: str = ""
    azure_tenant_id: str = "common"
    graph_redirect_uri: str = "http://localhost:3000/auth/callback"
    graph_token_encryption_key: str = ""
    graph_token_refresh_buffer: int = 300
    graph_rate_limit_max_requests: int = 10000
    graph_rate_limit_window: int = 600
    graph_debug: bool = False

    model_config = {"extra": "ignore"}

    @property
    def token_file(self) -> Path:
        return TOKEN_FILE

    @property
    def authority(self) -> str:
        return f"https://login.microsoftonline.com/{self.azure_tenant_id}"

    @property
    def authorize_endpoint(self) -> str:
        return f"{self.authority}/oauth2/v2.0/authorize"

    @property
    def token_endpoint(self) -> str:
        return f"{self.authority}/oauth2/v2.0/token"

    @property
    def scopes(self) -> list[str]:
        return [
            "offline_access",
            "openid",
            "profile",
            "User.Read",
            "User.ReadBasic.All",
            "Chat.Read",
            "Chat.ReadWrite",
            "ChatMessage.Send",
            "ChannelMessage.Read.All",
            "ChannelMessage.Send",
            "Team.ReadBasic.All",
            "Channel.ReadBasic.All",
            "Calendars.Read",
            "Mail.Read",
            "Mail.Send",
            "Presence.Read",
            "Presence.Read.All",
            "Presence.ReadWrite",
        ]


settings = Settings()
