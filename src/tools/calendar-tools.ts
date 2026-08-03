import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { EVENT_COMPACT_FIELDS, EVENT_LIST_FIELDS } from "../select-fields.js";
import {
  BODY_TYPE_ARGS_DOC,
  BODY_TYPE_SCHEMA,
  bodyTypeHeaders,
  collectionResult,
  COMPACT_ARGS_DOC,
  COMPACT_SCHEMA,
  filterForbidsSort,
  INCLUDE_NEXT_LINK_SCHEMA,
  NEXT_LINK_SCHEMA,
  PAGING_ARGS_DOC,
  selectFields,
  SKIP_ARGS_DOC,
  SKIP_SCHEMA,
} from "./list-options.js";
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
const USER_SCHEMA = OPTIONAL_RESOURCE_ID_SCHEMA;
const USER_ARGS_DOC = `    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`;
const TOP_SCHEMA = z.number().int().default(50);
const CALENDAR_LIST_FIELDS = "id,name,color,isDefaultCalendar";
const CALENDAR_COMPACT_FIELDS = "id,name,isDefaultCalendar";
const EVENT_ORDER_BY = "start/dateTime desc";
const EVENT_FILTER_ARGS_DOC = `    filter_query: Optional OData filter (e.g. "isCancelled eq false"). Only applied
        on the /events path, because calendarView does not accept arbitrary filters.
        A filter on a recipient or organizer-style property also drops the sort,
        which Graph refuses to combine with it.`;
const ATTENDEES_SCHEMA = z.array(z.string()).nullable().optional().default(null);
const SHOW_AS_SCHEMA = z
  .enum(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"])
  .default("busy");
const SENSITIVITY_SCHEMA = z
  .enum(["normal", "personal", "private", "confidential"])
  .default("normal");
const REMINDER_SCHEMA = z.number().int().default(-1);
const CATEGORIES_SCHEMA = z.array(z.string()).default([]);
const REPEAT_SCHEMA = z.enum(["none", "daily", "weekly", "monthly", "yearly"]).default("none");
const MISSING_INSTANCE_WINDOW_MESSAGE =
  "start_datetime and end_datetime are required to list event instances.";
const MISSING_REPEAT_DAYS_MESSAGE = "repeat_days is required when repeat is weekly.";
const CONFLICTING_REPEAT_END_MESSAGE = "Provide either repeat_until or repeat_count, not both.";

const RECURRENCE_PATTERN_TYPES = {
  daily: "daily",
  weekly: "weekly",
  monthly: "absoluteMonthly",
  yearly: "absoluteYearly",
} as const;

type RepeatKind = keyof typeof RECURRENCE_PATTERN_TYPES;

type GraphObject = Record<string, unknown>;
type GraphObjectWithId = GraphObject & { readonly id: string };

interface RichEventFields {
  readonly is_all_day: boolean;
  readonly show_as: z.infer<typeof SHOW_AS_SCHEMA>;
  readonly sensitivity: z.infer<typeof SENSITIVITY_SCHEMA>;
  readonly reminder_minutes_before_start: number;
  readonly categories: readonly string[];
  readonly allow_new_time_proposals: boolean;
  readonly response_requested: boolean;
}

interface RecurrenceFields {
  readonly repeat: z.infer<typeof REPEAT_SCHEMA>;
  readonly repeat_interval: number;
  readonly repeat_days: readonly string[];
  readonly repeat_until: string;
  readonly repeat_count: number;
}

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

function calendarRoot(user: string): string {
  return user === "" ? "/me" : `/users/${encodeURIComponent(user)}`;
}

function eventPath(user: string, eventId: string): string {
  return `${calendarRoot(user)}/events/${encodeURIComponent(eventId)}`;
}

const EVENT_RESPONSE_ACTIONS = {
  accept: { action: "accept", status: "Event accepted" },
  decline: { action: "decline", status: "Event declined" },
  tentative: { action: "tentativelyAccept", status: "Event tentatively accepted" },
} as const;

function calendarCollectionPath(
  user: string,
  calendarId: string,
  collection: "calendarView" | "events",
): string {
  const root = calendarRoot(user);
  return calendarId === ""
    ? `${root}/${collection}`
    : `${root}/calendars/${encodeURIComponent(calendarId)}/${collection}`;
}

function attendee(address: string, type: "required" | "optional"): GraphObject {
  return { emailAddress: { address }, type };
}

function attendeeList(
  required: readonly string[] | null | undefined,
  optional: readonly string[] | null | undefined,
): GraphObject[] {
  return [
    ...(required ?? []).map((address) => attendee(address, "required")),
    ...(optional ?? []).map((address) => attendee(address, "optional")),
  ];
}

function applyRichEventFields(event: GraphObject, fields: RichEventFields): void {
  if (fields.is_all_day) {
    event.isAllDay = true;
  }
  if (fields.show_as !== "busy") {
    event.showAs = fields.show_as;
  }
  if (fields.sensitivity !== "normal") {
    event.sensitivity = fields.sensitivity;
  }
  if (fields.reminder_minutes_before_start >= 0) {
    event.reminderMinutesBeforeStart = fields.reminder_minutes_before_start;
    event.isReminderOn = true;
  }
  if (fields.categories.length > 0) {
    event.categories = [...fields.categories];
  }
  if (!fields.allow_new_time_proposals) {
    event.allowNewTimeProposals = false;
  }
  if (!fields.response_requested) {
    event.responseRequested = false;
  }
}

function datePart(dateTime: string): string {
  return dateTime.split("T")[0] ?? dateTime;
}

function recurrenceRange(fields: RecurrenceFields, startDate: string): GraphObject {
  if (fields.repeat_until !== "") {
    return { type: "endDate", startDate, endDate: fields.repeat_until };
  }
  if (fields.repeat_count > 0) {
    return { type: "numbered", startDate, numberOfOccurrences: fields.repeat_count };
  }
  return { type: "noEnd", startDate };
}

function recurrencePattern(
  repeat: RepeatKind,
  fields: RecurrenceFields,
  startDate: string,
): GraphObject {
  const pattern: GraphObject = {
    type: RECURRENCE_PATTERN_TYPES[repeat],
    interval: fields.repeat_interval,
  };
  if (repeat === "weekly") {
    pattern.daysOfWeek = [...fields.repeat_days];
  }
  if (repeat === "monthly" || repeat === "yearly") {
    pattern.dayOfMonth = Number(startDate.slice(8, 10));
  }
  if (repeat === "yearly") {
    pattern.month = Number(startDate.slice(5, 7));
  }
  return pattern;
}

function recurrenceError(fields: RecurrenceFields): string | null {
  if (fields.repeat === "none") {
    return null;
  }
  if (fields.repeat === "weekly" && fields.repeat_days.length === 0) {
    return MISSING_REPEAT_DAYS_MESSAGE;
  }
  if (fields.repeat_until !== "" && fields.repeat_count > 0) {
    return CONFLICTING_REPEAT_END_MESSAGE;
  }
  return null;
}

function buildRecurrence(
  repeat: RepeatKind,
  fields: RecurrenceFields,
  startDateTime: string,
): GraphObject {
  const startDate = datePart(startDateTime);
  return {
    pattern: recurrencePattern(repeat, fields, startDate),
    range: recurrenceRange(fields, startDate),
  };
}

interface CollectionPageRequest {
  readonly path: string;
  readonly params?: Record<string, string>;
  readonly headers?: Record<string, string>;
  readonly includeNextLink: boolean;
}

/**
 * Fetch one page of a collection and shape it for the caller. A nextLink already carries
 * its own paging state, so those requests pass the absolute URL with no query parameters.
 *
 * @param graphClient The Graph client to read through.
 * @param request The page path, query parameters, headers, and paging preference.
 */
async function collectionPage(
  graphClient: ToolDependencies["graphClient"],
  request: CollectionPageRequest,
): Promise<string> {
  const response = await graphClient.get(request.path, request.params, request.headers);
  return successResponse(
    collectionResult(collectionValue(response), response, request.includeNextLink),
  );
}

export function registerCalendarTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_list_calendars",
    {
      description: `List the authenticated user's calendars.

Args:
${SKIP_ARGS_DOC}
${COMPACT_ARGS_DOC}
${PAGING_ARGS_DOC}
${USER_ARGS_DOC}`,
      inputSchema: {
        skip: SKIP_SCHEMA,
        compact: COMPACT_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
        user: USER_SCHEMA,
      },
    },
    async ({ skip, compact, next_link, include_next_link, user }) => {
      if (next_link !== "") {
        return await collectionPage(dependencies.graphClient, {
          path: next_link,
          includeNextLink: include_next_link,
        });
      }

      const params: Record<string, string> = {
        $select: selectFields(CALENDAR_LIST_FIELDS, CALENDAR_COMPACT_FIELDS, compact),
      };
      if (skip > 0) {
        params.$skip = String(skip);
      }

      return await collectionPage(dependencies.graphClient, {
        path: `${calendarRoot(user)}/calendars`,
        params,
        includeNextLink: include_next_link,
      });
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
    top: Maximum number of events to return (default 50).
${SKIP_ARGS_DOC}
${EVENT_FILTER_ARGS_DOC}
${COMPACT_ARGS_DOC}
${BODY_TYPE_ARGS_DOC}
${PAGING_ARGS_DOC}
${USER_ARGS_DOC}`,
      inputSchema: {
        start_datetime: z.string().default(""),
        end_datetime: z.string().default(""),
        calendar_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        top: TOP_SCHEMA,
        skip: SKIP_SCHEMA,
        filter_query: z.string().default(""),
        compact: COMPACT_SCHEMA,
        body_type: BODY_TYPE_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
        user: USER_SCHEMA,
      },
    },
    async ({
      start_datetime,
      end_datetime,
      calendar_id,
      top,
      skip,
      filter_query,
      compact,
      body_type,
      next_link,
      include_next_link,
      user,
    }) => {
      const headers = bodyTypeHeaders(body_type);
      if (next_link !== "") {
        return await collectionPage(dependencies.graphClient, {
          path: next_link,
          ...(headers === undefined ? {} : { headers }),
          includeNextLink: include_next_link,
        });
      }

      const params: Record<string, string> = {
        $select: selectFields(EVENT_LIST_FIELDS, EVENT_COMPACT_FIELDS, compact),
        $top: String(Math.min(top, 50)),
      };

      let path: string;
      if (start_datetime !== "" && end_datetime !== "") {
        params.startDateTime = start_datetime;
        params.endDateTime = end_datetime;
        path = calendarCollectionPath(user, calendar_id, "calendarView");
      } else {
        if (filter_query !== "") {
          params.$filter = filter_query;
        }
        if (!filterForbidsSort(filter_query)) {
          params.$orderby = EVENT_ORDER_BY;
        }
        path = calendarCollectionPath(user, calendar_id, "events");
      }
      if (skip > 0) {
        params.$skip = String(skip);
      }

      return await collectionPage(dependencies.graphClient, {
        path,
        params,
        ...(headers === undefined ? {} : { headers }),
        includeNextLink: include_next_link,
      });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_event",
    {
      description: `Get full details of a specific calendar event.

Args:
    event_id: The event ID.
${BODY_TYPE_ARGS_DOC}
${USER_ARGS_DOC}`,
      inputSchema: {
        event_id: RESOURCE_ID_SCHEMA,
        body_type: BODY_TYPE_SCHEMA,
        user: USER_SCHEMA,
      },
    },
    async ({ event_id, body_type, user }) => {
      const result = await dependencies.graphClient.get(
        eventPath(user, event_id),
        undefined,
        bodyTypeHeaders(body_type),
      );
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
    attendees: Optional list of required attendee email addresses.
    is_online_meeting: Whether to create a Teams online meeting (default false).
    is_html: Whether the body is HTML (default: plain text).
    is_all_day: Whether the event lasts all day (default false). Graph expects
        midnight start and end times for all-day events.
    show_as: Free/busy status: "free", "tentative", "busy", "oof",
        "workingElsewhere", or "unknown" (default "busy").
    sensitivity: Sensitivity: "normal", "personal", "private", or "confidential"
        (default "normal").
    reminder_minutes_before_start: Reminder lead time in minutes. Negative keeps
        the mailbox default (default -1).
    optional_attendees: Optional list of optional attendee email addresses.
    categories: Outlook category names to tag the event with.
    allow_new_time_proposals: Whether attendees may propose new times (default true).
    response_requested: Whether attendees are asked to respond (default true).
    repeat: Recurrence pattern: "none", "daily", "weekly", "monthly", or "yearly"
        (default "none").
    repeat_interval: Interval between occurrences (default 1).
    repeat_days: Weekday names for weekly recurrence, e.g. ["monday", "thursday"].
        Required when repeat is "weekly".
    repeat_until: Last date of the recurrence (YYYY-MM-DD). Mutually exclusive
        with repeat_count.
    repeat_count: Number of occurrences. Mutually exclusive with repeat_until.
${USER_ARGS_DOC}`,
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
        is_all_day: z.boolean().default(false),
        show_as: SHOW_AS_SCHEMA,
        sensitivity: SENSITIVITY_SCHEMA,
        reminder_minutes_before_start: REMINDER_SCHEMA,
        optional_attendees: ATTENDEES_SCHEMA,
        categories: CATEGORIES_SCHEMA,
        allow_new_time_proposals: z.boolean().default(true),
        response_requested: z.boolean().default(true),
        repeat: REPEAT_SCHEMA,
        repeat_interval: z.number().int().default(1),
        repeat_days: z.array(z.string()).default([]),
        repeat_until: z.string().default(""),
        repeat_count: z.number().int().default(0),
        user: USER_SCHEMA,
      },
    },
    async (args) => {
      const {
        subject,
        start_datetime,
        end_datetime,
        timezone,
        body,
        location,
        attendees,
        is_online_meeting,
        is_html,
        optional_attendees,
        repeat,
        user,
      } = args;

      const invalidRecurrence = recurrenceError(args);
      if (invalidRecurrence !== null) {
        return successResponse({ error: invalidRecurrence }, "error");
      }

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
      const eventAttendees = attendeeList(attendees, optional_attendees);
      if (eventAttendees.length > 0) {
        event.attendees = eventAttendees;
      }
      if (is_online_meeting) {
        event.isOnlineMeeting = true;
        event.onlineMeetingProvider = "teamsForBusiness";
      }
      applyRichEventFields(event, args);
      if (repeat !== "none") {
        event.recurrence = buildRecurrence(repeat, args, start_datetime);
      }

      const result = await dependencies.graphClient.post(`${calendarRoot(user)}/events`, event);
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
    attendees: New list of required attendee email addresses.
    is_html: Whether the body is HTML (default: plain text).
    is_all_day: Whether the event lasts all day (default false). Graph expects
        midnight start and end times for all-day events.
    show_as: Free/busy status: "free", "tentative", "busy", "oof",
        "workingElsewhere", or "unknown" (default "busy").
    sensitivity: Sensitivity: "normal", "personal", "private", or "confidential"
        (default "normal").
    reminder_minutes_before_start: Reminder lead time in minutes. Negative leaves
        the reminder unchanged (default -1).
    optional_attendees: New list of optional attendee email addresses, merged with
        attendees.
    categories: Outlook category names to tag the event with.
    allow_new_time_proposals: Whether attendees may propose new times (default true).
    response_requested: Whether attendees are asked to respond (default true).
${USER_ARGS_DOC}`,
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
        is_all_day: z.boolean().default(false),
        show_as: SHOW_AS_SCHEMA,
        sensitivity: SENSITIVITY_SCHEMA,
        reminder_minutes_before_start: REMINDER_SCHEMA,
        optional_attendees: ATTENDEES_SCHEMA,
        categories: CATEGORIES_SCHEMA,
        allow_new_time_proposals: z.boolean().default(true),
        response_requested: z.boolean().default(true),
        user: USER_SCHEMA,
      },
    },
    async (args) => {
      const {
        event_id,
        subject,
        start_datetime,
        end_datetime,
        timezone,
        body,
        location,
        attendees,
        is_html,
        optional_attendees,
        user,
      } = args;

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
      const updatedAttendees = attendeeList(attendees, optional_attendees);
      if (updatedAttendees.length > 0) {
        updates.attendees = updatedAttendees;
      }
      applyRichEventFields(updates, args);

      const result = await dependencies.graphClient.patch(eventPath(user, event_id), updates);
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_delete_event",
    {
      description: `Delete a calendar event.

Args:
    event_id: The event ID to delete.
${USER_ARGS_DOC}`,
      inputSchema: {
        event_id: RESOURCE_ID_SCHEMA,
        user: USER_SCHEMA,
      },
    },
    async ({ event_id, user }) => {
      await dependencies.graphClient.delete(eventPath(user, event_id));
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
    send_response: Whether to send the response to the organizer (default true).
${USER_ARGS_DOC}`,
      inputSchema: {
        event_id: RESOURCE_ID_SCHEMA,
        response: z.enum(["accept", "decline", "tentative"]),
        comment: z.string().default(""),
        send_response: z.boolean().default(true),
        user: USER_SCHEMA,
      },
    },
    async ({ event_id, response, comment, send_response, user }) => {
      const { action, status } = EVENT_RESPONSE_ACTIONS[response];
      const payload: GraphObject = {};
      if (comment !== "") {
        payload.comment = comment;
      }
      payload.sendResponse = send_response;

      await dependencies.graphClient.post(`${eventPath(user, event_id)}/${action}`, payload);
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
    availability_view_interval: Availability view interval in minutes (default 30).
${USER_ARGS_DOC}`,
      inputSchema: {
        schedules: z.array(z.string()),
        start_datetime: z.string(),
        end_datetime: z.string(),
        timezone: z.string().default("UTC"),
        availability_view_interval: z.number().int().default(30),
        user: USER_SCHEMA,
      },
    },
    async ({
      schedules,
      start_datetime,
      end_datetime,
      timezone,
      availability_view_interval,
      user,
    }) => {
      const result = await dependencies.graphClient.post(
        `${calendarRoot(user)}/calendar/getSchedule`,
        {
          schedules,
          startTime: { dateTime: start_datetime, timeZone: timezone },
          endTime: { dateTime: end_datetime, timeZone: timezone },
          availabilityViewInterval: availability_view_interval,
        },
      );
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_find_meeting_times",
    {
      description: `Suggest meeting times that work for the attendees.

Graph scores candidate slots from the attendees' free/busy data, so use this to
pick a time and graph_create_event to book it.

Args:
    attendees: Attendee email addresses to fit the meeting around.
    duration_minutes: Meeting length in minutes (default 30).
    start_datetime: Start of the search window (ISO 8601). Empty lets Graph choose.
    end_datetime: End of the search window (ISO 8601). Empty lets Graph choose.
        The window is only sent when both ends are supplied.
    timezone: Timezone for the search window (default "UTC").
    minimum_attendee_percentage: Minimum percentage of attendees that must be
        free (default 100).
    max_candidates: Maximum number of suggestions to return (default 10).
${USER_ARGS_DOC}`,
      inputSchema: {
        attendees: z.array(z.string()),
        duration_minutes: z.number().int().default(30),
        start_datetime: z.string().default(""),
        end_datetime: z.string().default(""),
        timezone: z.string().default("UTC"),
        minimum_attendee_percentage: z.number().default(100),
        max_candidates: z.number().int().default(10),
        user: USER_SCHEMA,
      },
    },
    async ({
      attendees,
      duration_minutes,
      start_datetime,
      end_datetime,
      timezone,
      minimum_attendee_percentage,
      max_candidates,
      user,
    }) => {
      const payload: GraphObject = {
        attendees: attendees.map((address) => attendee(address, "required")),
        meetingDuration: `PT${String(duration_minutes)}M`,
        maxCandidates: max_candidates,
        minimumAttendeePercentage: minimum_attendee_percentage,
        isOrganizerOptional: false,
      };
      if (start_datetime !== "" && end_datetime !== "") {
        payload.timeConstraint = {
          activityDomain: "work",
          timeSlots: [
            {
              start: { dateTime: start_datetime, timeZone: timezone },
              end: { dateTime: end_datetime, timeZone: timezone },
            },
          ],
        };
      }

      const result = await dependencies.graphClient.post(
        `${calendarRoot(user)}/findMeetingTimes`,
        payload,
      );
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_cancel_event",
    {
      description: `Cancel a meeting you organize and notify the attendees.

Unlike graph_delete_event, which removes the event without telling anyone,
cancelling sends a cancellation notice to every attendee. Only the organizer can
cancel a meeting; attendees should decline with graph_respond_to_event instead.

Args:
    event_id: The event ID to cancel.
    comment: Optional note to include in the cancellation notice.
${USER_ARGS_DOC}`,
      inputSchema: {
        event_id: RESOURCE_ID_SCHEMA,
        comment: z.string().default(""),
        user: USER_SCHEMA,
      },
    },
    async ({ event_id, comment, user }) => {
      const payload: GraphObject = {};
      if (comment !== "") {
        payload.comment = comment;
      }

      await dependencies.graphClient.post(`${eventPath(user, event_id)}/cancel`, payload);
      return successResponse({ status: "Event cancelled" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_event_instances",
    {
      description: `List the occurrences of a recurring event in a date range.

Pass the series master event ID from graph_list_events, then use the returned
occurrence IDs to update or cancel a single occurrence.

Args:
    event_id: The recurring series master event ID.
    start_datetime: Start of the occurrence window (ISO 8601). Required by Graph.
    end_datetime: End of the occurrence window (ISO 8601). Required by Graph.
    top: Maximum number of occurrences to return (default 50, maximum 50).
${SKIP_ARGS_DOC}
${COMPACT_ARGS_DOC}
${PAGING_ARGS_DOC}
${USER_ARGS_DOC}`,
      inputSchema: {
        event_id: RESOURCE_ID_SCHEMA,
        start_datetime: z.string(),
        end_datetime: z.string(),
        top: TOP_SCHEMA,
        skip: SKIP_SCHEMA,
        compact: COMPACT_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
        user: USER_SCHEMA,
      },
    },
    async ({
      event_id,
      start_datetime,
      end_datetime,
      top,
      skip,
      compact,
      next_link,
      include_next_link,
      user,
    }) => {
      if (next_link !== "") {
        return await collectionPage(dependencies.graphClient, {
          path: next_link,
          includeNextLink: include_next_link,
        });
      }
      if (start_datetime === "" || end_datetime === "") {
        return successResponse({ error: MISSING_INSTANCE_WINDOW_MESSAGE }, "error");
      }

      const params: Record<string, string> = {
        startDateTime: start_datetime,
        endDateTime: end_datetime,
        $select: selectFields(EVENT_LIST_FIELDS, EVENT_COMPACT_FIELDS, compact),
        $top: String(Math.min(top, 50)),
      };
      if (skip > 0) {
        params.$skip = String(skip);
      }

      return await collectionPage(dependencies.graphClient, {
        path: `${eventPath(user, event_id)}/instances`,
        params,
        includeNextLink: include_next_link,
      });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_rooms",
    {
      description: `List bookable meeting rooms in the tenant.

Requires the delegated Place.Read.All permission. Use the returned email
addresses with graph_get_schedule to check availability, or as attendees on
graph_create_event to book a room.

Args:
    room_list: Room list email address to list rooms from. Empty lists every
        room in the tenant.
    top: Maximum number of rooms to return (default 50, maximum 50).
${SKIP_ARGS_DOC}
${PAGING_ARGS_DOC}`,
      inputSchema: {
        room_list: OPTIONAL_RESOURCE_ID_SCHEMA,
        top: TOP_SCHEMA,
        skip: SKIP_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ room_list, top, skip, next_link, include_next_link }) => {
      if (next_link !== "") {
        return await collectionPage(dependencies.graphClient, {
          path: next_link,
          includeNextLink: include_next_link,
        });
      }

      const path =
        room_list === ""
          ? "/places/microsoft.graph.room"
          : `/places/${encodeURIComponent(room_list)}/microsoft.graph.roomlist/rooms`;

      const params: Record<string, string> = {
        $top: String(Math.min(top, 50)),
      };
      if (skip > 0) {
        params.$skip = String(skip);
      }

      return await collectionPage(dependencies.graphClient, {
        path,
        params,
        includeNextLink: include_next_link,
      });
    },
  );
}
