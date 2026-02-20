from graph_mcp._select_fields import USER_PROFILE_FIELDS
from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response


def register_profile_tools(mcp):
    @mcp.tool()
    @require_auth
    async def graph_get_profile() -> str:
        """Get the authenticated user's Microsoft 365 profile."""
        result = await graph_client.get(
            "/me", params={"$select": USER_PROFILE_FIELDS}
        )
        return success_response(result)
