from graph_mcp._select_fields import MAIL_LIST_FIELDS
from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response
from graph_mcp.tools.message_tools import build_rich_text_body


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
        is_html: bool = True,
    ) -> str:
        """Send an email.

        Args:
            to: List of recipient email addresses.
            subject: Email subject.
            body: Email body text. By default, markdown-like text is converted
                to HTML automatically for better rendering in mail clients.
            cc: Optional list of CC email addresses.
            is_html: Whether to send HTML content (default: True). If True and
                the body is not already HTML, markdown is converted to HTML
                before sending.
        """
        to_recipients = [
            {"emailAddress": {"address": addr}} for addr in to
        ]
        message: dict = {
            "subject": subject,
            "body": build_rich_text_body(
                body,
                is_html,
                html_content_type="HTML",
                text_content_type="Text",
            ),
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
        message_id: str,
        body: str,
        reply_all: bool = False,
        is_html: bool = True,
    ) -> str:
        """Reply to an email.

        Args:
            message_id: The email message ID to reply to.
            body: The reply body text. By default, markdown-like text is
                converted to HTML automatically for better rendering.
            reply_all: Whether to reply to all recipients (default: reply to sender only).
            is_html: Whether to send HTML content (default: True). If True and
                the body is not already HTML, markdown is converted to HTML
                before sending.
        """
        create_action = "createReplyAll" if reply_all else "createReply"
        draft = await graph_client.post(
            f"/me/messages/{message_id}/{create_action}"
        )
        draft_id = draft["id"]
        await graph_client.patch(
            f"/me/messages/{draft_id}",
            json_body={
                "body": build_rich_text_body(
                    body,
                    is_html,
                    html_content_type="HTML",
                    text_content_type="Text",
                )
            },
        )
        await graph_client.post(f"/me/messages/{draft_id}/send")
        return success_response(
            {"status": f"{'Reply all' if reply_all else 'Reply'} sent"}
        )

    @mcp.tool()
    @require_auth
    async def graph_list_mail_attachments(message_id: str) -> str:
        """List attachments on an email message.

        Args:
            message_id: The email message ID.
        """
        result = await graph_client.get(
            f"/me/messages/{message_id}/attachments",
            params={
                "$select": "id,name,contentType,size,isInline",
            },
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_get_mail_attachment(
        message_id: str, attachment_id: str
    ) -> str:
        """Get a specific email attachment including its content.

        The attachment content is returned as base64-encoded data in the
        'contentBytes' field. For large attachments, only metadata is practical.

        Args:
            message_id: The email message ID.
            attachment_id: The attachment ID (from graph_list_mail_attachments).
        """
        result = await graph_client.get(
            f"/me/messages/{message_id}/attachments/{attachment_id}"
        )
        return success_response(result)
