from graph_mcp._select_fields import CHAT_FIELDS
from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response


def register_chat_tools(mcp):
    @mcp.tool()
    @require_auth
    async def graph_list_chats(top: int = 50) -> str:
        """List recent Microsoft Teams chats.

        Args:
            top: Maximum number of chats to return (default 50, max 50).
        """
        params = {
            "$select": CHAT_FIELDS,
            "$top": str(min(top, 50)),
        }
        result = await graph_client.get("/me/chats", params=params)
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_get_chat_messages(chat_id: str, top: int = 50) -> str:
        """Get messages from a specific chat.

        Args:
            chat_id: The chat ID to get messages from.
            top: Maximum number of messages to return (default 50).
        """
        params = {"$top": str(min(top, 50))}
        result = await graph_client.get(
            f"/chats/{chat_id}/messages", params=params
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_send_chat_message(
        chat_id: str, message: str, is_html: bool = False
    ) -> str:
        """Send a message to a chat.

        Args:
            chat_id: The chat ID to send the message to.
            message: The message text to send.
            is_html: Whether the message is HTML (default: plain text).
        """
        content_type = "html" if is_html else "text"
        body = {"body": {"contentType": content_type, "content": message}}
        result = await graph_client.post(
            f"/chats/{chat_id}/messages", json_body=body
        )
        return success_response(result)

    @mcp.tool()
    @require_auth
    async def graph_create_chat(
        chat_type: str, members: list[str], topic: str = ""
    ) -> str:
        """Create a new chat (one-on-one or group).

        Args:
            chat_type: Either "oneOnOne" or "group".
            members: List of user IDs or UPNs to add to the chat.
            topic: Optional topic for group chats.
        """
        if chat_type == "oneOnOne":
            me = await graph_client.get("/me", params={"$select": "id"})
            my_id = me["id"]
            if my_id not in members:
                members = [my_id] + list(members)

        member_objects = []
        for member in members:
            member_objects.append(
                {
                    "@odata.type": "#microsoft.graph.aadUserConversationMember",
                    "roles": ["owner"],
                    "user@odata.bind": f"https://graph.microsoft.com/v1.0/users('{member}')",
                }
            )
        body: dict = {"chatType": chat_type, "members": member_objects}
        if topic and chat_type == "group":
            body["topic"] = topic
        result = await graph_client.post("/chats", json_body=body)
        return success_response(result)

    @mcp.tool()
    @require_auth
    async def graph_list_chat_members(chat_id: str) -> str:
        """List members of a chat.

        Args:
            chat_id: The chat ID.
        """
        result = await graph_client.get(f"/chats/{chat_id}/members")
        return success_response(result.get("value", []))
