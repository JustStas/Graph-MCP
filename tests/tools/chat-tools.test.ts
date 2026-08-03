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
    description: `List recent Microsoft Teams chats.

Args:
    top: Maximum number of chats to return (default 50, maximum 50).
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
  },
  {
    name: "graph_get_chat_messages",
    description: `Get messages from a specific chat.

Messages carry full HTML bodies plus their attachments and mentions, so
\`compact\` narrows them to the identifying fields. Without it no \`$select\` is
sent and the response is unchanged.

Args:
    chat_id: The chat ID.
    top: Maximum number of messages to return (default 50, maximum 50).
    compact: Whether to return only the identifying fields instead of the full
        record (default false). Use it to page through large collections cheaply.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
  },
  {
    name: "graph_send_chat_message",
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
  },
  {
    name: "graph_create_chat",
    description: "Create a new chat (one-on-one or group).",
  },
  {
    name: "graph_list_chat_members",
    description: `List members of a chat.

Args:
    chat_id: The chat ID.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
  },
  {
    name: "graph_get_chat",
    description: `Get a single chat, including its members.

Args:
    chat_id: The chat ID.`,
  },
  {
    name: "graph_update_chat_topic",
    description: `Rename a chat by setting its topic.

Only group chats have a topic; Graph rejects this for one-on-one chats.

Args:
    chat_id: The chat ID.
    topic: New topic for the chat.`,
  },
  {
    name: "graph_add_chat_member",
    description: `Add a user to a group chat.

Requires the delegated ChatMember.ReadWrite permission.

Args:
    chat_id: The chat ID.
    user_id: User ID or user principal name to add.
    share_history_from: ISO 8601 timestamp (e.g. "2026-07-14T12:00:00Z") to
        share chat history from. Empty shares no history.`,
  },
  {
    name: "graph_remove_chat_member",
    description: `Remove a member from a group chat.

Requires the delegated ChatMember.ReadWrite permission.

Args:
    chat_id: The chat ID.
    membership_id: The membership ID (from graph_list_chat_members).`,
  },
  {
    name: "graph_mark_chat_read",
    description: `Mark a chat as read or unread for a user.

Args:
    chat_id: The chat ID.
    user_id: The user ID to mark the chat for.
    is_read: Whether the chat is read (default true). Use false to mark it
        unread.`,
  },
  {
    name: "graph_update_chat_message",
    description: `Edit the body of a chat message.

You can only edit messages you sent.

Args:
    chat_id: The chat ID.
    message_id: The message ID to edit.
    message: New message body. When \`is_html\` is true, send explicit HTML;
        markdown is not converted.
    is_html: Whether the body is HTML content (default: True). Use false for
        plain text.`,
  },
  {
    name: "graph_delete_chat_message",
    description: `Soft delete a chat message, or restore one with \`restore\`.

Graph only exposes this action under /users/{user_id}, so the user ID is
required. There is no hard delete, so a deleted message stays recoverable.

Args:
    chat_id: The chat ID.
    message_id: The message ID to delete.
    user_id: The user ID that sent the message.
    restore: Whether to restore a previously deleted message (default false).`,
  },
  {
    name: "graph_react_to_message",
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
  test("registers exactly the thirteen chat tool names and verbatim descriptions", () => {
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
    expect(Object.keys(schemaFor(harness, "graph_list_chats"))).toEqual([
      "top",
      "next_link",
      "include_next_link",
    ]);
    expect(listSchema.parse({})).toEqual({
      top: 50,
      next_link: "",
      include_next_link: false,
    });
    expect(listSchema.safeParse({ top: 1.5 }).success).toBe(false);
    expect(listSchema.safeParse({ top: -1 }).success).toBe(true);
    expect(listSchema.safeParse({ top: 500 }).success).toBe(true);

    const getMessagesShape = schemaFor(harness, "graph_get_chat_messages");
    expect(Object.keys(getMessagesShape)).toEqual([
      "chat_id",
      "top",
      "compact",
      "next_link",
      "include_next_link",
    ]);
    const getMessagesSchema = z.object(getMessagesShape);
    expect(getMessagesSchema.parse({ chat_id: "chat-1" })).toEqual({
      chat_id: "chat-1",
      top: 50,
      compact: false,
      next_link: "",
      include_next_link: false,
    });
    expect(getMessagesSchema.safeParse({ top: 50 }).success).toBe(false);

    const sendShape = schemaFor(harness, "graph_send_chat_message");
    expect(Object.keys(sendShape)).toEqual([
      "chat_id",
      "message",
      "is_html",
      "mentions",
      "importance",
      "subject",
    ]);
    const sendSchema = z.object(sendShape);
    expect(sendSchema.parse({ chat_id: "chat-1", message: "hello" })).toEqual({
      chat_id: "chat-1",
      message: "hello",
      is_html: true,
      mentions: null,
      importance: "normal",
      subject: "",
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
      importance: "normal",
      subject: "",
    });
    expect(
      sendSchema.safeParse({ chat_id: "chat-1", message: "hello", importance: "low" }).success,
    ).toBe(false);
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
    expect(Object.keys(membersShape)).toEqual(["chat_id", "next_link", "include_next_link"]);
    expect(z.object(membersShape).parse({ chat_id: "chat-1" })).toEqual({
      chat_id: "chat-1",
      next_link: "",
      include_next_link: false,
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

describe("chat lifecycle tool schemas", () => {
  test("exposes exact snake_case schemas, defaults, and required fields for the new tools", () => {
    const { harness } = registerChatHarness();

    expect(Object.keys(schemaFor(harness, "graph_get_chat"))).toEqual(["chat_id"]);
    expect(z.object(schemaFor(harness, "graph_get_chat")).parse({ chat_id: "chat-1" })).toEqual({
      chat_id: "chat-1",
    });

    const topicShape = schemaFor(harness, "graph_update_chat_topic");
    expect(Object.keys(topicShape)).toEqual(["chat_id", "topic"]);
    expect(z.object(topicShape).safeParse({ chat_id: "chat-1" }).success).toBe(false);

    const addShape = schemaFor(harness, "graph_add_chat_member");
    expect(Object.keys(addShape)).toEqual(["chat_id", "user_id", "share_history_from"]);
    expect(z.object(addShape).parse({ chat_id: "chat-1", user_id: "user-1" })).toEqual({
      chat_id: "chat-1",
      user_id: "user-1",
      share_history_from: "",
    });

    const removeShape = schemaFor(harness, "graph_remove_chat_member");
    expect(Object.keys(removeShape)).toEqual(["chat_id", "membership_id"]);
    expect(z.object(removeShape).safeParse({ chat_id: "chat-1", membership_id: "" }).success).toBe(
      false,
    );

    const markShape = schemaFor(harness, "graph_mark_chat_read");
    expect(Object.keys(markShape)).toEqual(["chat_id", "user_id", "is_read"]);
    expect(z.object(markShape).parse({ chat_id: "chat-1", user_id: "user-1" })).toEqual({
      chat_id: "chat-1",
      user_id: "user-1",
      is_read: true,
    });

    const updateMessageShape = schemaFor(harness, "graph_update_chat_message");
    expect(Object.keys(updateMessageShape)).toEqual([
      "chat_id",
      "message_id",
      "message",
      "is_html",
    ]);
    expect(
      z
        .object(updateMessageShape)
        .parse({ chat_id: "chat-1", message_id: "message-1", message: "edited" }),
    ).toEqual({
      chat_id: "chat-1",
      message_id: "message-1",
      message: "edited",
      is_html: true,
    });

    const deleteShape = schemaFor(harness, "graph_delete_chat_message");
    expect(Object.keys(deleteShape)).toEqual(["chat_id", "message_id", "user_id", "restore"]);
    expect(
      z
        .object(deleteShape)
        .parse({ chat_id: "chat-1", message_id: "message-1", user_id: "user-1" }),
    ).toEqual({
      chat_id: "chat-1",
      message_id: "message-1",
      user_id: "user-1",
      restore: false,
    });
    expect(
      z.object(deleteShape).safeParse({ chat_id: "chat-1", message_id: "message-1" }).success,
    ).toBe(false);

    const reactShape = schemaFor(harness, "graph_react_to_message");
    expect(Object.keys(reactShape)).toEqual([
      "message_id",
      "chat_id",
      "team_id",
      "channel_id",
      "reaction",
      "remove",
    ]);
    const reactSchema = z.object(reactShape);
    expect(reactSchema.parse({ message_id: "message-1" })).toEqual({
      message_id: "message-1",
      chat_id: "",
      team_id: "",
      channel_id: "",
      reaction: "like",
      remove: false,
    });
    for (const dotSegment of [".", ".."]) {
      expect(reactSchema.safeParse({ message_id: "message-1", chat_id: dotSegment }).success).toBe(
        false,
      );
      expect(reactSchema.safeParse({ message_id: "message-1", team_id: dotSegment }).success).toBe(
        false,
      );
      expect(
        reactSchema.safeParse({ message_id: "message-1", channel_id: dotSegment }).success,
      ).toBe(false);
    }
    expect(reactSchema.safeParse({ message_id: "" }).success).toBe(false);
  });
});

describe("chat read and topic operations", () => {
  test("expands members with the centralized select fields and returns the chat unchanged", async () => {
    const chat = {
      id: "chat-1",
      chatType: "group",
      topic: "Release room",
      members: [{ id: "member-1" }],
    };
    const { harness, graph } = registerChatHarness([chat]);

    expect(dataFrom(await harness.invoke("graph_get_chat", { chat_id: "chat-1" }))).toEqual(chat);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/chats/chat-1",
        params: { $select: CHAT_FIELDS, $expand: "members" },
      },
    ]);
  });

  test.each([
    { label: "null response", response: null },
    { label: "text response", response: "payload-secret-text" },
    { label: "array response", response: [{ id: "payload-secret-array" }] },
  ])("graph_get_chat rejects malformed responses without leakage: $label", async ({ response }) => {
    const { harness } = registerChatHarness([response]);

    const result = await harness.invoke("graph_get_chat", { chat_id: "chat-1" });

    expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
    expect(JSON.stringify(result)).not.toContain("payload-secret");
  });

  test("patches only the topic and reports the applied topic", async () => {
    const { harness, graph } = registerChatHarness([{}]);

    expect(
      dataFrom(
        await harness.invoke("graph_update_chat_topic", {
          chat_id: "chat-1",
          topic: "Release room",
        }),
      ),
    ).toEqual({ status: "Chat topic updated", topic: "Release room" });
    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: "/chats/chat-1",
        body: { topic: "Release room" },
      },
    ]);
  });
});

describe("chat membership operations", () => {
  test("omits visibleHistoryStartDateTime by default and includes it when history is shared", async () => {
    const { harness, graph } = registerChatHarness([{}, {}]);

    expect(
      dataFrom(
        await harness.invoke("graph_add_chat_member", {
          chat_id: "chat-1",
          user_id: "user-1",
        }),
      ),
    ).toEqual({ status: "Chat member added", user_id: "user-1" });
    expect(
      dataFrom(
        await harness.invoke("graph_add_chat_member", {
          chat_id: "chat-1",
          user_id: "o'hara@example.com",
          share_history_from: "2026-07-14T12:00:00Z",
        }),
      ),
    ).toEqual({ status: "Chat member added", user_id: "o'hara@example.com" });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/chats/chat-1/members",
        body: {
          "@odata.type": "#microsoft.graph.aadUserConversationMember",
          roles: ["owner"],
          "user@odata.bind": "https://graph.microsoft.com/v1.0/users('user-1')",
        },
      },
      {
        method: "POST",
        path: "/chats/chat-1/members",
        body: {
          "@odata.type": "#microsoft.graph.aadUserConversationMember",
          roles: ["owner"],
          "user@odata.bind": "https://graph.microsoft.com/v1.0/users('o''hara@example.com')",
          visibleHistoryStartDateTime: "2026-07-14T12:00:00Z",
        },
      },
    ]);
  });

  test("deletes the exact membership route with both IDs encoded", async () => {
    const { harness, graph } = registerChatHarness([null]);
    const hostileChatId = "../chat/id#fragment?query=:value%";
    const hostileMembershipId = "../member/id\\name#fragment";

    expect(
      dataFrom(
        await harness.invoke("graph_remove_chat_member", {
          chat_id: hostileChatId,
          membership_id: hostileMembershipId,
        }),
      ),
    ).toEqual({ status: "Chat member removed", membership_id: hostileMembershipId });
    expect(graph.calls).toEqual([
      {
        method: "DELETE",
        path: `/chats/${encodeURIComponent(hostileChatId)}/members/${encodeURIComponent(
          hostileMembershipId,
        )}`,
      },
    ]);
  });

  test.each([
    {
      is_read: true,
      action: "markChatReadForUser",
      status: "Chat marked read",
    },
    {
      is_read: false,
      action: "markChatUnreadForUser",
      status: "Chat marked unread",
    },
  ])("marks a chat with $action when is_read is $is_read", async ({ is_read, action, status }) => {
    const { harness, graph } = registerChatHarness([{}]);
    const hostileChatId = "../chat/id?query";

    expect(
      dataFrom(
        await harness.invoke("graph_mark_chat_read", {
          chat_id: hostileChatId,
          user_id: "user-1",
          is_read,
        }),
      ),
    ).toEqual({ status });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: `/chats/${encodeURIComponent(hostileChatId)}/${action}`,
        body: { user: { id: "user-1" } },
      },
    ]);
  });
});

describe("chat message editing and deletion", () => {
  test.each([
    { is_html: true, contentType: "html" },
    { is_html: false, contentType: "text" },
  ])("patches the message body with contentType $contentType", async ({ is_html, contentType }) => {
    const { harness, graph } = registerChatHarness([{}]);
    const hostileChatId = "../chat/id#fragment";
    const hostileMessageId = "../message/id?query=:value%";

    expect(
      dataFrom(
        await harness.invoke("graph_update_chat_message", {
          chat_id: hostileChatId,
          message_id: hostileMessageId,
          message: "<p>edited</p>",
          is_html,
        }),
      ),
    ).toEqual({ status: "Message updated", message_id: hostileMessageId });
    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: `/chats/${encodeURIComponent(hostileChatId)}/messages/${encodeURIComponent(
          hostileMessageId,
        )}`,
        body: { body: { contentType, content: "<p>edited</p>" } },
      },
    ]);
  });

  test.each([
    { restore: false, action: "softDelete", status: "Message deleted" },
    { restore: true, action: "undoSoftDelete", status: "Message restored" },
  ])("posts $action under /users when restore is $restore", async ({ restore, action, status }) => {
    const { harness, graph } = registerChatHarness([{}]);
    const hostileUserId = "../user/id@example.com?query";
    const hostileChatId = "../chat/id#fragment";
    const hostileMessageId = "../message/id%";

    expect(
      dataFrom(
        await harness.invoke("graph_delete_chat_message", {
          chat_id: hostileChatId,
          message_id: hostileMessageId,
          user_id: hostileUserId,
          restore,
        }),
      ),
    ).toEqual({ status, message_id: hostileMessageId });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: `/users/${encodeURIComponent(hostileUserId)}/chats/${encodeURIComponent(
          hostileChatId,
        )}/messages/${encodeURIComponent(hostileMessageId)}/${action}`,
      },
    ]);
  });
});

describe("message reactions", () => {
  test.each([
    { remove: false, action: "setReaction", status: "Reaction set" },
    { remove: true, action: "unsetReaction", status: "Reaction removed" },
  ])("routes chat reactions to $action", async ({ remove, action, status }) => {
    const { harness, graph } = registerChatHarness([{}]);
    const hostileChatId = "../chat/id#fragment";
    const hostileMessageId = "../message/id?query";

    expect(
      dataFrom(
        await harness.invoke("graph_react_to_message", {
          message_id: hostileMessageId,
          chat_id: hostileChatId,
          reaction: "heart",
          remove,
        }),
      ),
    ).toEqual({ status, reaction: "heart" });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: `/chats/${encodeURIComponent(hostileChatId)}/messages/${encodeURIComponent(
          hostileMessageId,
        )}/${action}`,
        body: { reactionType: "heart" },
      },
    ]);
  });

  test.each([
    { remove: false, action: "setReaction", status: "Reaction set" },
    { remove: true, action: "unsetReaction", status: "Reaction removed" },
  ])(
    "routes channel reactions to $action with the default reaction",
    async ({ remove, action, status }) => {
      const { harness, graph } = registerChatHarness([{}]);
      const hostileTeamId = "../team/id#fragment";
      const hostileChannelId = "../channel/id?query";
      const hostileMessageId = "../message/id%";

      expect(
        dataFrom(
          await harness.invoke("graph_react_to_message", {
            message_id: hostileMessageId,
            team_id: hostileTeamId,
            channel_id: hostileChannelId,
            remove,
          }),
        ),
      ).toEqual({ status, reaction: "like" });
      expect(graph.calls).toEqual([
        {
          method: "POST",
          path: `/teams/${encodeURIComponent(hostileTeamId)}/channels/${encodeURIComponent(
            hostileChannelId,
          )}/messages/${encodeURIComponent(hostileMessageId)}/${action}`,
          body: { reactionType: "like" },
        },
      ]);
    },
  );

  test.each([
    { label: "no target", args: {} },
    { label: "only a team ID", args: { team_id: "team-1" } },
    { label: "only a channel ID", args: { channel_id: "channel-1" } },
  ])(
    "returns the required-target error envelope with $label and makes no Graph call",
    async ({ args }) => {
      const { harness, graph } = registerChatHarness();

      await expect(
        harness.invoke("graph_react_to_message", { message_id: "message-1", ...args }),
      ).resolves.toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: { error: "Provide either chat_id or both team_id and channel_id." },
              message: "error",
            }),
          },
        ],
      });
      expect(graph.calls).toEqual([]);
    },
  );

  test.each([
    {
      label: "a chat ID and a full channel pair",
      args: { chat_id: "chat-1", team_id: "team-1", channel_id: "channel-1" },
    },
    { label: "a chat ID and a team ID", args: { chat_id: "chat-1", team_id: "team-1" } },
    { label: "a chat ID and a channel ID", args: { chat_id: "chat-1", channel_id: "channel-1" } },
  ])(
    "returns the conflicting-target error envelope with $label and makes no Graph call",
    async ({ args }) => {
      const { harness, graph } = registerChatHarness();

      await expect(
        harness.invoke("graph_react_to_message", { message_id: "message-1", ...args }),
      ).resolves.toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: { error: "Provide either chat_id or team_id with channel_id, not both." },
              message: "error",
            }),
          },
        ],
      });
      expect(graph.calls).toEqual([]);
    },
  );
});

describe("chat message importance and subject", () => {
  test("omits importance and subject at their defaults", async () => {
    const { harness, graph } = registerChatHarness([{ id: "message-1" }]);

    await harness.invoke("graph_send_chat_message", {
      chat_id: "chat-1",
      message: "hello",
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/chats/chat-1/messages",
        body: { body: { contentType: "html", content: "hello" } },
      },
    ]);
  });

  test("sends importance and subject when supplied", async () => {
    const { harness, graph } = registerChatHarness([{ id: "message-1" }, { id: "message-2" }]);

    await harness.invoke("graph_send_chat_message", {
      chat_id: "chat-1",
      message: "hello",
      importance: "urgent",
      subject: "Incident 42",
    });
    await harness.invoke("graph_send_chat_message", {
      chat_id: "chat-1",
      message: "hello",
      is_html: false,
      mentions: [{ name: "Ada", user_id: "user-1" }],
      importance: "high",
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/chats/chat-1/messages",
        body: {
          body: { contentType: "html", content: "hello" },
          importance: "urgent",
          subject: "Incident 42",
        },
      },
      {
        method: "POST",
        path: "/chats/chat-1/messages",
        body: {
          body: { contentType: "text", content: "hello" },
          mentions: [
            {
              id: 0,
              mentionText: "Ada",
              mentioned: {
                user: { id: "user-1", displayName: "Ada", userIdentityType: "aadUser" },
              },
            },
          ],
          importance: "high",
        },
      },
    ]);
  });
});

describe("chat lifecycle authenticated wrapper errors", () => {
  const LIFECYCLE_INVOCATIONS = [
    { name: "graph_get_chat", args: { chat_id: "chat-1" } },
    { name: "graph_update_chat_topic", args: { chat_id: "chat-1", topic: "Release room" } },
    { name: "graph_add_chat_member", args: { chat_id: "chat-1", user_id: "user-1" } },
    { name: "graph_remove_chat_member", args: { chat_id: "chat-1", membership_id: "member-1" } },
    { name: "graph_mark_chat_read", args: { chat_id: "chat-1", user_id: "user-1" } },
    {
      name: "graph_update_chat_message",
      args: { chat_id: "chat-1", message_id: "message-1", message: "edited" },
    },
    {
      name: "graph_delete_chat_message",
      args: { chat_id: "chat-1", message_id: "message-1", user_id: "user-1" },
    },
    {
      name: "graph_react_to_message",
      args: { message_id: "message-1", chat_id: "chat-1" },
    },
    {
      name: "graph_react_to_message",
      args: { message_id: "message-1", team_id: "team-1", channel_id: "channel-1" },
    },
  ] as const;

  test.each(LIFECYCLE_INVOCATIONS)(
    "$name returns the stable authentication error envelope",
    async ({ name, args }) => {
      const { harness } = registerChatHarness([new AuthenticationError("Not authenticated.")]);

      await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
    },
  );

  test.each(LIFECYCLE_INVOCATIONS)(
    "$name returns the stable Graph API error envelope",
    async ({ name, args }) => {
      const { harness } = registerChatHarness([new GraphApiError("403: Access denied", 403)]);

      await expect(harness.invoke(name, args)).resolves.toEqual(GRAPH_API_ERROR_RESULT);
    },
  );
});

describe("chat list paging and compact projections", () => {
  const CHAT_NEXT_LINK =
    "https://graph.microsoft.com/v1.0/chats/chat-1/messages?$top=50&$skiptoken=integer'50'";
  const CHAT_MESSAGE_COMPACT_FIELDS = "id,createdDateTime,from,subject,importance,webUrl";

  test.each([
    { name: "graph_list_chats", args: { top: 500 } },
    {
      name: "graph_get_chat_messages",
      args: { chat_id: "chat-1", top: 500, compact: true },
    },
    { name: "graph_list_chat_members", args: { chat_id: "chat-1" } },
  ])(
    "$name fetches next_link as a bare absolute URL and ignores the other arguments",
    async ({ name, args }) => {
      const { harness, graph } = registerChatHarness([{ value: [{ id: "page-2" }] }]);

      expect(dataFrom(await harness.invoke(name, { ...args, next_link: CHAT_NEXT_LINK }))).toEqual([
        { id: "page-2" },
      ]);
      expect(graph.calls).toEqual([{ method: "GET", path: CHAT_NEXT_LINK }]);
    },
  );

  test("wraps chat messages as {items, next_link} only when include_next_link is set", async () => {
    const { harness } = registerChatHarness([
      { value: [{ id: "message-1" }], "@odata.nextLink": CHAT_NEXT_LINK },
      { value: [{ id: "message-1" }], "@odata.nextLink": CHAT_NEXT_LINK },
      { value: [{ id: "message-1" }] },
    ]);

    expect(
      dataFrom(await harness.invoke("graph_get_chat_messages", { chat_id: "chat-1" })),
    ).toEqual([{ id: "message-1" }]);
    expect(
      dataFrom(
        await harness.invoke("graph_get_chat_messages", {
          chat_id: "chat-1",
          include_next_link: true,
        }),
      ),
    ).toEqual({ items: [{ id: "message-1" }], next_link: CHAT_NEXT_LINK });
    expect(
      dataFrom(
        await harness.invoke("graph_get_chat_messages", {
          chat_id: "chat-1",
          include_next_link: true,
        }),
      ),
    ).toEqual({ items: [{ id: "message-1" }], next_link: "" });
  });

  test.each(["graph_list_chats", "graph_get_chat_messages", "graph_list_chat_members"])(
    "%s only accepts a Graph v1.0 next_link",
    (name) => {
      const { harness } = registerChatHarness();
      const schema = z.object(schemaFor(harness, name));
      const base = name === "graph_list_chats" ? {} : { chat_id: "chat-1" };

      for (const next_link of [
        "https://evil.example.com/v1.0/chats/chat-1/messages",
        "https://graph.microsoft.com/beta/chats/chat-1/messages",
        "/chats/chat-1/messages?$skiptoken=abc",
      ]) {
        expect(schema.safeParse({ ...base, next_link }).success).toBe(false);
      }
      expect(schema.safeParse({ ...base, next_link: CHAT_NEXT_LINK }).success).toBe(true);
    },
  );

  test("adds $select to chat messages only when compact is requested", async () => {
    const { harness, graph } = registerChatHarness([{ value: [] }, { value: [] }]);

    await harness.invoke("graph_get_chat_messages", { chat_id: "chat-1" });
    await harness.invoke("graph_get_chat_messages", {
      chat_id: "chat-1",
      top: 10,
      compact: true,
    });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/chats/chat-1/messages",
        params: { $top: "50" },
      },
      {
        method: "GET",
        path: "/chats/chat-1/messages",
        params: { $top: "10", $select: CHAT_MESSAGE_COMPACT_FIELDS },
      },
    ]);
  });
});
