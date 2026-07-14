import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError } from "../../src/errors.js";
import { MAIL_LIST_FIELDS } from "../../src/select-fields.js";
import { registerMailTools } from "../../src/tools/mail-tools.js";
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

const EXPECTED_MAIL_TOOLS = [
  {
    name: "graph_list_mail",
    description: `List emails from a mail folder.

Args:
    folder: Mail folder name (default "inbox"). Common: inbox, sentitems, drafts, deleteditems.
    top: Maximum number of emails to return (default 25).
    filter_query: Optional OData filter (e.g. "isRead eq false").`,
  },
  {
    name: "graph_read_mail",
    description: `Read full details of a specific email.

Args:
    message_id: The email message ID.`,
  },
  {
    name: "graph_search_mail",
    description: `Search emails by keyword.

Args:
    query: Search query string.
    top: Maximum number of results (default 25).`,
  },
  {
    name: "graph_send_mail",
    description: `Send an email.

Args:
    to: List of recipient email addresses.
    subject: Email subject.
    body: Email body content. When \`is_html\` is true, send explicit
        HTML; markdown is not converted.
    cc: Optional list of CC email addresses.
    is_html: Whether to send the email body as HTML content (default:
        True). Use false for plain text.`,
  },
  {
    name: "graph_reply_mail",
    description: `Reply to an email.

Args:
    message_id: The email message ID to reply to.
    body: The reply body content. When \`is_html\` is true, send explicit
        HTML; markdown is not converted.
    reply_all: Whether to reply to all recipients (default: reply to sender only).
    is_html: Whether to send the reply body as HTML content (default:
        True). Use false for plain text.`,
  },
  {
    name: "graph_list_mail_attachments",
    description: `List attachments on an email message.

Args:
    message_id: The email message ID.`,
  },
  {
    name: "graph_get_mail_attachment",
    description: `Get a specific email attachment including its content.

The attachment content is returned as base64-encoded data in the
'contentBytes' field. For large attachments, only metadata is practical.

Args:
    message_id: The email message ID.
    attachment_id: The attachment ID (from graph_list_mail_attachments).`,
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

const AUTHENTICATION_ERROR_RESULT = {
  content: [
    {
      type: "text",
      text: '{"error":"Not authenticated.","action_required":"Please call the graph_auth_login tool first."}',
    },
  ],
} as const;

function nextGraphResponse(responses: unknown[]): unknown {
  if (responses.length === 0) {
    throw new Error("No fake Graph response was configured.");
  }
  const response = responses.shift();
  if (response instanceof Error) {
    throw response;
  }
  return response;
}

function createGraphFake(initialResponses: readonly unknown[] = []): GraphFake {
  const responses = [...initialResponses];
  const calls: GraphCall[] = [];
  const graphClient: ToolDependencies["graphClient"] = {
    get: (path, params, headers) => {
      calls.push({
        method: "GET",
        path,
        ...(params === undefined ? {} : { params }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    post: (path, body, params, headers) => {
      calls.push({
        method: "POST",
        path,
        ...(body === undefined ? {} : { body }),
        ...(params === undefined ? {} : { params }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    patch: (path, body, headers) => {
      calls.push({
        method: "PATCH",
        path,
        ...(body === undefined ? {} : { body }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    put: (path, data, body, headers) => {
      calls.push({
        method: "PUT",
        path,
        ...(data === undefined ? {} : { body: data }),
        ...(body === undefined ? {} : { params: body }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    delete: (path, headers) => {
      calls.push({
        method: "DELETE",
        path,
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
  };

  return { graphClient, calls };
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

function dataFrom(result: CallToolResult): unknown {
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("Expected a text tool result.");
  }
  const payload: unknown = JSON.parse(content.text);
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    throw new Error("Expected a success response.");
  }
  return payload.data;
}

function registerMailHarness(graphResponses: readonly unknown[] = []): {
  readonly harness: ToolHarness;
  readonly graph: GraphFake;
} {
  const harness = createToolHarness();
  const graph = createGraphFake(graphResponses);
  const dependencies: ToolDependencies = {
    authManager: {
      getStatus: () => ({ state: "unauthenticated" }),
      login: () => Promise.resolve({ state: "authenticated" }),
      logout: () => Promise.resolve(),
      getValidAccessToken: () => Promise.resolve("access-token"),
      refreshAccessToken: () => Promise.resolve(true),
    },
    graphClient: graph.graphClient,
  };
  registerMailTools(harness.server, dependencies);
  return { harness, graph };
}

describe("mail tool registration", () => {
  test("registers exactly the seven legacy mail names and complete descriptions", () => {
    const { harness } = registerMailHarness();

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_MAIL_TOOLS);
  });

  test("exposes exact public snake_case schemas, defaults, and required fields", () => {
    const { harness } = registerMailHarness();

    const listShape = schemaFor(harness, "graph_list_mail");
    expect(Object.keys(listShape)).toEqual(["folder", "top", "filter_query"]);
    const listSchema = z.object(listShape);
    expect(listSchema.parse({})).toEqual({ folder: "inbox", top: 25, filter_query: "" });
    expect(listSchema.safeParse({ top: 1.5 }).success).toBe(false);
    expect(listSchema.safeParse({ top: -1 }).success).toBe(true);
    expect(listSchema.safeParse({ top: 500 }).success).toBe(true);

    const readShape = schemaFor(harness, "graph_read_mail");
    expect(Object.keys(readShape)).toEqual(["message_id"]);
    expect(z.object(readShape).safeParse({}).success).toBe(false);

    const searchShape = schemaFor(harness, "graph_search_mail");
    expect(Object.keys(searchShape)).toEqual(["query", "top"]);
    const searchSchema = z.object(searchShape);
    expect(searchSchema.parse({ query: "planning" })).toEqual({ query: "planning", top: 25 });
    expect(searchSchema.safeParse({}).success).toBe(false);
    expect(searchSchema.safeParse({ query: "planning", top: 2.5 }).success).toBe(false);

    const sendShape = schemaFor(harness, "graph_send_mail");
    expect(Object.keys(sendShape)).toEqual(["to", "subject", "body", "cc", "is_html"]);
    const sendSchema = z.object(sendShape);
    expect(sendSchema.parse({ to: ["ada@example.com"], subject: "Hi", body: "Hello" })).toEqual({
      to: ["ada@example.com"],
      subject: "Hi",
      body: "Hello",
      cc: null,
      is_html: true,
    });
    expect(sendSchema.safeParse({ to: [42], subject: "Hi", body: "Hello" }).success).toBe(false);
    expect(sendSchema.safeParse({ subject: "Hi", body: "Hello" }).success).toBe(false);

    const replyShape = schemaFor(harness, "graph_reply_mail");
    expect(Object.keys(replyShape)).toEqual(["message_id", "body", "reply_all", "is_html"]);
    expect(z.object(replyShape).parse({ message_id: "message-1", body: "Thanks" })).toEqual({
      message_id: "message-1",
      body: "Thanks",
      reply_all: false,
      is_html: true,
    });

    const listAttachmentsShape = schemaFor(harness, "graph_list_mail_attachments");
    expect(Object.keys(listAttachmentsShape)).toEqual(["message_id"]);
    expect(z.object(listAttachmentsShape).safeParse({}).success).toBe(false);

    const getAttachmentShape = schemaFor(harness, "graph_get_mail_attachment");
    expect(Object.keys(getAttachmentShape)).toEqual(["message_id", "attachment_id"]);
    expect(z.object(getAttachmentShape).safeParse({ message_id: "message-1" }).success).toBe(false);
  });

  test("rejects empty and dot-segment folders, message IDs, and attachment IDs", () => {
    const { harness } = registerMailHarness();
    const cases = [
      { name: "graph_list_mail", key: "folder", base: {} },
      { name: "graph_read_mail", key: "message_id", base: {} },
      { name: "graph_reply_mail", key: "message_id", base: { body: "Thanks" } },
      { name: "graph_list_mail_attachments", key: "message_id", base: {} },
      {
        name: "graph_get_mail_attachment",
        key: "message_id",
        base: { attachment_id: "attachment-1" },
      },
      {
        name: "graph_get_mail_attachment",
        key: "attachment_id",
        base: { message_id: "message-1" },
      },
    ];

    for (const row of cases) {
      const schema = z.object(schemaFor(harness, row.name));
      for (const value of ["", ".", ".."]) {
        expect(schema.safeParse({ ...row.base, [row.key]: value }).success).toBe(false);
      }
    }
  });
});

describe("mail list, read, and search operations", () => {
  test("lists the default folder with exact select, order, and top parameters", async () => {
    const { harness, graph } = registerMailHarness([{ value: [{ id: "message-1" }] }]);

    expect(dataFrom(await harness.invoke("graph_list_mail"))).toEqual([{ id: "message-1" }]);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/mailFolders/inbox/messages",
        params: {
          $select: MAIL_LIST_FIELDS,
          $top: "25",
          $orderby: "receivedDateTime desc",
        },
      },
    ]);
  });

  test("lists an encoded folder with a cap and only includes non-empty filters", async () => {
    const folder = "archive/2026#priority?owner=me";
    const { harness, graph } = registerMailHarness([{ value: [] }, { value: [] }]);

    await harness.invoke("graph_list_mail", {
      folder,
      top: 500,
      filter_query: "isRead eq false",
    });
    await harness.invoke("graph_list_mail", { folder: "sentitems", top: -2, filter_query: "" });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/mailFolders/${encodeURIComponent(folder)}/messages`,
        params: {
          $select: MAIL_LIST_FIELDS,
          $top: "50",
          $orderby: "receivedDateTime desc",
          $filter: "isRead eq false",
        },
      },
      {
        method: "GET",
        path: "/me/mailFolders/sentitems/messages",
        params: {
          $select: MAIL_LIST_FIELDS,
          $top: "-2",
          $orderby: "receivedDateTime desc",
        },
      },
    ]);
  });

  test("reads a full message from the exact path", async () => {
    const message = { id: "message-1", subject: "Planning" };
    const { harness, graph } = registerMailHarness([message]);

    expect(dataFrom(await harness.invoke("graph_read_mail", { message_id: "message-1" }))).toEqual(
      message,
    );
    expect(graph.calls).toEqual([{ method: "GET", path: "/me/messages/message-1" }]);
  });

  test("searches with the exact normal query and caps only in the handler", async () => {
    const { harness, graph } = registerMailHarness([{ value: [] }, { value: [] }]);

    await harness.invoke("graph_search_mail", { query: "quarterly report" });
    await harness.invoke("graph_search_mail", { query: "quarterly report", top: 500 });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/messages",
        params: {
          $search: '"quarterly report"',
          $select: MAIL_LIST_FIELDS,
          $top: "25",
        },
      },
      {
        method: "GET",
        path: "/me/messages",
        params: {
          $search: '"quarterly report"',
          $select: MAIL_LIST_FIELDS,
          $top: "50",
        },
      },
    ]);
  });

  test("contains embedded search quotes by doubling them inside one quoted value", async () => {
    const query = 'budget" OR from:ceo@example.com OR subject:"secret';
    const { harness, graph } = registerMailHarness([{ value: [] }]);

    await harness.invoke("graph_search_mail", { query });

    expect(graph.calls[0]?.params).toEqual({
      $search: '"budget"" OR from:ceo@example.com OR subject:""secret"',
      $select: MAIL_LIST_FIELDS,
      $top: "25",
    });
  });

  test.each([
    { name: "graph_list_mail", args: {} },
    { name: "graph_search_mail", args: { query: "planning" } },
    { name: "graph_list_mail_attachments", args: { message_id: "message-1" } },
  ])("$name treats a missing value property as an empty list", async ({ name, args }) => {
    const { harness } = registerMailHarness([{}]);
    expect(dataFrom(await harness.invoke(name, args))).toEqual([]);
  });

  test.each([null, [], "payload-secret", { value: null }, { value: {} }])(
    "rejects malformed mail collection response %# without leakage",
    async (response) => {
      const { harness } = registerMailHarness([response]);
      const result = await harness.invoke("graph_list_mail");

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );

  test.each([null, [], "payload-secret"])(
    "rejects malformed full mail response %# without leakage",
    async (response) => {
      const { harness } = registerMailHarness([response]);
      const result = await harness.invoke("graph_read_mail", { message_id: "message-1" });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("mail send and reply operations", () => {
  test("sends the exact default HTML payload without an empty CC property", async () => {
    const { harness, graph } = registerMailHarness([undefined]);

    expect(
      dataFrom(
        await harness.invoke("graph_send_mail", {
          to: ["ada@example.com"],
          subject: "Planning",
          body: "<p>Hello</p>",
        }),
      ),
    ).toEqual({ status: "Email sent" });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/sendMail",
        body: {
          message: {
            subject: "Planning",
            body: { contentType: "HTML", content: "<p>Hello</p>" },
            toRecipients: [{ emailAddress: { address: "ada@example.com" } }],
          },
          saveToSentItems: true,
        },
      },
    ]);
  });

  test("sends Text with CC recipients and does not mutate to or cc inputs", async () => {
    const to = Object.freeze(["ada@example.com", "grace@example.com"]);
    const cc = Object.freeze(["linus@example.com"]);
    const toBefore = [...to];
    const ccBefore = [...cc];
    const { harness, graph } = registerMailHarness([undefined]);

    await harness.invokeRaw("graph_send_mail", {
      to,
      subject: "Planning",
      body: "Hello",
      cc,
      is_html: false,
    });

    expect(to).toEqual(toBefore);
    expect(cc).toEqual(ccBefore);
    expect(graph.calls[0]?.body).toEqual({
      message: {
        subject: "Planning",
        body: { contentType: "Text", content: "Hello" },
        toRecipients: [
          { emailAddress: { address: "ada@example.com" } },
          { emailAddress: { address: "grace@example.com" } },
        ],
        ccRecipients: [{ emailAddress: { address: "linus@example.com" } }],
      },
      saveToSentItems: true,
    });
  });

  test.each([
    {
      reply_all: false,
      is_html: true,
      action: "createReply",
      contentType: "HTML",
      status: "Reply sent",
    },
    {
      reply_all: true,
      is_html: false,
      action: "createReplyAll",
      contentType: "Text",
      status: "Reply all sent",
    },
  ])("creates, patches, and sends a $action draft in sequence", async (row) => {
    const { harness, graph } = registerMailHarness([{ id: "draft-1" }, undefined, undefined]);

    expect(
      dataFrom(
        await harness.invoke("graph_reply_mail", {
          message_id: "message-1",
          body: "Thanks",
          reply_all: row.reply_all,
          is_html: row.is_html,
        }),
      ),
    ).toEqual({ status: row.status });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: `/me/messages/message-1/${row.action}`,
      },
      {
        method: "PATCH",
        path: "/me/messages/draft-1",
        body: { body: { contentType: row.contentType, content: "Thanks" } },
      },
      {
        method: "POST",
        path: "/me/messages/draft-1/send",
      },
    ]);
  });

  test.each([null, [], {}, { id: "" }, { id: 42 }, { id: "", secret: "payload-secret" }])(
    "rejects a malformed reply draft before patch or send: %#",
    async (response) => {
      const { harness, graph } = registerMailHarness([response]);
      const result = await harness.invoke("graph_reply_mail", {
        message_id: "message-1",
        body: "Thanks",
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(graph.calls).toEqual([{ method: "POST", path: "/me/messages/message-1/createReply" }]);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("mail attachment operations", () => {
  test("lists attachment metadata with the exact select string", async () => {
    const { harness, graph } = registerMailHarness([{ value: [{ id: "attachment-1" }] }]);

    expect(
      dataFrom(await harness.invoke("graph_list_mail_attachments", { message_id: "message-1" })),
    ).toEqual([{ id: "attachment-1" }]);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/messages/message-1/attachments",
        params: { $select: "id,name,contentType,size,isInline" },
      },
    ]);
  });

  test("gets a full attachment from the exact path", async () => {
    const attachment = { id: "attachment-1", contentBytes: "SGVsbG8=" };
    const { harness, graph } = registerMailHarness([attachment]);

    expect(
      dataFrom(
        await harness.invoke("graph_get_mail_attachment", {
          message_id: "message-1",
          attachment_id: "attachment-1",
        }),
      ),
    ).toEqual(attachment);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/messages/message-1/attachments/attachment-1",
      },
    ]);
  });

  test.each([null, [], "payload-secret"])(
    "rejects malformed full attachment response %# without leakage",
    async (response) => {
      const { harness } = registerMailHarness([response]);
      const result = await harness.invoke("graph_get_mail_attachment", {
        message_id: "message-1",
        attachment_id: "attachment-1",
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("mail path safety", () => {
  test.each([
    "../messages",
    "folder/child",
    "domain\\folder",
    "folder#fragment",
    "folder?query=value",
    ":@!$&'()*+,;= %",
  ])("keeps adversarial folder %s inside one encoded segment", async (folder) => {
    const { harness, graph } = registerMailHarness([{ value: [] }]);

    await harness.invoke("graph_list_mail", { folder });

    expect(graph.calls[0]?.path).toBe(`/me/mailFolders/${encodeURIComponent(folder)}/messages`);
  });

  test.each([
    { name: "graph_read_mail", args: {}, response: { id: "message-1" }, suffix: "" },
    {
      name: "graph_list_mail_attachments",
      args: {},
      response: { value: [] },
      suffix: "/attachments",
    },
  ])("encodes message IDs in the $name route", async ({ name, args, response, suffix }) => {
    const messageId = "../message/path\\name#fragment?query=:value%";
    const { harness, graph } = registerMailHarness([response]);

    await harness.invoke(name, { ...args, message_id: messageId });

    expect(graph.calls[0]?.path).toBe(`/me/messages/${encodeURIComponent(messageId)}${suffix}`);
  });

  test("encodes original message and returned draft IDs throughout reply routes", async () => {
    const messageId = "../message/path\\name#fragment?query=:value%";
    const draftId = "../draft/path\\name#fragment?query=:value%";
    const { harness, graph } = registerMailHarness([{ id: draftId }, undefined, undefined]);

    await harness.invoke("graph_reply_mail", { message_id: messageId, body: "Thanks" });

    expect(graph.calls.map(({ path }) => path)).toEqual([
      `/me/messages/${encodeURIComponent(messageId)}/createReply`,
      `/me/messages/${encodeURIComponent(draftId)}`,
      `/me/messages/${encodeURIComponent(draftId)}/send`,
    ]);
  });

  test("encodes both message and attachment IDs in the attachment route", async () => {
    const messageId = "../message/path\\name#fragment?query=:value%";
    const attachmentId = "../attachment/path\\name#fragment?query=:value%";
    const { harness, graph } = registerMailHarness([{ id: "attachment-1" }]);

    await harness.invoke("graph_get_mail_attachment", {
      message_id: messageId,
      attachment_id: attachmentId,
    });

    expect(graph.calls[0]?.path).toBe(
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  });
});

describe("mail authenticated wrapper errors", () => {
  test.each([
    { name: "graph_list_mail", args: {} },
    { name: "graph_read_mail", args: { message_id: "message-1" } },
    { name: "graph_search_mail", args: { query: "planning" } },
    { name: "graph_send_mail", args: { to: [], subject: "Hi", body: "Hello" } },
    { name: "graph_reply_mail", args: { message_id: "message-1", body: "Thanks" } },
    { name: "graph_list_mail_attachments", args: { message_id: "message-1" } },
    {
      name: "graph_get_mail_attachment",
      args: { message_id: "message-1", attachment_id: "attachment-1" },
    },
  ])("$name returns the stable authentication error envelope", async ({ name, args }) => {
    const { harness } = registerMailHarness([new AuthenticationError("Not authenticated.")]);

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });
});
