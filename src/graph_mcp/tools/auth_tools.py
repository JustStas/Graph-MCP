from graph_mcp.auth import auth_manager
from graph_mcp.responses import error_response, success_response
from graph_mcp.token_store import token_store


def register_auth_tools(mcp):
    @mcp.tool()
    async def graph_auth_status() -> str:
        """Check Microsoft Graph authentication status. Attempts token refresh if needed."""
        try:
            if (
                token_store.is_access_token_expired()
                and token_store.get_refresh_token()
            ):
                refreshed = await auth_manager.refresh_access_token()
                if not refreshed:
                    return success_response(
                        {
                            "authenticated": False,
                            "message": "Session expired. Please log in again.",
                        }
                    )

            is_auth = token_store.is_authenticated()
            return success_response(
                {
                    "authenticated": is_auth,
                    "message": "Authenticated"
                    if is_auth
                    else "Not authenticated",
                }
            )
        except Exception as e:
            return error_response(str(e))

    @mcp.tool()
    async def graph_auth_login() -> str:
        """Log in to Microsoft 365. Opens a browser for OAuth2 authentication."""
        try:
            await auth_manager.login()
            return success_response(
                {
                    "authenticated": True,
                    "message": "Successfully logged in to Microsoft 365.",
                }
            )
        except Exception as e:
            return error_response(
                str(e),
                action_required="Check Azure app registration and try again.",
            )

    @mcp.tool()
    async def graph_auth_logout() -> str:
        """Log out from Microsoft 365. Clears stored tokens."""
        try:
            auth_manager.logout()
            return success_response(
                {
                    "authenticated": False,
                    "message": "Successfully logged out.",
                }
            )
        except Exception as e:
            return error_response(str(e))
