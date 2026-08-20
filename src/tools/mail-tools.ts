import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { MAIL_COMPACT_FIELDS, MAIL_FOLDER_FIELDS, MAIL_LIST_FIELDS } from "../select-fields.js";
import {
  BODY_TYPE_ARGS_DOC,
  BODY_TYPE_SCHEMA,
  bodyTypeHeaders,
  collectionResult,
  COMPACT_ARGS_DOC,
  COMPACT_SCHEMA,
  filterForbidsSort,
  immutableIdHeaders,
  INCLUDE_NEXT_LINK_SCHEMA,
  mergeHeaders,
  NEXT_LINK_SCHEMA,
  PAGING_ARGS_DOC,
  selectFields,
  SKIP_ARGS_DOC,
  SKIP_SCHEMA,
} from "./list-options.js";
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
const MAILBOX_SCHEMA = OPTIONAL_RESOURCE_ID_SCHEMA;
const MAILBOX_ARGS_DOC = `    mailbox: Shared mailbox address or user ID to act on. Empty targets your own
        mailbox. Requires the delegated Mail.*.Shared permissions.`;
const IMMUTABLE_IDS_ARGS_DOC = `    immutable_ids: Whether to ask Graph for immutable message IDs (default false).
        A message ID changes when the message is moved, so a stored ID stops
        working; an immutable ID survives the move.`;
const MESSAGE_IDS_SCHEMA = z.array(RESOURCE_ID_SCHEMA).min(1).max(50);
const IMPORTANCE_SCHEMA = z.enum(["low", "normal", "high"]);
const INCOMPLETE_MESSAGE_RULE_MESSAGE =
  "A message rule needs at least one condition and at least one action.";
const DEFAULT_MAIL_TIPS_OPTIONS = [
  "automaticReplies",
  "mailboxFullStatus",
  "recipientScope",
] as const;
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

interface PagedCollectionRequest {
  /** Absolute nextLink from a previous page. Empty means start from `path`. */
  readonly nextLink: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly includeNextLink: boolean;
  readonly headers: Record<string, string> | undefined;
}

/**
 * Fetch one page of a collection. A nextLink already carries every query parameter Graph
 * needs, so it is requested bare and the caller's paging arguments are ignored.
 */
async function pagedCollection(
  graphClient: ToolDependencies["graphClient"],
  request: PagedCollectionRequest,
): Promise<string> {
  const response =
    request.nextLink === ""
      ? await graphClient.get(request.path, request.params, request.headers)
      : await graphClient.get(request.nextLink, undefined, request.headers);
  return successResponse(
    collectionResult(collectionValue(response), response, request.includeNextLink),
  );
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

function deltaToken(response: unknown): string {
  if (!isNonArrayObject(response)) {
    return "";
  }
  const deltaLink = response["@odata.deltaLink"];
  if (typeof deltaLink !== "string") {
    return "";
  }
  const queryStart = deltaLink.indexOf("?");
  if (queryStart === -1) {
    return "";
  }
  return new URLSearchParams(deltaLink.slice(queryStart + 1)).get("$deltatoken") ?? "";
}

function mailboxRoot(mailbox: string): string {
  return mailbox === "" ? "/me" : `/users/${encodeURIComponent(mailbox)}`;
}

function messagePath(mailbox: string, messageId: string): string {
  return `${mailboxRoot(mailbox)}/messages/${encodeURIComponent(messageId)}`;
}

function mailFolderPath(mailbox: string, parentFolderId: string): string {
  const root = `${mailboxRoot(mailbox)}/mailFolders`;
  return parentFolderId === ""
    ? root
    : `${root}/${encodeURIComponent(parentFolderId)}/childFolders`;
}

function recipient(address: string): { readonly emailAddress: { readonly address: string } } {
  return { emailAddress: { address } };
}

interface ComposeMessageInput {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly cc: readonly string[] | null;
  readonly bcc: readonly string[] | null;
  readonly is_html: boolean;
  readonly importance: "low" | "normal" | "high";
  readonly reply_to: readonly string[] | null;
}

function composeMessage(input: ComposeMessageInput): GraphObject {
  const message: GraphObject = {
    subject: input.subject,
    body: buildRichTextBody(input.body, input.is_html, RICH_TEXT_OPTIONS),
    toRecipients: input.to.map(recipient),
  };
  if (input.cc !== null && input.cc.length > 0) {
    message.ccRecipients = input.cc.map(recipient);
  }
  if (input.bcc !== null && input.bcc.length > 0) {
    message.bccRecipients = input.bcc.map(recipient);
  }
  if (input.reply_to !== null && input.reply_to.length > 0) {
    message.replyTo = input.reply_to.map(recipient);
  }
  if (input.importance !== "normal") {
    message.importance = input.importance;
  }
  return message;
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

Results are sorted newest first, except that the sort is dropped automatically when
filter_query targets from/, sender/, toRecipients/ or ccRecipients/, because Graph
cannot combine a sort with a filter on those properties.

Args:
    folder: Mail folder name or ID (default "inbox"). Common: inbox, sentitems, drafts,
        deleteditems, archive.
    top: Maximum number of emails to return per call (default 25, maximum 50).
${SKIP_ARGS_DOC}
    filter_query: Optional OData filter (e.g. "isRead eq false"). Filtering on a
        sender or recipient drops the sort order, as described above.
${COMPACT_ARGS_DOC}
${PAGING_ARGS_DOC}
${IMMUTABLE_IDS_ARGS_DOC}
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        folder: RESOURCE_ID_SCHEMA.default("inbox"),
        top: LIST_TOP_SCHEMA,
        skip: SKIP_SCHEMA,
        filter_query: z.string().default(""),
        compact: COMPACT_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
        immutable_ids: z.boolean().default(false),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({
      folder,
      top,
      skip,
      filter_query,
      compact,
      next_link,
      include_next_link,
      immutable_ids,
      mailbox,
    }) => {
      const params: Record<string, string> = {
        $select: selectFields(MAIL_LIST_FIELDS, MAIL_COMPACT_FIELDS, compact),
        $top: String(Math.min(top, 50)),
      };
      if (!filterForbidsSort(filter_query)) {
        params.$orderby = "receivedDateTime desc";
      }
      if (skip > 0) {
        params.$skip = String(skip);
      }
      if (filter_query !== "") {
        params.$filter = filter_query;
      }

      return await pagedCollection(dependencies.graphClient, {
        nextLink: next_link,
        path: `${mailboxRoot(mailbox)}/mailFolders/${encodeURIComponent(folder)}/messages`,
        params,
        includeNextLink: include_next_link,
        headers: immutableIdHeaders(immutable_ids),
      });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_read_mail",
    {
      description: `Read full details of a specific email.

Args:
    message_id: The email message ID.
${BODY_TYPE_ARGS_DOC}
${IMMUTABLE_IDS_ARGS_DOC}
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        body_type: BODY_TYPE_SCHEMA,
        immutable_ids: z.boolean().default(false),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_id, body_type, immutable_ids, mailbox }) => {
      const result = await dependencies.graphClient.get(
        messagePath(mailbox, message_id),
        undefined,
        mergeHeaders(bodyTypeHeaders(body_type), immutableIdHeaders(immutable_ids)),
      );
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
    top: Maximum number of results (default 25).
    folder: Mail folder name or ID to search (default "", the whole mailbox). Scope
        the search to a folder when the mailbox holds thousands of messages.
${COMPACT_ARGS_DOC}
${PAGING_ARGS_DOC}
${IMMUTABLE_IDS_ARGS_DOC}
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        query: z.string(),
        top: LIST_TOP_SCHEMA,
        folder: OPTIONAL_RESOURCE_ID_SCHEMA,
        compact: COMPACT_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
        immutable_ids: z.boolean().default(false),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({
      query,
      top,
      folder,
      compact,
      next_link,
      include_next_link,
      immutable_ids,
      mailbox,
    }) => {
      const escapedQuery = query.replaceAll('"', '""');
      const root = mailboxRoot(mailbox);

      return await pagedCollection(dependencies.graphClient, {
        nextLink: next_link,
        path:
          folder === ""
            ? `${root}/messages`
            : `${root}/mailFolders/${encodeURIComponent(folder)}/messages`,
        params: {
          $search: `"${escapedQuery}"`,
          $select: selectFields(MAIL_LIST_FIELDS, MAIL_COMPACT_FIELDS, compact),
          $top: String(Math.min(top, 50)),
        },
        includeNextLink: include_next_link,
        headers: immutableIdHeaders(immutable_ids),
      });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_send_mail",
    {
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
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        to: RECIPIENTS_SCHEMA,
        subject: z.string(),
        body: z.string(),
        cc: CC_SCHEMA,
        bcc: CC_SCHEMA,
        is_html: z.boolean().default(true),
        importance: IMPORTANCE_SCHEMA.default("normal"),
        reply_to: CC_SCHEMA,
        save_to_sent_items: z.boolean().default(true),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({
      to,
      subject,
      body,
      cc,
      bcc,
      is_html,
      importance,
      reply_to,
      save_to_sent_items,
      mailbox,
    }) => {
      const message = composeMessage({
        to,
        subject,
        body,
        cc,
        bcc,
        is_html,
        importance,
        reply_to,
      });

      await dependencies.graphClient.post(`${mailboxRoot(mailbox)}/sendMail`, {
        message,
        saveToSentItems: save_to_sent_items,
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
        True). Use false for plain text.
    as_draft: Whether to leave the reply as an unsent draft (default false).
        Returns the created draft instead of a sent status.
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        body: z.string(),
        reply_all: z.boolean().default(false),
        is_html: z.boolean().default(true),
        as_draft: z.boolean().default(false),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_id, body, reply_all, is_html, as_draft, mailbox }) => {
      const action = reply_all ? "createReplyAll" : "createReply";
      const draftResult = await dependencies.graphClient.post(
        `${messagePath(mailbox, message_id)}/${action}`,
      );
      const draft = requireGraphObjectWithId(draftResult);
      const draftPath = messagePath(mailbox, draft.id);

      await dependencies.graphClient.patch(draftPath, {
        body: buildRichTextBody(body, is_html, RICH_TEXT_OPTIONS),
      });
      if (as_draft) {
        return successResponse(draft);
      }
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
    message_id: The email message ID.
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_id, mailbox }) => {
      const result = await dependencies.graphClient.get(
        `${messagePath(mailbox, message_id)}/attachments`,
        {
          $select: "id,name,contentType,size,isInline",
        },
      );
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
    attachment_id: The attachment ID (from graph_list_mail_attachments).
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        attachment_id: RESOURCE_ID_SCHEMA,
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_id, attachment_id, mailbox }) => {
      const result = await dependencies.graphClient.get(
        `${messagePath(mailbox, message_id)}/attachments/${encodeURIComponent(attachment_id)}`,
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
        (default "archive"). Common: archive, inbox, deleteditems, junkemail.
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_ids: MESSAGE_IDS_SCHEMA,
        destination_folder: RESOURCE_ID_SCHEMA.default("archive"),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_ids, destination_folder, mailbox }) => {
      const outcome = await applyToMessages(message_ids, async (messageId) => {
        await dependencies.graphClient.post(`${messagePath(mailbox, messageId)}/move`, {
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
    message_ids: Message IDs to delete (1-50 per call).
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_ids: MESSAGE_IDS_SCHEMA,
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_ids, mailbox }) => {
      const outcome = await applyToMessages(message_ids, async (messageId) => {
        await dependencies.graphClient.delete(messagePath(mailbox, messageId));
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
        mark them unread.
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_ids: MESSAGE_IDS_SCHEMA,
        is_read: z.boolean().default(true),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_ids, is_read, mailbox }) => {
      const outcome = await applyToMessages(message_ids, async (messageId) => {
        await dependencies.graphClient.patch(messagePath(mailbox, messageId), { isRead: is_read });
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
        (default "flagged").
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_ids: MESSAGE_IDS_SCHEMA,
        flag_status: FLAG_STATUS_SCHEMA.default("flagged"),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_ids, flag_status, mailbox }) => {
      const outcome = await applyToMessages(message_ids, async (messageId) => {
        await dependencies.graphClient.patch(messagePath(mailbox, messageId), {
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
    top: Maximum number of folders to return (default 25).
${SKIP_ARGS_DOC}
${PAGING_ARGS_DOC}
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        parent_folder_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        top: LIST_TOP_SCHEMA,
        skip: SKIP_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ parent_folder_id, top, skip, next_link, include_next_link, mailbox }) => {
      const params: Record<string, string> = {
        $select: MAIL_FOLDER_FIELDS,
        $top: String(Math.min(top, 50)),
      };
      if (skip > 0) {
        params.$skip = String(skip);
      }

      return await pagedCollection(dependencies.graphClient, {
        nextLink: next_link,
        path: mailFolderPath(mailbox, parent_folder_id),
        params,
        includeNextLink: include_next_link,
        headers: undefined,
      });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_create_mail_folder",
    {
      description: `Create a mail folder.

Args:
    display_name: Name of the new folder.
    parent_folder_id: Parent folder ID. Empty creates a top-level folder.
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        display_name: RESOURCE_ID_SCHEMA,
        parent_folder_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ display_name, parent_folder_id, mailbox }) => {
      const result = await dependencies.graphClient.post(
        mailFolderPath(mailbox, parent_folder_id),
        { displayName: display_name },
      );
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
        false for plain text.
    as_draft: Whether to leave the forward as an unsent draft (default false).
        Returns the created draft instead of a sent status.
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        to: RECIPIENTS_SCHEMA,
        comment: z.string().default(""),
        is_html: z.boolean().default(true),
        as_draft: z.boolean().default(false),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_id, to, comment, is_html, as_draft, mailbox }) => {
      const draftResult = await dependencies.graphClient.post(
        `${messagePath(mailbox, message_id)}/createForward`,
      );
      const draft = requireGraphObjectWithId(draftResult);
      const draftPath = messagePath(mailbox, draft.id);

      const updates: GraphObject = { toRecipients: to.map(recipient) };
      if (comment !== "") {
        updates.body = buildRichTextBody(comment, is_html, RICH_TEXT_OPTIONS);
      }
      await dependencies.graphClient.patch(draftPath, updates);
      if (as_draft) {
        return successResponse(draft);
      }
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
    bcc: Optional list of BCC email addresses.
    is_html: Whether the body is HTML content (default: True). Use false
        for plain text.
    importance: Message importance: "low", "normal", or "high" (default
        "normal").
    reply_to: Optional list of addresses that replies should be sent to.
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        to: RECIPIENTS_SCHEMA,
        subject: z.string(),
        body: z.string(),
        cc: CC_SCHEMA,
        bcc: CC_SCHEMA,
        is_html: z.boolean().default(true),
        importance: IMPORTANCE_SCHEMA.default("normal"),
        reply_to: CC_SCHEMA,
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ to, subject, body, cc, bcc, is_html, importance, reply_to, mailbox }) => {
      const message = composeMessage({
        to,
        subject,
        body,
        cc,
        bcc,
        is_html,
        importance,
        reply_to,
      });

      const result = await dependencies.graphClient.post(
        `${mailboxRoot(mailbox)}/messages`,
        message,
      );
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
    content_type: MIME type (default "application/octet-stream").
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        file_name: RESOURCE_ID_SCHEMA,
        content_base64: z.string(),
        content_type: z.string().default("application/octet-stream"),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_id, file_name, content_base64, content_type, mailbox }) => {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content_base64) || content_base64.length % 4 !== 0) {
        return successResponse({ error: INVALID_ATTACHMENT_BASE64_MESSAGE }, "error");
      }
      if (content_base64.length > MAX_ATTACHMENT_BASE64_LENGTH) {
        return successResponse({ error: ATTACHMENT_TOO_LARGE_MESSAGE }, "error");
      }

      const result = await dependencies.graphClient.post(
        `${messagePath(mailbox, message_id)}/attachments`,
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: file_name,
          contentType: content_type,
          contentBytes: content_base64,
        },
      );
      return successResponse(requireGraphObjectWithId(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_send_mail_draft",
    {
      description: `Send an existing draft message.

Args:
    message_id: The draft message ID (from graph_create_mail_draft).
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_id, mailbox }) => {
      await dependencies.graphClient.post(`${messagePath(mailbox, message_id)}/send`);
      return successResponse({ status: "Draft sent" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_update_mail_draft",
    {
      description: `Update an existing draft email message.

All fields are optional except message_id. Only the fields you supply are
changed; omitted fields keep their current value. To clear recipients from
a field (e.g. remove all BCC), pass an empty array.

Use graph_add_mail_attachment / graph_remove_mail_attachment to manage
attachments on the draft.

Args:
    message_id: The draft message ID (from graph_create_mail_draft or
        graph_list_mail with folder "drafts").
    to: New list of To recipient email addresses. Replaces all current To
        recipients when provided.
    cc: New list of CC recipient email addresses. Replaces all current CC
        recipients when provided.
    bcc: New list of BCC recipient email addresses. Replaces all current BCC
        recipients when provided.
    subject: New email subject.
    body: New email body content. When \`is_html\` is true, send explicit
        HTML; markdown is not converted.
    is_html: Whether the body is HTML content (default: True). Only used
        when \`body\` is provided.
    importance: Message importance: "low", "normal", or "high".
    reply_to: New list of addresses that replies should be sent to.
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        to: RECIPIENTS_SCHEMA.nullable().optional().default(null),
        cc: CC_SCHEMA,
        bcc: CC_SCHEMA,
        subject: z.string().nullable().optional().default(null),
        body: z.string().nullable().optional().default(null),
        is_html: z.boolean().default(true),
        importance: IMPORTANCE_SCHEMA.nullable().optional().default(null),
        reply_to: CC_SCHEMA,
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_id, to, cc, bcc, subject, body, is_html, importance, reply_to, mailbox }) => {
      const updates: GraphObject = {};

      if (to !== null && to !== undefined) {
        updates.toRecipients = to.map(recipient);
      }
      if (cc !== null && cc !== undefined) {
        updates.ccRecipients = cc.map(recipient);
      }
      if (bcc !== null && bcc !== undefined) {
        updates.bccRecipients = bcc.map(recipient);
      }
      if (subject !== null && subject !== undefined) {
        updates.subject = subject;
      }
      if (body !== null && body !== undefined) {
        updates.body = buildRichTextBody(body, is_html, RICH_TEXT_OPTIONS);
      }
      if (importance !== null && importance !== undefined) {
        updates.importance = importance;
      }
      if (reply_to !== null && reply_to !== undefined) {
        updates.replyTo = reply_to.map(recipient);
      }

      if (Object.keys(updates).length === 0) {
        return successResponse({ error: "No fields to update were provided." }, "error");
      }

      const result = await dependencies.graphClient.patch(
        messagePath(mailbox, message_id),
        updates,
      );
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_remove_mail_attachment",
    {
      description: `Remove an attachment from a draft message.

Use graph_list_mail_attachments to find the attachment ID.

Args:
    message_id: The draft message ID.
    attachment_id: The attachment ID to remove (from graph_list_mail_attachments).
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_id: RESOURCE_ID_SCHEMA,
        attachment_id: RESOURCE_ID_SCHEMA,
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_id, attachment_id, mailbox }) => {
      await dependencies.graphClient.delete(
        `${messagePath(mailbox, message_id)}/attachments/${encodeURIComponent(attachment_id)}`,
      );
      return successResponse({ status: "Attachment removed" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_message_rules",
    {
      description: `List the inbox rules, including their conditions, actions, and order.

Args:
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ mailbox }) => {
      const result = await dependencies.graphClient.get(
        `${mailboxRoot(mailbox)}/mailFolders/inbox/messageRules`,
      );
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_create_message_rule",
    {
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
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        display_name: RESOURCE_ID_SCHEMA,
        sequence: z.number().int().default(1),
        from_addresses: z.array(z.string()).default([]),
        subject_contains: z.array(z.string()).default([]),
        body_contains: z.array(z.string()).default([]),
        move_to_folder: OPTIONAL_RESOURCE_ID_SCHEMA,
        mark_as_read: z.boolean().default(false),
        delete_message: z.boolean().default(false),
        is_enabled: z.boolean().default(true),
        stop_processing: z.boolean().default(false),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({
      display_name,
      sequence,
      from_addresses,
      subject_contains,
      body_contains,
      move_to_folder,
      mark_as_read,
      delete_message,
      is_enabled,
      stop_processing,
      mailbox,
    }) => {
      const conditions: GraphObject = {};
      if (from_addresses.length > 0) {
        conditions.fromAddresses = from_addresses.map(recipient);
      }
      if (subject_contains.length > 0) {
        conditions.subjectContains = [...subject_contains];
      }
      if (body_contains.length > 0) {
        conditions.bodyContains = [...body_contains];
      }

      const actions: GraphObject = {};
      if (move_to_folder !== "") {
        actions.moveToFolder = move_to_folder;
      }
      if (mark_as_read) {
        actions.markAsRead = true;
      }
      if (delete_message) {
        actions.delete = true;
      }
      if (stop_processing) {
        actions.stopProcessingRules = true;
      }

      if (Object.keys(conditions).length === 0 || Object.keys(actions).length === 0) {
        return successResponse({ error: INCOMPLETE_MESSAGE_RULE_MESSAGE }, "error");
      }

      const result = await dependencies.graphClient.post(
        `${mailboxRoot(mailbox)}/mailFolders/inbox/messageRules`,
        {
          displayName: display_name,
          sequence,
          isEnabled: is_enabled,
          conditions,
          actions,
        },
      );
      return successResponse(requireGraphObjectWithId(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_delete_message_rule",
    {
      description: `Delete an inbox rule.

Args:
    rule_id: The rule ID (from graph_list_message_rules).
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        rule_id: RESOURCE_ID_SCHEMA,
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ rule_id, mailbox }) => {
      await dependencies.graphClient.delete(
        `${mailboxRoot(mailbox)}/mailFolders/inbox/messageRules/${encodeURIComponent(rule_id)}`,
      );
      return successResponse({ status: "Message rule deleted" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_categorize_mail",
    {
      description: `Set the categories on messages, replacing the categories already set.

Each category must match the display name of a master category, so create it
with graph_create_master_category first. Processes each message in order and
reports per-message outcomes.

Args:
    message_ids: Message IDs to update (1-50 per call).
    categories: Category display names to apply. An empty list clears them.
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        message_ids: MESSAGE_IDS_SCHEMA,
        categories: z.array(z.string()),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ message_ids, categories, mailbox }) => {
      const outcome = await applyToMessages(message_ids, async (messageId) => {
        await dependencies.graphClient.patch(messagePath(mailbox, messageId), {
          categories: [...categories],
        });
      });
      return batchResponse(outcome, { action: "categorized", categories: [...categories] });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_master_categories",
    {
      description: `List the master categories available for mail and events.

Args:
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ mailbox }) => {
      const result = await dependencies.graphClient.get(
        `${mailboxRoot(mailbox)}/outlook/masterCategories`,
      );
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_create_master_category",
    {
      description: `Create a master category so it can be applied to mail and events.

The displayName is immutable after creation: to rename a category, delete it and
create a new one. Colors are the presets preset0 through preset24.

Args:
    display_name: Name of the new category.
    color: Color preset, preset0 through preset24 (default "preset0").
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        display_name: RESOURCE_ID_SCHEMA,
        color: z.string().default("preset0"),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ display_name, color, mailbox }) => {
      const result = await dependencies.graphClient.post(
        `${mailboxRoot(mailbox)}/outlook/masterCategories`,
        { displayName: display_name, color },
      );
      return successResponse(requireGraphObjectWithId(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_mail_tips",
    {
      description: `Get mail tips for recipients. Use this to check whether someone is out of office.

Args:
    email_addresses: Recipient addresses to look up.
    options: Mail tips to request (default "automaticReplies",
        "mailboxFullStatus", "recipientScope"). Other values: customMailTip,
        deliveryRestriction, externalMemberCount, maxMessageSize,
        moderationStatus, totalMemberCount.
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        email_addresses: z.array(z.string()),
        options: z.array(z.string()).default([...DEFAULT_MAIL_TIPS_OPTIONS]),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ email_addresses, options, mailbox }) => {
      const result = await dependencies.graphClient.post(`${mailboxRoot(mailbox)}/getMailTips`, {
        emailAddresses: [...email_addresses],
        mailTipsOptions: options.join(","),
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_mail_delta",
    {
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
${MAILBOX_ARGS_DOC}`,
      inputSchema: {
        folder: RESOURCE_ID_SCHEMA.default("inbox"),
        delta_link: z.string().default(""),
        top: z.number().int().default(50),
        mailbox: MAILBOX_SCHEMA,
      },
    },
    async ({ folder, delta_link, top, mailbox }) => {
      const params: Record<string, string> =
        delta_link === ""
          ? { $select: MAIL_LIST_FIELDS, $top: String(top) }
          : { $deltatoken: delta_link, $top: String(top) };

      const result = await dependencies.graphClient.get(
        `${mailboxRoot(mailbox)}/mailFolders/${encodeURIComponent(folder)}/messages/delta`,
        params,
      );
      return successResponse({ value: collectionValue(result), delta_token: deltaToken(result) });
    },
  );
}
