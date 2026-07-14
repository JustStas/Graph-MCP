import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vitest";

import { createServer } from "../src/server.js";
import type { ToolDependencies } from "../src/tools/tool-types.js";

export const EXPECTED_TOOL_NAMES = [
  "graph_auth_login",
  "graph_auth_logout",
  "graph_auth_status",
  "graph_create_chat",
  "graph_create_event",
  "graph_delete_event",
  "graph_get_channel_message_replies",
  "graph_get_channel_messages",
  "graph_get_chat_messages",
  "graph_get_event",
  "graph_get_file_content",
  "graph_get_mail_attachment",
  "graph_get_meeting_recording_url",
  "graph_get_meeting_transcript_content",
  "graph_get_my_presence",
  "graph_get_profile",
  "graph_get_user_presence",
  "graph_list_calendars",
  "graph_list_channel_members",
  "graph_list_channels",
  "graph_list_chat_members",
  "graph_list_chats",
  "graph_list_events",
  "graph_list_files",
  "graph_list_mail",
  "graph_list_mail_attachments",
  "graph_list_meeting_recordings",
  "graph_list_meeting_transcripts",
  "graph_list_online_meetings",
  "graph_list_teams",
  "graph_read_mail",
  "graph_reply_mail",
  "graph_reply_to_channel_message",
  "graph_search_files",
  "graph_search_mail",
  "graph_search_messages",
  "graph_search_users",
  "graph_send_channel_message",
  "graph_send_chat_message",
  "graph_send_mail",
  "graph_set_my_presence",
  "graph_share_file",
  "graph_update_event",
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

describe("Graph MCP tool contract", () => {
  test("exposes the exact 44-tool inventory and representative input schemas", async () => {
    const server = await createServer(createDependencies());
    const client = new Client({ name: "tool-contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getServerVersion()).toEqual({ name: "Graph MCP", version: "0.6.0" });
      expect(client.getInstructions()).toBe(
        "Microsoft Teams, Outlook Calendar, Mail, meetings, users, presence, and OneDrive integration via Microsoft Graph API",
      );

      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
      expect(result.tools).toHaveLength(44);

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
