import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError, GraphApiError } from "../../src/errors.js";
import { CHANNEL_FIELDS, TEAM_FIELDS } from "../../src/select-fields.js";
import { registerChatTools } from "../../src/tools/chat-tools.js";
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

const EXPECTED_CHAT_AND_TEAMS_TOOLS = [
  {
    name: "graph_list_chats",
    description: "List recent Microsoft Teams chats.",
  },
  {
    name: "graph_get_chat_messages",
    description: "Get messages from a specific chat.",
  },
  {
    name: "graph_send_chat_message",
    description: "Send a message to a chat.",
  },
  {
    name: "graph_create_chat",
    description: "Create a new chat (one-on-one or group).",
  },
  {
    name: "graph_list_chat_members",
    description: "List members of a chat.",
  },
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

describe("chat and Teams tool registration", () => {
  test("registers exactly the twelve legacy names and first-line descriptions", () => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies();

    registerChatTools(harness.server, dependencies);
    registerTeamsTools(harness.server, dependencies);

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_CHAT_AND_TEAMS_TOOLS);
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
