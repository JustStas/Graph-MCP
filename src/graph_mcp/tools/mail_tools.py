from graph_mcp._select_fields import MAIL_LIST_FIELDS
from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response


def register_mail_tools(mcp):
    @mcp.tool()
    @require_auth
    async def graph_list_mail(
        folder: str = "inbox",
        top: int = 25,
        filter_query: str = "",
    ) -> str:
        """List emails from a mail folder.

        Args:
            folder: Mail folder name (default "inbox"). Common: inbox, sentitems, drafts, deleteditems.
            top: Maximum number of emails to return (default 25).
            filter_query: Optional OData filter (e.g. "isRead eq false").
        """
        params: dict[str, str] = {
            "$select": MAIL_LIST_FIELDS,
            "$top": str(min(top, 50)),
            "$orderby": "receivedDateTime desc",
        }
        if filter_query:
            params["$filter"] = filter_query
        result = await graph_client.get(
            f"/me/mailFolders/{folder}/messages", params=params
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_read_mail(message_id: str) -> str:
        """Read full details of a specific email.

        Args:
            message_id: The email message ID.
        """
        result = await graph_client.get(f"/me/messages/{message_id}")
        return success_response(result)

    @mcp.tool()
    @require_auth
    async def graph_search_mail(query: str, top: int = 25) -> str:
        """Search emails by keyword.

        Args:
            query: Search query string.
            top: Maximum number of results (default 25).
        """
        params: dict[str, str] = {
            "$search": f'"{query}"',
            "$select": MAIL_LIST_FIELDS,
            "$top": str(min(top, 50)),
        }
        result = await graph_client.get("/me/messages", params=params)
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_send_mail(
        to: list[str],
        subject: str,
        body: str,
        cc: list[str] | None = None,
        is_html: bool = False,
    ) -> str:
        """Send an email.

        Args:
            to: List of recipient email addresses.
            subject: Email subject.
            body: Email body text.
            cc: Optional list of CC email addresses.
            is_html: Whether the body is HTML (default: plain text).
        """
        to_recipients = [
            {"emailAddress": {"address": addr}} for addr in to
        ]
        message: dict = {
            "subject": subject,
            "body": {
                "contentType": "HTML" if is_html else "Text",
                "content": body,
            },
            "toRecipients": to_recipients,
        }
        if cc:
            message["ccRecipients"] = [
                {"emailAddress": {"address": addr}} for addr in cc
            ]
        payload = {"message": message, "saveToSentItems": True}
        await graph_client.post("/me/sendMail", json_body=payload)
        return success_response({"status": "Email sent"})

    @mcp.tool()
    @require_auth
    async def graph_reply_mail(
        message_id: str, body: str, reply_all: bool = False
    ) -> str:
        """Reply to an email.

        Args:
            message_id: The email message ID to reply to.
            body: The reply body text.
            reply_all: Whether to reply to all recipients (default: reply to sender only).
        """
        action = "replyAll" if reply_all else "reply"
        payload = {"comment": body}
        await graph_client.post(
            f"/me/messages/{message_id}/{action}", json_body=payload
        )
        return success_response(
            {"status": f"{'Reply all' if reply_all else 'Reply'} sent"}
        )
