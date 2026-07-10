import unittest

from graph_mcp.tools.message_tools import (
    build_chat_message_payload,
    build_rich_text_body,
)


class RichTextBodyTests(unittest.TestCase):
    def test_html_body_is_sent_exactly_without_markdown_conversion(self) -> None:
        content = "**Codex notes** use YOUR_RESOURCE and `<code>`"

        body = build_rich_text_body(content, is_html=True)

        self.assertEqual(body["contentType"], "html")
        self.assertEqual(body["content"], content)

    def test_email_html_content_type_uses_exact_body(self) -> None:
        content = "<p><strong>Ready</strong></p>"

        body = build_rich_text_body(
            content,
            is_html=True,
            html_content_type="HTML",
            text_content_type="Text",
        )

        self.assertEqual(body["contentType"], "HTML")
        self.assertEqual(body["content"], content)

    def test_plain_text_body_is_sent_exactly(self) -> None:
        content = "<p>not html when sent as text</p>"

        body = build_rich_text_body(content, is_html=False)

        self.assertEqual(body["contentType"], "text")
        self.assertEqual(body["content"], content)

    def test_chat_payload_uses_same_rich_text_contract(self) -> None:
        payload = build_chat_message_payload("<p>Hello</p>", is_html=True)

        self.assertEqual(
            payload,
            {"body": {"contentType": "html", "content": "<p>Hello</p>"}},
        )


if __name__ == "__main__":
    unittest.main()
