import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const MISSING_SCHEDULE_MESSAGE =
  'start_datetime and end_datetime are required when status is "scheduled".';
const AUTOMATIC_REPLIES_STATUS_SCHEMA = z.enum(["disabled", "alwaysEnabled", "scheduled"]);
const EXTERNAL_AUDIENCE_SCHEMA = z.enum(["none", "contactsOnly", "all"]);

type GraphObject = Record<string, unknown>;

function isNonArrayObject(value: unknown): value is GraphObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireGraphObject(response: unknown): GraphObject {
  if (!isNonArrayObject(response)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response;
}

export function registerMailboxTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_get_mailbox_settings",
    {
      description: `Get mailbox settings, including automatic replies, time zone, and working hours.`,
      inputSchema: {},
    },
    async () => {
      const result = await dependencies.graphClient.get("/me/mailboxSettings");
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_set_automatic_replies",
    {
      description: `Set or clear the automatic reply (out of office) message.

Args:
    status: "disabled", "alwaysEnabled", or "scheduled". Scheduled requires
        start_datetime and end_datetime.
    internal_message: Reply sent to people inside the organization. When
        \`is_html\` is true, send explicit HTML; markdown is not converted.
    external_message: Reply sent to people outside the organization. Empty
        reuses internal_message.
    external_audience: Who outside the organization receives a reply: "none",
        "contactsOnly", or "all" (default "none").
    start_datetime: Scheduled window start (ISO 8601, e.g. "2025-03-01T09:00:00").
    end_datetime: Scheduled window end (ISO 8601).
    timezone: Timezone for the scheduled window (default "UTC").
    is_html: Whether the messages are HTML content (default: True). Use false
        for plain text.`,
      inputSchema: {
        status: AUTOMATIC_REPLIES_STATUS_SCHEMA,
        internal_message: z.string().default(""),
        external_message: z.string().default(""),
        external_audience: EXTERNAL_AUDIENCE_SCHEMA.default("none"),
        start_datetime: z.string().default(""),
        end_datetime: z.string().default(""),
        timezone: z.string().default("UTC"),
        is_html: z.boolean().default(true),
      },
    },
    async ({
      status,
      internal_message,
      external_message,
      external_audience,
      start_datetime,
      end_datetime,
      timezone,
      is_html,
    }) => {
      if (status === "scheduled" && (start_datetime === "" || end_datetime === "")) {
        return successResponse({ error: MISSING_SCHEDULE_MESSAGE }, "error");
      }

      const setting: GraphObject = {
        status,
        externalAudience: external_audience,
      };
      if (status !== "disabled") {
        const internal = is_html ? internal_message : escapeAsPlainText(internal_message);
        const external = external_message === "" ? internal_message : external_message;
        setting.internalReplyMessage = internal;
        setting.externalReplyMessage = is_html ? external : escapeAsPlainText(external);
      }
      if (status === "scheduled") {
        setting.scheduledStartDateTime = { dateTime: start_datetime, timeZone: timezone };
        setting.scheduledEndDateTime = { dateTime: end_datetime, timeZone: timezone };
      }

      const result = await dependencies.graphClient.patch("/me/mailboxSettings", {
        automaticRepliesSetting: setting,
      });
      return successResponse(requireGraphObject(result));
    },
  );
}

function escapeAsPlainText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "<br>");
}
