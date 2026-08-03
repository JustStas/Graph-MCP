const INVALID_MENTION_MESSAGE =
  "Each mention must include either raw Graph mention fields or a simplified shape with `name`/`display_name` and `user_id`.";

export type MentionInput = Readonly<Record<string, unknown>>;
export type GraphMention = Record<string, unknown>;

export interface RichTextBody {
  readonly contentType: string;
  readonly content: string;
}

export interface RichTextBodyOptions {
  readonly htmlContentType?: string;
  readonly textContentType?: string;
}

export type ChatMessageImportance = "normal" | "high" | "urgent";

export interface ChatMessageOptions {
  readonly importance?: ChatMessageImportance;
  readonly subject?: string;
}

export interface ChatMessagePayload {
  readonly body: RichTextBody;
  readonly mentions?: GraphMention[];
  readonly importance?: ChatMessageImportance;
  readonly subject?: string;
}

export function normalizeMentions(
  mentions: readonly MentionInput[] | null | undefined,
): GraphMention[] {
  if (mentions === null || mentions === undefined || mentions.length === 0) {
    return [];
  }

  return mentions.map((mention, index) => {
    if ("mentioned" in mention && "mentionText" in mention) {
      const normalized = { ...mention };
      if (!("id" in normalized)) {
        normalized.id = index;
      }
      return normalized;
    }

    const rawId = mention.id;
    const mentionId =
      mention.mention_id !== null && mention.mention_id !== undefined
        ? mention.mention_id
        : typeof rawId === "number" && Number.isInteger(rawId)
          ? rawId
          : index;
    const mentionText =
      mention.name ||
      mention.display_name ||
      mention.displayName ||
      mention.mentionText ||
      mention.text;
    const userId =
      mention.user_id || mention.userId || (typeof rawId === "string" ? rawId : undefined);
    const userIdentityType = mention.user_identity_type || mention.userIdentityType || "aadUser";

    if (
      mentionText === null ||
      mentionText === undefined ||
      userId === null ||
      userId === undefined
    ) {
      throw new Error(INVALID_MENTION_MESSAGE);
    }

    return {
      id: mentionId,
      mentionText,
      mentioned: {
        user: {
          id: userId,
          displayName: mentionText,
          userIdentityType,
        },
      },
    };
  });
}

export function buildRichTextBody(
  message: string,
  isHtml = true,
  options: RichTextBodyOptions = {},
): RichTextBody {
  return {
    contentType: isHtml ? (options.htmlContentType ?? "html") : (options.textContentType ?? "text"),
    content: message,
  };
}

export function buildChatMessagePayload(
  message: string,
  isHtml = true,
  mentions: readonly MentionInput[] | null | undefined = undefined,
  options: ChatMessageOptions = {},
): ChatMessagePayload {
  const normalizedMentions = normalizeMentions(mentions);
  const importance = options.importance ?? "normal";
  const subject = options.subject ?? "";

  return {
    body: buildRichTextBody(message, isHtml),
    ...(normalizedMentions.length > 0 ? { mentions: normalizedMentions } : {}),
    ...(importance === "normal" ? {} : { importance }),
    ...(subject === "" ? {} : { subject }),
  };
}
