import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { CHAT_FIELDS } from "../select-fields.js";
import {
  collectionResult,
  COMPACT_ARGS_DOC,
  COMPACT_SCHEMA,
  INCLUDE_NEXT_LINK_SCHEMA,
  NEXT_LINK_SCHEMA,
  PAGING_ARGS_DOC,
  selectFields,
} from "./list-options.js";
import { buildChatMessagePayload, buildRichTextBody } from "./message-tools.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value !== "" && value !== "." && value !== "..", {
    message: "Resource IDs must not be empty, '.' or '..'.",
  });
const OPTIONAL_RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value === "" || (value !== "." && value !== ".."), {
    message: "Resource IDs must not be '.' or '..'.",
  })
  .default("");
const TOP_SCHEMA = z.number().int().default(50);
const CHAT_MESSAGE_COMPACT_FIELDS = "id,createdDateTime,from,subject,importance,webUrl";
const IMPORTANCE_SCHEMA = z.enum(["normal", "high", "urgent"]).default("normal");
const SUBJECT_SCHEMA = z.string().default("");
const REACTION_TARGET_REQUIRED_MESSAGE = "Provide either chat_id or both team_id and channel_id.";
const REACTION_TARGET_CONFLICT_MESSAGE =
  "Provide either chat_id or team_id with channel_id, not both.";
const MENTIONS_SCHEMA = z
  .array(z.record(z.string(), z.unknown()))
  .nullable()
  .optional()
  .default(null);

type GraphObjectWithId = Record<string, unknown> & { readonly id: string };

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectionValue(response: unknown): unknown[] {
  if (!isNonArrayObject(response)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  if (!Object.hasOwn(response, "value")) {
    return [];
  }
  if (!Array.isArray(response.value)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response.value;
}

function requireGraphObject(response: unknown): Record<string, unknown> {
  if (!isNonArrayObject(response)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response;
}

function requireGraphObjectWithId(response: unknown): GraphObjectWithId {
  if (!isNonArrayObject(response) || typeof response.id !== "string" || response.id.length === 0) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response as GraphObjectWithId;
}

/** Query parameters for a chat message list, adding `$select` only when compact is asked for. */
function messageListParams(top: number, compact: boolean): Record<string, string> {
  const select = selectFields("", CHAT_MESSAGE_COMPACT_FIELDS, compact);
  return {
    $top: String(Math.min(top, 50)),
    ...(select === "" ? {} : { $select: select }),
  };
}

function chatPath(chatId: string): string {
  return `/chats/${encodeURIComponent(chatId)}`;
}

function chatMessagePath(chatId: string, messageId: string): string {
  return `${chatPath(chatId)}/messages/${encodeURIComponent(messageId)}`;
}

function channelMessagePath(teamId: string, channelId: string, messageId: string): string {
  return `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(
    channelId,
  )}/messages/${encodeURIComponent(messageId)}`;
}

function memberBinding(member: string): string {
  const encodedMember = encodeURIComponent(member).replace(/%40/gi, "@").replaceAll("'", "''");
  return `https://graph.microsoft.com/v1.0/users('${encodedMember}')`;
}

export function registerChatTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_list_chats",
    {
      description: `List recent Microsoft Teams chats.

Args:
    top: Maximum number of chats to return (default 50, maximum 50).
${PAGING_ARGS_DOC}`,
      inputSchema: {
        top: TOP_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ top, next_link, include_next_link }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get("/me/chats", {
              $select: CHAT_FIELDS,
              $top: String(Math.min(top, 50)),
            })
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_chat_messages",
    {
      description: `Get messages from a specific chat.

Messages carry full HTML bodies plus their attachments and mentions, so
\`compact\` narrows them to the identifying fields. Without it no \`$select\` is
sent and the response is unchanged.

Args:
    chat_id: The chat ID.
    top: Maximum number of messages to return (default 50, maximum 50).
${COMPACT_ARGS_DOC}
${PAGING_ARGS_DOC}`,
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
        top: TOP_SCHEMA,
        compact: COMPACT_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ chat_id, top, compact, next_link, include_next_link }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get(
              `/chats/${encodeURIComponent(chat_id)}/messages`,
              messageListParams(top, compact),
            )
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_send_chat_message",
    {
      description: `Send a message to a chat.

Args:
    chat_id: The chat ID.
    message: Message body. When \`is_html\` is true, send explicit HTML;
        markdown is not converted.
    is_html: Whether the body is HTML content (default: True). Use false for
        plain text.
    mentions: Optional mentions. Each entry accepts raw Graph mention fields or
        a simplified shape with \`name\`/\`display_name\` and \`user_id\`.
    importance: Message importance: "normal", "high", or "urgent"
        (default "normal").
    subject: Optional subject line. Empty omits it.`,
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
        message: z.string(),
        is_html: z.boolean().default(true),
        mentions: MENTIONS_SCHEMA,
        importance: IMPORTANCE_SCHEMA,
        subject: SUBJECT_SCHEMA,
      },
    },
    async ({ chat_id, message, is_html, mentions, importance, subject }) => {
      const result = await dependencies.graphClient.post(
        `${chatPath(chat_id)}/messages`,
        buildChatMessagePayload(message, is_html, mentions, { importance, subject }),
      );
      return successResponse(result);
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_create_chat",
    {
      description: "Create a new chat (one-on-one or group).",
      inputSchema: {
        chat_type: z.string(),
        members: z.array(z.string()),
        topic: z.string().default(""),
      },
    },
    async ({ chat_type, members, topic }) => {
      const chatMembers = [...members];

      if (chat_type === "oneOnOne") {
        const me = await dependencies.graphClient.get("/me", { $select: "id" });
        const myId = requireGraphObjectWithId(me).id;
        if (!chatMembers.includes(myId)) {
          chatMembers.unshift(myId);
        }
      }

      const body: Record<string, unknown> = {
        chatType: chat_type,
        members: chatMembers.map((member) => ({
          "@odata.type": "#microsoft.graph.aadUserConversationMember",
          roles: ["owner"],
          "user@odata.bind": memberBinding(member),
        })),
      };
      if (chat_type === "group" && topic !== "") {
        body.topic = topic;
      }

      const result = await dependencies.graphClient.post("/chats", body);
      return successResponse(requireGraphObjectWithId(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_chat_members",
    {
      description: `List members of a chat.

Args:
    chat_id: The chat ID.
${PAGING_ARGS_DOC}`,
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ chat_id, next_link, include_next_link }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get(`/chats/${encodeURIComponent(chat_id)}/members`)
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_chat",
    {
      description: `Get a single chat, including its members.

Args:
    chat_id: The chat ID.`,
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ chat_id }) => {
      const result = await dependencies.graphClient.get(chatPath(chat_id), {
        $select: CHAT_FIELDS,
        $expand: "members",
      });
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_update_chat_topic",
    {
      description: `Rename a chat by setting its topic.

Only group chats have a topic; Graph rejects this for one-on-one chats.

Args:
    chat_id: The chat ID.
    topic: New topic for the chat.`,
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
        topic: z.string(),
      },
    },
    async ({ chat_id, topic }) => {
      await dependencies.graphClient.patch(chatPath(chat_id), { topic });
      return successResponse({ status: "Chat topic updated", topic });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_add_chat_member",
    {
      description: `Add a user to a group chat.

Requires the delegated ChatMember.ReadWrite permission.

Args:
    chat_id: The chat ID.
    user_id: User ID or user principal name to add.
    share_history_from: ISO 8601 timestamp (e.g. "2026-07-14T12:00:00Z") to
        share chat history from. Empty shares no history.`,
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
        user_id: RESOURCE_ID_SCHEMA,
        share_history_from: z.string().default(""),
      },
    },
    async ({ chat_id, user_id, share_history_from }) => {
      const body: Record<string, unknown> = {
        "@odata.type": "#microsoft.graph.aadUserConversationMember",
        roles: ["owner"],
        "user@odata.bind": memberBinding(user_id),
      };
      if (share_history_from !== "") {
        body.visibleHistoryStartDateTime = share_history_from;
      }

      await dependencies.graphClient.post(`${chatPath(chat_id)}/members`, body);
      return successResponse({ status: "Chat member added", user_id });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_remove_chat_member",
    {
      description: `Remove a member from a group chat.

Requires the delegated ChatMember.ReadWrite permission.

Args:
    chat_id: The chat ID.
    membership_id: The membership ID (from graph_list_chat_members).`,
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
        membership_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ chat_id, membership_id }) => {
      await dependencies.graphClient.delete(
        `${chatPath(chat_id)}/members/${encodeURIComponent(membership_id)}`,
      );
      return successResponse({ status: "Chat member removed", membership_id });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_mark_chat_read",
    {
      description: `Mark a chat as read or unread for a user.

Args:
    chat_id: The chat ID.
    user_id: The user ID to mark the chat for.
    is_read: Whether the chat is read (default true). Use false to mark it
        unread.`,
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
        user_id: RESOURCE_ID_SCHEMA,
        is_read: z.boolean().default(true),
      },
    },
    async ({ chat_id, user_id, is_read }) => {
      const action = is_read ? "markChatReadForUser" : "markChatUnreadForUser";
      await dependencies.graphClient.post(`${chatPath(chat_id)}/${action}`, {
        user: { id: user_id },
      });
      return successResponse({ status: is_read ? "Chat marked read" : "Chat marked unread" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_update_chat_message",
    {
      description: `Edit the body of a chat message.

You can only edit messages you sent.

Args:
    chat_id: The chat ID.
    message_id: The message ID to edit.
    message: New message body. When \`is_html\` is true, send explicit HTML;
        markdown is not converted.
    is_html: Whether the body is HTML content (default: True). Use false for
        plain text.`,
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
        message_id: RESOURCE_ID_SCHEMA,
        message: z.string(),
        is_html: z.boolean().default(true),
      },
    },
    async ({ chat_id, message_id, message, is_html }) => {
      await dependencies.graphClient.patch(chatMessagePath(chat_id, message_id), {
        body: buildRichTextBody(message, is_html),
      });
      return successResponse({ status: "Message updated", message_id });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_delete_chat_message",
    {
      description: `Soft delete a chat message, or restore one with \`restore\`.

Graph only exposes this action under /users/{user_id}, so the user ID is
required. There is no hard delete, so a deleted message stays recoverable.

Args:
    chat_id: The chat ID.
    message_id: The message ID to delete.
    user_id: The user ID that sent the message.
    restore: Whether to restore a previously deleted message (default false).`,
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
        message_id: RESOURCE_ID_SCHEMA,
        user_id: RESOURCE_ID_SCHEMA,
        restore: z.boolean().default(false),
      },
    },
    async ({ chat_id, message_id, user_id, restore }) => {
      const action = restore ? "undoSoftDelete" : "softDelete";
      await dependencies.graphClient.post(
        `/users/${encodeURIComponent(user_id)}${chatMessagePath(chat_id, message_id)}/${action}`,
      );
      return successResponse({
        status: restore ? "Message restored" : "Message deleted",
        message_id,
      });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_react_to_message",
    {
      description: `Set or remove an emoji reaction on a chat or channel message.

Supply either \`chat_id\` for a chat message or both \`team_id\` and
\`channel_id\` for a channel message, never both.

Args:
    message_id: The message ID to react to.
    chat_id: Chat ID for a chat message. Empty when targeting a channel.
    team_id: Team ID for a channel message. Empty when targeting a chat.
    channel_id: Channel ID for a channel message. Empty when targeting a chat.
    reaction: Reaction type (default "like"). Common: like, heart, laugh,
        surprised, sad, angry.
    remove: Whether to remove the reaction instead of setting it
        (default false).`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        chat_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        team_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        channel_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        reaction: z.string().default("like"),
        remove: z.boolean().default(false),
      },
    },
    async ({ message_id, chat_id, team_id, channel_id, reaction, remove }) => {
      const hasChat = chat_id !== "";
      const hasChannel = team_id !== "" && channel_id !== "";

      if (hasChat && (team_id !== "" || channel_id !== "")) {
        return successResponse({ error: REACTION_TARGET_CONFLICT_MESSAGE }, "error");
      }
      if (!hasChat && !hasChannel) {
        return successResponse({ error: REACTION_TARGET_REQUIRED_MESSAGE }, "error");
      }

      const action = remove ? "unsetReaction" : "setReaction";
      const basePath = hasChat
        ? chatMessagePath(chat_id, message_id)
        : channelMessagePath(team_id, channel_id, message_id);
      await dependencies.graphClient.post(`${basePath}/${action}`, {
        reactionType: reaction,
      });
      return successResponse({
        status: remove ? "Reaction removed" : "Reaction set",
        reaction,
      });
    },
  );
}
