import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError, GraphApiError } from "../../src/errors.js";
import { CHAT_FIELDS } from "../../src/select-fields.js";
import { registerChatTools } from "../../src/tools/chat-tools.js";
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

const EXPECTED_CHAT_TOOLS = [
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

function registerChatHarness(graphResponses: readonly unknown[] = []): {
  readonly harness: ToolHarness;
  readonly graph: GraphFake;
} {
  const harness = createToolHarness();
  const { dependencies, graph } = createDependencies(graphResponses);
  registerChatTools(harness.server, dependencies);
  return { harness, graph };
}

describe("chat tool registration", () => {
  test("registers exactly the five legacy chat names and first-line descriptions", () => {
    const { harness } = registerChatHarness();

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_CHAT_TOOLS);
  });

  test("exposes exact public snake_case schemas, defaults, and required fields", () => {
    const { harness } = registerChatHarness();

    const listSchema = z.object(schemaFor(harness, "graph_list_chats"));
    expect(Object.keys(schemaFor(harness, "graph_list_chats"))).toEqual(["top"]);
    expect(listSchema.parse({})).toEqual({ top: 50 });
    expect(listSchema.safeParse({ top: 1.5 }).success).toBe(false);
    expect(listSchema.safeParse({ top: -1 }).success).toBe(true);
    expect(listSchema.safeParse({ top: 500 }).success).toBe(true);

    const getMessagesShape = schemaFor(harness, "graph_get_chat_messages");
    expect(Object.keys(getMessagesShape)).toEqual(["chat_id", "top"]);
    const getMessagesSchema = z.object(getMessagesShape);
    expect(getMessagesSchema.parse({ chat_id: "chat-1" })).toEqual({
      chat_id: "chat-1",
      top: 50,
    });
    expect(getMessagesSchema.safeParse({ top: 50 }).success).toBe(false);

    const sendShape = schemaFor(harness, "graph_send_chat_message");
    expect(Object.keys(sendShape)).toEqual(["chat_id", "message", "is_html", "mentions"]);
    const sendSchema = z.object(sendShape);
    expect(sendSchema.parse({ chat_id: "chat-1", message: "hello" })).toEqual({
      chat_id: "chat-1",
      message: "hello",
      is_html: true,
      mentions: null,
    });
    expect(
      sendSchema.parse({
        chat_id: "chat-1",
        message: "hello",
        is_html: false,
        mentions: [{ name: "Ada", user_id: "user-1", custom: 42 }],
      }),
    ).toEqual({
      chat_id: "chat-1",
      message: "hello",
      is_html: false,
      mentions: [{ name: "Ada", user_id: "user-1", custom: 42 }],
    });
    expect(
      sendSchema.safeParse({
        chat_id: "chat-1",
        message: "hello",
        mentions: ["not-an-object"],
      }).success,
    ).toBe(false);
    expect(sendSchema.safeParse({ chat_id: "chat-1" }).success).toBe(false);

    const createShape = schemaFor(harness, "graph_create_chat");
    expect(Object.keys(createShape)).toEqual(["chat_type", "members", "topic"]);
    const createSchema = z.object(createShape);
    expect(createSchema.parse({ chat_type: "group", members: ["user-1"] })).toEqual({
      chat_type: "group",
      members: ["user-1"],
      topic: "",
    });
    expect(createSchema.safeParse({ chat_type: "group", members: [42] }).success).toBe(false);
    expect(createSchema.safeParse({ members: ["user-1"] }).success).toBe(false);

    const membersShape = schemaFor(harness, "graph_list_chat_members");
    expect(Object.keys(membersShape)).toEqual(["chat_id"]);
    expect(z.object(membersShape).parse({ chat_id: "chat-1" })).toEqual({
      chat_id: "chat-1",
    });
  });

  test("rejects empty and dot-segment chat IDs in every chat ID schema", () => {
    const { harness } = registerChatHarness();
    const schemas = [
      z.object(schemaFor(harness, "graph_get_chat_messages")),
      z.object(schemaFor(harness, "graph_send_chat_message")),
      z.object(schemaFor(harness, "graph_list_chat_members")),
    ];

    for (const schema of schemas) {
      for (const chat_id of ["", ".", ".."]) {
        const args =
          schema === schemas[1]
            ? { chat_id, message: "hello" }
            : {
                chat_id,
              };
        expect(schema.safeParse(args).success).toBe(false);
      }
    }
  });
});

describe("chat list operations", () => {
  test("uses exact paths, centralized select fields, string top values, and handler caps", async () => {
    const { harness, graph } = registerChatHarness([
      { value: [{ id: "chat-1" }] },
      { value: [{ id: "chat-2" }] },
      { value: [{ id: "message-1" }] },
      { value: [{ id: "message-2" }] },
      { value: [{ id: "member-1" }] },
    ]);

    expect(dataFrom(await harness.invoke("graph_list_chats"))).toEqual([{ id: "chat-1" }]);
    expect(dataFrom(await harness.invoke("graph_list_chats", { top: 500 }))).toEqual([
      { id: "chat-2" },
    ]);
    expect(
      dataFrom(await harness.invoke("graph_get_chat_messages", { chat_id: "chat-1" })),
    ).toEqual([{ id: "message-1" }]);
    expect(
      dataFrom(
        await harness.invoke("graph_get_chat_messages", {
          chat_id: "chat-1",
          top: 500,
        }),
      ),
    ).toEqual([{ id: "message-2" }]);
    expect(
      dataFrom(await harness.invoke("graph_list_chat_members", { chat_id: "chat-1" })),
    ).toEqual([{ id: "member-1" }]);

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/chats",
        params: { $select: CHAT_FIELDS, $top: "50" },
      },
      {
        method: "GET",
        path: "/me/chats",
        params: { $select: CHAT_FIELDS, $top: "50" },
      },
      {
        method: "GET",
        path: "/chats/chat-1/messages",
        params: { $top: "50" },
      },
      {
        method: "GET",
        path: "/chats/chat-1/messages",
        params: { $top: "50" },
      },
      {
        method: "GET",
        path: "/chats/chat-1/members",
      },
    ]);
  });

  test.each([
    {
      name: "graph_list_chats",
      args: {},
    },
    {
      name: "graph_get_chat_messages",
      args: { chat_id: "chat-1" },
    },
    {
      name: "graph_list_chat_members",
      args: { chat_id: "chat-1" },
    },
  ])("$name treats a missing value property as an empty list", async ({ name, args }) => {
    const { harness } = registerChatHarness([{}]);

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
      { name: "graph_list_chats", args: {} },
      { name: "graph_get_chat_messages", args: { chat_id: "chat-1" } },
      { name: "graph_list_chat_members", args: { chat_id: "chat-1" } },
    ] as const;

    for (const { name, args } of invocations) {
      const { harness } = registerChatHarness([response]);
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

describe("chat message operations", () => {
  test("sends exact HTML and mention payloads, returns the full result, and preserves inputs", async () => {
    const result = { id: "message-1", body: { content: "<p>Hello Ada</p>" } };
    const { harness, graph } = registerChatHarness([result]);
    const mention = Object.freeze({
      name: "Ada Lovelace",
      user_id: "user-1",
    });
    const mentions = Object.freeze([mention]);

    const response = await harness.invokeRaw("graph_send_chat_message", {
      chat_id: "chat-1",
      message: "<p>Hello Ada</p>",
      is_html: true,
      mentions,
    });

    expect(dataFrom(response)).toEqual(result);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/chats/chat-1/messages",
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

  test("sends exact plain text without a mentions property when mentions default to null", async () => {
    const result = { id: "message-2" };
    const { harness, graph } = registerChatHarness([result]);

    expect(
      dataFrom(
        await harness.invoke("graph_send_chat_message", {
          chat_id: "chat-1",
          message: "<p>plain text</p>",
          is_html: false,
        }),
      ),
    ).toEqual(result);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/chats/chat-1/messages",
        body: {
          body: {
            contentType: "text",
            content: "<p>plain text</p>",
          },
        },
      },
    ]);
  });
});

describe("chat creation", () => {
  test("prepends the current user to one-on-one members only when absent without mutating inputs", async () => {
    const firstResult = { id: "chat-created-1" };
    const secondResult = { id: "chat-created-2" };
    const { harness, graph } = registerChatHarness([
      { id: "me-id" },
      firstResult,
      { id: "me-id" },
      secondResult,
    ]);
    const membersWithoutSelf = Object.freeze(["other-id"]);
    const membersWithSelf = Object.freeze(["me-id", "other-id"]);

    expect(
      dataFrom(
        await harness.invokeRaw("graph_create_chat", {
          chat_type: "oneOnOne",
          members: membersWithoutSelf,
          topic: "ignored one-on-one topic",
        }),
      ),
    ).toEqual(firstResult);
    expect(
      dataFrom(
        await harness.invokeRaw("graph_create_chat", {
          chat_type: "oneOnOne",
          members: membersWithSelf,
          topic: "",
        }),
      ),
    ).toEqual(secondResult);

    const memberObject = (member: string) => ({
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${member}')`,
    });
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me",
        params: { $select: "id" },
      },
      {
        method: "POST",
        path: "/chats",
        body: {
          chatType: "oneOnOne",
          members: [memberObject("me-id"), memberObject("other-id")],
        },
      },
      {
        method: "GET",
        path: "/me",
        params: { $select: "id" },
      },
      {
        method: "POST",
        path: "/chats",
        body: {
          chatType: "oneOnOne",
          members: [memberObject("me-id"), memberObject("other-id")],
        },
      },
    ]);
    expect(membersWithoutSelf).toEqual(["other-id"]);
    expect(membersWithSelf).toEqual(["me-id", "other-id"]);
  });

  test("includes a topic only for a non-empty group topic and never fetches /me for groups", async () => {
    const { harness, graph } = registerChatHarness([
      { id: "group-with-topic" },
      { id: "group-without-topic" },
    ]);

    expect(
      dataFrom(
        await harness.invoke("graph_create_chat", {
          chat_type: "group",
          members: ["user-1"],
          topic: "Release room",
        }),
      ),
    ).toEqual({ id: "group-with-topic" });
    expect(
      dataFrom(
        await harness.invoke("graph_create_chat", {
          chat_type: "group",
          members: ["user-1"],
        }),
      ),
    ).toEqual({ id: "group-without-topic" });

    const member = {
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": "https://graph.microsoft.com/v1.0/users('user-1')",
    };
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/chats",
        body: {
          chatType: "group",
          members: [member],
          topic: "Release room",
        },
      },
      {
        method: "POST",
        path: "/chats",
        body: {
          chatType: "group",
          members: [member],
        },
      },
    ]);
  });

  test("returns the full valid created chat response unchanged", async () => {
    const createdChat = {
      id: "group-created",
      chatType: "group",
      topic: "Release room",
      createdDateTime: "2026-07-14T12:00:00Z",
    };
    const { harness } = registerChatHarness([createdChat]);

    await expect(
      harness.invoke("graph_create_chat", {
        chat_type: "group",
        members: ["user-1"],
        topic: "Release room",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ data: createdChat, message: "success" }),
        },
      ],
    });
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
      response: [{ id: "payload-secret-array-id" }],
    },
    {
      label: "missing id",
      response: { topic: "payload-secret-missing-id" },
    },
    {
      label: "null id",
      response: { id: null, secret: "payload-secret-null-id" },
    },
    {
      label: "numeric id",
      response: { id: 42, secret: "payload-secret-numeric-id" },
    },
    {
      label: "empty id",
      response: { id: "", secret: "payload-secret-empty-id" },
    },
  ])("rejects malformed created chat responses without leakage: $label", async ({ response }) => {
    const { harness, graph } = registerChatHarness([response]);

    const result = await harness.invoke("graph_create_chat", {
      chat_type: "group",
      members: ["user-1"],
    });

    expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0]?.path).toBe("/chats");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("payload-secret");
    expect(serialized).not.toContain("TypeError");
    expect(serialized).not.toContain("Cannot read");
  });

  test("preserves ordinary member bindings and contains apostrophes and URI-breaking member data", async () => {
    const { harness, graph } = registerChatHarness([{ id: "group-1" }]);
    const ordinaryGuid = "11111111-2222-3333-4444-555555555555";
    const ordinarySimpleId = "simple-user_id.42";
    const upn = "ada.lovelace@example.com";
    const hostile = "o'hara#ops/team?domain\\user@example.com";

    await harness.invoke("graph_create_chat", {
      chat_type: "group",
      members: [ordinaryGuid, ordinarySimpleId, upn, hostile],
    });

    const body = graph.calls[0]?.body as
      { readonly members?: ReadonlyArray<Record<string, unknown>> } | undefined;
    const bindings = body?.members?.map((member) => member["user@odata.bind"]);
    expect(bindings).toEqual([
      `https://graph.microsoft.com/v1.0/users('${ordinaryGuid}')`,
      `https://graph.microsoft.com/v1.0/users('${ordinarySimpleId}')`,
      "https://graph.microsoft.com/v1.0/users('ada.lovelace@example.com')",
      "https://graph.microsoft.com/v1.0/users('o''hara%23ops%2Fteam%3Fdomain%5Cuser@example.com')",
    ]);

    for (const binding of bindings ?? []) {
      expect(typeof binding).toBe("string");
      const url = new URL(String(binding));
      expect(url.origin).toBe("https://graph.microsoft.com");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(url.pathname.split("/")).toHaveLength(3);
    }
  });

  test.each([
    {
      label: "null response",
      response: null,
    },
    {
      label: "array response",
      response: [{ id: "payload-secret-array" }],
    },
    {
      label: "missing id",
      response: { displayName: "payload-secret-missing-id" },
    },
    {
      label: "null id",
      response: { id: null, secret: "payload-secret-null-id" },
    },
    {
      label: "numeric id",
      response: { id: 42, secret: "payload-secret-numeric-id" },
    },
    {
      label: "empty id",
      response: { id: "", secret: "payload-secret-empty-id" },
    },
  ])(
    "rejects malformed /me responses for one-on-one chat creation: $label",
    async ({ response }) => {
      const { harness, graph } = registerChatHarness([response]);

      const result = await harness.invoke("graph_create_chat", {
        chat_type: "oneOnOne",
        members: ["other-id"],
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(graph.calls).toEqual([
        {
          method: "GET",
          path: "/me",
          params: { $select: "id" },
        },
      ]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("payload-secret");
      expect(serialized).not.toContain("TypeError");
    },
  );
});

describe("chat path safety", () => {
  test.each([
    "../me/messages",
    "chat/child",
    "domain\\chat",
    "chat#fragment",
    "chat?query=value",
    ":@!$&'()*+,;= %",
  ])("keeps adversarial chat ID %s inside one encoded path segment", async (chatId) => {
    const { harness, graph } = registerChatHarness([{ value: [] }]);

    await harness.invoke("graph_get_chat_messages", { chat_id: chatId });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/chats/${encodeURIComponent(chatId)}/messages`,
        params: { $top: "50" },
      },
    ]);
  });

  test.each([
    {
      name: "graph_get_chat_messages",
      args: (chat_id: string) => ({ chat_id }),
      expectedSuffix: "/messages",
      response: { value: [] },
    },
    {
      name: "graph_send_chat_message",
      args: (chat_id: string) => ({
        chat_id,
        message: "hello",
      }),
      expectedSuffix: "/messages",
      response: { id: "message-1" },
    },
    {
      name: "graph_list_chat_members",
      args: (chat_id: string) => ({ chat_id }),
      expectedSuffix: "/members",
      response: { value: [] },
    },
  ])(
    "encodes chat IDs in every dynamic route for $name",
    async ({ name, args, expectedSuffix, response }) => {
      const hostileId = "../chat/path\\name#fragment?query=:value%";
      const { harness, graph } = registerChatHarness([response]);

      await harness.invoke(name, args(hostileId));

      expect(graph.calls[0]?.path).toBe(`/chats/${encodeURIComponent(hostileId)}${expectedSuffix}`);
    },
  );
});

describe("chat authenticated wrapper errors", () => {
  test.each([
    {
      name: "graph_list_chats",
      args: {},
    },
    {
      name: "graph_get_chat_messages",
      args: { chat_id: "chat-1" },
    },
    {
      name: "graph_send_chat_message",
      args: { chat_id: "chat-1", message: "hello" },
    },
    {
      name: "graph_create_chat",
      args: { chat_type: "group", members: ["user-1"] },
    },
    {
      name: "graph_list_chat_members",
      args: { chat_id: "chat-1" },
    },
  ])("$name returns the stable authentication error envelope", async ({ name, args }) => {
    const { harness } = registerChatHarness([new AuthenticationError("Not authenticated.")]);

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });

  test.each([
    {
      name: "graph_list_chats",
      args: {},
    },
    {
      name: "graph_get_chat_messages",
      args: { chat_id: "chat-1" },
    },
    {
      name: "graph_send_chat_message",
      args: { chat_id: "chat-1", message: "hello" },
    },
    {
      name: "graph_create_chat",
      args: { chat_type: "group", members: ["user-1"] },
    },
    {
      name: "graph_list_chat_members",
      args: { chat_id: "chat-1" },
    },
  ])("$name returns the stable Graph API error envelope", async ({ name, args }) => {
    const { harness } = registerChatHarness([new GraphApiError("403: Access denied", 403)]);

    await expect(harness.invoke(name, args)).resolves.toEqual(GRAPH_API_ERROR_RESULT);
  });
});
