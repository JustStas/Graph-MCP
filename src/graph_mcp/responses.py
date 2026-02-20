from __future__ import annotations

import functools
import json
from typing import Any

from graph_mcp.exceptions import AuthenticationError, GraphAPIError


def success_response(data: Any, message: str = "success") -> str:
    return json.dumps({"data": data, "message": message})


def error_response(error: str, action_required: str | None = None) -> str:
    result: dict[str, Any] = {"error": error}
    if action_required:
        result["action_required"] = action_required
    return json.dumps(result)


def require_auth(func):
    """Decorator that wraps Graph API tools with auth and error handling."""

    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except AuthenticationError as e:
            return error_response(
                str(e),
                action_required="Please call the graph_auth_login tool first.",
            )
        except GraphAPIError as e:
            return error_response(f"Graph API error: {e}")
        except Exception as e:
            return error_response(f"Unexpected error: {e}")

    return wrapper
