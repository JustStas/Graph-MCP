import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { CHANNEL_FIELDS, TEAM_FIELDS } from "../select-fields.js";
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

function teamPath(teamId: string): string {
  return `/teams/${encodeURIComponent(teamId)}`;
}

function channelPath(teamId: string, channelId: string): string {
  return `${teamPath(teamId)}/channels/${encodeURIComponent(channelId)}`;
}

function messagePath(teamId: string, channelId: string, messageId?: string): string {
  const messagesPath = `${channelPath(teamId, channelId)}/messages`;
  return messageId === undefined
    ? messagesPath
    : `${messagesPath}/${encodeURIComponent(messageId)}`;
}

export function registerTeamsTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_list_teams",
    {
      description: "List Microsoft Teams that the authenticated user has joined.",
      inputSchema: {},
    },
    async () => {
      const result = await dependencies.graphClient.get("/me/joinedTeams", {
        $select: TEAM_FIELDS,
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_channels",
    {
      description: "List channels in a team.",
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ team_id }) => {
      const result = await dependencies.graphClient.get(`${teamPath(team_id)}/channels`, {
        $select: CHANNEL_FIELDS,
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_channel_messages",
    {
      description: "Get messages from a channel.",
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
        channel_id: RESOURCE_ID_SCHEMA,
        top: TOP_SCHEMA,
      },
    },
    async ({ team_id, channel_id, top }) => {
      const result = await dependencies.graphClient.get(messagePath(team_id, channel_id), {
        $top: String(Math.min(top, 50)),
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_send_channel_message",
    {
      description: "Send a message to a channel.",
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
        channel_id: RESOURCE_ID_SCHEMA,
        message: z.string(),
        is_html: z.boolean().default(true),
        mentions: MENTIONS_SCHEMA,
      },
    },
    async ({ team_id, channel_id, message, is_html, mentions }) => {
      const result = await dependencies.graphClient.post(
        messagePath(team_id, channel_id),
        buildChatMessagePayload(message, is_html, mentions),
      );
      return successResponse(result);
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_channel_members",
    {
      description: "List members of a channel.",
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
        channel_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ team_id, channel_id }) => {
      const result = await dependencies.graphClient.get(
        `${channelPath(team_id, channel_id)}/members`,
      );
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_channel_message_replies",
    {
      description: "Get replies to a channel message.",
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
        channel_id: RESOURCE_ID_SCHEMA,
        message_id: RESOURCE_ID_SCHEMA,
        top: TOP_SCHEMA,
      },
    },
    async ({ team_id, channel_id, message_id, top }) => {
      const result = await dependencies.graphClient.get(
        `${messagePath(team_id, channel_id, message_id)}/replies`,
        { $top: String(Math.min(top, 50)) },
      );
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_reply_to_channel_message",
    {
      description: "Reply to a channel message.",
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
        channel_id: RESOURCE_ID_SCHEMA,
        message_id: RESOURCE_ID_SCHEMA,
        message: z.string(),
        is_html: z.boolean().default(true),
        mentions: MENTIONS_SCHEMA,
      },
    },
    async ({ team_id, channel_id, message_id, message, is_html, mentions }) => {
      const result = await dependencies.graphClient.post(
        `${messagePath(team_id, channel_id, message_id)}/replies`,
        buildChatMessagePayload(message, is_html, mentions),
      );
      return successResponse(result);
    },
  );
}
