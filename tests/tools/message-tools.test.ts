import { describe, expect, test } from "vitest";

import {
  CHANNEL_FIELDS,
  CHAT_FIELDS,
  EVENT_LIST_FIELDS,
  MAIL_LIST_FIELDS,
  TEAM_FIELDS,
  USER_PROFILE_FIELDS,
} from "../../src/select-fields.js";
import {
  buildChatMessagePayload,
  buildRichTextBody,
  normalizeMentions,
} from "../../src/tools/message-tools.js";

const INVALID_MENTION_MESSAGE =
  "Each mention must include either raw Graph mention fields or a simplified shape with `name`/`display_name` and `user_id`.";

describe("select field constants", () => {
  test("match the legacy Python values exactly", () => {
    expect(EVENT_LIST_FIELDS).toBe(
      "id,subject,start,end,location,organizer,attendees,isAllDay,isCancelled,showAs,isOnlineMeeting,onlineMeeting,categories,responseStatus,bodyPreview,recurrence,type",
    );
    expect(CHAT_FIELDS).toBe("id,chatType,topic,createdDateTime,lastUpdatedDateTime");
    expect(TEAM_FIELDS).toBe("id,displayName,description");
    expect(CHANNEL_FIELDS).toBe("id,displayName,description,membershipType");
    expect(MAIL_LIST_FIELDS).toBe(
      "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,importance,flag",
    );
    expect(USER_PROFILE_FIELDS).toBe("id,displayName,mail,jobTitle,department,officeLocation");
  });
});

describe("buildRichTextBody", () => {
  test("passes HTML through unchanged with the lowercase Graph chat content type", () => {
    const content = "**Codex notes** use YOUR_RESOURCE and `<code>`";

    expect(buildRichTextBody(content, true)).toEqual({
      contentType: "html",
      content,
    });
  });

  test("supports the exact email HTML and Text content type overrides", () => {
    const content = "<p><strong>Ready</strong></p>";

    expect(
      buildRichTextBody(content, true, {
        htmlContentType: "HTML",
        textContentType: "Text",
      }),
    ).toEqual({
      contentType: "HTML",
      content,
    });
    expect(
      buildRichTextBody(content, false, {
        htmlContentType: "HTML",
        textContentType: "Text",
      }),
    ).toEqual({
      contentType: "Text",
      content,
    });
  });

  test("passes plain text through unchanged with the lowercase text content type", () => {
    const content = "<p>not html when sent as text</p>";

    expect(buildRichTextBody(content, false)).toEqual({
      contentType: "text",
      content,
    });
  });

  test("returns a fresh body object for each call", () => {
    const first = buildRichTextBody("hello");
    const second = buildRichTextBody("hello");

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

describe("normalizeMentions", () => {
  test.each([undefined, null, []] as const)("normalizes %s to an empty fresh list", (mentions) => {
    const result = normalizeMentions(mentions);

    expect(result).toEqual([]);
    if (Array.isArray(mentions)) {
      expect(result).not.toBe(mentions);
    }
  });

  test("preserves raw Graph mention fields and defaults a missing id to its zero-based index", () => {
    const rawMention = Object.freeze({
      mentionText: "Jane Smith",
      mentioned: Object.freeze({
        user: Object.freeze({
          id: "user-1",
          displayName: "Jane Smith",
          userIdentityType: "aadUser",
        }),
      }),
      custom: Object.freeze({ retained: true }),
    });
    const secondRawMention = Object.freeze({
      id: 42,
      mentionText: "Alex Doe",
      mentioned: Object.freeze({ user: Object.freeze({ id: "user-2" }) }),
      extra: "preserved",
    });

    const result = normalizeMentions([rawMention, secondRawMention]);

    expect(result).toEqual([{ ...rawMention, id: 0 }, { ...secondRawMention }]);
    expect(result[0]).not.toBe(rawMention);
    expect(result[1]).not.toBe(secondRawMention);
    expect("id" in rawMention).toBe(false);
  });

  test("uses the exact simplified alias precedence and defaults", () => {
    const mentions = [
      Object.freeze({
        mention_id: "mention-7",
        id: 99,
        name: "Primary Name",
        display_name: "Ignored Name",
        user_id: "primary-user",
        userId: "ignored-user",
        user_identity_type: "customIdentity",
        userIdentityType: "ignoredIdentity",
      }),
      Object.freeze({
        id: 5,
        name: "",
        display_name: "Display Name",
        user_id: "",
        userId: "camel-user",
        user_identity_type: "",
        userIdentityType: "camelIdentity",
      }),
      Object.freeze({
        id: "string-user-id",
        displayName: "Camel Display",
      }),
      Object.freeze({
        mentionText: "Mention Text",
        userId: "mention-text-user",
      }),
      Object.freeze({
        text: "Text Alias",
        user_id: "text-user",
      }),
    ];

    const result = normalizeMentions(mentions);

    expect(result).toEqual([
      {
        id: "mention-7",
        mentionText: "Primary Name",
        mentioned: {
          user: {
            id: "primary-user",
            displayName: "Primary Name",
            userIdentityType: "customIdentity",
          },
        },
      },
      {
        id: 5,
        mentionText: "Display Name",
        mentioned: {
          user: {
            id: "camel-user",
            displayName: "Display Name",
            userIdentityType: "camelIdentity",
          },
        },
      },
      {
        id: 2,
        mentionText: "Camel Display",
        mentioned: {
          user: {
            id: "string-user-id",
            displayName: "Camel Display",
            userIdentityType: "aadUser",
          },
        },
      },
      {
        id: 3,
        mentionText: "Mention Text",
        mentioned: {
          user: {
            id: "mention-text-user",
            displayName: "Mention Text",
            userIdentityType: "aadUser",
          },
        },
      },
      {
        id: 4,
        mentionText: "Text Alias",
        mentioned: {
          user: {
            id: "text-user",
            displayName: "Text Alias",
            userIdentityType: "aadUser",
          },
        },
      },
    ]);
    expect(result).not.toBe(mentions);
    for (const [index, mention] of mentions.entries()) {
      expect(result[index]).not.toBe(mention);
    }
  });

  test.each([
    { label: "fractional numbers", rawId: 1.5 },
    { label: "NaN", rawId: Number.NaN },
    { label: "positive infinity", rawId: Number.POSITIVE_INFINITY },
    { label: "negative infinity", rawId: Number.NEGATIVE_INFINITY },
  ])("falls back to the zero-based index for $label", ({ rawId }) => {
    const result = normalizeMentions([
      {
        id: rawId,
        name: "Jane Smith",
        user_id: "user-1",
      },
    ]);

    expect(result[0]?.id).toBe(0);
  });

  test("throws the exact legacy validation message when the name is missing", () => {
    expect(() => normalizeMentions([{ user_id: "user-1" }])).toThrowError(INVALID_MENTION_MESSAGE);
  });

  test("throws the exact legacy validation message when the user id is missing", () => {
    expect(() => normalizeMentions([{ name: "Jane Smith" }])).toThrowError(INVALID_MENTION_MESSAGE);
  });
});

describe("buildChatMessagePayload", () => {
  test.each([undefined, null, []] as const)(
    "uses only the rich text body when mentions are %s",
    (mentions) => {
      expect(buildChatMessagePayload("<p>Hello</p>", true, mentions)).toEqual({
        body: { contentType: "html", content: "<p>Hello</p>" },
      });
    },
  );

  test("adds mentions only after normalization and does not mutate caller inputs", () => {
    const mention = Object.freeze({
      name: "Jane Smith",
      user_id: "user-1",
    });
    const mentions = Object.freeze([mention]);

    const payload = buildChatMessagePayload("Hello Jane", false, mentions);

    expect(payload).toEqual({
      body: { contentType: "text", content: "Hello Jane" },
      mentions: [
        {
          id: 0,
          mentionText: "Jane Smith",
          mentioned: {
            user: {
              id: "user-1",
              displayName: "Jane Smith",
              userIdentityType: "aadUser",
            },
          },
        },
      ],
    });
    expect(payload.mentions).not.toBe(mentions);
  });
});
