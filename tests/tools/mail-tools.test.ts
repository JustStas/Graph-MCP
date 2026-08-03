import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError, GraphApiError } from "../../src/errors.js";
import { MAIL_FOLDER_FIELDS, MAIL_LIST_FIELDS } from "../../src/select-fields.js";
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
    folder: Mail folder name or ID (default "inbox"). Common: inbox, sentitems, drafts,
        deleteditems, archive.
    top: Maximum number of emails to return per call (default 25, maximum 50).
    skip: Number of emails to skip before returning results (default 0). Graph
        returns at most 50 per call, so page through larger folders by raising
        skip in steps of top.
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
  {
    name: "graph_move_mail",
    description: `Move messages to a mail folder. Use this to archive mail.

Processes each message in order and reports per-message outcomes, so a
partial failure still tells you what moved.

Args:
    message_ids: Message IDs to move (1-50 per call).
    destination_folder: Destination folder ID or well-known name
        (default "archive"). Common: archive, inbox, deleteditems, junkemail.`,
  },
  {
    name: "graph_delete_mail",
    description: `Delete messages. They are moved to Deleted Items, not erased.

Processes each message in order and reports per-message outcomes.

Args:
    message_ids: Message IDs to delete (1-50 per call).`,
  },
  {
    name: "graph_mark_mail_read",
    description: `Mark messages as read or unread.

Processes each message in order and reports per-message outcomes.

Args:
    message_ids: Message IDs to update (1-50 per call).
    is_read: Whether the messages are read (default true). Use false to
        mark them unread.`,
  },
  {
    name: "graph_flag_mail",
    description: `Set the follow-up flag on messages.

Processes each message in order and reports per-message outcomes.

Args:
    message_ids: Message IDs to update (1-50 per call).
    flag_status: Flag state: "notFlagged", "flagged", or "complete"
        (default "flagged").`,
  },
  {
    name: "graph_list_mail_folders",
    description: `List mail folders, including their unread and total counts.

Use the returned folder IDs with graph_list_mail or graph_move_mail.

Args:
    parent_folder_id: Parent folder ID. Empty lists top-level folders.
    top: Maximum number of folders to return (default 25).`,
  },
  {
    name: "graph_create_mail_folder",
    description: `Create a mail folder.

Args:
    display_name: Name of the new folder.
    parent_folder_id: Parent folder ID. Empty creates a top-level folder.`,
  },
  {
    name: "graph_forward_mail",
    description: `Forward an email to other recipients.

Args:
    message_id: The email message ID to forward.
    to: List of recipient email addresses.
    comment: Optional note to add above the forwarded message. When
        \`is_html\` is true, send explicit HTML; markdown is not converted.
    is_html: Whether the comment is HTML content (default: True). Use
        false for plain text.`,
  },
  {
    name: "graph_create_mail_draft",
    description: `Create a draft email without sending it.

Use graph_add_mail_attachment to attach files to the draft and
graph_send_mail_draft to send it.

Args:
    to: List of recipient email addresses.
    subject: Email subject.
    body: Email body content. When \`is_html\` is true, send explicit
        HTML; markdown is not converted.
    cc: Optional list of CC email addresses.
    is_html: Whether the body is HTML content (default: True). Use false
        for plain text.`,
  },
  {
    name: "graph_add_mail_attachment",
    description: `Attach a file to an existing draft message (max 3MB).

Args:
    message_id: The draft message ID (from graph_create_mail_draft).
    file_name: File name to show on the attachment.
    content_base64: File content encoded as base64.
    content_type: MIME type (default "application/octet-stream").`,
  },
  {
    name: "graph_send_mail_draft",
    description: `Send an existing draft message.

Args:
    message_id: The draft message ID (from graph_create_mail_draft).`,
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

const FAKE_AUTH_MANAGER: ToolDependencies["authManager"] = {
  getStatus: () => ({ state: "unauthenticated" }),
  login: () => Promise.resolve({ state: "authenticated" }),
  logout: () => Promise.resolve(),
  getValidAccessToken: () => Promise.resolve("access-token"),
  refreshAccessToken: () => Promise.resolve(true),
};

function registerMailHarness(graphResponses: readonly unknown[] = []): {
  readonly harness: ToolHarness;
  readonly graph: GraphFake;
} {
  const harness = createToolHarness();
  const graph = createGraphFake(graphResponses);
  const dependencies: ToolDependencies = {
    authManager: FAKE_AUTH_MANAGER,
    graphClient: graph.graphClient,
  };
  registerMailTools(harness.server, dependencies);
  return { harness, graph };
}

function registerMailHarnessWithClient(graphClient: ToolDependencies["graphClient"]): ToolHarness {
  const harness = createToolHarness();
  registerMailTools(harness.server, { authManager: FAKE_AUTH_MANAGER, graphClient });
  return harness;
}

function alwaysRejectingGraphClient(reason: unknown): ToolDependencies["graphClient"] {
  const reject = (): Promise<never> =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    Promise.reject(reason);
  return {
    get: reject,
    post: reject,
    patch: reject,
    put: reject,
    delete: reject,
  };
}

function messageIds(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `message-${String(index + 1)}`);
}

describe("mail tool registration", () => {
  test("registers exactly the seventeen mail names and complete descriptions", () => {
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
    expect(Object.keys(listShape)).toEqual(["folder", "top", "skip", "filter_query"]);
    const listSchema = z.object(listShape);
    expect(listSchema.parse({})).toEqual({ folder: "inbox", top: 25, skip: 0, filter_query: "" });
    expect(listSchema.safeParse({ top: 1.5 }).success).toBe(false);
    expect(listSchema.safeParse({ top: -1 }).success).toBe(true);
    expect(listSchema.safeParse({ top: 500 }).success).toBe(true);
    expect(listSchema.safeParse({ skip: 0 }).success).toBe(true);
    expect(listSchema.safeParse({ skip: 200 }).success).toBe(true);
    expect(listSchema.safeParse({ skip: -1 }).success).toBe(false);
    expect(listSchema.safeParse({ skip: 2.5 }).success).toBe(false);

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

describe("mail lifecycle batch operations", () => {
  const envelopeFrom = (result: CallToolResult): { data: unknown; message: unknown } => {
    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("Expected a text tool result.");
    }
    const payload: unknown = JSON.parse(content.text);
    if (typeof payload !== "object" || payload === null) {
      throw new Error("Expected an object payload.");
    }
    return payload as { data: unknown; message: unknown };
  };

  test("moves messages to archive by default and reports every success", async () => {
    const { harness, graph } = registerMailHarness([{}, {}]);

    const envelope = envelopeFrom(
      await harness.invoke("graph_move_mail", { message_ids: ["message-1", "message 2"] }),
    );

    expect(envelope.message).toBe("success");
    expect(envelope.data).toEqual({
      action: "moved",
      destination_folder: "archive",
      succeeded_count: 2,
      failed_count: 0,
      succeeded: ["message-1", "message 2"],
      failed: [],
    });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/messages/message-1/move",
        body: { destinationId: "archive" },
      },
      {
        method: "POST",
        path: `/me/messages/${encodeURIComponent("message 2")}/move`,
        body: { destinationId: "archive" },
      },
    ]);
  });

  test("moves to an explicit destination folder id", async () => {
    const { harness, graph } = registerMailHarness([{}]);

    await harness.invoke("graph_move_mail", {
      message_ids: ["message-1"],
      destination_folder: "AAMkAD folder/id",
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/messages/message-1/move",
        body: { destinationId: "AAMkAD folder/id" },
      },
    ]);
  });

  test("keeps a partial failure successful and names the messages that failed", async () => {
    const { harness } = registerMailHarness([{}, new GraphApiError("Move failed."), {}]);

    const envelope = envelopeFrom(
      await harness.invoke("graph_move_mail", {
        message_ids: ["message-1", "message-2", "message-3"],
      }),
    );

    expect(envelope.message).toBe("success");
    expect(envelope.data).toEqual({
      action: "moved",
      destination_folder: "archive",
      succeeded_count: 2,
      failed_count: 1,
      succeeded: ["message-1", "message-3"],
      failed: [{ message_id: "message-2", error: "Move failed." }],
    });
  });

  test("reports an error envelope when every message fails", async () => {
    const { harness } = registerMailHarness([
      new GraphApiError("Move failed."),
      new GraphApiError("Move failed again."),
    ]);

    const envelope = envelopeFrom(
      await harness.invoke("graph_move_mail", { message_ids: ["message-1", "message-2"] }),
    );

    expect(envelope.message).toBe("error");
    expect(envelope.data).toMatchObject({
      succeeded_count: 0,
      failed_count: 2,
      succeeded: [],
      failed: [
        { message_id: "message-1", error: "Move failed." },
        { message_id: "message-2", error: "Move failed again." },
      ],
    });
  });

  test("describes a non-Error rejection as an unknown error", async () => {
    const harness = registerMailHarnessWithClient(alwaysRejectingGraphClient("socket closed"));

    const envelope = envelopeFrom(
      await harness.invoke("graph_delete_mail", { message_ids: ["message-1"] }),
    );

    expect(envelope.message).toBe("error");
    expect(envelope.data).toMatchObject({
      action: "deleted",
      failed: [{ message_id: "message-1", error: "Unknown error." }],
    });
  });

  test("deletes messages through the encoded message route", async () => {
    const { harness, graph } = registerMailHarness([null]);

    const envelope = envelopeFrom(
      await harness.invoke("graph_delete_mail", { message_ids: ["message 1"] }),
    );

    expect(envelope.data).toEqual({
      action: "deleted",
      succeeded_count: 1,
      failed_count: 0,
      succeeded: ["message 1"],
      failed: [],
    });
    expect(graph.calls).toEqual([
      { method: "DELETE", path: `/me/messages/${encodeURIComponent("message 1")}` },
    ]);
  });

  test.each([
    { is_read: true, action: "marked read" },
    { is_read: false, action: "marked unread" },
  ])("marks messages with isRead $is_read", async ({ is_read, action }) => {
    const { harness, graph } = registerMailHarness([{}]);

    const envelope = envelopeFrom(
      await harness.invoke("graph_mark_mail_read", { message_ids: ["message-1"], is_read }),
    );

    expect(envelope.data).toMatchObject({ action, succeeded_count: 1 });
    expect(graph.calls).toEqual([
      { method: "PATCH", path: "/me/messages/message-1", body: { isRead: is_read } },
    ]);
  });

  test("defaults the flag status to flagged and sends the nested flag body", async () => {
    const { harness, graph } = registerMailHarness([{}, {}]);

    await harness.invoke("graph_flag_mail", { message_ids: ["message-1"] });
    await harness.invoke("graph_flag_mail", {
      message_ids: ["message-2"],
      flag_status: "complete",
    });

    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: "/me/messages/message-1",
        body: { flag: { flagStatus: "flagged" } },
      },
      {
        method: "PATCH",
        path: "/me/messages/message-2",
        body: { flag: { flagStatus: "complete" } },
      },
    ]);
  });

  test("rejects an unknown flag status and out-of-range message id batches", () => {
    const { harness } = registerMailHarness();
    const flagSchema = z.object(schemaFor(harness, "graph_flag_mail"));
    const moveSchema = z.object(schemaFor(harness, "graph_move_mail"));

    expect(
      flagSchema.safeParse({ message_ids: ["message-1"], flag_status: "urgent" }).success,
    ).toBe(false);
    expect(moveSchema.safeParse({ message_ids: [] }).success).toBe(false);
    expect(moveSchema.safeParse({ message_ids: messageIds(51) }).success).toBe(false);
    expect(moveSchema.safeParse({ message_ids: messageIds(50) }).success).toBe(true);
  });
});

describe("mail folder operations", () => {
  test("lists top-level folders with the exact folder select string", async () => {
    const { harness, graph } = registerMailHarness([{ value: [{ id: "folder-1" }] }]);

    expect(dataFrom(await harness.invoke("graph_list_mail_folders"))).toEqual([{ id: "folder-1" }]);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/mailFolders",
        params: { $select: MAIL_FOLDER_FIELDS, $top: "25" },
      },
    ]);
  });

  test("lists child folders of an encoded parent and caps top at 50", async () => {
    const parent = "AAMkAD parent/id";
    const { harness, graph } = registerMailHarness([{ value: [] }]);

    await harness.invoke("graph_list_mail_folders", { parent_folder_id: parent, top: 500 });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/mailFolders/${encodeURIComponent(parent)}/childFolders`,
        params: { $select: MAIL_FOLDER_FIELDS, $top: "50" },
      },
    ]);
  });

  test("creates top-level and nested folders and returns the created folder", async () => {
    const parent = "AAMkAD parent/id";
    const { harness, graph } = registerMailHarness([
      { id: "folder-1", displayName: "Robots" },
      { id: "folder-2" },
    ]);

    expect(
      dataFrom(await harness.invoke("graph_create_mail_folder", { display_name: "Robots" })),
    ).toEqual({ id: "folder-1", displayName: "Robots" });
    await harness.invoke("graph_create_mail_folder", {
      display_name: "Nested",
      parent_folder_id: parent,
    });

    expect(graph.calls).toEqual([
      { method: "POST", path: "/me/mailFolders", body: { displayName: "Robots" } },
      {
        method: "POST",
        path: `/me/mailFolders/${encodeURIComponent(parent)}/childFolders`,
        body: { displayName: "Nested" },
      },
    ]);
  });

  test("rejects a created folder response without an id", async () => {
    const { harness } = registerMailHarness([{ displayName: "Robots" }]);

    await expect(
      harness.invoke("graph_create_mail_folder", { display_name: "Robots" }),
    ).resolves.toEqual(INVALID_GRAPH_RESPONSE_RESULT);
  });
});

describe("mail forward, draft, and attachment composition", () => {
  test("forwards through createForward, patch, and send with encoded ids", async () => {
    const messageId = "message 1";
    const { harness, graph } = registerMailHarness([{ id: "draft 9" }, {}, {}]);

    expect(
      dataFrom(
        await harness.invoke("graph_forward_mail", {
          message_id: messageId,
          to: ["lead@bp.com"],
          comment: "<p>See below</p>",
        }),
      ),
    ).toEqual({ status: "Message forwarded" });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: `/me/messages/${encodeURIComponent(messageId)}/createForward`,
      },
      {
        method: "PATCH",
        path: `/me/messages/${encodeURIComponent("draft 9")}`,
        body: {
          toRecipients: [{ emailAddress: { address: "lead@bp.com" } }],
          body: { contentType: "HTML", content: "<p>See below</p>" },
        },
      },
      {
        method: "POST",
        path: `/me/messages/${encodeURIComponent("draft 9")}/send`,
      },
    ]);
  });

  test("omits the body when the forward comment is empty and honours plain text", async () => {
    const { harness, graph } = registerMailHarness([
      { id: "draft-1" },
      {},
      {},
      { id: "draft-2" },
      {},
      {},
    ]);

    await harness.invoke("graph_forward_mail", { message_id: "message-1", to: ["a@bp.com"] });
    await harness.invoke("graph_forward_mail", {
      message_id: "message-2",
      to: ["b@bp.com"],
      comment: "plain note",
      is_html: false,
    });

    expect(graph.calls[1]).toEqual({
      method: "PATCH",
      path: "/me/messages/draft-1",
      body: { toRecipients: [{ emailAddress: { address: "a@bp.com" } }] },
    });
    expect(graph.calls[4]).toEqual({
      method: "PATCH",
      path: "/me/messages/draft-2",
      body: {
        toRecipients: [{ emailAddress: { address: "b@bp.com" } }],
        body: { contentType: "Text", content: "plain note" },
      },
    });
  });

  test("creates a draft with HTML by default and omits an empty CC property", async () => {
    const { harness, graph } = registerMailHarness([{ id: "draft-1" }]);

    expect(
      dataFrom(
        await harness.invoke("graph_create_mail_draft", {
          to: ["lead@bp.com"],
          subject: "Cert renewal",
          body: "<p>Hello</p>",
        }),
      ),
    ).toEqual({ id: "draft-1" });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/messages",
        body: {
          subject: "Cert renewal",
          body: { contentType: "HTML", content: "<p>Hello</p>" },
          toRecipients: [{ emailAddress: { address: "lead@bp.com" } }],
        },
      },
    ]);
  });

  test("creates a plain text draft with CC recipients", async () => {
    const { harness, graph } = registerMailHarness([{ id: "draft-1" }]);

    await harness.invoke("graph_create_mail_draft", {
      to: ["lead@bp.com"],
      subject: "Cert renewal",
      body: "Hello",
      cc: ["team@bp.com"],
      is_html: false,
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/messages",
        body: {
          subject: "Cert renewal",
          body: { contentType: "Text", content: "Hello" },
          toRecipients: [{ emailAddress: { address: "lead@bp.com" } }],
          ccRecipients: [{ emailAddress: { address: "team@bp.com" } }],
        },
      },
    ]);
  });

  test("attaches a base64 file to a draft with the fileAttachment type", async () => {
    const { harness, graph } = registerMailHarness([{ id: "attachment-1" }]);

    expect(
      dataFrom(
        await harness.invoke("graph_add_mail_attachment", {
          message_id: "draft 1",
          file_name: "report.csv",
          content_base64: "aGVsbG8=",
          content_type: "text/csv",
        }),
      ),
    ).toEqual({ id: "attachment-1" });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: `/me/messages/${encodeURIComponent("draft 1")}/attachments`,
        body: {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: "report.csv",
          contentType: "text/csv",
          contentBytes: "aGVsbG8=",
        },
      },
    ]);
  });

  test.each([
    { label: "invalid base64", content: "not*base64", error: "Invalid base64 content." },
    { label: "misaligned base64", content: "aGVsbG8", error: "Invalid base64 content." },
    {
      label: "oversized content",
      content: "A".repeat(4 * Math.ceil((3 * 1024 * 1024) / 3) + 4),
      error: "Attachment too large. Maximum size is 3MB.",
    },
  ])("rejects $label without calling Graph", async ({ content, error }) => {
    const { harness, graph } = registerMailHarness();

    const envelopeText = (
      await harness.invoke("graph_add_mail_attachment", {
        message_id: "draft-1",
        file_name: "report.csv",
        content_base64: content,
      })
    ).content[0];
    if (envelopeText?.type !== "text") {
      throw new Error("Expected a text tool result.");
    }

    expect(JSON.parse(envelopeText.text)).toEqual({ data: { error }, message: "error" });
    expect(graph.calls).toEqual([]);
  });

  test("sends an existing draft through the encoded send route", async () => {
    const { harness, graph } = registerMailHarness([{}]);

    expect(
      dataFrom(await harness.invoke("graph_send_mail_draft", { message_id: "draft 1" })),
    ).toEqual({ status: "Draft sent" });
    expect(graph.calls).toEqual([
      { method: "POST", path: `/me/messages/${encodeURIComponent("draft 1")}/send` },
    ]);
  });
});

describe("mail paging", () => {
  test("adds $skip only when a positive skip is requested", async () => {
    const { harness, graph } = registerMailHarness([{ value: [] }, { value: [] }]);

    await harness.invoke("graph_list_mail", { skip: 0 });
    await harness.invoke("graph_list_mail", { top: 50, skip: 100 });

    expect(graph.calls[0]?.params).toEqual({
      $select: MAIL_LIST_FIELDS,
      $top: "25",
      $orderby: "receivedDateTime desc",
    });
    expect(graph.calls[1]?.params).toEqual({
      $select: MAIL_LIST_FIELDS,
      $top: "50",
      $orderby: "receivedDateTime desc",
      $skip: "100",
    });
  });

  test("rejects a negative skip", () => {
    const { harness } = registerMailHarness();

    expect(z.object(schemaFor(harness, "graph_list_mail")).safeParse({ skip: -1 }).success).toBe(
      false,
    );
  });
});

describe("mail lifecycle authenticated wrapper errors", () => {
  test.each([
    { name: "graph_list_mail_folders", args: {} },
    { name: "graph_create_mail_folder", args: { display_name: "Robots" } },
    { name: "graph_forward_mail", args: { message_id: "message-1", to: ["a@bp.com"] } },
    {
      name: "graph_create_mail_draft",
      args: { to: ["a@bp.com"], subject: "Hi", body: "Hello" },
    },
    {
      name: "graph_add_mail_attachment",
      args: { message_id: "draft-1", file_name: "a.txt", content_base64: "aGk=" },
    },
    { name: "graph_send_mail_draft", args: { message_id: "draft-1" } },
  ])("$name returns the stable authentication error envelope", async ({ name, args }) => {
    const { harness } = registerMailHarness([new AuthenticationError("Not authenticated.")]);

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });
});
