from graph_mcp._select_fields import CHANNEL_FIELDS, TEAM_FIELDS
from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response


def register_teams_tools(mcp):
    @mcp.tool()
    @require_auth
    async def graph_list_teams() -> str:
        """List Microsoft Teams that the authenticated user has joined."""
        params = {"$select": TEAM_FIELDS}
        result = await graph_client.get("/me/joinedTeams", params=params)
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_list_channels(team_id: str) -> str:
        """List channels in a team.

        Args:
            team_id: The team ID.
        """
        params = {"$select": CHANNEL_FIELDS}
        result = await graph_client.get(
            f"/teams/{team_id}/channels", params=params
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_get_channel_messages(
        team_id: str, channel_id: str, top: int = 50
    ) -> str:
        """Get messages from a channel.

        Args:
            team_id: The team ID.
            channel_id: The channel ID.
            top: Maximum number of messages to return (default 50).
        """
        params = {"$top": str(min(top, 50))}
        result = await graph_client.get(
            f"/teams/{team_id}/channels/{channel_id}/messages", params=params
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_send_channel_message(
        team_id: str,
        channel_id: str,
        message: str,
        is_html: bool = False,
    ) -> str:
        """Send a message to a channel.

        Args:
            team_id: The team ID.
            channel_id: The channel ID.
            message: The message text to send.
            is_html: Whether the message is HTML (default: plain text).
        """
        content_type = "html" if is_html else "text"
        body = {"body": {"contentType": content_type, "content": message}}
        result = await graph_client.post(
            f"/teams/{team_id}/channels/{channel_id}/messages", json_body=body
        )
        return success_response(result)

    @mcp.tool()
    @require_auth
    async def graph_list_channel_members(
        team_id: str, channel_id: str
    ) -> str:
        """List members of a channel.

        Args:
            team_id: The team ID.
            channel_id: The channel ID.
        """
        result = await graph_client.get(
            f"/teams/{team_id}/channels/{channel_id}/members"
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_get_channel_message_replies(
        team_id: str, channel_id: str, message_id: str, top: int = 50
    ) -> str:
        """Get replies to a channel message.

        Args:
            team_id: The team ID.
            channel_id: The channel ID.
            message_id: The message ID.
            top: Maximum number of replies to return (default 50).
        """
        params = {"$top": str(min(top, 50))}
        result = await graph_client.get(
            f"/teams/{team_id}/channels/{channel_id}/messages/{message_id}/replies",
            params=params,
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_reply_to_channel_message(
        team_id: str,
        channel_id: str,
        message_id: str,
        message: str,
        is_html: bool = False,
    ) -> str:
        """Reply to a channel message.

        Args:
            team_id: The team ID.
            channel_id: The channel ID.
            message_id: The message ID to reply to.
            message: The reply text.
            is_html: Whether the message is HTML (default: plain text).
        """
        content_type = "html" if is_html else "text"
        body = {"body": {"contentType": content_type, "content": message}}
        result = await graph_client.post(
            f"/teams/{team_id}/channels/{channel_id}/messages/{message_id}/replies",
            json_body=body,
        )
        return success_response(result)
