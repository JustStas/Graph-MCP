import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { CHANNEL_FIELDS, TEAM_FIELDS } from "../select-fields.js";
import { buildChatMessagePayload, buildRichTextBody } from "./message-tools.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value !== "" && value !== "." && value !== "..", {
    message: "Resource IDs must not be empty, '.' or '..'.",
  });
const TOP_SCHEMA = z.number().int().default(50);
const TEAM_DETAIL_FIELDS = "id,displayName,description,isArchived,visibility,webUrl";
const MEMBERSHIP_TYPE_SCHEMA = z.enum(["standard", "private", "shared"]).default("standard");
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

function requireGraphObject(response: unknown): Record<string, unknown> {
  if (!isNonArrayObject(response)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response;
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

  registerAuthenticatedTool(
    server,
    "graph_list_team_members",
    {
      description: `List members of a team.

Needs the TeamMember.Read.All permission, which requires admin consent.

Args:
    team_id: The team ID (from graph_list_teams).
    top: Maximum number of members to return (default 50, maximum 50).`,
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
        top: TOP_SCHEMA,
      },
    },
    async ({ team_id, top }) => {
      const result = await dependencies.graphClient.get(`${teamPath(team_id)}/members`, {
        $top: String(Math.min(top, 50)),
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_team",
    {
      description: `Get a team's details, including whether it is archived.

Args:
    team_id: The team ID (from graph_list_teams).`,
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ team_id }) => {
      const result = await dependencies.graphClient.get(teamPath(team_id), {
        $select: TEAM_DETAIL_FIELDS,
      });
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_primary_channel",
    {
      description: `Get a team's primary channel, the one named General.

Use this as a shortcut for the default channel instead of listing every
channel in the team.

Args:
    team_id: The team ID (from graph_list_teams).`,
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ team_id }) => {
      const result = await dependencies.graphClient.get(`${teamPath(team_id)}/primaryChannel`, {
        $select: CHANNEL_FIELDS,
      });
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_create_channel",
    {
      description: `Create a channel in a team.

Needs the Channel.Create permission.

Args:
    team_id: The team ID (from graph_list_teams).
    display_name: Name of the new channel.
    description: Optional channel description.
    membership_type: Channel type: "standard", "private", or "shared"
        (default "standard").`,
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
        display_name: RESOURCE_ID_SCHEMA,
        description: z.string().default(""),
        membership_type: MEMBERSHIP_TYPE_SCHEMA,
      },
    },
    async ({ team_id, display_name, description, membership_type }) => {
      const result = await dependencies.graphClient.post(`${teamPath(team_id)}/channels`, {
        displayName: display_name,
        description,
        membershipType: membership_type,
      });
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_channel_files_folder",
    {
      description: `Get the SharePoint folder that stores a channel's files.

This is the bridge from a channel to its SharePoint folder: the returned
folder ID works with the OneDrive file tools. Needs the Files.Read.All
permission.

Args:
    team_id: The team ID (from graph_list_teams).
    channel_id: The channel ID (from graph_list_channels).
    include_children: Whether to also list the folder contents (default
        false). When true the result is {"folder": ..., "children": [...]}.
    top: Maximum number of children to return (default 50, maximum 50).`,
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
        channel_id: RESOURCE_ID_SCHEMA,
        include_children: z.boolean().default(false),
        top: TOP_SCHEMA,
      },
    },
    async ({ team_id, channel_id, include_children, top }) => {
      const folderPath = `${channelPath(team_id, channel_id)}/filesFolder`;
      const folderResult = await dependencies.graphClient.get(folderPath);
      const folder = requireGraphObject(folderResult);
      if (!include_children) {
        return successResponse(folder);
      }

      const childrenResult = await dependencies.graphClient.get(`${folderPath}/children`, {
        $top: String(Math.min(top, 50)),
      });
      return successResponse({ folder, children: collectionValue(childrenResult) });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_update_channel_message",
    {
      description: `Edit a channel message you posted.

Only your own messages can be edited; editing anyone else's message fails.

Args:
    team_id: The team ID (from graph_list_teams).
    channel_id: The channel ID (from graph_list_channels).
    message_id: The message ID to edit (from graph_get_channel_messages).
    message: Replacement message content. When \`is_html\` is true, send
        explicit HTML; markdown is not converted.
    is_html: Whether the message is HTML content (default: True). Use false
        for plain text.`,
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
        channel_id: RESOURCE_ID_SCHEMA,
        message_id: RESOURCE_ID_SCHEMA,
        message: z.string(),
        is_html: z.boolean().default(true),
      },
    },
    async ({ team_id, channel_id, message_id, message, is_html }) => {
      await dependencies.graphClient.patch(messagePath(team_id, channel_id, message_id), {
        body: buildRichTextBody(message, is_html),
      });
      return successResponse({ status: "Message updated" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_delete_channel_message",
    {
      description: `Soft-delete a channel message, or restore one you deleted.

Args:
    team_id: The team ID (from graph_list_teams).
    channel_id: The channel ID (from graph_list_channels).
    message_id: The message ID to delete (from graph_get_channel_messages).
    restore: Whether to restore a previously soft-deleted message
        (default false).`,
      inputSchema: {
        team_id: RESOURCE_ID_SCHEMA,
        channel_id: RESOURCE_ID_SCHEMA,
        message_id: RESOURCE_ID_SCHEMA,
        restore: z.boolean().default(false),
      },
    },
    async ({ team_id, channel_id, message_id, restore }) => {
      const action = restore ? "undoSoftDelete" : "softDelete";
      await dependencies.graphClient.post(
        `${messagePath(team_id, channel_id, message_id)}/${action}`,
      );
      return successResponse({ status: restore ? "Message restored" : "Message deleted" });
    },
  );
}
