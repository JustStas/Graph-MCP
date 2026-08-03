import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { EVENT_LIST_FIELDS } from "../select-fields.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value !== "" && value !== "." && value !== "..", {
    message: "Resource IDs must not be empty, '.' or '..'.",
  });
const OPTIONAL_RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value === "" || (value !== "." && value !== ".."), {
    message: "Resource IDs must not be '.' or '..'.",
  })
  .default("");
const TOP_SCHEMA = z.number().int().default(50);
const ATTENDEES_SCHEMA = z.array(z.string()).nullable().optional().default(null);

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

function eventPath(eventId: string): string {
  return `/me/events/${encodeURIComponent(eventId)}`;
}

const EVENT_RESPONSE_ACTIONS = {
  accept: { action: "accept", status: "Event accepted" },
  decline: { action: "decline", status: "Event declined" },
  tentative: { action: "tentativelyAccept", status: "Event tentatively accepted" },
} as const;

function calendarCollectionPath(calendarId: string, collection: "calendarView" | "events"): string {
  return calendarId === ""
    ? `/me/${collection}`
    : `/me/calendars/${encodeURIComponent(calendarId)}/${collection}`;
}

export function registerCalendarTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_list_calendars",
    {
      description: "List the authenticated user's calendars.",
      inputSchema: {},
    },
    async () => {
      const result = await dependencies.graphClient.get("/me/calendars", {
        $select: "id,name,color,isDefaultCalendar",
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_events",
    {
      description: `List calendar events. Uses calendarView for date ranges, /events otherwise.

Args:
    start_datetime: Start of date range (ISO 8601, e.g. "2025-01-01T00:00:00Z"). Required with end_datetime for date range queries.
    end_datetime: End of date range (ISO 8601). Required with start_datetime.
    calendar_id: Optional calendar ID. Defaults to primary calendar.
    top: Maximum number of events to return (default 50).`,
      inputSchema: {
        start_datetime: z.string().default(""),
        end_datetime: z.string().default(""),
        calendar_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        top: TOP_SCHEMA,
      },
    },
    async ({ start_datetime, end_datetime, calendar_id, top }) => {
      const params: Record<string, string> = {
        $select: EVENT_LIST_FIELDS,
        $top: String(Math.min(top, 50)),
      };

      let path: string;
      if (start_datetime !== "" && end_datetime !== "") {
        params.startDateTime = start_datetime;
        params.endDateTime = end_datetime;
        path = calendarCollectionPath(calendar_id, "calendarView");
      } else {
        params.$orderby = "start/dateTime desc";
        path = calendarCollectionPath(calendar_id, "events");
      }

      const result = await dependencies.graphClient.get(path, params);
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_event",
    {
      description: `Get full details of a specific calendar event.

Args:
    event_id: The event ID.`,
      inputSchema: {
        event_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ event_id }) => {
      const result = await dependencies.graphClient.get(eventPath(event_id));
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_create_event",
    {
      description: `Create a new calendar event.

Args:
    subject: Event subject/title.
    start_datetime: Start time in ISO 8601 (e.g. "2025-03-01T10:00:00").
    end_datetime: End time in ISO 8601 (e.g. "2025-03-01T11:00:00").
    timezone: Timezone (default "UTC"). Examples: "Pacific Standard Time", "Europe/London".
    body: Optional event body/description.
    location: Optional location name.
    attendees: Optional list of attendee email addresses.
    is_online_meeting: Whether to create a Teams online meeting (default false).
    is_html: Whether the body is HTML (default: plain text).`,
      inputSchema: {
        subject: z.string(),
        start_datetime: z.string(),
        end_datetime: z.string(),
        timezone: z.string().default("UTC"),
        body: z.string().default(""),
        location: z.string().default(""),
        attendees: ATTENDEES_SCHEMA,
        is_online_meeting: z.boolean().default(false),
        is_html: z.boolean().default(false),
      },
    },
    async ({
      subject,
      start_datetime,
      end_datetime,
      timezone,
      body,
      location,
      attendees,
      is_online_meeting,
      is_html,
    }) => {
      const event: GraphObject = {
        subject,
        start: { dateTime: start_datetime, timeZone: timezone },
        end: { dateTime: end_datetime, timeZone: timezone },
      };
      if (body !== "") {
        event.body = {
          contentType: is_html ? "HTML" : "Text",
          content: body,
        };
      }
      if (location !== "") {
        event.location = { displayName: location };
      }
      if (attendees !== null && attendees.length > 0) {
        event.attendees = attendees.map((address) => ({
          emailAddress: { address },
          type: "required",
        }));
      }
      if (is_online_meeting) {
        event.isOnlineMeeting = true;
        event.onlineMeetingProvider = "teamsForBusiness";
      }

      const result = await dependencies.graphClient.post("/me/events", event);
      return successResponse(requireGraphObjectWithId(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_update_event",
    {
      description: `Update an existing calendar event. Only provided fields are updated.

Args:
    event_id: The event ID to update.
    subject: New subject/title.
    start_datetime: New start time (ISO 8601). Requires timezone.
    end_datetime: New end time (ISO 8601). Requires timezone.
    timezone: Timezone for start/end times.
    body: New body/description.
    location: New location name.
    attendees: New list of attendee email addresses.
    is_html: Whether the body is HTML (default: plain text).`,
      inputSchema: {
        event_id: RESOURCE_ID_SCHEMA,
        subject: z.string().default(""),
        start_datetime: z.string().default(""),
        end_datetime: z.string().default(""),
        timezone: z.string().default(""),
        body: z.string().default(""),
        location: z.string().default(""),
        attendees: ATTENDEES_SCHEMA,
        is_html: z.boolean().default(false),
      },
    },
    async ({
      event_id,
      subject,
      start_datetime,
      end_datetime,
      timezone,
      body,
      location,
      attendees,
      is_html,
    }) => {
      const updates: GraphObject = {};
      if (subject !== "") {
        updates.subject = subject;
      }
      if (start_datetime !== "") {
        updates.start = { dateTime: start_datetime, timeZone: timezone || "UTC" };
      }
      if (end_datetime !== "") {
        updates.end = { dateTime: end_datetime, timeZone: timezone || "UTC" };
      }
      if (body !== "") {
        updates.body = {
          contentType: is_html ? "HTML" : "Text",
          content: body,
        };
      }
      if (location !== "") {
        updates.location = { displayName: location };
      }
      if (attendees !== null && attendees.length > 0) {
        updates.attendees = attendees.map((address) => ({
          emailAddress: { address },
          type: "required",
        }));
      }

      const result = await dependencies.graphClient.patch(eventPath(event_id), updates);
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_delete_event",
    {
      description: `Delete a calendar event.

Args:
    event_id: The event ID to delete.`,
      inputSchema: {
        event_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ event_id }) => {
      await dependencies.graphClient.delete(eventPath(event_id));
      return successResponse({ status: "Event deleted" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_respond_to_event",
    {
      description: `RSVP to a meeting invite.

Args:
    event_id: The event ID to respond to.
    response: Response type: "accept", "decline", or "tentative".
    comment: Optional comment to send with the response.
    send_response: Whether to send the response to the organizer (default true).`,
      inputSchema: {
        event_id: RESOURCE_ID_SCHEMA,
        response: z.enum(["accept", "decline", "tentative"]),
        comment: z.string().default(""),
        send_response: z.boolean().default(true),
      },
    },
    async ({ event_id, response, comment, send_response }) => {
      const { action, status } = EVENT_RESPONSE_ACTIONS[response];
      const payload: GraphObject = {};
      if (comment !== "") {
        payload.comment = comment;
      }
      payload.sendResponse = send_response;

      await dependencies.graphClient.post(`${eventPath(event_id)}/${action}`, payload);
      return successResponse({ status });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_schedule",
    {
      description: `Get free/busy availability for people or rooms.

Args:
    schedules: List of SMTP addresses (users or rooms) to look up.
    start_datetime: Start of the lookup window (ISO 8601, e.g. "2025-03-01T09:00:00").
    end_datetime: End of the lookup window (ISO 8601).
    timezone: Timezone for the window (default "UTC").
    availability_view_interval: Availability view interval in minutes (default 30).`,
      inputSchema: {
        schedules: z.array(z.string()),
        start_datetime: z.string(),
        end_datetime: z.string(),
        timezone: z.string().default("UTC"),
        availability_view_interval: z.number().int().default(30),
      },
    },
    async ({ schedules, start_datetime, end_datetime, timezone, availability_view_interval }) => {
      const result = await dependencies.graphClient.post("/me/calendar/getSchedule", {
        schedules,
        startTime: { dateTime: start_datetime, timeZone: timezone },
        endTime: { dateTime: end_datetime, timeZone: timezone },
        availabilityViewInterval: availability_view_interval,
      });
      return successResponse(collectionValue(result));
    },
  );
}
