from graph_mcp._select_fields import USER_PROFILE_FIELDS
from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response


def register_user_tools(mcp):
    @mcp.tool()
    @require_auth
    async def graph_search_users(query: str, top: int = 10) -> str:
        """Search for users in the organization directory by name or email.

        Args:
            query: Search query (name or email).
            top: Maximum number of results (default 10).
        """
        params: dict[str, str] = {
            "$search": f'"displayName:{query}" OR "mail:{query}"',
            "$select": USER_PROFILE_FIELDS,
            "$top": str(min(top, 25)),
        }
        headers = {"ConsistencyLevel": "eventual"}
        result = await graph_client.get(
            "/users", params=params, headers=headers
        )
        return success_response(result.get("value", []))
