import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { MAIL_FOLDER_FIELDS, MAIL_LIST_FIELDS } from "../select-fields.js";
import { buildRichTextBody } from "./message-tools.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value !== "" && value !== "." && value !== "..", {
    message: "Resource IDs must not be empty, '.' or '..'.",
  });
const LIST_TOP_SCHEMA = z.number().int().default(25);
const RECIPIENTS_SCHEMA = z.array(z.string());
const CC_SCHEMA = z.array(z.string()).nullable().optional().default(null);
const OPTIONAL_RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value === "" || (value !== "." && value !== ".."), {
    message: "Resource IDs must not be '.' or '..'.",
  })
  .default("");
const SKIP_SCHEMA = z.number().int().min(0).default(0);
const MESSAGE_IDS_SCHEMA = z.array(RESOURCE_ID_SCHEMA).min(1).max(50);
const FLAG_STATUS_SCHEMA = z.enum(["notFlagged", "flagged", "complete"]);
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const MAX_ATTACHMENT_BASE64_LENGTH = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);
const INVALID_ATTACHMENT_BASE64_MESSAGE = "Invalid base64 content.";
const ATTACHMENT_TOO_LARGE_MESSAGE = "Attachment too large. Maximum size is 3MB.";
const RICH_TEXT_OPTIONS = {
  htmlContentType: "HTML",
  textContentType: "Text",
} as const;

type GraphObject = Record<string, unknown>;
type GraphObjectWithId = GraphObject & { readonly id: string };

function isNonArrayObject(value: unknown): value is GraphObject {
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

function requireGraphObject(response: unknown): GraphObject {
  if (!isNonArrayObject(response)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response;
}

function requireGraphObjectWithId(response: unknown): GraphObjectWithId {
  if (!isNonArrayObject(response) || typeof response.id !== "string" || response.id.length === 0) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response as GraphObjectWithId;
}

function messagePath(messageId: string): string {
  return `/me/messages/${encodeURIComponent(messageId)}`;
}

function recipient(address: string): { readonly emailAddress: { readonly address: string } } {
  return { emailAddress: { address } };
}

interface BatchFailure {
  readonly message_id: string;
  readonly error: string;
}

interface BatchOutcome {
  readonly succeeded: readonly string[];
  readonly failed: readonly BatchFailure[];
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

async function applyToMessages(
  messageIds: readonly string[],
  apply: (messageId: string) => Promise<void>,
): Promise<BatchOutcome> {
  const succeeded: string[] = [];
  const failed: BatchFailure[] = [];
  for (const messageId of messageIds) {
    try {
      await apply(messageId);
      succeeded.push(messageId);
    } catch (error: unknown) {
      failed.push({ message_id: messageId, error: failureMessage(error) });
    }
  }
  return { succeeded, failed };
}

function batchResponse(outcome: BatchOutcome, details: GraphObject): string {
  const data = {
    ...details,
    succeeded_count: outcome.succeeded.length,
    failed_count: outcome.failed.length,
    succeeded: outcome.succeeded,
    failed: outcome.failed,
  };
  return successResponse(data, outcome.succeeded.length === 0 ? "error" : "success");
}

export function registerMailTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_list_mail",
    {
      description: `List emails from a mail folder.

Args:
    folder: Mail folder name or ID (default "inbox"). Common: inbox, sentitems, drafts,
        deleteditems, archive.
    top: Maximum number of emails to return per call (default 25, maximum 50).
    skip: Number of emails to skip before returning results (default 0). Graph
        returns at most 50 per call, so page through larger folders by raising
        skip in steps of top.
    filter_query: Optional OData filter (e.g. "isRead eq false").`,
      inputSchema: {
        folder: RESOURCE_ID_SCHEMA.default("inbox"),
        top: LIST_TOP_SCHEMA,
        skip: SKIP_SCHEMA,
        filter_query: z.string().default(""),
      },
    },
    async ({ folder, top, skip, filter_query }) => {
      const params: Record<string, string> = {
        $select: MAIL_LIST_FIELDS,
        $top: String(Math.min(top, 50)),
        $orderby: "receivedDateTime desc",
      };
      if (skip > 0) {
        params.$skip = String(skip);
      }
      if (filter_query !== "") {
        params.$filter = filter_query;
      }

      const result = await dependencies.graphClient.get(
        `/me/mailFolders/${encodeURIComponent(folder)}/messages`,
        params,
      );
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_read_mail",
    {
      description: `Read full details of a specific email.

Args:
    message_id: The email message ID.`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ message_id }) => {
      const result = await dependencies.graphClient.get(messagePath(message_id));
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_search_mail",
    {
      description: `Search emails by keyword.

Args:
    query: Search query string.
    top: Maximum number of results (default 25).`,
      inputSchema: {
        query: z.string(),
        top: LIST_TOP_SCHEMA,
      },
    },
    async ({ query, top }) => {
      const escapedQuery = query.replaceAll('"', '""');
      const result = await dependencies.graphClient.get("/me/messages", {
        $search: `"${escapedQuery}"`,
        $select: MAIL_LIST_FIELDS,
        $top: String(Math.min(top, 50)),
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_send_mail",
    {
      description: `Send an email.

Args:
    to: List of recipient email addresses.
    subject: Email subject.
    body: Email body content. When \`is_html\` is true, send explicit
        HTML; markdown is not converted.
    cc: Optional list of CC email addresses.
    is_html: Whether to send the email body as HTML content (default:
        True). Use false for plain text.`,
      inputSchema: {
        to: RECIPIENTS_SCHEMA,
        subject: z.string(),
        body: z.string(),
        cc: CC_SCHEMA,
        is_html: z.boolean().default(true),
      },
    },
    async ({ to, subject, body, cc, is_html }) => {
      const message: GraphObject = {
        subject,
        body: buildRichTextBody(body, is_html, RICH_TEXT_OPTIONS),
        toRecipients: to.map(recipient),
      };
      if (cc !== null && cc.length > 0) {
        message.ccRecipients = cc.map(recipient);
      }

      await dependencies.graphClient.post("/me/sendMail", {
        message,
        saveToSentItems: true,
      });
      return successResponse({ status: "Email sent" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_reply_mail",
    {
      description: `Reply to an email.

Args:
    message_id: The email message ID to reply to.
    body: The reply body content. When \`is_html\` is true, send explicit
        HTML; markdown is not converted.
    reply_all: Whether to reply to all recipients (default: reply to sender only).
    is_html: Whether to send the reply body as HTML content (default:
        True). Use false for plain text.`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        body: z.string(),
        reply_all: z.boolean().default(false),
        is_html: z.boolean().default(true),
      },
    },
    async ({ message_id, body, reply_all, is_html }) => {
      const action = reply_all ? "createReplyAll" : "createReply";
      const draftResult = await dependencies.graphClient.post(
        `${messagePath(message_id)}/${action}`,
      );
      const draft = requireGraphObjectWithId(draftResult);
      const draftPath = messagePath(draft.id);

      await dependencies.graphClient.patch(draftPath, {
        body: buildRichTextBody(body, is_html, RICH_TEXT_OPTIONS),
      });
      await dependencies.graphClient.post(`${draftPath}/send`);

      return successResponse({ status: reply_all ? "Reply all sent" : "Reply sent" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_mail_attachments",
    {
      description: `List attachments on an email message.

Args:
    message_id: The email message ID.`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ message_id }) => {
      const result = await dependencies.graphClient.get(`${messagePath(message_id)}/attachments`, {
        $select: "id,name,contentType,size,isInline",
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_mail_attachment",
    {
      description: `Get a specific email attachment including its content.

The attachment content is returned as base64-encoded data in the
'contentBytes' field. For large attachments, only metadata is practical.

Args:
    message_id: The email message ID.
    attachment_id: The attachment ID (from graph_list_mail_attachments).`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        attachment_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ message_id, attachment_id }) => {
      const result = await dependencies.graphClient.get(
        `${messagePath(message_id)}/attachments/${encodeURIComponent(attachment_id)}`,
      );
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_move_mail",
    {
      description: `Move messages to a mail folder. Use this to archive mail.

Processes each message in order and reports per-message outcomes, so a
partial failure still tells you what moved.

Args:
    message_ids: Message IDs to move (1-50 per call).
    destination_folder: Destination folder ID or well-known name
        (default "archive"). Common: archive, inbox, deleteditems, junkemail.`,
      inputSchema: {
        message_ids: MESSAGE_IDS_SCHEMA,
        destination_folder: RESOURCE_ID_SCHEMA.default("archive"),
      },
    },
    async ({ message_ids, destination_folder }) => {
      const outcome = await applyToMessages(message_ids, async (messageId) => {
        await dependencies.graphClient.post(`${messagePath(messageId)}/move`, {
          destinationId: destination_folder,
        });
      });
      return batchResponse(outcome, {
        action: "moved",
        destination_folder,
      });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_delete_mail",
    {
      description: `Delete messages. They are moved to Deleted Items, not erased.

Processes each message in order and reports per-message outcomes.

Args:
    message_ids: Message IDs to delete (1-50 per call).`,
      inputSchema: {
        message_ids: MESSAGE_IDS_SCHEMA,
      },
    },
    async ({ message_ids }) => {
      const outcome = await applyToMessages(message_ids, async (messageId) => {
        await dependencies.graphClient.delete(messagePath(messageId));
      });
      return batchResponse(outcome, { action: "deleted" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_mark_mail_read",
    {
      description: `Mark messages as read or unread.

Processes each message in order and reports per-message outcomes.

Args:
    message_ids: Message IDs to update (1-50 per call).
    is_read: Whether the messages are read (default true). Use false to
        mark them unread.`,
      inputSchema: {
        message_ids: MESSAGE_IDS_SCHEMA,
        is_read: z.boolean().default(true),
      },
    },
    async ({ message_ids, is_read }) => {
      const outcome = await applyToMessages(message_ids, async (messageId) => {
        await dependencies.graphClient.patch(messagePath(messageId), { isRead: is_read });
      });
      return batchResponse(outcome, { action: is_read ? "marked read" : "marked unread" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_flag_mail",
    {
      description: `Set the follow-up flag on messages.

Processes each message in order and reports per-message outcomes.

Args:
    message_ids: Message IDs to update (1-50 per call).
    flag_status: Flag state: "notFlagged", "flagged", or "complete"
        (default "flagged").`,
      inputSchema: {
        message_ids: MESSAGE_IDS_SCHEMA,
        flag_status: FLAG_STATUS_SCHEMA.default("flagged"),
      },
    },
    async ({ message_ids, flag_status }) => {
      const outcome = await applyToMessages(message_ids, async (messageId) => {
        await dependencies.graphClient.patch(messagePath(messageId), {
          flag: { flagStatus: flag_status },
        });
      });
      return batchResponse(outcome, { action: "flagged", flag_status });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_mail_folders",
    {
      description: `List mail folders, including their unread and total counts.

Use the returned folder IDs with graph_list_mail or graph_move_mail.

Args:
    parent_folder_id: Parent folder ID. Empty lists top-level folders.
    top: Maximum number of folders to return (default 25).`,
      inputSchema: {
        parent_folder_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        top: LIST_TOP_SCHEMA,
      },
    },
    async ({ parent_folder_id, top }) => {
      const path =
        parent_folder_id === ""
          ? "/me/mailFolders"
          : `/me/mailFolders/${encodeURIComponent(parent_folder_id)}/childFolders`;
      const result = await dependencies.graphClient.get(path, {
        $select: MAIL_FOLDER_FIELDS,
        $top: String(Math.min(top, 50)),
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_create_mail_folder",
    {
      description: `Create a mail folder.

Args:
    display_name: Name of the new folder.
    parent_folder_id: Parent folder ID. Empty creates a top-level folder.`,
      inputSchema: {
        display_name: RESOURCE_ID_SCHEMA,
        parent_folder_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ display_name, parent_folder_id }) => {
      const path =
        parent_folder_id === ""
          ? "/me/mailFolders"
          : `/me/mailFolders/${encodeURIComponent(parent_folder_id)}/childFolders`;
      const result = await dependencies.graphClient.post(path, { displayName: display_name });
      return successResponse(requireGraphObjectWithId(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_forward_mail",
    {
      description: `Forward an email to other recipients.

Args:
    message_id: The email message ID to forward.
    to: List of recipient email addresses.
    comment: Optional note to add above the forwarded message. When
        \`is_html\` is true, send explicit HTML; markdown is not converted.
    is_html: Whether the comment is HTML content (default: True). Use
        false for plain text.`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        to: RECIPIENTS_SCHEMA,
        comment: z.string().default(""),
        is_html: z.boolean().default(true),
      },
    },
    async ({ message_id, to, comment, is_html }) => {
      const draftResult = await dependencies.graphClient.post(
        `${messagePath(message_id)}/createForward`,
      );
      const draft = requireGraphObjectWithId(draftResult);
      const draftPath = messagePath(draft.id);

      const updates: GraphObject = { toRecipients: to.map(recipient) };
      if (comment !== "") {
        updates.body = buildRichTextBody(comment, is_html, RICH_TEXT_OPTIONS);
      }
      await dependencies.graphClient.patch(draftPath, updates);
      await dependencies.graphClient.post(`${draftPath}/send`);

      return successResponse({ status: "Message forwarded" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_create_mail_draft",
    {
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
      inputSchema: {
        to: RECIPIENTS_SCHEMA,
        subject: z.string(),
        body: z.string(),
        cc: CC_SCHEMA,
        is_html: z.boolean().default(true),
      },
    },
    async ({ to, subject, body, cc, is_html }) => {
      const message: GraphObject = {
        subject,
        body: buildRichTextBody(body, is_html, RICH_TEXT_OPTIONS),
        toRecipients: to.map(recipient),
      };
      if (cc !== null && cc.length > 0) {
        message.ccRecipients = cc.map(recipient);
      }

      const result = await dependencies.graphClient.post("/me/messages", message);
      return successResponse(requireGraphObjectWithId(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_add_mail_attachment",
    {
      description: `Attach a file to an existing draft message (max 3MB).

Args:
    message_id: The draft message ID (from graph_create_mail_draft).
    file_name: File name to show on the attachment.
    content_base64: File content encoded as base64.
    content_type: MIME type (default "application/octet-stream").`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        file_name: RESOURCE_ID_SCHEMA,
        content_base64: z.string(),
        content_type: z.string().default("application/octet-stream"),
      },
    },
    async ({ message_id, file_name, content_base64, content_type }) => {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content_base64) || content_base64.length % 4 !== 0) {
        return successResponse({ error: INVALID_ATTACHMENT_BASE64_MESSAGE }, "error");
      }
      if (content_base64.length > MAX_ATTACHMENT_BASE64_LENGTH) {
        return successResponse({ error: ATTACHMENT_TOO_LARGE_MESSAGE }, "error");
      }

      const result = await dependencies.graphClient.post(`${messagePath(message_id)}/attachments`, {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: file_name,
        contentType: content_type,
        contentBytes: content_base64,
      });
      return successResponse(requireGraphObjectWithId(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_send_mail_draft",
    {
      description: `Send an existing draft message.

Args:
    message_id: The draft message ID (from graph_create_mail_draft).`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ message_id }) => {
      await dependencies.graphClient.post(`${messagePath(message_id)}/send`);
      return successResponse({ status: "Draft sent" });
    },
  );
}
