import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError, GraphApiError } from "../../src/errors.js";
import {
  MAIL_COMPACT_FIELDS,
  MAIL_FOLDER_FIELDS,
  MAIL_LIST_FIELDS,
} from "../../src/select-fields.js";
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

Results are sorted newest first, except that the sort is dropped automatically when
filter_query targets from/, sender/, toRecipients/ or ccRecipients/, because Graph
cannot combine a sort with a filter on those properties.

Args:
    folder: Mail folder name or ID (default "inbox"). Common: inbox, sentitems, drafts,
        deleteditems, archive.
    top: Maximum number of emails to return per call (default 25, maximum 50).
    skip: Number of items to skip before returning results (default 0). Graph
        returns at most 50 per call, so page by raising skip in steps of top.
    filter_query: Optional OData filter (e.g. "isRead eq false"). Filtering on a
        sender or recipient drops the sort order, as described above.
    compact: Whether to return only the identifying fields instead of the full
        record (default false). Use it to page through large collections cheaply.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).
    immutable_ids: Whether to ask Graph for immutable message IDs (default false).
        A message ID changes when the message is moved, so a stored ID stops
        working; an immutable ID survives the move.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_read_mail",
    description: `Read full details of a specific email.

Args:
    message_id: The email message ID.
    body_type: Body format to request: "html" or "text" (default "html").
        Use "text" to avoid pulling large HTML bodies into context.
    immutable_ids: Whether to ask Graph for immutable message IDs (default false).
        A message ID changes when the message is moved, so a stored ID stops
        working; an immutable ID survives the move.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_search_mail",
    description: `Search emails by keyword.

Args:
    query: Search query string.
    top: Maximum number of results (default 25).
    folder: Mail folder name or ID to search (default "", the whole mailbox). Scope
        the search to a folder when the mailbox holds thousands of messages.
    compact: Whether to return only the identifying fields instead of the full
        record (default false). Use it to page through large collections cheaply.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).
    immutable_ids: Whether to ask Graph for immutable message IDs (default false).
        A message ID changes when the message is moved, so a stored ID stops
        working; an immutable ID survives the move.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_send_mail",
    description: `Send an email.

A non-empty \`mailbox\` posts to /users/{mailbox}/sendMail, so the message is
sent as that shared mailbox and needs the delegated Mail.Send.Shared permission.

Args:
    to: List of recipient email addresses.
    subject: Email subject.
    body: Email body content. When \`is_html\` is true, send explicit
        HTML; markdown is not converted.
    cc: Optional list of CC email addresses.
    bcc: Optional list of BCC email addresses.
    is_html: Whether to send the email body as HTML content (default:
        True). Use false for plain text.
    importance: Message importance: "low", "normal", or "high" (default
        "normal").
    reply_to: Optional list of addresses that replies should be sent to.
    save_to_sent_items: Whether to keep a copy in Sent Items (default true).
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
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
        True). Use false for plain text.
    as_draft: Whether to leave the reply as an unsent draft (default false).
        Returns the created draft instead of a sent status.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_list_mail_attachments",
    description: `List attachments on an email message.

Args:
    message_id: The email message ID.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_get_mail_attachment",
    description: `Get a specific email attachment including its content.

The attachment content is returned as base64-encoded data in the
'contentBytes' field. For large attachments, only metadata is practical.

Args:
    message_id: The email message ID.
    attachment_id: The attachment ID (from graph_list_mail_attachments).
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_move_mail",
    description: `Move messages to a mail folder. Use this to archive mail.

Processes each message in order and reports per-message outcomes, so a
partial failure still tells you what moved.

Args:
    message_ids: Message IDs to move (1-50 per call).
    destination_folder: Destination folder ID or well-known name
        (default "archive"). Common: archive, inbox, deleteditems, junkemail.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_delete_mail",
    description: `Delete messages. They are moved to Deleted Items, not erased.

Processes each message in order and reports per-message outcomes.

Args:
    message_ids: Message IDs to delete (1-50 per call).
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_mark_mail_read",
    description: `Mark messages as read or unread.

Processes each message in order and reports per-message outcomes.

Args:
    message_ids: Message IDs to update (1-50 per call).
    is_read: Whether the messages are read (default true). Use false to
        mark them unread.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_flag_mail",
    description: `Set the follow-up flag on messages.

Processes each message in order and reports per-message outcomes.

Args:
    message_ids: Message IDs to update (1-50 per call).
    flag_status: Flag state: "notFlagged", "flagged", or "complete"
        (default "flagged").
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_list_mail_folders",
    description: `List mail folders, including their unread and total counts.

Use the returned folder IDs with graph_list_mail or graph_move_mail.

Args:
    parent_folder_id: Parent folder ID. Empty lists top-level folders.
    top: Maximum number of folders to return (default 25).
    skip: Number of items to skip before returning results (default 0). Graph
        returns at most 50 per call, so page by raising skip in steps of top.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_create_mail_folder",
    description: `Create a mail folder.

Args:
    display_name: Name of the new folder.
    parent_folder_id: Parent folder ID. Empty creates a top-level folder.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
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
        false for plain text.
    as_draft: Whether to leave the forward as an unsent draft (default false).
        Returns the created draft instead of a sent status.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
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
    bcc: Optional list of BCC email addresses.
    is_html: Whether the body is HTML content (default: True). Use false
        for plain text.
    importance: Message importance: "low", "normal", or "high" (default
        "normal").
    reply_to: Optional list of addresses that replies should be sent to.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_add_mail_attachment",
    description: `Attach a file to an existing draft message (max 3MB).

Args:
    message_id: The draft message ID (from graph_create_mail_draft).
    file_name: File name to show on the attachment.
    content_base64: File content encoded as base64.
    content_type: MIME type (default "application/octet-stream").
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_send_mail_draft",
    description: `Send an existing draft message.

Args:
    message_id: The draft message ID (from graph_create_mail_draft).
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_list_message_rules",
    description: `List the inbox rules, including their conditions, actions, and order.

Args:
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_create_message_rule",
    description: `Create an inbox rule that Exchange runs on incoming mail.

At least one condition and at least one action are required; only the parts you
supply are sent to Graph.

Args:
    display_name: Name of the rule.
    sequence: Order in which the rule runs, lowest first (default 1).
    from_addresses: Sender addresses the rule matches.
    subject_contains: Strings the subject must contain.
    body_contains: Strings the body must contain.
    move_to_folder: Destination folder ID for matching messages.
    mark_as_read: Whether matching messages are marked read (default false).
    delete_message: Whether matching messages move to Deleted Items
        (default false).
    is_enabled: Whether the rule is active (default true).
    stop_processing: Whether later rules are skipped once this rule matches
        (default false).
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_delete_message_rule",
    description: `Delete an inbox rule.

Args:
    rule_id: The rule ID (from graph_list_message_rules).
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_categorize_mail",
    description: `Set the categories on messages, replacing the categories already set.

Each category must match the display name of a master category, so create it
with graph_create_master_category first. Processes each message in order and
reports per-message outcomes.

Args:
    message_ids: Message IDs to update (1-50 per call).
    categories: Category display names to apply. An empty list clears them.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_list_master_categories",
    description: `List the master categories available for mail and events.

Args:
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_create_master_category",
    description: `Create a master category so it can be applied to mail and events.

The displayName is immutable after creation: to rename a category, delete it and
create a new one. Colors are the presets preset0 through preset24.

Args:
    display_name: Name of the new category.
    color: Color preset, preset0 through preset24 (default "preset0").
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_get_mail_tips",
    description: `Get mail tips for recipients. Use this to check whether someone is out of office.

Args:
    email_addresses: Recipient addresses to look up.
    options: Mail tips to request (default "automaticReplies",
        "mailboxFullStatus", "recipientScope"). Other values: customMailTip,
        deliveryRestriction, externalMemberCount, maxMessageSize,
        moderationStatus, totalMemberCount.
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
  },
  {
    name: "graph_get_mail_delta",
    description: `List the changes in a mail folder since a previous delta token.

Call it once without delta_link to seed a token, then pass the returned
delta_token to receive only what changed since, including read-state changes and
removals. Graph tracks one folder at a time and rejects $search on a delta
query, so page through the folder you care about.

Args:
    folder: Mail folder name or ID (default "inbox").
    delta_link: Opaque delta token from a previous call. Empty starts a new
        sync of the folder.
    top: Maximum number of messages per page (default 50).
    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`,
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
    getBytes: () => Promise.reject(new Error("These tools never read raw bytes.")),
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
    getBytes: reject,
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
  test("registers exactly the twenty-five mail names and complete descriptions", () => {
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
    expect(Object.keys(listShape)).toEqual([
      "folder",
      "top",
      "skip",
      "filter_query",
      "compact",
      "next_link",
      "include_next_link",
      "immutable_ids",
      "mailbox",
    ]);
    const listSchema = z.object(listShape);
    expect(listSchema.parse({})).toEqual({
      folder: "inbox",
      top: 25,
      skip: 0,
      filter_query: "",
      compact: false,
      next_link: "",
      include_next_link: false,
      immutable_ids: false,
      mailbox: "",
    });
    expect(listSchema.safeParse({ top: 1.5 }).success).toBe(false);
    expect(listSchema.safeParse({ top: -1 }).success).toBe(true);
    expect(listSchema.safeParse({ top: 500 }).success).toBe(true);
    expect(listSchema.safeParse({ skip: 0 }).success).toBe(true);
    expect(listSchema.safeParse({ skip: 200 }).success).toBe(true);
    expect(listSchema.safeParse({ skip: -1 }).success).toBe(false);
    expect(listSchema.safeParse({ skip: 2.5 }).success).toBe(false);

    const readShape = schemaFor(harness, "graph_read_mail");
    expect(Object.keys(readShape)).toEqual(["message_id", "body_type", "immutable_ids", "mailbox"]);
    const readSchema = z.object(readShape);
    expect(readSchema.safeParse({}).success).toBe(false);
    expect(readSchema.parse({ message_id: "message-1" })).toEqual({
      message_id: "message-1",
      body_type: "html",
      immutable_ids: false,
      mailbox: "",
    });
    expect(readSchema.safeParse({ message_id: "message-1", body_type: "text" }).success).toBe(true);
    expect(readSchema.safeParse({ message_id: "message-1", body_type: "markdown" }).success).toBe(
      false,
    );

    const searchShape = schemaFor(harness, "graph_search_mail");
    expect(Object.keys(searchShape)).toEqual([
      "query",
      "top",
      "folder",
      "compact",
      "next_link",
      "include_next_link",
      "immutable_ids",
      "mailbox",
    ]);
    const searchSchema = z.object(searchShape);
    expect(searchSchema.parse({ query: "planning" })).toEqual({
      query: "planning",
      top: 25,
      folder: "",
      compact: false,
      next_link: "",
      include_next_link: false,
      immutable_ids: false,
      mailbox: "",
    });
    for (const folder of [".", ".."]) {
      expect(searchSchema.safeParse({ query: "planning", folder }).success).toBe(false);
    }
    expect(searchSchema.safeParse({}).success).toBe(false);
    expect(searchSchema.safeParse({ query: "planning", top: 2.5 }).success).toBe(false);

    const sendShape = schemaFor(harness, "graph_send_mail");
    expect(Object.keys(sendShape)).toEqual([
      "to",
      "subject",
      "body",
      "cc",
      "bcc",
      "is_html",
      "importance",
      "reply_to",
      "save_to_sent_items",
      "mailbox",
    ]);
    const sendSchema = z.object(sendShape);
    expect(sendSchema.parse({ to: ["ada@example.com"], subject: "Hi", body: "Hello" })).toEqual({
      to: ["ada@example.com"],
      subject: "Hi",
      body: "Hello",
      cc: null,
      bcc: null,
      is_html: true,
      importance: "normal",
      reply_to: null,
      save_to_sent_items: true,
      mailbox: "",
    });
    expect(
      sendSchema.safeParse({ to: [], subject: "Hi", body: "Hello", importance: "urgent" }).success,
    ).toBe(false);
    for (const importance of ["low", "normal", "high"]) {
      expect(
        sendSchema.safeParse({ to: [], subject: "Hi", body: "Hello", importance }).success,
      ).toBe(true);
    }
    expect(sendSchema.safeParse({ to: [42], subject: "Hi", body: "Hello" }).success).toBe(false);
    expect(sendSchema.safeParse({ subject: "Hi", body: "Hello" }).success).toBe(false);

    const replyShape = schemaFor(harness, "graph_reply_mail");
    expect(Object.keys(replyShape)).toEqual([
      "message_id",
      "body",
      "reply_all",
      "is_html",
      "as_draft",
      "mailbox",
    ]);
    expect(z.object(replyShape).parse({ message_id: "message-1", body: "Thanks" })).toEqual({
      message_id: "message-1",
      body: "Thanks",
      reply_all: false,
      is_html: true,
      as_draft: false,
      mailbox: "",
    });

    const forwardShape = schemaFor(harness, "graph_forward_mail");
    expect(Object.keys(forwardShape)).toEqual([
      "message_id",
      "to",
      "comment",
      "is_html",
      "as_draft",
      "mailbox",
    ]);
    expect(z.object(forwardShape).parse({ message_id: "message-1", to: ["lead@bp.com"] })).toEqual({
      message_id: "message-1",
      to: ["lead@bp.com"],
      comment: "",
      is_html: true,
      as_draft: false,
      mailbox: "",
    });

    const draftShape = schemaFor(harness, "graph_create_mail_draft");
    expect(Object.keys(draftShape)).toEqual([
      "to",
      "subject",
      "body",
      "cc",
      "bcc",
      "is_html",
      "importance",
      "reply_to",
      "mailbox",
    ]);
    expect(
      z.object(draftShape).parse({ to: ["lead@bp.com"], subject: "Hi", body: "Hello" }),
    ).toEqual({
      to: ["lead@bp.com"],
      subject: "Hi",
      body: "Hello",
      cc: null,
      bcc: null,
      is_html: true,
      importance: "normal",
      reply_to: null,
      mailbox: "",
    });

    const rulesShape = schemaFor(harness, "graph_create_message_rule");
    expect(Object.keys(rulesShape)).toEqual([
      "display_name",
      "sequence",
      "from_addresses",
      "subject_contains",
      "body_contains",
      "move_to_folder",
      "mark_as_read",
      "delete_message",
      "is_enabled",
      "stop_processing",
      "mailbox",
    ]);
    const rulesSchema = z.object(rulesShape);
    expect(rulesSchema.parse({ display_name: "Route alerts" })).toEqual({
      display_name: "Route alerts",
      sequence: 1,
      from_addresses: [],
      subject_contains: [],
      body_contains: [],
      move_to_folder: "",
      mark_as_read: false,
      delete_message: false,
      is_enabled: true,
      stop_processing: false,
      mailbox: "",
    });
    expect(rulesSchema.safeParse({}).success).toBe(false);
    expect(rulesSchema.safeParse({ display_name: "Route", sequence: 1.5 }).success).toBe(false);

    expect(Object.keys(schemaFor(harness, "graph_list_message_rules"))).toEqual(["mailbox"]);
    expect(Object.keys(schemaFor(harness, "graph_list_master_categories"))).toEqual(["mailbox"]);
    expect(Object.keys(schemaFor(harness, "graph_delete_message_rule"))).toEqual([
      "rule_id",
      "mailbox",
    ]);

    const categorizeShape = schemaFor(harness, "graph_categorize_mail");
    expect(Object.keys(categorizeShape)).toEqual(["message_ids", "categories", "mailbox"]);
    const categorizeSchema = z.object(categorizeShape);
    expect(categorizeSchema.parse({ message_ids: ["message-1"], categories: [] })).toEqual({
      message_ids: ["message-1"],
      categories: [],
      mailbox: "",
    });
    expect(categorizeSchema.safeParse({ message_ids: ["message-1"] }).success).toBe(false);
    expect(categorizeSchema.safeParse({ message_ids: [], categories: [] }).success).toBe(false);

    const categoryShape = schemaFor(harness, "graph_create_master_category");
    expect(Object.keys(categoryShape)).toEqual(["display_name", "color", "mailbox"]);
    expect(z.object(categoryShape).parse({ display_name: "Renewals" })).toEqual({
      display_name: "Renewals",
      color: "preset0",
      mailbox: "",
    });

    const tipsShape = schemaFor(harness, "graph_get_mail_tips");
    expect(Object.keys(tipsShape)).toEqual(["email_addresses", "options", "mailbox"]);
    const tipsSchema = z.object(tipsShape);
    expect(tipsSchema.parse({ email_addresses: ["ada@example.com"] })).toEqual({
      email_addresses: ["ada@example.com"],
      options: ["automaticReplies", "mailboxFullStatus", "recipientScope"],
      mailbox: "",
    });
    expect(tipsSchema.safeParse({}).success).toBe(false);

    const deltaShape = schemaFor(harness, "graph_get_mail_delta");
    expect(Object.keys(deltaShape)).toEqual(["folder", "delta_link", "top", "mailbox"]);
    const deltaSchema = z.object(deltaShape);
    expect(deltaSchema.parse({})).toEqual({
      folder: "inbox",
      delta_link: "",
      top: 50,
      mailbox: "",
    });
    expect(deltaSchema.safeParse({ top: 2.5 }).success).toBe(false);

    const foldersShape = schemaFor(harness, "graph_list_mail_folders");
    expect(Object.keys(foldersShape)).toEqual([
      "parent_folder_id",
      "top",
      "skip",
      "next_link",
      "include_next_link",
      "mailbox",
    ]);
    const foldersSchema = z.object(foldersShape);
    expect(foldersSchema.parse({})).toEqual({
      parent_folder_id: "",
      top: 25,
      skip: 0,
      next_link: "",
      include_next_link: false,
      mailbox: "",
    });
    expect(foldersSchema.safeParse({ skip: -1 }).success).toBe(false);

    const listAttachmentsShape = schemaFor(harness, "graph_list_mail_attachments");
    expect(Object.keys(listAttachmentsShape)).toEqual(["message_id", "mailbox"]);
    expect(z.object(listAttachmentsShape).safeParse({}).success).toBe(false);

    const getAttachmentShape = schemaFor(harness, "graph_get_mail_attachment");
    expect(Object.keys(getAttachmentShape)).toEqual(["message_id", "attachment_id", "mailbox"]);
    expect(z.object(getAttachmentShape).safeParse({ message_id: "message-1" }).success).toBe(false);

    for (const { name } of EXPECTED_MAIL_TOOLS) {
      expect(Object.keys(schemaFor(harness, name)).at(-1)).toBe("mailbox");
    }
  });

  test("rejects empty and dot-segment folders, message IDs, attachment IDs, and mailboxes", () => {
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
      { name: "graph_delete_message_rule", key: "rule_id", base: {} },
      { name: "graph_create_message_rule", key: "display_name", base: {} },
      { name: "graph_create_master_category", key: "display_name", base: {} },
      { name: "graph_get_mail_delta", key: "folder", base: {} },
    ];

    for (const row of cases) {
      const schema = z.object(schemaFor(harness, row.name));
      for (const value of ["", ".", ".."]) {
        expect(schema.safeParse({ ...row.base, [row.key]: value }).success).toBe(false);
      }
    }

    for (const { name } of EXPECTED_MAIL_TOOLS) {
      const mailboxField = schemaFor(harness, name).mailbox;
      if (mailboxField === undefined) {
        throw new Error(`Tool ${name} did not expose a mailbox argument.`);
      }
      const mailboxSchema = z.object({ mailbox: mailboxField });
      expect(mailboxSchema.safeParse({ mailbox: "" }).success).toBe(true);
      expect(mailboxSchema.safeParse({ mailbox: "shared box@bp.com" }).success).toBe(true);
      expect(mailboxSchema.safeParse({ mailbox: "." }).success).toBe(false);
      expect(mailboxSchema.safeParse({ mailbox: ".." }).success).toBe(false);
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
      bcc: null,
      is_html: false,
      importance: "normal",
      reply_to: null,
      save_to_sent_items: true,
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

  test("adds $skip to a folder listing only when a positive skip is requested", async () => {
    const { harness, graph } = registerMailHarness([{ value: [] }, { value: [] }]);

    await harness.invoke("graph_list_mail_folders", { skip: 0 });
    await harness.invoke("graph_list_mail_folders", { top: 50, skip: 25 });

    expect(graph.calls[0]?.params).toEqual({ $select: MAIL_FOLDER_FIELDS, $top: "25" });
    expect(graph.calls[1]?.params).toEqual({
      $select: MAIL_FOLDER_FIELDS,
      $top: "50",
      $skip: "25",
    });
  });

  test("rejects a negative skip", () => {
    const { harness } = registerMailHarness();

    expect(z.object(schemaFor(harness, "graph_list_mail")).safeParse({ skip: -1 }).success).toBe(
      false,
    );
    expect(
      z.object(schemaFor(harness, "graph_list_mail_folders")).safeParse({ skip: -1 }).success,
    ).toBe(false);
  });
});

const NEXT_PAGE_LINK =
  "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$select=id&$skiptoken=page-2";

describe("mail sort compatibility", () => {
  test.each([
    { label: "from", filter: "from/emailAddress/address eq 'alerts@bp.com'" },
    { label: "sender", filter: "sender/emailAddress/address eq 'alerts@bp.com'" },
    {
      label: "toRecipients",
      filter: "toRecipients/any(r: r/emailAddress/address eq 'me@bp.com')",
    },
    {
      label: "ccRecipients",
      filter: "ccRecipients/any(r: r/emailAddress/address eq 'me@bp.com')",
    },
    { label: "differently cased From", filter: "From/emailAddress/address eq 'alerts@bp.com'" },
  ])("omits $orderby for a $label filter that Graph cannot sort", async ({ filter }) => {
    const { harness, graph } = registerMailHarness([{ value: [] }]);

    await harness.invoke("graph_list_mail", { filter_query: filter });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/mailFolders/inbox/messages",
        params: { $select: MAIL_LIST_FIELDS, $top: "25", $filter: filter },
      },
    ]);
  });

  test.each([
    { label: "no filter", filter: "" },
    { label: "a read-state filter", filter: "isRead eq false" },
    { label: "a date filter", filter: "receivedDateTime ge 2026-07-01T00:00:00Z" },
    { label: "a subject filter", filter: "contains(subject, 'renewal')" },
  ])("keeps $orderby with $label", async ({ filter }) => {
    const { harness, graph } = registerMailHarness([{ value: [] }]);

    await harness.invoke("graph_list_mail", { filter_query: filter });

    expect(graph.calls[0]?.params).toEqual({
      $select: MAIL_LIST_FIELDS,
      $top: "25",
      $orderby: "receivedDateTime desc",
      ...(filter === "" ? {} : { $filter: filter }),
    });
  });
});

describe("mail compact projections", () => {
  test.each([
    { name: "graph_list_mail", args: {} },
    { name: "graph_search_mail", args: { query: "planning" } },
  ])("$name selects the compact fields only when compact is set", async ({ name, args }) => {
    const { harness, graph } = registerMailHarness([{ value: [] }, { value: [] }]);

    await harness.invoke(name, args);
    await harness.invoke(name, { ...args, compact: true });

    expect((graph.calls[0]?.params as Record<string, string>).$select).toBe(MAIL_LIST_FIELDS);
    expect((graph.calls[1]?.params as Record<string, string>).$select).toBe(MAIL_COMPACT_FIELDS);
    expect(MAIL_COMPACT_FIELDS).not.toBe(MAIL_LIST_FIELDS);
  });
});

describe("folder-scoped mail search", () => {
  test("searches the whole mailbox by default and an encoded folder when scoped", async () => {
    const folder = "archive/2026#priority?owner=me";
    const { harness, graph } = registerMailHarness([{ value: [] }, { value: [] }]);

    await harness.invoke("graph_search_mail", { query: "renewal" });
    await harness.invoke("graph_search_mail", { query: "renewal", folder });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/messages",
        params: { $search: '"renewal"', $select: MAIL_LIST_FIELDS, $top: "25" },
      },
      {
        method: "GET",
        path: `/me/mailFolders/${encodeURIComponent(folder)}/messages`,
        params: { $search: '"renewal"', $select: MAIL_LIST_FIELDS, $top: "25" },
      },
    ]);
  });

  test("scopes a folder search inside a shared mailbox", async () => {
    const { harness, graph } = registerMailHarness([{ value: [] }]);

    await harness.invoke("graph_search_mail", {
      query: "renewal",
      folder: "archive",
      mailbox: SHARED_MAILBOX,
    });

    expect(graph.calls[0]?.path).toBe(`${SHARED_ROOT}/mailFolders/archive/messages`);
  });

  test("never sends $skip alongside $search", async () => {
    const { harness, graph } = registerMailHarness([{ value: [] }]);

    await harness.invoke("graph_search_mail", { query: "renewal" });

    expect(schemaFor(harness, "graph_search_mail").skip).toBeUndefined();
    expect(graph.calls[0]?.params).not.toHaveProperty("$skip");
  });
});

describe("mail nextLink paging", () => {
  test.each([
    {
      name: "graph_list_mail",
      args: {
        folder: "sentitems",
        top: 50,
        skip: 100,
        filter_query: "isRead eq false",
        compact: true,
      },
    },
    {
      name: "graph_search_mail",
      args: { query: "planning", top: 50, folder: "archive", compact: true },
    },
    {
      name: "graph_list_mail_folders",
      args: { parent_folder_id: "folder-1", top: 50, skip: 25 },
    },
  ])(
    "$name fetches next_link as a bare absolute URL and ignores the other arguments",
    async ({ name, args }) => {
      const { harness, graph } = registerMailHarness([{ value: [{ id: "item-2" }] }]);

      expect(dataFrom(await harness.invoke(name, { ...args, next_link: NEXT_PAGE_LINK }))).toEqual([
        { id: "item-2" },
      ]);
      expect(graph.calls).toEqual([{ method: "GET", path: NEXT_PAGE_LINK }]);
    },
  );

  test("keeps the immutable id header while following a next_link", async () => {
    const { harness, graph } = registerMailHarness([{ value: [] }]);

    await harness.invoke("graph_list_mail", { next_link: NEXT_PAGE_LINK, immutable_ids: true });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: NEXT_PAGE_LINK,
        headers: { Prefer: 'IdType="ImmutableId"' },
      },
    ]);
  });

  test.each([
    { label: "a message list", name: "graph_list_mail", args: {} },
    { label: "a search", name: "graph_search_mail", args: { query: "planning" } },
    { label: "a folder list", name: "graph_list_mail_folders", args: {} },
  ])(
    "$label wraps the page as {items, next_link} only when include_next_link is set",
    async ({ name, args }) => {
      const { harness } = registerMailHarness([
        { value: [{ id: "item-1" }], "@odata.nextLink": NEXT_PAGE_LINK },
        { value: [{ id: "item-1" }], "@odata.nextLink": NEXT_PAGE_LINK },
        { value: [{ id: "item-1" }] },
        { value: [{ id: "item-1" }], "@odata.nextLink": "https://example.com/v1.0/next" },
      ]);

      expect(dataFrom(await harness.invoke(name, args))).toEqual([{ id: "item-1" }]);
      expect(dataFrom(await harness.invoke(name, { ...args, include_next_link: true }))).toEqual({
        items: [{ id: "item-1" }],
        next_link: NEXT_PAGE_LINK,
      });
      expect(dataFrom(await harness.invoke(name, { ...args, include_next_link: true }))).toEqual({
        items: [{ id: "item-1" }],
        next_link: "",
      });
      expect(dataFrom(await harness.invoke(name, { ...args, include_next_link: true }))).toEqual({
        items: [{ id: "item-1" }],
        next_link: "",
      });
    },
  );

  test.each(["graph_list_mail", "graph_search_mail", "graph_list_mail_folders"])(
    "%s rejects a next_link that is not a Graph v1.0 URL",
    (name) => {
      const { harness } = registerMailHarness();
      const nextLinkField = schemaFor(harness, name).next_link;
      if (nextLinkField === undefined) {
        throw new Error(`Tool ${name} did not expose a next_link argument.`);
      }
      const schema = z.object({ next_link: nextLinkField });

      expect(schema.parse({})).toEqual({ next_link: "" });
      expect(schema.safeParse({ next_link: NEXT_PAGE_LINK }).success).toBe(true);
      for (const value of [
        "https://graph.microsoft.com/beta/me/messages",
        "https://evil.example.com/v1.0/me/messages",
        "https://graph.microsoft.com.evil.example/v1.0/me/messages",
        "http://graph.microsoft.com/v1.0/me/messages",
        "/me/mailFolders/inbox/messages?$skiptoken=page-2",
      ]) {
        expect(schema.safeParse({ next_link: value }).success).toBe(false);
      }
    },
  );

  test.each([
    { name: "graph_list_mail", args: {} },
    { name: "graph_search_mail", args: { query: "planning" } },
    { name: "graph_list_mail_folders", args: {} },
  ])("$name rejects a malformed page while paging", async ({ name, args }) => {
    const { harness } = registerMailHarness([{ value: [], "@odata.nextLink": 42 }]);

    await expect(harness.invoke(name, { ...args, include_next_link: true })).resolves.toEqual(
      INVALID_GRAPH_RESPONSE_RESULT,
    );
  });
});

describe("mail Prefer headers", () => {
  test.each([
    { name: "graph_list_mail", args: {}, response: { value: [] } },
    { name: "graph_search_mail", args: { query: "planning" }, response: { value: [] } },
  ])("$name asks for immutable ids only when requested", async ({ name, args, response }) => {
    const { harness, graph } = registerMailHarness([response, response]);

    await harness.invoke(name, args);
    await harness.invoke(name, { ...args, immutable_ids: true });

    expect(graph.calls[0]).not.toHaveProperty("headers");
    expect(graph.calls[1]?.headers).toEqual({ Prefer: 'IdType="ImmutableId"' });
  });

  test.each([
    { label: "neither preference", args: {}, headers: undefined },
    {
      label: "only a text body",
      args: { body_type: "text" },
      headers: { Prefer: 'outlook.body-content-type="text"' },
    },
    {
      label: "only immutable ids",
      args: { immutable_ids: true },
      headers: { Prefer: 'IdType="ImmutableId"' },
    },
    {
      label: "both preferences merged into one Prefer header",
      args: { body_type: "text", immutable_ids: true },
      headers: { Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"' },
    },
  ])("graph_read_mail sends $label", async ({ args, headers }) => {
    const { harness, graph } = registerMailHarness([{ id: "message-1" }]);

    await harness.invoke("graph_read_mail", { message_id: "message-1", ...args });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/messages/message-1",
        ...(headers === undefined ? {} : { headers }),
      },
    ]);
  });

  test("keeps the default html body without a Prefer header", async () => {
    const { harness, graph } = registerMailHarness([{ id: "message-1" }]);

    await harness.invoke("graph_read_mail", { message_id: "message-1", body_type: "html" });

    expect(graph.calls).toEqual([{ method: "GET", path: "/me/messages/message-1" }]);
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

const SHARED_MAILBOX = "shared box@bp.com";
const SHARED_ROOT = `/users/${encodeURIComponent(SHARED_MAILBOX)}`;

interface MailboxRoutingCase {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly responses: readonly unknown[];
  readonly ownPaths: readonly string[];
  readonly sharedPaths: readonly string[];
}

const MAILBOX_ROUTING_CASES: readonly MailboxRoutingCase[] = [
  {
    name: "graph_list_mail",
    args: {},
    responses: [{ value: [] }],
    ownPaths: ["/me/mailFolders/inbox/messages"],
    sharedPaths: [`${SHARED_ROOT}/mailFolders/inbox/messages`],
  },
  {
    name: "graph_read_mail",
    args: { message_id: "message-1" },
    responses: [{ id: "message-1" }],
    ownPaths: ["/me/messages/message-1"],
    sharedPaths: [`${SHARED_ROOT}/messages/message-1`],
  },
  {
    name: "graph_search_mail",
    args: { query: "planning" },
    responses: [{ value: [] }],
    ownPaths: ["/me/messages"],
    sharedPaths: [`${SHARED_ROOT}/messages`],
  },
  {
    name: "graph_send_mail",
    args: { to: ["ada@example.com"], subject: "Hi", body: "Hello" },
    responses: [undefined],
    ownPaths: ["/me/sendMail"],
    sharedPaths: [`${SHARED_ROOT}/sendMail`],
  },
  {
    name: "graph_reply_mail",
    args: { message_id: "message-1", body: "Thanks" },
    responses: [{ id: "draft-1" }, undefined, undefined],
    ownPaths: [
      "/me/messages/message-1/createReply",
      "/me/messages/draft-1",
      "/me/messages/draft-1/send",
    ],
    sharedPaths: [
      `${SHARED_ROOT}/messages/message-1/createReply`,
      `${SHARED_ROOT}/messages/draft-1`,
      `${SHARED_ROOT}/messages/draft-1/send`,
    ],
  },
  {
    name: "graph_list_mail_attachments",
    args: { message_id: "message-1" },
    responses: [{ value: [] }],
    ownPaths: ["/me/messages/message-1/attachments"],
    sharedPaths: [`${SHARED_ROOT}/messages/message-1/attachments`],
  },
  {
    name: "graph_get_mail_attachment",
    args: { message_id: "message-1", attachment_id: "attachment-1" },
    responses: [{ id: "attachment-1" }],
    ownPaths: ["/me/messages/message-1/attachments/attachment-1"],
    sharedPaths: [`${SHARED_ROOT}/messages/message-1/attachments/attachment-1`],
  },
  {
    name: "graph_move_mail",
    args: { message_ids: ["message-1"] },
    responses: [{}],
    ownPaths: ["/me/messages/message-1/move"],
    sharedPaths: [`${SHARED_ROOT}/messages/message-1/move`],
  },
  {
    name: "graph_delete_mail",
    args: { message_ids: ["message-1"] },
    responses: [null],
    ownPaths: ["/me/messages/message-1"],
    sharedPaths: [`${SHARED_ROOT}/messages/message-1`],
  },
  {
    name: "graph_mark_mail_read",
    args: { message_ids: ["message-1"] },
    responses: [{}],
    ownPaths: ["/me/messages/message-1"],
    sharedPaths: [`${SHARED_ROOT}/messages/message-1`],
  },
  {
    name: "graph_flag_mail",
    args: { message_ids: ["message-1"] },
    responses: [{}],
    ownPaths: ["/me/messages/message-1"],
    sharedPaths: [`${SHARED_ROOT}/messages/message-1`],
  },
  {
    name: "graph_list_mail_folders",
    args: {},
    responses: [{ value: [] }],
    ownPaths: ["/me/mailFolders"],
    sharedPaths: [`${SHARED_ROOT}/mailFolders`],
  },
  {
    name: "graph_create_mail_folder",
    args: { display_name: "Robots" },
    responses: [{ id: "folder-1" }],
    ownPaths: ["/me/mailFolders"],
    sharedPaths: [`${SHARED_ROOT}/mailFolders`],
  },
  {
    name: "graph_forward_mail",
    args: { message_id: "message-1", to: ["lead@bp.com"] },
    responses: [{ id: "draft-1" }, {}, {}],
    ownPaths: [
      "/me/messages/message-1/createForward",
      "/me/messages/draft-1",
      "/me/messages/draft-1/send",
    ],
    sharedPaths: [
      `${SHARED_ROOT}/messages/message-1/createForward`,
      `${SHARED_ROOT}/messages/draft-1`,
      `${SHARED_ROOT}/messages/draft-1/send`,
    ],
  },
  {
    name: "graph_create_mail_draft",
    args: { to: ["lead@bp.com"], subject: "Hi", body: "Hello" },
    responses: [{ id: "draft-1" }],
    ownPaths: ["/me/messages"],
    sharedPaths: [`${SHARED_ROOT}/messages`],
  },
  {
    name: "graph_add_mail_attachment",
    args: { message_id: "draft-1", file_name: "report.csv", content_base64: "aGk=" },
    responses: [{ id: "attachment-1" }],
    ownPaths: ["/me/messages/draft-1/attachments"],
    sharedPaths: [`${SHARED_ROOT}/messages/draft-1/attachments`],
  },
  {
    name: "graph_send_mail_draft",
    args: { message_id: "draft-1" },
    responses: [{}],
    ownPaths: ["/me/messages/draft-1/send"],
    sharedPaths: [`${SHARED_ROOT}/messages/draft-1/send`],
  },
  {
    name: "graph_list_message_rules",
    args: {},
    responses: [{ value: [] }],
    ownPaths: ["/me/mailFolders/inbox/messageRules"],
    sharedPaths: [`${SHARED_ROOT}/mailFolders/inbox/messageRules`],
  },
  {
    name: "graph_create_message_rule",
    args: { display_name: "Route alerts", from_addresses: ["alerts@bp.com"], mark_as_read: true },
    responses: [{ id: "rule-1" }],
    ownPaths: ["/me/mailFolders/inbox/messageRules"],
    sharedPaths: [`${SHARED_ROOT}/mailFolders/inbox/messageRules`],
  },
  {
    name: "graph_delete_message_rule",
    args: { rule_id: "rule-1" },
    responses: [null],
    ownPaths: ["/me/mailFolders/inbox/messageRules/rule-1"],
    sharedPaths: [`${SHARED_ROOT}/mailFolders/inbox/messageRules/rule-1`],
  },
  {
    name: "graph_categorize_mail",
    args: { message_ids: ["message-1"], categories: ["Renewals"] },
    responses: [{}],
    ownPaths: ["/me/messages/message-1"],
    sharedPaths: [`${SHARED_ROOT}/messages/message-1`],
  },
  {
    name: "graph_list_master_categories",
    args: {},
    responses: [{ value: [] }],
    ownPaths: ["/me/outlook/masterCategories"],
    sharedPaths: [`${SHARED_ROOT}/outlook/masterCategories`],
  },
  {
    name: "graph_create_master_category",
    args: { display_name: "Renewals" },
    responses: [{ id: "category-1" }],
    ownPaths: ["/me/outlook/masterCategories"],
    sharedPaths: [`${SHARED_ROOT}/outlook/masterCategories`],
  },
  {
    name: "graph_get_mail_tips",
    args: { email_addresses: ["ada@example.com"] },
    responses: [{ value: [] }],
    ownPaths: ["/me/getMailTips"],
    sharedPaths: [`${SHARED_ROOT}/getMailTips`],
  },
  {
    name: "graph_get_mail_delta",
    args: {},
    responses: [{ value: [] }],
    ownPaths: ["/me/mailFolders/inbox/messages/delta"],
    sharedPaths: [`${SHARED_ROOT}/mailFolders/inbox/messages/delta`],
  },
];

describe("shared and delegated mailbox routing", () => {
  test("covers every registered mail tool", () => {
    expect(MAILBOX_ROUTING_CASES.map(({ name }) => name)).toEqual(
      EXPECTED_MAIL_TOOLS.map(({ name }) => name),
    );
  });

  test.each(MAILBOX_ROUTING_CASES)(
    "$name targets the encoded shared mailbox root and never /me",
    async ({ name, args, responses, sharedPaths }) => {
      const { harness, graph } = registerMailHarness(responses);

      await harness.invoke(name, { ...args, mailbox: SHARED_MAILBOX });

      const paths = graph.calls.map(({ path }) => path);
      expect(paths).toEqual(sharedPaths);
      for (const path of paths) {
        expect(path.startsWith(`${SHARED_ROOT}/`)).toBe(true);
        expect(path).not.toContain("/me/");
      }
    },
  );

  test.each(MAILBOX_ROUTING_CASES)(
    "$name still targets /me when mailbox is omitted",
    async ({ name, args, responses, ownPaths }) => {
      const { harness, graph } = registerMailHarness(responses);

      await harness.invoke(name, args);

      const paths = graph.calls.map(({ path }) => path);
      expect(paths).toEqual(ownPaths);
      for (const path of paths) {
        expect(path.startsWith("/me/")).toBe(true);
        expect(path).not.toContain("/users/");
      }
    },
  );

  test("rejects dot-segment mailboxes before any Graph call", () => {
    const { harness, graph } = registerMailHarness([{ value: [] }]);

    for (const mailbox of [".", ".."]) {
      expect(z.object(schemaFor(harness, "graph_list_mail")).safeParse({ mailbox }).success).toBe(
        false,
      );
    }
    expect(graph.calls).toEqual([]);
  });
});

describe("mail composition options", () => {
  test("sends bcc, replyTo, and high importance in one exact payload", async () => {
    const { harness, graph } = registerMailHarness([undefined]);

    await harness.invoke("graph_send_mail", {
      to: ["ada@example.com"],
      subject: "Planning",
      body: "<p>Hello</p>",
      cc: ["grace@example.com"],
      bcc: ["audit@bp.com", "archive@bp.com"],
      importance: "high",
      reply_to: ["inbox@bp.com"],
      save_to_sent_items: false,
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/sendMail",
        body: {
          message: {
            subject: "Planning",
            body: { contentType: "HTML", content: "<p>Hello</p>" },
            toRecipients: [{ emailAddress: { address: "ada@example.com" } }],
            ccRecipients: [{ emailAddress: { address: "grace@example.com" } }],
            bccRecipients: [
              { emailAddress: { address: "audit@bp.com" } },
              { emailAddress: { address: "archive@bp.com" } },
            ],
            replyTo: [{ emailAddress: { address: "inbox@bp.com" } }],
            importance: "high",
          },
          saveToSentItems: false,
        },
      },
    ]);
  });

  test.each(["graph_send_mail", "graph_create_mail_draft"])(
    "%s omits importance when it is normal and omits empty bcc and reply_to",
    async (name) => {
      const { harness, graph } = registerMailHarness([{ id: "draft-1" }]);

      await harness.invoke(name, {
        to: ["ada@example.com"],
        subject: "Planning",
        body: "Hello",
        bcc: [],
        reply_to: [],
        importance: "normal",
        is_html: false,
      });

      const body = graph.calls[0]?.body as { message?: Record<string, unknown> } | undefined;
      const message = name === "graph_send_mail" ? body?.message : body;
      expect(message).toEqual({
        subject: "Planning",
        body: { contentType: "Text", content: "Hello" },
        toRecipients: [{ emailAddress: { address: "ada@example.com" } }],
      });
    },
  );

  test.each(["low", "high"])("keeps importance %s on a draft", async (importance) => {
    const { harness, graph } = registerMailHarness([{ id: "draft-1" }]);

    await harness.invoke("graph_create_mail_draft", {
      to: ["ada@example.com"],
      subject: "Planning",
      body: "<p>Hello</p>",
      bcc: ["audit@bp.com"],
      reply_to: ["inbox@bp.com"],
      importance,
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/messages",
        body: {
          subject: "Planning",
          body: { contentType: "HTML", content: "<p>Hello</p>" },
          toRecipients: [{ emailAddress: { address: "ada@example.com" } }],
          bccRecipients: [{ emailAddress: { address: "audit@bp.com" } }],
          replyTo: [{ emailAddress: { address: "inbox@bp.com" } }],
          importance,
        },
      },
    ]);
  });

  test("keeps a reply as a draft and returns the draft instead of sending", async () => {
    const draft = { id: "draft-1", subject: "RE: Planning" };
    const { harness, graph } = registerMailHarness([draft, {}]);

    expect(
      dataFrom(
        await harness.invoke("graph_reply_mail", {
          message_id: "message-1",
          body: "Thanks",
          as_draft: true,
        }),
      ),
    ).toEqual(draft);
    expect(graph.calls).toEqual([
      { method: "POST", path: "/me/messages/message-1/createReply" },
      {
        method: "PATCH",
        path: "/me/messages/draft-1",
        body: { body: { contentType: "HTML", content: "Thanks" } },
      },
    ]);
  });

  test("keeps a reply all as a draft", async () => {
    const { harness, graph } = registerMailHarness([{ id: "draft-1" }, {}]);

    await harness.invoke("graph_reply_mail", {
      message_id: "message-1",
      body: "Thanks",
      reply_all: true,
      as_draft: true,
    });

    expect(graph.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /me/messages/message-1/createReplyAll",
      "PATCH /me/messages/draft-1",
    ]);
  });

  test("keeps a forward as a draft and returns the draft instead of sending", async () => {
    const draft = { id: "draft-9", subject: "FW: Planning" };
    const { harness, graph } = registerMailHarness([draft, {}]);

    expect(
      dataFrom(
        await harness.invoke("graph_forward_mail", {
          message_id: "message-1",
          to: ["lead@bp.com"],
          comment: "<p>See below</p>",
          as_draft: true,
        }),
      ),
    ).toEqual(draft);
    expect(graph.calls).toEqual([
      { method: "POST", path: "/me/messages/message-1/createForward" },
      {
        method: "PATCH",
        path: "/me/messages/draft-9",
        body: {
          toRecipients: [{ emailAddress: { address: "lead@bp.com" } }],
          body: { contentType: "HTML", content: "<p>See below</p>" },
        },
      },
    ]);
  });

  test.each([
    { name: "graph_reply_mail", args: { message_id: "message-1", body: "Thanks" } },
    { name: "graph_forward_mail", args: { message_id: "message-1", to: ["lead@bp.com"] } },
  ])("$name still sends when as_draft is omitted", async ({ name, args }) => {
    const { harness, graph } = registerMailHarness([{ id: "draft-1" }, {}, {}]);

    await harness.invoke(name, args);

    expect(graph.calls.at(-1)).toEqual({ method: "POST", path: "/me/messages/draft-1/send" });
  });
});

describe("inbox message rules", () => {
  test("lists rules from the inbox rules collection", async () => {
    const { harness, graph } = registerMailHarness([{ value: [{ id: "rule-1" }] }]);

    expect(dataFrom(await harness.invoke("graph_list_message_rules"))).toEqual([{ id: "rule-1" }]);
    expect(graph.calls).toEqual([{ method: "GET", path: "/me/mailFolders/inbox/messageRules" }]);
  });

  test("treats a missing value property as an empty rule list", async () => {
    const { harness } = registerMailHarness([{}]);

    expect(dataFrom(await harness.invoke("graph_list_message_rules"))).toEqual([]);
  });

  test("creates a rule with every condition and action in the exact Graph shape", async () => {
    const { harness, graph } = registerMailHarness([{ id: "rule-1" }]);

    expect(
      dataFrom(
        await harness.invoke("graph_create_message_rule", {
          display_name: "Route alerts",
          sequence: 3,
          from_addresses: ["alerts@bp.com", "ops@bp.com"],
          subject_contains: ["ALERT"],
          body_contains: ["severity"],
          move_to_folder: "AAMkAD folder/id",
          mark_as_read: true,
          delete_message: true,
          is_enabled: false,
          stop_processing: true,
        }),
      ),
    ).toEqual({ id: "rule-1" });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/mailFolders/inbox/messageRules",
        body: {
          displayName: "Route alerts",
          sequence: 3,
          isEnabled: false,
          conditions: {
            fromAddresses: [
              { emailAddress: { address: "alerts@bp.com" } },
              { emailAddress: { address: "ops@bp.com" } },
            ],
            subjectContains: ["ALERT"],
            bodyContains: ["severity"],
          },
          actions: {
            moveToFolder: "AAMkAD folder/id",
            markAsRead: true,
            delete: true,
            stopProcessingRules: true,
          },
        },
      },
    ]);
  });

  test("sends only the supplied condition and action with the default sequence", async () => {
    const { harness, graph } = registerMailHarness([{ id: "rule-1" }]);

    await harness.invoke("graph_create_message_rule", {
      display_name: "Archive newsletters",
      subject_contains: ["Newsletter"],
      move_to_folder: "archive",
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/mailFolders/inbox/messageRules",
        body: {
          displayName: "Archive newsletters",
          sequence: 1,
          isEnabled: true,
          conditions: { subjectContains: ["Newsletter"] },
          actions: { moveToFolder: "archive" },
        },
      },
    ]);
  });

  test.each([
    { label: "no condition and no action", args: {} },
    { label: "a condition but no action", args: { subject_contains: ["ALERT"] } },
    { label: "an action but no condition", args: { mark_as_read: true } },
    {
      label: "only disabled boolean actions",
      args: { body_contains: ["x"], delete_message: false },
    },
  ])("rejects a rule with $label without calling Graph", async ({ args }) => {
    const { harness, graph } = registerMailHarness();

    const envelopeText = (
      await harness.invoke("graph_create_message_rule", { display_name: "Rule", ...args })
    ).content[0];
    if (envelopeText?.type !== "text") {
      throw new Error("Expected a text tool result.");
    }

    expect(JSON.parse(envelopeText.text)).toEqual({
      data: { error: "A message rule needs at least one condition and at least one action." },
      message: "error",
    });
    expect(graph.calls).toEqual([]);
  });

  test("rejects a created rule response without an id", async () => {
    const { harness } = registerMailHarness([{ displayName: "Route alerts" }]);

    await expect(
      harness.invoke("graph_create_message_rule", {
        display_name: "Route alerts",
        subject_contains: ["ALERT"],
        mark_as_read: true,
      }),
    ).resolves.toEqual(INVALID_GRAPH_RESPONSE_RESULT);
  });

  test("deletes a rule through the encoded rule route", async () => {
    const ruleId = "../rule/path\\name#fragment?query=:value%";
    const { harness, graph } = registerMailHarness([null]);

    expect(
      dataFrom(await harness.invoke("graph_delete_message_rule", { rule_id: ruleId })),
    ).toEqual({ status: "Message rule deleted" });
    expect(graph.calls).toEqual([
      {
        method: "DELETE",
        path: `/me/mailFolders/inbox/messageRules/${encodeURIComponent(ruleId)}`,
      },
    ]);
  });
});

describe("mail categories", () => {
  test("categorizes messages in order and reports per-message outcomes", async () => {
    const { harness, graph } = registerMailHarness([{}, new GraphApiError("Patch failed.")]);

    const result = await harness.invoke("graph_categorize_mail", {
      message_ids: ["message-1", "message 2"],
      categories: ["Renewals", "Blue category"],
    });
    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("Expected a text tool result.");
    }

    expect(JSON.parse(content.text)).toEqual({
      data: {
        action: "categorized",
        categories: ["Renewals", "Blue category"],
        succeeded_count: 1,
        failed_count: 1,
        succeeded: ["message-1"],
        failed: [{ message_id: "message 2", error: "Patch failed." }],
      },
      message: "success",
    });
    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: "/me/messages/message-1",
        body: { categories: ["Renewals", "Blue category"] },
      },
      {
        method: "PATCH",
        path: `/me/messages/${encodeURIComponent("message 2")}`,
        body: { categories: ["Renewals", "Blue category"] },
      },
    ]);
  });

  test("clears categories with an empty list", async () => {
    const { harness, graph } = registerMailHarness([{}]);

    await harness.invoke("graph_categorize_mail", {
      message_ids: ["message-1"],
      categories: [],
    });

    expect(graph.calls).toEqual([
      { method: "PATCH", path: "/me/messages/message-1", body: { categories: [] } },
    ]);
  });

  test("lists master categories from the outlook collection", async () => {
    const { harness, graph } = registerMailHarness([
      { value: [{ id: "category-1", displayName: "Renewals", color: "preset3" }] },
    ]);

    expect(dataFrom(await harness.invoke("graph_list_master_categories"))).toEqual([
      { id: "category-1", displayName: "Renewals", color: "preset3" },
    ]);
    expect(graph.calls).toEqual([{ method: "GET", path: "/me/outlook/masterCategories" }]);
  });

  test("creates a master category with the default and an explicit color", async () => {
    const { harness, graph } = registerMailHarness([{ id: "category-1" }, { id: "category-2" }]);

    expect(
      dataFrom(await harness.invoke("graph_create_master_category", { display_name: "Renewals" })),
    ).toEqual({ id: "category-1" });
    await harness.invoke("graph_create_master_category", {
      display_name: "Audits",
      color: "preset24",
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/outlook/masterCategories",
        body: { displayName: "Renewals", color: "preset0" },
      },
      {
        method: "POST",
        path: "/me/outlook/masterCategories",
        body: { displayName: "Audits", color: "preset24" },
      },
    ]);
  });

  test("rejects a created master category response without an id", async () => {
    const { harness } = registerMailHarness([{ displayName: "Renewals" }]);

    await expect(
      harness.invoke("graph_create_master_category", { display_name: "Renewals" }),
    ).resolves.toEqual(INVALID_GRAPH_RESPONSE_RESULT);
  });
});

describe("mail tips", () => {
  test("posts the default mail tips options joined by commas", async () => {
    const tips = [{ emailAddress: { address: "ada@example.com" }, automaticReplies: {} }];
    const { harness, graph } = registerMailHarness([{ value: tips }]);

    expect(
      dataFrom(
        await harness.invoke("graph_get_mail_tips", {
          email_addresses: ["ada@example.com", "grace@example.com"],
        }),
      ),
    ).toEqual(tips);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/getMailTips",
        body: {
          emailAddresses: ["ada@example.com", "grace@example.com"],
          mailTipsOptions: "automaticReplies,mailboxFullStatus,recipientScope",
        },
      },
    ]);
  });

  test("posts explicit options and treats a missing value property as empty", async () => {
    const { harness, graph } = registerMailHarness([{}]);

    expect(
      dataFrom(
        await harness.invoke("graph_get_mail_tips", {
          email_addresses: ["ada@example.com"],
          options: ["automaticReplies"],
        }),
      ),
    ).toEqual([]);
    expect(graph.calls[0]?.body).toEqual({
      emailAddresses: ["ada@example.com"],
      mailTipsOptions: "automaticReplies",
    });
  });
});

describe("mail delta", () => {
  test("seeds a sync with the select and top parameters and parses the delta token", async () => {
    const { harness, graph } = registerMailHarness([
      {
        value: [{ id: "message-1" }],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc%2F123",
      },
    ]);

    expect(dataFrom(await harness.invoke("graph_get_mail_delta"))).toEqual({
      value: [{ id: "message-1" }],
      delta_token: "abc/123",
    });
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/mailFolders/inbox/messages/delta",
        params: { $select: MAIL_LIST_FIELDS, $top: "50" },
      },
    ]);
  });

  test("resumes from a token without sending select and encodes the folder", async () => {
    const folder = "archive/2026#priority";
    const { harness, graph } = registerMailHarness([{ value: [] }]);

    await harness.invoke("graph_get_mail_delta", {
      folder,
      delta_link: "token-1",
      top: 10,
    });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/mailFolders/${encodeURIComponent(folder)}/messages/delta`,
        params: { $deltatoken: "token-1", $top: "10" },
      },
    ]);
  });

  test.each([
    { label: "no deltaLink", response: { value: [] } },
    {
      label: "a deltaLink without a query",
      response: {
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/messages/delta",
      },
    },
    {
      label: "a deltaLink without a delta token",
      response: {
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=abc",
      },
    },
    { label: "a non-string deltaLink", response: { value: [], "@odata.deltaLink": 42 } },
  ])("returns an empty delta token for $label", async ({ response }) => {
    const { harness } = registerMailHarness([response]);

    expect(dataFrom(await harness.invoke("graph_get_mail_delta"))).toEqual({
      value: [],
      delta_token: "",
    });
  });

  test.each([null, [], "payload-secret", { value: null }])(
    "rejects a malformed delta response %# without leakage",
    async (response) => {
      const { harness } = registerMailHarness([response]);
      const result = await harness.invoke("graph_get_mail_delta");

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("mail rules, categories, tips, and delta wrapper errors", () => {
  test.each([
    { name: "graph_list_message_rules", args: {} },
    {
      name: "graph_create_message_rule",
      args: { display_name: "Rule", subject_contains: ["ALERT"], mark_as_read: true },
    },
    { name: "graph_delete_message_rule", args: { rule_id: "rule-1" } },
    { name: "graph_list_master_categories", args: {} },
    { name: "graph_create_master_category", args: { display_name: "Renewals" } },
    { name: "graph_get_mail_tips", args: { email_addresses: ["ada@example.com"] } },
    { name: "graph_get_mail_delta", args: {} },
  ])("$name returns the stable authentication error envelope", async ({ name, args }) => {
    const { harness } = registerMailHarness([new AuthenticationError("Not authenticated.")]);

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });

  test("graph_categorize_mail reports the authentication failure per message", async () => {
    const { harness } = registerMailHarness([new AuthenticationError("Not authenticated.")]);

    const result = await harness.invoke("graph_categorize_mail", {
      message_ids: ["message-1"],
      categories: ["Renewals"],
    });
    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("Expected a text tool result.");
    }

    expect(JSON.parse(content.text)).toEqual({
      data: {
        action: "categorized",
        categories: ["Renewals"],
        succeeded_count: 0,
        failed_count: 1,
        succeeded: [],
        failed: [{ message_id: "message-1", error: "Not authenticated." }],
      },
      message: "error",
    });
  });
});
