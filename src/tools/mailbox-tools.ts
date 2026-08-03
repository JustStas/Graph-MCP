import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const MISSING_SCHEDULE_MESSAGE =
  'start_datetime and end_datetime are required when status is "scheduled".';
const MISSING_MAILBOX_SETTINGS_MESSAGE = "At least one mailbox setting is required.";
const OPTIONAL_RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value === "" || (value !== "." && value !== ".."), {
    message: "Resource IDs must not be '.' or '..'.",
  })
  .default("");
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
      description: `Get mailbox settings, including automatic replies, time zone, and working hours.

Args:
    user: Colleague's address or user ID whose settings to read. Empty targets
        your own mailbox. Reading someone else needs delegate rights on that
        mailbox plus the MailboxSettings.Read permission.`,
      inputSchema: {
        user: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ user }) => {
      const result = await dependencies.graphClient.get(
        user === "" ? "/me/mailboxSettings" : `/users/${encodeURIComponent(user)}/mailboxSettings`,
      );
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

  registerAuthenticatedTool(
    server,
    "graph_update_mailbox_settings",
    {
      description: `Update the mailbox time zone and working hours.

Only the parts you supply are sent, so the rest of the mailbox settings stay as
they are. This always targets your own mailbox: Graph exposes no shared variant
of mailbox settings.

Args:
    time_zone: Mailbox time zone name (e.g. "Pacific Standard Time").
    working_days: Working days, lowercase (e.g. ["monday", "tuesday"]).
    working_hours_start: Start of the working day (e.g. "09:00:00").
    working_hours_end: End of the working day (e.g. "17:00:00").
    working_hours_timezone: Time zone name for the working hours.`,
      inputSchema: {
        time_zone: z.string().default(""),
        working_days: z.array(z.string()).default([]),
        working_hours_start: z.string().default(""),
        working_hours_end: z.string().default(""),
        working_hours_timezone: z.string().default(""),
      },
    },
    async ({
      time_zone,
      working_days,
      working_hours_start,
      working_hours_end,
      working_hours_timezone,
    }) => {
      const settings: GraphObject = {};
      if (time_zone !== "") {
        settings.timeZone = time_zone;
      }

      const workingHours: GraphObject = {};
      if (working_days.length > 0) {
        workingHours.daysOfWeek = [...working_days];
      }
      if (working_hours_start !== "") {
        workingHours.startTime = working_hours_start;
      }
      if (working_hours_end !== "") {
        workingHours.endTime = working_hours_end;
      }
      if (working_hours_timezone !== "") {
        workingHours.timeZone = { name: working_hours_timezone };
      }
      if (Object.keys(workingHours).length > 0) {
        settings.workingHours = workingHours;
      }

      if (Object.keys(settings).length === 0) {
        return successResponse({ error: MISSING_MAILBOX_SETTINGS_MESSAGE }, "error");
      }

      const result = await dependencies.graphClient.patch("/me/mailboxSettings", settings);
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
