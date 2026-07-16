import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { MAIL_LIST_FIELDS } from "../select-fields.js";
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
    folder: Mail folder name (default "inbox"). Common: inbox, sentitems, drafts, deleteditems.
    top: Maximum number of emails to return (default 25).
    filter_query: Optional OData filter (e.g. "isRead eq false").`,
      inputSchema: {
        folder: RESOURCE_ID_SCHEMA.default("inbox"),
        top: LIST_TOP_SCHEMA,
        filter_query: z.string().default(""),
      },
    },
    async ({ folder, top, filter_query }) => {
      const params: Record<string, string> = {
        $select: MAIL_LIST_FIELDS,
        $top: String(Math.min(top, 50)),
        $orderby: "receivedDateTime desc",
      };
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
}
