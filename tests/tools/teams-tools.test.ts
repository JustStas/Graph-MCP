import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError, GraphApiError } from "../../src/errors.js";
import { CHANNEL_FIELDS, TEAM_FIELDS } from "../../src/select-fields.js";
import { registerTeamsTools } from "../../src/tools/teams-tools.js";
import type { ToolDependencies } from "../../src/tools/tool-types.js";

type RecordedCallback = (args: unknown, extra: unknown) => CallToolResult | Promise<CallToolResult>;

interface RecordedToolConfig {
  readonly description?: string;
  readonly inputSchema?: ZodRawShape;
}

interface RecordedRegistration {
  readonly name: string;
  readonly config: RecordedToolConfig;
  readonly callback: RecordedCallback;
}

interface GraphCall {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly params?: unknown;
  readonly body?: unknown;
  readonly headers?: unknown;
}

interface GraphFake {
  readonly graphClient: ToolDependencies["graphClient"];
  readonly calls: GraphCall[];
}

interface ToolHarness {
  readonly server: Pick<McpServer, "registerTool">;
  readonly registrations: RecordedRegistration[];
  registration(name: string): RecordedRegistration;
  invoke(name: string, args?: unknown): Promise<CallToolResult>;
  invokeRaw(name: string, args: unknown): Promise<CallToolResult>;
}

const EXPECTED_TEAMS_TOOLS = [
  {
    name: "graph_list_teams",
    description: "List Microsoft Teams that the authenticated user has joined.",
  },
  {
    name: "graph_list_channels",
    description: "List channels in a team.",
  },
  {
    name: "graph_get_channel_messages",
    description: "Get messages from a channel.",
  },
  {
    name: "graph_send_channel_message",
    description: "Send a message to a channel.",
  },
  {
    name: "graph_list_channel_members",
    description: "List members of a channel.",
  },
  {
    name: "graph_get_channel_message_replies",
    description: "Get replies to a channel message.",
  },
  {
    name: "graph_reply_to_channel_message",
    description: "Reply to a channel message.",
  },
  {
    name: "graph_list_team_members",
    description: `List members of a team.

Needs the TeamMember.Read.All permission, which requires admin consent.

Args:
    team_id: The team ID (from graph_list_teams).
    top: Maximum number of members to return (default 50, maximum 50).`,
  },
  {
    name: "graph_get_team",
    description: `Get a team's details, including whether it is archived.

Args:
    team_id: The team ID (from graph_list_teams).`,
  },
  {
    name: "graph_get_primary_channel",
    description: `Get a team's primary channel, the one named General.

Use this as a shortcut for the default channel instead of listing every
channel in the team.

Args:
    team_id: The team ID (from graph_list_teams).`,
  },
  {
    name: "graph_create_channel",
    description: `Create a channel in a team.

Needs the Channel.Create permission.

Args:
    team_id: The team ID (from graph_list_teams).
    display_name: Name of the new channel.
    description: Optional channel description.
    membership_type: Channel type: "standard", "private", or "shared"
        (default "standard").`,
  },
  {
    name: "graph_get_channel_files_folder",
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
  },
  {
    name: "graph_update_channel_message",
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
  },
  {
    name: "graph_delete_channel_message",
    description: `Soft-delete a channel message, or restore one you deleted.

Args:
    team_id: The team ID (from graph_list_teams).
    channel_id: The channel ID (from graph_list_channels).
    message_id: The message ID to delete (from graph_get_channel_messages).
    restore: Whether to restore a previously soft-deleted message
        (default false).`,
  },
] as const;

const INVALID_GRAPH_RESPONSE_RESULT = {
  content: [
    {
      type: "text",
      text: '{"error":"Graph API error: Invalid Microsoft Graph response."}',
    },
  ],
} as const;

const GRAPH_API_ERROR_RESULT = {
  content: [
    {
      type: "text",
      text: '{"error":"Graph API error: 403: Access denied"}',
    },
  ],
} as const;

const AUTHENTICATION_ERROR_RESULT = {
  content: [
    {
      type: "text",
      text: '{"error":"Not authenticated.","action_required":"Please call the graph_auth_login tool first."}',
    },
  ],
} as const;

function responsePromise(readResponse: () => unknown): Promise<unknown> {
  return Promise.resolve().then(readResponse);
}

function createGraphFake(initialResponses: readonly unknown[] = []): GraphFake {
  const responses = [...initialResponses];
  let responseIndex = 0;
  const calls: GraphCall[] = [];

  function readResponse(): unknown {
    if (responseIndex >= responses.length) {
      throw new Error("No fake Graph response was configured.");
    }
    const response = responses[responseIndex];
    responseIndex += 1;
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  const graphClient: ToolDependencies["graphClient"] = {
    get: (path, params, headers) => {
      calls.push({
        method: "GET",
        path,
        ...(params === undefined ? {} : { params }),
        ...(headers === undefined ? {} : { headers }),
      });
      return responsePromise(readResponse);
    },
    post: (path, body, params, headers) => {
      calls.push({
        method: "POST",
        path,
        ...(body === undefined ? {} : { body }),
        ...(params === undefined ? {} : { params }),
        ...(headers === undefined ? {} : { headers }),
      });
      return responsePromise(readResponse);
    },
    patch: (path, body, headers) => {
      calls.push({
        method: "PATCH",
        path,
        ...(body === undefined ? {} : { body }),
        ...(headers === undefined ? {} : { headers }),
      });
      return responsePromise(readResponse);
    },
    put: (path, data, body, headers) => {
      calls.push({
        method: "PUT",
        path,
        ...(data === undefined ? {} : { body: data }),
        ...(body === undefined ? {} : { params: body }),
        ...(headers === undefined ? {} : { headers }),
      });
      return responsePromise(readResponse);
    },
    delete: (path, headers) => {
      calls.push({
        method: "DELETE",
        path,
        ...(headers === undefined ? {} : { headers }),
      });
      return responsePromise(readResponse);
    },
  };

  return { graphClient, calls };
}

function createDependencies(graphResponses: readonly unknown[] = []): {
  readonly dependencies: ToolDependencies;
  readonly graph: GraphFake;
} {
  const graph = createGraphFake(graphResponses);
  return {
    dependencies: {
      authManager: {
        getStatus: () => ({ state: "unauthenticated" }),
        login: () => Promise.resolve({ state: "authenticated" }),
        logout: () => Promise.resolve(),
        getValidAccessToken: () => Promise.resolve("access-token"),
        refreshAccessToken: () => Promise.resolve(true),
      },
      graphClient: graph.graphClient,
    },
    graph,
  };
}

function createToolHarness(): ToolHarness {
  const registrations: RecordedRegistration[] = [];
  const registerTool = ((name: string, config: unknown, callback: unknown) => {
    if (typeof callback !== "function") {
      throw new Error("Expected a registered callback.");
    }
    registrations.push({
      name,
      config: config as RecordedToolConfig,
      callback: callback as RecordedCallback,
    });
    return {} as RegisteredTool;
  }) as McpServer["registerTool"];

  return {
    server: { registerTool },
    registrations,
    registration(name) {
      const registration = registrations.find((candidate) => candidate.name === name);
      if (registration === undefined) {
        throw new Error(`Tool ${name} was not registered.`);
      }
      return registration;
    },
    async invoke(name, args = {}) {
      const registration = this.registration(name);
      const parsedArgs = z.object(registration.config.inputSchema ?? {}).parse(args);
      return await registration.callback(parsedArgs, {});
    },
    async invokeRaw(name, args) {
      return await this.registration(name).callback(args, {});
    },
  };
}

function schemaFor(harness: ToolHarness, name: string): ZodRawShape {
  const schema = harness.registration(name).config.inputSchema;
  if (schema === undefined) {
    throw new Error(`Tool ${name} did not expose an input schema.`);
  }
  return schema;
}

function textFrom(result: CallToolResult): string {
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("Expected a text tool result.");
  }
  return content.text;
}

function dataFrom(result: CallToolResult): unknown {
  const payload: unknown = JSON.parse(textFrom(result));
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    throw new Error("Expected a success response.");
  }
  return payload.data;
}

function registerTeamsHarness(graphResponses: readonly unknown[] = []): {
  readonly harness: ToolHarness;
  readonly graph: GraphFake;
} {
  const harness = createToolHarness();
  const { dependencies, graph } = createDependencies(graphResponses);
  registerTeamsTools(harness.server, dependencies);
  return { harness, graph };
}

describe("Teams tool registration", () => {
  test("registers exactly the fourteen Teams names with complete descriptions", () => {
    const { harness } = registerTeamsHarness();

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_TEAMS_TOOLS);
  });

  test("exposes exact public snake_case Teams schemas, defaults, and required fields", () => {
    const { harness } = registerTeamsHarness();

    expect(schemaFor(harness, "graph_list_teams")).toEqual({});

    const channelsShape = schemaFor(harness, "graph_list_channels");
    expect(Object.keys(channelsShape)).toEqual(["team_id"]);
    expect(z.object(channelsShape).parse({ team_id: "team-1" })).toEqual({
      team_id: "team-1",
    });

    const messagesShape = schemaFor(harness, "graph_get_channel_messages");
    expect(Object.keys(messagesShape)).toEqual(["team_id", "channel_id", "top"]);
    const messagesSchema = z.object(messagesShape);
    expect(messagesSchema.parse({ team_id: "team-1", channel_id: "channel-1" })).toEqual({
      team_id: "team-1",
      channel_id: "channel-1",
      top: 50,
    });
    expect(
      messagesSchema.safeParse({
        team_id: "team-1",
        channel_id: "channel-1",
        top: 1.5,
      }).success,
    ).toBe(false);
    expect(
      messagesSchema.safeParse({
        team_id: "team-1",
        channel_id: "channel-1",
        top: -1,
      }).success,
    ).toBe(true);
    expect(
      messagesSchema.safeParse({
        team_id: "team-1",
        channel_id: "channel-1",
        top: 500,
      }).success,
    ).toBe(true);

    const sendShape = schemaFor(harness, "graph_send_channel_message");
    expect(Object.keys(sendShape)).toEqual([
      "team_id",
      "channel_id",
      "message",
      "is_html",
      "mentions",
    ]);
    const sendSchema = z.object(sendShape);
    expect(
      sendSchema.parse({
        team_id: "team-1",
        channel_id: "channel-1",
        message: "hello",
      }),
    ).toEqual({
      team_id: "team-1",
      channel_id: "channel-1",
      message: "hello",
      is_html: true,
      mentions: null,
    });
    expect(
      sendSchema.parse({
        team_id: "team-1",
        channel_id: "channel-1",
        message: "hello",
        is_html: false,
        mentions: [{ name: "Ada", user_id: "user-1", custom: 42 }],
      }),
    ).toEqual({
      team_id: "team-1",
      channel_id: "channel-1",
      message: "hello",
      is_html: false,
      mentions: [{ name: "Ada", user_id: "user-1", custom: 42 }],
    });
    expect(
      sendSchema.safeParse({
        team_id: "team-1",
        channel_id: "channel-1",
        message: "hello",
        mentions: ["not-an-object"],
      }).success,
    ).toBe(false);

    const membersShape = schemaFor(harness, "graph_list_channel_members");
    expect(Object.keys(membersShape)).toEqual(["team_id", "channel_id"]);

    const repliesShape = schemaFor(harness, "graph_get_channel_message_replies");
    expect(Object.keys(repliesShape)).toEqual(["team_id", "channel_id", "message_id", "top"]);
    expect(
      z.object(repliesShape).parse({
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
      }),
    ).toEqual({
      team_id: "team-1",
      channel_id: "channel-1",
      message_id: "message-1",
      top: 50,
    });

    const replyShape = schemaFor(harness, "graph_reply_to_channel_message");
    expect(Object.keys(replyShape)).toEqual([
      "team_id",
      "channel_id",
      "message_id",
      "message",
      "is_html",
      "mentions",
    ]);
    expect(
      z.object(replyShape).parse({
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
        message: "reply",
      }),
    ).toEqual({
      team_id: "team-1",
      channel_id: "channel-1",
      message_id: "message-1",
      message: "reply",
      is_html: true,
      mentions: null,
    });
  });

  test("rejects empty and dot-segment values in every Teams ID schema", () => {
    const { harness } = registerTeamsHarness();
    const cases = [
      {
        name: "graph_list_channels",
        ids: ["team_id"],
        base: {},
      },
      {
        name: "graph_get_channel_messages",
        ids: ["team_id", "channel_id"],
        base: {},
      },
      {
        name: "graph_send_channel_message",
        ids: ["team_id", "channel_id"],
        base: { message: "hello" },
      },
      {
        name: "graph_list_channel_members",
        ids: ["team_id", "channel_id"],
        base: {},
      },
      {
        name: "graph_get_channel_message_replies",
        ids: ["team_id", "channel_id", "message_id"],
        base: {},
      },
      {
        name: "graph_reply_to_channel_message",
        ids: ["team_id", "channel_id", "message_id"],
        base: { message: "reply" },
      },
    ] as const;

    for (const { name, ids, base } of cases) {
      const schema = z.object(schemaFor(harness, name));
      const validIds = {
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
      };
      for (const idName of ids) {
        for (const invalidValue of ["", ".", ".."]) {
          expect(
            schema.safeParse({
              ...base,
              ...validIds,
              [idName]: invalidValue,
            }).success,
          ).toBe(false);
        }
      }
    }
  });
});

describe("Teams list operations", () => {
  test("uses exact paths, select fields, string top values, handler caps, and list extraction", async () => {
    const { harness, graph } = registerTeamsHarness([
      { value: [{ id: "team-1" }] },
      { value: [{ id: "channel-1" }] },
      { value: [{ id: "message-1" }] },
      { value: [{ id: "message-2" }] },
      { value: [{ id: "member-1" }] },
      { value: [{ id: "reply-1" }] },
      { value: [{ id: "reply-2" }] },
    ]);

    expect(dataFrom(await harness.invoke("graph_list_teams"))).toEqual([{ id: "team-1" }]);
    expect(dataFrom(await harness.invoke("graph_list_channels", { team_id: "team-1" }))).toEqual([
      { id: "channel-1" },
    ]);
    expect(
      dataFrom(
        await harness.invoke("graph_get_channel_messages", {
          team_id: "team-1",
          channel_id: "channel-1",
        }),
      ),
    ).toEqual([{ id: "message-1" }]);
    expect(
      dataFrom(
        await harness.invoke("graph_get_channel_messages", {
          team_id: "team-1",
          channel_id: "channel-1",
          top: 500,
        }),
      ),
    ).toEqual([{ id: "message-2" }]);
    expect(
      dataFrom(
        await harness.invoke("graph_list_channel_members", {
          team_id: "team-1",
          channel_id: "channel-1",
        }),
      ),
    ).toEqual([{ id: "member-1" }]);
    expect(
      dataFrom(
        await harness.invoke("graph_get_channel_message_replies", {
          team_id: "team-1",
          channel_id: "channel-1",
          message_id: "message-1",
        }),
      ),
    ).toEqual([{ id: "reply-1" }]);
    expect(
      dataFrom(
        await harness.invoke("graph_get_channel_message_replies", {
          team_id: "team-1",
          channel_id: "channel-1",
          message_id: "message-1",
          top: 500,
        }),
      ),
    ).toEqual([{ id: "reply-2" }]);

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/joinedTeams",
        params: { $select: TEAM_FIELDS },
      },
      {
        method: "GET",
        path: "/teams/team-1/channels",
        params: { $select: CHANNEL_FIELDS },
      },
      {
        method: "GET",
        path: "/teams/team-1/channels/channel-1/messages",
        params: { $top: "50" },
      },
      {
        method: "GET",
        path: "/teams/team-1/channels/channel-1/messages",
        params: { $top: "50" },
      },
      {
        method: "GET",
        path: "/teams/team-1/channels/channel-1/members",
      },
      {
        method: "GET",
        path: "/teams/team-1/channels/channel-1/messages/message-1/replies",
        params: { $top: "50" },
      },
      {
        method: "GET",
        path: "/teams/team-1/channels/channel-1/messages/message-1/replies",
        params: { $top: "50" },
      },
    ]);
  });

  test.each([
    {
      name: "graph_list_teams",
      args: {},
    },
    {
      name: "graph_list_channels",
      args: { team_id: "team-1" },
    },
    {
      name: "graph_get_channel_messages",
      args: { team_id: "team-1", channel_id: "channel-1" },
    },
    {
      name: "graph_list_channel_members",
      args: { team_id: "team-1", channel_id: "channel-1" },
    },
    {
      name: "graph_get_channel_message_replies",
      args: {
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
      },
    },
  ])("$name treats a missing value property as an empty list", async ({ name, args }) => {
    const { harness } = registerTeamsHarness([{}]);

    expect(dataFrom(await harness.invoke(name, args))).toEqual([]);
  });

  test.each([
    {
      label: "null response",
      response: null,
    },
    {
      label: "text response",
      response: "payload-secret-text-response",
    },
    {
      label: "scalar response",
      response: 42,
    },
    {
      label: "array response",
      response: [{ secret: "payload-secret-array-response" }],
    },
    {
      label: "null value",
      response: { value: null, secret: "payload-secret-null-value" },
    },
    {
      label: "text value",
      response: { value: "payload-secret-text-value" },
    },
    {
      label: "scalar value",
      response: { value: 42, secret: "payload-secret-scalar-value" },
    },
    {
      label: "object value",
      response: { value: { secret: "payload-secret-object-value" } },
    },
  ])("rejects malformed collection responses without leakage: $label", async ({ response }) => {
    const invocations = [
      { name: "graph_list_teams", args: {} },
      { name: "graph_list_channels", args: { team_id: "team-1" } },
      {
        name: "graph_get_channel_messages",
        args: { team_id: "team-1", channel_id: "channel-1" },
      },
      {
        name: "graph_list_channel_members",
        args: { team_id: "team-1", channel_id: "channel-1" },
      },
      {
        name: "graph_get_channel_message_replies",
        args: {
          team_id: "team-1",
          channel_id: "channel-1",
          message_id: "message-1",
        },
      },
    ] as const;

    for (const { name, args } of invocations) {
      const { harness } = registerTeamsHarness([response]);
      const result = await harness.invoke(name, args);

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("payload-secret");
      expect(serialized).not.toContain("TypeError");
      expect(serialized).not.toContain("Cannot read");
      expect(serialized).not.toContain("not iterable");
    }
  });
});

describe("Teams message operations", () => {
  test("sends exact channel HTML and mention payloads, returns the full result, and preserves inputs", async () => {
    const result = { id: "message-1", body: { content: "<p>Hello Ada</p>" } };
    const { harness, graph } = registerTeamsHarness([result]);
    const mention = Object.freeze({
      name: "Ada Lovelace",
      user_id: "user-1",
    });
    const mentions = Object.freeze([mention]);

    const response = await harness.invokeRaw("graph_send_channel_message", {
      team_id: "team-1",
      channel_id: "channel-1",
      message: "<p>Hello Ada</p>",
      is_html: true,
      mentions,
    });

    expect(dataFrom(response)).toEqual(result);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/teams/team-1/channels/channel-1/messages",
        body: {
          body: {
            contentType: "html",
            content: "<p>Hello Ada</p>",
          },
          mentions: [
            {
              id: 0,
              mentionText: "Ada Lovelace",
              mentioned: {
                user: {
                  id: "user-1",
                  displayName: "Ada Lovelace",
                  userIdentityType: "aadUser",
                },
              },
            },
          ],
        },
      },
    ]);
    expect(mentions).toEqual([mention]);
    expect(mention).toEqual({
      name: "Ada Lovelace",
      user_id: "user-1",
    });
  });

  test("posts an exact plain-text reply with raw mentions and returns the full result", async () => {
    const result = { id: "reply-1" };
    const { harness, graph } = registerTeamsHarness([result]);
    const rawMention = Object.freeze({
      id: 7,
      mentionText: "Ada Lovelace",
      mentioned: Object.freeze({
        user: Object.freeze({
          id: "user-1",
          displayName: "Ada Lovelace",
          userIdentityType: "aadUser",
        }),
      }),
    });
    const mentions = Object.freeze([rawMention]);

    const response = await harness.invokeRaw("graph_reply_to_channel_message", {
      team_id: "team-1",
      channel_id: "channel-1",
      message_id: "message-1",
      message: "<p>plain reply</p>",
      is_html: false,
      mentions,
    });

    expect(dataFrom(response)).toEqual(result);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/teams/team-1/channels/channel-1/messages/message-1/replies",
        body: {
          body: {
            contentType: "text",
            content: "<p>plain reply</p>",
          },
          mentions: [{ ...rawMention }],
        },
      },
    ]);
    expect(mentions).toEqual([rawMention]);
  });
});

describe("Teams path safety", () => {
  test.each([
    "../messages/replies",
    "team/channel",
    "domain\\identifier",
    "identifier#fragment",
    "identifier?query=value",
    ":@!$&'()*+,;= %",
  ])("keeps adversarial IDs %s inside encoded team, channel, and message segments", async (id) => {
    const { harness, graph } = registerTeamsHarness([{ value: [] }]);
    const encodedId = encodeURIComponent(id);

    await harness.invoke("graph_get_channel_message_replies", {
      team_id: id,
      channel_id: id,
      message_id: id,
    });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/teams/${encodedId}/channels/${encodedId}/messages/${encodedId}/replies`,
        params: { $top: "50" },
      },
    ]);
  });

  test.each([
    {
      name: "graph_list_channels",
      args: (id: string) => ({ team_id: id }),
      path: (id: string) => `/teams/${id}/channels`,
      response: { value: [] },
    },
    {
      name: "graph_get_channel_messages",
      args: (id: string) => ({ team_id: id, channel_id: id }),
      path: (id: string) => `/teams/${id}/channels/${id}/messages`,
      response: { value: [] },
    },
    {
      name: "graph_send_channel_message",
      args: (id: string) => ({ team_id: id, channel_id: id, message: "hello" }),
      path: (id: string) => `/teams/${id}/channels/${id}/messages`,
      response: { id: "message-1" },
    },
    {
      name: "graph_list_channel_members",
      args: (id: string) => ({ team_id: id, channel_id: id }),
      path: (id: string) => `/teams/${id}/channels/${id}/members`,
      response: { value: [] },
    },
    {
      name: "graph_get_channel_message_replies",
      args: (id: string) => ({ team_id: id, channel_id: id, message_id: id }),
      path: (id: string) => `/teams/${id}/channels/${id}/messages/${id}/replies`,
      response: { value: [] },
    },
    {
      name: "graph_reply_to_channel_message",
      args: (id: string) => ({
        team_id: id,
        channel_id: id,
        message_id: id,
        message: "reply",
      }),
      path: (id: string) => `/teams/${id}/channels/${id}/messages/${id}/replies`,
      response: { id: "reply-1" },
    },
  ])("encodes every dynamic ID in the $name route", async ({ name, args, path, response }) => {
    const hostileId = "../path\\name#fragment?query=:value%";
    const encodedId = encodeURIComponent(hostileId);
    const { harness, graph } = registerTeamsHarness([response]);

    await harness.invoke(name, args(hostileId));

    expect(graph.calls[0]?.path).toBe(path(encodedId));
  });
});

describe("Teams authenticated wrapper errors", () => {
  test.each([
    {
      name: "graph_list_teams",
      args: {},
    },
    {
      name: "graph_list_channels",
      args: { team_id: "team-1" },
    },
    {
      name: "graph_get_channel_messages",
      args: { team_id: "team-1", channel_id: "channel-1" },
    },
    {
      name: "graph_send_channel_message",
      args: {
        team_id: "team-1",
        channel_id: "channel-1",
        message: "hello",
      },
    },
    {
      name: "graph_list_channel_members",
      args: { team_id: "team-1", channel_id: "channel-1" },
    },
    {
      name: "graph_get_channel_message_replies",
      args: {
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
      },
    },
    {
      name: "graph_reply_to_channel_message",
      args: {
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
        message: "reply",
      },
    },
  ])("$name returns the stable authentication error envelope", async ({ name, args }) => {
    const { harness } = registerTeamsHarness([new AuthenticationError("Not authenticated.")]);

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });

  test.each([
    {
      name: "graph_list_teams",
      args: {},
    },
    {
      name: "graph_list_channels",
      args: { team_id: "team-1" },
    },
    {
      name: "graph_get_channel_messages",
      args: { team_id: "team-1", channel_id: "channel-1" },
    },
    {
      name: "graph_send_channel_message",
      args: {
        team_id: "team-1",
        channel_id: "channel-1",
        message: "hello",
      },
    },
    {
      name: "graph_list_channel_members",
      args: { team_id: "team-1", channel_id: "channel-1" },
    },
    {
      name: "graph_get_channel_message_replies",
      args: {
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
      },
    },
    {
      name: "graph_reply_to_channel_message",
      args: {
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
        message: "reply",
      },
    },
  ])("$name returns the stable Graph API error envelope", async ({ name, args }) => {
    const { harness } = registerTeamsHarness([new GraphApiError("403: Access denied", 403)]);

    await expect(harness.invoke(name, args)).resolves.toEqual(GRAPH_API_ERROR_RESULT);
  });
});

describe("Teams team and channel metadata operations", () => {
  test("exposes exact schemas, defaults, and required fields for the new Teams tools", () => {
    const { harness } = registerTeamsHarness();

    const membersShape = schemaFor(harness, "graph_list_team_members");
    expect(Object.keys(membersShape)).toEqual(["team_id", "top"]);
    expect(z.object(membersShape).parse({ team_id: "team-1" })).toEqual({
      team_id: "team-1",
      top: 50,
    });

    const teamShape = schemaFor(harness, "graph_get_team");
    expect(Object.keys(teamShape)).toEqual(["team_id"]);
    expect(z.object(teamShape).safeParse({}).success).toBe(false);

    const primaryShape = schemaFor(harness, "graph_get_primary_channel");
    expect(Object.keys(primaryShape)).toEqual(["team_id"]);
    expect(z.object(primaryShape).safeParse({}).success).toBe(false);

    const createShape = schemaFor(harness, "graph_create_channel");
    expect(Object.keys(createShape)).toEqual([
      "team_id",
      "display_name",
      "description",
      "membership_type",
    ]);
    const createSchema = z.object(createShape);
    expect(createSchema.parse({ team_id: "team-1", display_name: "Launch" })).toEqual({
      team_id: "team-1",
      display_name: "Launch",
      description: "",
      membership_type: "standard",
    });
    expect(
      createSchema.safeParse({
        team_id: "team-1",
        display_name: "Launch",
        membership_type: "public",
      }).success,
    ).toBe(false);
    for (const membershipType of ["standard", "private", "shared"]) {
      expect(
        createSchema.safeParse({
          team_id: "team-1",
          display_name: "Launch",
          membership_type: membershipType,
        }).success,
      ).toBe(true);
    }

    const filesShape = schemaFor(harness, "graph_get_channel_files_folder");
    expect(Object.keys(filesShape)).toEqual(["team_id", "channel_id", "include_children", "top"]);
    expect(z.object(filesShape).parse({ team_id: "team-1", channel_id: "channel-1" })).toEqual({
      team_id: "team-1",
      channel_id: "channel-1",
      include_children: false,
      top: 50,
    });

    const updateShape = schemaFor(harness, "graph_update_channel_message");
    expect(Object.keys(updateShape)).toEqual([
      "team_id",
      "channel_id",
      "message_id",
      "message",
      "is_html",
    ]);
    expect(
      z.object(updateShape).parse({
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
        message: "edited",
      }),
    ).toEqual({
      team_id: "team-1",
      channel_id: "channel-1",
      message_id: "message-1",
      message: "edited",
      is_html: true,
    });

    const deleteShape = schemaFor(harness, "graph_delete_channel_message");
    expect(Object.keys(deleteShape)).toEqual(["team_id", "channel_id", "message_id", "restore"]);
    expect(
      z.object(deleteShape).parse({
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
      }),
    ).toEqual({
      team_id: "team-1",
      channel_id: "channel-1",
      message_id: "message-1",
      restore: false,
    });
  });

  test("rejects empty and dot-segment IDs in every new Teams schema", () => {
    const { harness } = registerTeamsHarness();
    const cases = [
      { name: "graph_list_team_members", ids: ["team_id"], base: {} },
      { name: "graph_get_team", ids: ["team_id"], base: {} },
      { name: "graph_get_primary_channel", ids: ["team_id"], base: {} },
      {
        name: "graph_create_channel",
        ids: ["team_id", "display_name"],
        base: { display_name: "Launch" },
      },
      {
        name: "graph_get_channel_files_folder",
        ids: ["team_id", "channel_id"],
        base: {},
      },
      {
        name: "graph_update_channel_message",
        ids: ["team_id", "channel_id", "message_id"],
        base: { message: "edited" },
      },
      {
        name: "graph_delete_channel_message",
        ids: ["team_id", "channel_id", "message_id"],
        base: {},
      },
    ] as const;

    for (const { name, ids, base } of cases) {
      const schema = z.object(schemaFor(harness, name));
      const validIds = {
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
      };
      for (const idName of ids) {
        for (const invalidValue of ["", ".", ".."]) {
          expect(schema.safeParse({ ...base, ...validIds, [idName]: invalidValue }).success).toBe(
            false,
          );
        }
      }
    }
  });

  test("lists team members with the encoded team path and capped string top", async () => {
    const teamId = "team/../id#fragment";
    const { harness, graph } = registerTeamsHarness([
      { value: [{ id: "member-1" }] },
      { value: [{ id: "member-2" }] },
    ]);

    expect(dataFrom(await harness.invoke("graph_list_team_members", { team_id: teamId }))).toEqual([
      { id: "member-1" },
    ]);
    expect(
      dataFrom(await harness.invoke("graph_list_team_members", { team_id: teamId, top: 500 })),
    ).toEqual([{ id: "member-2" }]);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/teams/${encodeURIComponent(teamId)}/members`,
        params: { $top: "50" },
      },
      {
        method: "GET",
        path: `/teams/${encodeURIComponent(teamId)}/members`,
        params: { $top: "50" },
      },
    ]);
  });

  test("gets a team and its primary channel with the exact selects and encoded paths", async () => {
    const teamId = "../team/path?query=value";
    const team = { id: "team-1", displayName: "R&D", isArchived: false };
    const channel = { id: "channel-1", displayName: "General" };
    const { harness, graph } = registerTeamsHarness([team, channel]);

    expect(dataFrom(await harness.invoke("graph_get_team", { team_id: teamId }))).toEqual(team);
    expect(
      dataFrom(await harness.invoke("graph_get_primary_channel", { team_id: teamId })),
    ).toEqual(channel);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/teams/${encodeURIComponent(teamId)}`,
        params: { $select: "id,displayName,description,isArchived,visibility,webUrl" },
      },
      {
        method: "GET",
        path: `/teams/${encodeURIComponent(teamId)}/primaryChannel`,
        params: { $select: CHANNEL_FIELDS },
      },
    ]);
  });

  test("creates a channel with the exact body at defaults and with overrides", async () => {
    const { harness, graph } = registerTeamsHarness([{ id: "channel-1" }, { id: "channel-2" }]);

    expect(
      dataFrom(
        await harness.invoke("graph_create_channel", {
          team_id: "team-1",
          display_name: "Launch",
        }),
      ),
    ).toEqual({ id: "channel-1" });
    await harness.invoke("graph_create_channel", {
      team_id: "team-1",
      display_name: "Launch",
      description: "Launch coordination",
      membership_type: "private",
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/teams/team-1/channels",
        body: {
          displayName: "Launch",
          description: "",
          membershipType: "standard",
        },
      },
      {
        method: "POST",
        path: "/teams/team-1/channels",
        body: {
          displayName: "Launch",
          description: "Launch coordination",
          membershipType: "private",
        },
      },
    ]);
  });

  test("returns only the files folder when include_children is false", async () => {
    const folder = { id: "folder-1", name: "General", parentReference: { driveId: "drive-1" } };
    const { harness, graph } = registerTeamsHarness([folder]);

    expect(
      dataFrom(
        await harness.invoke("graph_get_channel_files_folder", {
          team_id: "team-1",
          channel_id: "channel-1",
        }),
      ),
    ).toEqual(folder);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/teams/team-1/channels/channel-1/filesFolder",
      },
    ]);
  });

  test("makes two calls and returns folder with children when include_children is true", async () => {
    const teamId = "team/../id";
    const channelId = "channel/../id";
    const folder = { id: "folder-1", name: "General" };
    const { harness, graph } = registerTeamsHarness([folder, { value: [{ id: "item-1" }] }]);

    expect(
      dataFrom(
        await harness.invoke("graph_get_channel_files_folder", {
          team_id: teamId,
          channel_id: channelId,
          include_children: true,
          top: 500,
        }),
      ),
    ).toEqual({ folder, children: [{ id: "item-1" }] });
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/filesFolder`,
      },
      {
        method: "GET",
        path: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/filesFolder/children`,
        params: { $top: "50" },
      },
    ]);
  });

  test("treats a missing children value property as an empty list", async () => {
    const { harness } = registerTeamsHarness([{ id: "folder-1" }, {}]);

    expect(
      dataFrom(
        await harness.invoke("graph_get_channel_files_folder", {
          team_id: "team-1",
          channel_id: "channel-1",
          include_children: true,
        }),
      ),
    ).toEqual({ folder: { id: "folder-1" }, children: [] });
  });

  test.each([null, [], "payload-secret", 42])(
    "rejects malformed files folder metadata %# without leakage",
    async (response) => {
      const { harness, graph } = registerTeamsHarness([response]);
      const result = await harness.invoke("graph_get_channel_files_folder", {
        team_id: "team-1",
        channel_id: "channel-1",
        include_children: true,
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(graph.calls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );

  test.each([null, [], "payload-secret", 42])(
    "rejects malformed team and channel objects %# without leakage",
    async (response) => {
      for (const name of ["graph_get_team", "graph_get_primary_channel"]) {
        const { harness } = registerTeamsHarness([response]);
        const result = await harness.invoke(name, { team_id: "team-1" });

        expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
        expect(JSON.stringify(result)).not.toContain("payload-secret");
        expect(JSON.stringify(result)).not.toContain("TypeError");
      }
    },
  );
});

describe("Teams message lifecycle operations", () => {
  test("patches an edited message body with html and text content types", async () => {
    const messageId = "message/../id#fragment";
    const { harness, graph } = registerTeamsHarness([{ id: "message-1" }, { id: "message-1" }]);

    expect(
      dataFrom(
        await harness.invoke("graph_update_channel_message", {
          team_id: "team-1",
          channel_id: "channel-1",
          message_id: messageId,
          message: "<p>edited</p>",
        }),
      ),
    ).toEqual({ status: "Message updated" });
    await harness.invoke("graph_update_channel_message", {
      team_id: "team-1",
      channel_id: "channel-1",
      message_id: messageId,
      message: "edited",
      is_html: false,
    });

    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: `/teams/team-1/channels/channel-1/messages/${encodeURIComponent(messageId)}`,
        body: { body: { contentType: "html", content: "<p>edited</p>" } },
      },
      {
        method: "PATCH",
        path: `/teams/team-1/channels/channel-1/messages/${encodeURIComponent(messageId)}`,
        body: { body: { contentType: "text", content: "edited" } },
      },
    ]);
  });

  test("posts softDelete by default and undoSoftDelete when restoring", async () => {
    const { harness, graph } = registerTeamsHarness([{}, {}]);

    expect(
      dataFrom(
        await harness.invoke("graph_delete_channel_message", {
          team_id: "team-1",
          channel_id: "channel-1",
          message_id: "message-1",
        }),
      ),
    ).toEqual({ status: "Message deleted" });
    expect(
      dataFrom(
        await harness.invoke("graph_delete_channel_message", {
          team_id: "team-1",
          channel_id: "channel-1",
          message_id: "message-1",
          restore: true,
        }),
      ),
    ).toEqual({ status: "Message restored" });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/teams/team-1/channels/channel-1/messages/message-1/softDelete",
      },
      {
        method: "POST",
        path: "/teams/team-1/channels/channel-1/messages/message-1/undoSoftDelete",
      },
    ]);
  });

  test.each([
    {
      name: "graph_list_team_members",
      args: (id: string) => ({ team_id: id }),
      path: (id: string) => `/teams/${id}/members`,
      response: { value: [] },
    },
    {
      name: "graph_get_team",
      args: (id: string) => ({ team_id: id }),
      path: (id: string) => `/teams/${id}`,
      response: { id: "team-1" },
    },
    {
      name: "graph_get_primary_channel",
      args: (id: string) => ({ team_id: id }),
      path: (id: string) => `/teams/${id}/primaryChannel`,
      response: { id: "channel-1" },
    },
    {
      name: "graph_create_channel",
      args: (id: string) => ({ team_id: id, display_name: "Launch" }),
      path: (id: string) => `/teams/${id}/channels`,
      response: { id: "channel-1" },
    },
    {
      name: "graph_get_channel_files_folder",
      args: (id: string) => ({ team_id: id, channel_id: id }),
      path: (id: string) => `/teams/${id}/channels/${id}/filesFolder`,
      response: { id: "folder-1" },
    },
    {
      name: "graph_update_channel_message",
      args: (id: string) => ({
        team_id: id,
        channel_id: id,
        message_id: id,
        message: "edited",
      }),
      path: (id: string) => `/teams/${id}/channels/${id}/messages/${id}`,
      response: {},
    },
    {
      name: "graph_delete_channel_message",
      args: (id: string) => ({ team_id: id, channel_id: id, message_id: id }),
      path: (id: string) => `/teams/${id}/channels/${id}/messages/${id}/softDelete`,
      response: {},
    },
  ])("encodes every dynamic ID in the $name route", async ({ name, args, path, response }) => {
    const hostileId = "../path\\name#fragment?query=:value%";
    const encodedId = encodeURIComponent(hostileId);
    const { harness, graph } = registerTeamsHarness([response]);

    await harness.invoke(name, args(hostileId));

    expect(graph.calls[0]?.path).toBe(path(encodedId));
  });

  test.each([
    { name: "graph_list_team_members", args: { team_id: "team-1" } },
    { name: "graph_get_team", args: { team_id: "team-1" } },
    { name: "graph_get_primary_channel", args: { team_id: "team-1" } },
    {
      name: "graph_create_channel",
      args: { team_id: "team-1", display_name: "Launch" },
    },
    {
      name: "graph_get_channel_files_folder",
      args: { team_id: "team-1", channel_id: "channel-1" },
    },
    {
      name: "graph_update_channel_message",
      args: {
        team_id: "team-1",
        channel_id: "channel-1",
        message_id: "message-1",
        message: "edited",
      },
    },
    {
      name: "graph_delete_channel_message",
      args: { team_id: "team-1", channel_id: "channel-1", message_id: "message-1" },
    },
  ])("$name returns the stable error envelopes", async ({ name, args }) => {
    const auth = registerTeamsHarness([new AuthenticationError("Not authenticated.")]);
    await expect(auth.harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);

    const graphError = registerTeamsHarness([new GraphApiError("403: Access denied", 403)]);
    await expect(graphError.harness.invoke(name, args)).resolves.toEqual(GRAPH_API_ERROR_RESULT);
  });
});
