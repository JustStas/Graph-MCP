import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vitest";

import { createServer } from "../src/server.js";
import type { ToolDependencies } from "../src/tools/tool-types.js";

export const EXPECTED_TOOL_NAMES = [
  "graph_add_chat_member",
  "graph_add_mail_attachment",
  "graph_auth_login",
  "graph_auth_logout",
  "graph_auth_status",
  "graph_cancel_event",
  "graph_categorize_mail",
  "graph_clear_my_presence",
  "graph_copy_file",
  "graph_create_channel",
  "graph_create_chat",
  "graph_create_contact",
  "graph_create_event",
  "graph_create_folder",
  "graph_create_mail_draft",
  "graph_create_mail_folder",
  "graph_create_master_category",
  "graph_create_message_rule",
  "graph_create_online_meeting",
  "graph_create_todo_task",
  "graph_delete_channel_message",
  "graph_delete_chat_message",
  "graph_delete_contact",
  "graph_delete_event",
  "graph_delete_file",
  "graph_delete_file_permission",
  "graph_delete_mail",
  "graph_delete_message_rule",
  "graph_delete_todo_task",
  "graph_find_meeting_times",
  "graph_flag_mail",
  "graph_forward_mail",
  "graph_get_channel_files_folder",
  "graph_get_channel_message_replies",
  "graph_get_channel_messages",
  "graph_get_chat",
  "graph_get_chat_messages",
  "graph_get_event",
  "graph_get_file_bytes",
  "graph_get_file_content",
  "graph_get_mail_attachment",
  "graph_get_mail_delta",
  "graph_get_mail_tips",
  "graph_get_mailbox_settings",
  "graph_get_manager",
  "graph_get_meeting_attendance",
  "graph_get_meeting_id",
  "graph_get_meeting_recording_url",
  "graph_get_my_presence",
  "graph_get_online_meeting",
  "graph_get_presences_by_user_ids",
  "graph_get_primary_channel",
  "graph_get_profile",
  "graph_get_schedule",
  "graph_get_team",
  "graph_get_transcript_content",
  "graph_get_user_presence",
  "graph_get_worksheet_range",
  "graph_invite_to_file",
  "graph_list_calendars",
  "graph_list_channel_members",
  "graph_list_channels",
  "graph_list_chat_members",
  "graph_list_chats",
  "graph_list_contact_folders",
  "graph_list_contacts",
  "graph_list_direct_reports",
  "graph_list_drives",
  "graph_list_event_instances",
  "graph_list_events",
  "graph_list_file_permissions",
  "graph_list_file_versions",
  "graph_list_files",
  "graph_list_mail",
  "graph_list_mail_attachments",
  "graph_list_mail_folders",
  "graph_list_master_categories",
  "graph_list_meeting_recordings",
  "graph_list_meeting_transcripts",
  "graph_list_message_rules",
  "graph_list_my_planner_tasks",
  "graph_list_online_meetings",
  "graph_list_recent_files",
  "graph_list_rooms",
  "graph_list_shared_files",
  "graph_list_site_drives",
  "graph_list_team_members",
  "graph_list_teams",
  "graph_list_todo_lists",
  "graph_list_todo_tasks",
  "graph_list_worksheets",
  "graph_mark_chat_read",
  "graph_mark_mail_read",
  "graph_move_file",
  "graph_move_mail",
  "graph_react_to_message",
  "graph_read_mail",
  "graph_remove_chat_member",
  "graph_reply_mail",
  "graph_reply_to_channel_message",
  "graph_resolve_share_link",
  "graph_respond_to_event",
  "graph_restore_file_version",
  "graph_search_all",
  "graph_search_files",
  "graph_search_mail",
  "graph_search_messages",
  "graph_search_people",
  "graph_search_sites",
  "graph_search_users",
  "graph_send_channel_message",
  "graph_send_chat_message",
  "graph_send_mail",
  "graph_send_mail_draft",
  "graph_set_automatic_replies",
  "graph_set_my_presence",
  "graph_set_status_message",
  "graph_share_file",
  "graph_update_channel_message",
  "graph_update_chat_message",
  "graph_update_chat_topic",
  "graph_update_contact",
  "graph_update_event",
  "graph_update_mailbox_settings",
  "graph_update_todo_task",
  "graph_update_worksheet_range",
  "graph_upload_file",
] as const;

function createDependencies(): ToolDependencies {
  return {
    authManager: {
      getStatus: () => ({ state: "unauthenticated" }),
      login: () => Promise.resolve({ state: "authenticated" }),
      logout: () => Promise.resolve(),
      getValidAccessToken: () => Promise.resolve("access-token"),
      refreshAccessToken: () => Promise.resolve(true),
    },
    graphClient: {
      get: () => Promise.resolve({}),
      getBytes: () => Promise.resolve(new Uint8Array()),
      post: () => Promise.resolve({}),
      patch: () => Promise.resolve({}),
      put: () => Promise.resolve({}),
      delete: () => Promise.resolve(null),
    },
  };
}

function requireTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Tool ${name} was not registered.`);
  }
  return tool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSchemaProperty(tool: Tool, propertyName: string): Record<string, unknown> {
  const properties: unknown = tool.inputSchema.properties;
  if (!isRecord(properties) || !isRecord(properties[propertyName])) {
    throw new Error(`Tool ${tool.name} is missing schema property ${propertyName}.`);
  }
  return properties[propertyName];
}

/**
 * A plugin install prefixes every tool with `mcp__plugin_<plugin>_<server>__`, and MCP caps a
 * prefixed tool name at 64 characters. Past that the client rewrites the name to a truncated
 * hashed alias that does not route, so the tool is simply unreachable — which is how
 * `graph_get_meeting_transcript_content` (65) silently disappeared from plugin installs while
 * standalone installs, prefixed with only `mcp__graph__`, kept working.
 */
const PLUGIN_TOOL_NAME_PREFIX = "mcp__plugin_graph-mcp_graph__";
const MAX_PREFIXED_TOOL_NAME_LENGTH = 64;

describe("Graph MCP tool contract", () => {
  test("keeps every tool name reachable under the plugin prefix", () => {
    const overLimit = EXPECTED_TOOL_NAMES.filter(
      (name) => PLUGIN_TOOL_NAME_PREFIX.length + name.length > MAX_PREFIXED_TOOL_NAME_LENGTH,
    ).map((name) => `${name} (${PLUGIN_TOOL_NAME_PREFIX.length + name.length})`);

    expect(overLimit).toEqual([]);
  });

  test("exposes the exact 127-tool inventory and representative input schemas", async () => {
    const server = await createServer(createDependencies());
    const client = new Client({ name: "tool-contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getServerVersion()).toEqual({ name: "Graph MCP", version: "0.9.0" });
      expect(client.getInstructions()).toBe(
        "Microsoft Teams, Outlook Calendar, Mail, meetings, users, presence, and OneDrive integration via Microsoft Graph API",
      );

      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
      expect(result.tools).toHaveLength(127);

      expect(requireTool(result.tools, "graph_get_profile").inputSchema).toMatchObject({
        type: "object",
        properties: {},
      });

      expect(requireTool(result.tools, "graph_get_user_presence").inputSchema).toMatchObject({
        type: "object",
        properties: { user_id: { type: "string" } },
        required: ["user_id"],
      });

      expect(requireTool(result.tools, "graph_list_chats").inputSchema).toMatchObject({
        type: "object",
        properties: { top: { type: "integer", default: 50 } },
      });

      const createChatSchema = requireTool(result.tools, "graph_create_chat").inputSchema;
      expect(createChatSchema).toMatchObject({
        type: "object",
        properties: {
          members: { type: "array", items: { type: "string" } },
        },
      });
      expect(createChatSchema.required).toEqual(expect.arrayContaining(["chat_type", "members"]));

      const sendChatMessage = requireTool(result.tools, "graph_send_chat_message");
      expect(sendChatMessage.inputSchema).toMatchObject({
        type: "object",
      });
      expect(sendChatMessage.inputSchema.required).toEqual(
        expect.arrayContaining(["chat_id", "message"]),
      );
      const mentionsSchema = requireSchemaProperty(sendChatMessage, "mentions");
      expect(mentionsSchema.default).toBeNull();
      expect(mentionsSchema.anyOf).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "array" }),
          expect.objectContaining({ type: "null" }),
        ]),
      );

      expect(requireTool(result.tools, "graph_auth_login").inputSchema).toMatchObject({
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["browser", "device_code"],
            default: "browser",
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
