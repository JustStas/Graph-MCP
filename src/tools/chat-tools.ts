import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { CHAT_FIELDS } from "../select-fields.js";
import { buildChatMessagePayload } from "./message-tools.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value !== "" && value !== "." && value !== "..", {
    message: "Resource IDs must not be empty, '.' or '..'.",
  });
const TOP_SCHEMA = z.number().int().default(50);
const MENTIONS_SCHEMA = z
  .array(z.record(z.string(), z.unknown()))
  .nullable()
  .optional()
  .default(null);

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

function currentUserId(response: unknown): string {
  if (!isNonArrayObject(response) || typeof response.id !== "string" || response.id.length === 0) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response.id;
}

function memberBinding(member: string): string {
  const encodedMember = encodeURIComponent(member).replaceAll("'", "''");
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
      description: "List recent Microsoft Teams chats.",
      inputSchema: {
        top: TOP_SCHEMA,
      },
    },
    async ({ top }) => {
      const result = await dependencies.graphClient.get("/me/chats", {
        $select: CHAT_FIELDS,
        $top: String(Math.min(top, 50)),
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_chat_messages",
    {
      description: "Get messages from a specific chat.",
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
        top: TOP_SCHEMA,
      },
    },
    async ({ chat_id, top }) => {
      const encodedChatId = encodeURIComponent(chat_id);
      const result = await dependencies.graphClient.get(`/chats/${encodedChatId}/messages`, {
        $top: String(Math.min(top, 50)),
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_send_chat_message",
    {
      description: "Send a message to a chat.",
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
        message: z.string(),
        is_html: z.boolean().default(true),
        mentions: MENTIONS_SCHEMA,
      },
    },
    async ({ chat_id, message, is_html, mentions }) => {
      const encodedChatId = encodeURIComponent(chat_id);
      const result = await dependencies.graphClient.post(
        `/chats/${encodedChatId}/messages`,
        buildChatMessagePayload(message, is_html, mentions),
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
        const myId = currentUserId(me);
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
      return successResponse(result);
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_chat_members",
    {
      description: "List members of a chat.",
      inputSchema: {
        chat_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ chat_id }) => {
      const encodedChatId = encodeURIComponent(chat_id);
      const result = await dependencies.graphClient.get(`/chats/${encodedChatId}/members`);
      return successResponse(collectionValue(result));
    },
  );
}
