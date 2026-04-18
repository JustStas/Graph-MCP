from __future__ import annotations

from typing import Any

from graph_mcp._select_fields import CHANNEL_FIELDS, TEAM_FIELDS
from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response
from graph_mcp.tools.message_tools import build_chat_message_payload


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
        is_html: bool = True,
        mentions: list[dict[str, Any]] | None = None,
    ) -> str:
        """Send a message to a channel.

        Args:
            team_id: The team ID.
            channel_id: The channel ID.
            message: The message text to send. By default, markdown-like text is
                converted to Teams-compatible HTML automatically.
            is_html: Whether to send HTML content (default: True). If True and
                the message is not already HTML, markdown-like text is converted
                to HTML before sending.
            mentions: Optional mentions to include. Accepts either raw Microsoft
                Graph `mentions` objects or simplified items like
                `{"name": "Jane Smith", "user_id": "..."}`.
        """
        body = build_chat_message_payload(
            message=message,
            is_html=is_html,
            mentions=mentions,
        )
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
        is_html: bool = True,
        mentions: list[dict[str, Any]] | None = None,
    ) -> str:
        """Reply to a channel message.

        Args:
            team_id: The team ID.
            channel_id: The channel ID.
            message_id: The message ID to reply to.
            message: The reply text. By default, markdown-like text is converted
                to Teams-compatible HTML automatically.
            is_html: Whether to send HTML content (default: True). If True and
                the message is not already HTML, markdown-like text is converted
                to HTML before sending.
            mentions: Optional mentions to include. Accepts either raw Microsoft
                Graph `mentions` objects or simplified items like
                `{"name": "Jane Smith", "user_id": "..."}`.
        """
        body = build_chat_message_payload(
            message=message,
            is_html=is_html,
            mentions=mentions,
        )
        result = await graph_client.post(
            f"/teams/{team_id}/channels/{channel_id}/messages/{message_id}/replies",
            json_body=body,
        )
        return success_response(result)
