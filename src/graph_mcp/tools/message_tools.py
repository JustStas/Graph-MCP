from __future__ import annotations

import re
from typing import Any

from markdown import markdown

_HTML_TAG_RE = re.compile(r"<\s*[a-zA-Z][^>]*>")
_MARKDOWN_EXTENSIONS = ["extra", "sane_lists", "nl2br"]


def _looks_like_html(text: str) -> bool:
    return bool(_HTML_TAG_RE.search(text))


def markdown_to_html(message: str) -> str:
    """Convert markdown into Teams-friendly HTML via Python-Markdown."""
    if not message.strip():
        return ""

    return markdown(message, extensions=_MARKDOWN_EXTENSIONS)


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


def build_rich_text_body(
    message: str,
    is_html: bool = True,
    *,
    html_content_type: str = "html",
    text_content_type: str = "text",
) -> dict[str, Any]:
    if is_html:
        content = message if _looks_like_html(message) else markdown_to_html(message)
        content_type = html_content_type
    else:
        content = message
        content_type = text_content_type

    return {"contentType": content_type, "content": content}


def build_chat_message_payload(
    message: str,
    is_html: bool = True,
    mentions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "body": build_rich_text_body(message, is_html)
    }

    normalized_mentions = normalize_mentions(mentions)
    if normalized_mentions:
        payload["mentions"] = normalized_mentions

    return payload
