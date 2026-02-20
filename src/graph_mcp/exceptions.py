from __future__ import annotations


class GraphMCPError(Exception):
    """Base exception for Graph MCP server."""


class AuthenticationError(GraphMCPError):
    """Raised when authentication fails or is required."""


class GraphAPIError(GraphMCPError):
    """Raised when a Graph API call fails."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class RateLimitError(GraphMCPError):
    """Raised when rate limit is exceeded."""
