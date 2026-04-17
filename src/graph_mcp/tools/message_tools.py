from __future__ import annotations

import html
import re
from typing import Any

_HTML_TAG_RE = re.compile(r"<\s*[a-zA-Z][^>]*>")
_CODE_BLOCK_RE = re.compile(r"```(?:[\w+-]+)?\n?(.*?)```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_ITALIC_RE = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)")


def _looks_like_html(text: str) -> bool:
    return bool(_HTML_TAG_RE.search(text))


def _apply_inline_markdown(text: str) -> str:
    text = _CODE_BLOCK_RE.sub(lambda m: f"<pre><code>{html.escape(m.group(1).strip())}</code></pre>", text)
    text = _INLINE_CODE_RE.sub(lambda m: f"<code>{html.escape(m.group(1))}</code>", text)
    text = _BOLD_RE.sub(r"<strong>\1</strong>", text)
    text = _ITALIC_RE.sub(r"<em>\1</em>", text)
    return text


def markdown_to_html(message: str) -> str:
    """Convert common LLM markdown into Teams-friendly HTML."""
    if not message.strip():
        return ""

    lines = message.splitlines()
    chunks: list[str] = []
    paragraph: list[str] = []
    list_items: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            text = " ".join(part.strip() for part in paragraph if part.strip())
            if text:
                escaped = html.escape(text)
                chunks.append(f"<p>{_apply_inline_markdown(escaped)}</p>")
            paragraph.clear()

    def flush_list() -> None:
        if list_items:
            rendered_items = "".join(
                f"<li>{_apply_inline_markdown(html.escape(item.strip()))}</li>"
                for item in list_items
                if item.strip()
            )
            if rendered_items:
                chunks.append(f"<ul>{rendered_items}</ul>")
            list_items.clear()

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()

        if not stripped:
            flush_paragraph()
            flush_list()
            continue

        if stripped.startswith(("- ", "* ")):
            flush_paragraph()
            list_items.append(stripped[2:])
            continue

        flush_list()
        paragraph.append(stripped)

    flush_paragraph()
    flush_list()

    rendered = "".join(chunks)
    return rendered or f"<p>{_apply_inline_markdown(html.escape(message))}</p>"


def normalize_mentions(mentions: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not mentions:
        return []

    normalized: list[dict[str, Any]] = []
    for index, mention in enumerate(mentions):
        if "mentioned" in mention and "mentionText" in mention:
            entry = dict(mention)
            entry.setdefault("id", index)
            normalized.append(entry)
            continue

        raw_id = mention.get("id")
        mention_id = mention.get("mention_id")
        if mention_id is None:
            mention_id = raw_id if isinstance(raw_id, int) else index

        mention_text = (
            mention.get("name")
            or mention.get("display_name")
            or mention.get("displayName")
            or mention.get("mentionText")
            or mention.get("text")
        )
        user_id = (
            mention.get("user_id")
            or mention.get("userId")
            or (raw_id if isinstance(raw_id, str) else None)
        )
        user_identity_type = (
            mention.get("user_identity_type")
            or mention.get("userIdentityType")
            or "aadUser"
        )

        if mention_text is None or user_id is None:
            raise ValueError(
                "Each mention must include either raw Graph mention fields or "
                "a simplified shape with `name`/`display_name` and `user_id`."
            )

        normalized.append(
            {
                "id": mention_id,
                "mentionText": mention_text,
                "mentioned": {
                    "user": {
                        "id": user_id,
                        "displayName": mention_text,
                        "userIdentityType": user_identity_type,
                    }
                },
            }
        )

    return normalized


def build_chat_message_payload(
    message: str,
    is_html: bool = True,
    mentions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if is_html:
        content = message if _looks_like_html(message) else markdown_to_html(message)
        content_type = "html"
    else:
        content = message
        content_type = "text"

    payload: dict[str, Any] = {
        "body": {"contentType": content_type, "content": content}
    }

    normalized_mentions = normalize_mentions(mentions)
    if normalized_mentions:
        payload["mentions"] = normalized_mentions

    return payload
