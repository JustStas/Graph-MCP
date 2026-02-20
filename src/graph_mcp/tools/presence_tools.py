from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response


def register_presence_tools(mcp):
    @mcp.tool()
    @require_auth
    async def graph_get_my_presence() -> str:
        """Get the authenticated user's current presence status."""
        result = await graph_client.get("/me/presence")
        return success_response(result)

    @mcp.tool()
    @require_auth
    async def graph_get_user_presence(user_id: str) -> str:
        """Get another user's presence status.

        Args:
            user_id: The user's ID.
        """
        result = await graph_client.get(f"/users/{user_id}/presence")
        return success_response(result)

    @mcp.tool()
    @require_auth
    async def graph_set_my_presence(
        availability: str,
        activity: str,
        expiration_duration: str = "PT1H",
    ) -> str:
        """Set the authenticated user's presence status.

        Args:
            availability: Availability status (e.g. "Available", "Busy", "DoNotDisturb", "Away", "Offline").
            activity: Activity status (e.g. "Available", "InACall", "InAMeeting", "Presenting", "Away", "Offline").
            expiration_duration: How long the status lasts (ISO 8601 duration, default "PT1H" = 1 hour).
        """
        body = {
            "sessionId": "graph-mcp",
            "availability": availability,
            "activity": activity,
            "expirationDuration": expiration_duration,
        }
        await graph_client.post(
            "/me/presence/setUserPreferredPresence", json_body=body
        )
        return success_response(
            {
                "status": "Presence updated",
                "availability": availability,
                "activity": activity,
            }
        )
