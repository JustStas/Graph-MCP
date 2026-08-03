import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError } from "../../src/errors.js";
import { EVENT_LIST_FIELDS } from "../../src/select-fields.js";
import { registerCalendarTools } from "../../src/tools/calendar-tools.js";
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

const EXPECTED_CALENDAR_TOOLS = [
  {
    name: "graph_list_calendars",
    description: `List the authenticated user's calendars.

Args:
    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`,
  },
  {
    name: "graph_list_events",
    description: `List calendar events. Uses calendarView for date ranges, /events otherwise.

Args:
    start_datetime: Start of date range (ISO 8601, e.g. "2025-01-01T00:00:00Z"). Required with end_datetime for date range queries.
    end_datetime: End of date range (ISO 8601). Required with start_datetime.
    calendar_id: Optional calendar ID. Defaults to primary calendar.
    top: Maximum number of events to return (default 50).
    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`,
  },
  {
    name: "graph_get_event",
    description: `Get full details of a specific calendar event.

Args:
    event_id: The event ID.
    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`,
  },
  {
    name: "graph_create_event",
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
    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`,
  },
  {
    name: "graph_update_event",
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
    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`,
  },
  {
    name: "graph_delete_event",
    description: `Delete a calendar event.

Args:
    event_id: The event ID to delete.
    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`,
  },
  {
    name: "graph_respond_to_event",
    description: `RSVP to a meeting invite.

Args:
    event_id: The event ID to respond to.
    response: Response type: "accept", "decline", or "tentative".
    comment: Optional comment to send with the response.
    send_response: Whether to send the response to the organizer (default true).
    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`,
  },
  {
    name: "graph_get_schedule",
    description: `Get free/busy availability for people or rooms.

Args:
    schedules: List of SMTP addresses (users or rooms) to look up.
    start_datetime: Start of the lookup window (ISO 8601, e.g. "2025-03-01T09:00:00").
    end_datetime: End of the lookup window (ISO 8601).
    timezone: Timezone for the window (default "UTC").
    availability_view_interval: Availability view interval in minutes (default 30).
    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`,
  },
  {
    name: "graph_find_meeting_times",
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
    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`,
  },
  {
    name: "graph_cancel_event",
    description: `Cancel a meeting you organize and notify the attendees.

Unlike graph_delete_event, which removes the event without telling anyone,
cancelling sends a cancellation notice to every attendee. Only the organizer can
cancel a meeting; attendees should decline with graph_respond_to_event instead.

Args:
    event_id: The event ID to cancel.
    comment: Optional note to include in the cancellation notice.
    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`,
  },
  {
    name: "graph_list_event_instances",
    description: `List the occurrences of a recurring event in a date range.

Pass the series master event ID from graph_list_events, then use the returned
occurrence IDs to update or cancel a single occurrence.

Args:
    event_id: The recurring series master event ID.
    start_datetime: Start of the occurrence window (ISO 8601). Required by Graph.
    end_datetime: End of the occurrence window (ISO 8601). Required by Graph.
    top: Maximum number of occurrences to return (default 50, maximum 50).
    user: Shared or delegated calendar owner address or user ID to act on. Empty
        targets your own calendar. Requires the delegated Calendars.Read.Shared or
        Calendars.ReadWrite.Shared permissions.`,
  },
  {
    name: "graph_list_rooms",
    description: `List bookable meeting rooms in the tenant.

Requires the delegated Place.Read.All permission. Use the returned email
addresses with graph_get_schedule to check availability, or as attendees on
graph_create_event to book a room.

Args:
    room_list: Room list email address to list rooms from. Empty lists every
        room in the tenant.
    top: Maximum number of rooms to return (default 50, maximum 50).`,
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

function payloadFrom(result: CallToolResult): unknown {
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("Expected a text tool result.");
  }
  return JSON.parse(content.text);
}

function registerCalendarHarness(graphResponses: readonly unknown[] = []): {
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
  registerCalendarTools(harness.server, dependencies);
  return { harness, graph };
}

const SHARED_USER = "shared.calendar@bp.com";
const SHARED_ROOT = `/users/${encodeURIComponent(SHARED_USER)}`;

const USER_ROUTING_CASES = [
  {
    name: "graph_list_calendars",
    args: {},
    responses: [{ value: [] }],
    ownPaths: ["/me/calendars"],
    sharedPaths: [`${SHARED_ROOT}/calendars`],
  },
  {
    name: "graph_list_events",
    args: {},
    responses: [{ value: [] }],
    ownPaths: ["/me/events"],
    sharedPaths: [`${SHARED_ROOT}/events`],
  },
  {
    name: "graph_get_event",
    args: { event_id: "event-1" },
    responses: [{ id: "event-1" }],
    ownPaths: ["/me/events/event-1"],
    sharedPaths: [`${SHARED_ROOT}/events/event-1`],
  },
  {
    name: "graph_create_event",
    args: { subject: "Planning", start_datetime: "start", end_datetime: "end" },
    responses: [{ id: "event-1" }],
    ownPaths: ["/me/events"],
    sharedPaths: [`${SHARED_ROOT}/events`],
  },
  {
    name: "graph_update_event",
    args: { event_id: "event-1" },
    responses: [{ id: "event-1" }],
    ownPaths: ["/me/events/event-1"],
    sharedPaths: [`${SHARED_ROOT}/events/event-1`],
  },
  {
    name: "graph_delete_event",
    args: { event_id: "event-1" },
    responses: [undefined],
    ownPaths: ["/me/events/event-1"],
    sharedPaths: [`${SHARED_ROOT}/events/event-1`],
  },
  {
    name: "graph_respond_to_event",
    args: { event_id: "event-1", response: "accept" },
    responses: [null],
    ownPaths: ["/me/events/event-1/accept"],
    sharedPaths: [`${SHARED_ROOT}/events/event-1/accept`],
  },
  {
    name: "graph_get_schedule",
    args: { schedules: ["ada@example.com"], start_datetime: "start", end_datetime: "end" },
    responses: [{ value: [] }],
    ownPaths: ["/me/calendar/getSchedule"],
    sharedPaths: [`${SHARED_ROOT}/calendar/getSchedule`],
  },
  {
    name: "graph_find_meeting_times",
    args: { attendees: ["ada@example.com"] },
    responses: [{}],
    ownPaths: ["/me/findMeetingTimes"],
    sharedPaths: [`${SHARED_ROOT}/findMeetingTimes`],
  },
  {
    name: "graph_cancel_event",
    args: { event_id: "event-1" },
    responses: [null],
    ownPaths: ["/me/events/event-1/cancel"],
    sharedPaths: [`${SHARED_ROOT}/events/event-1/cancel`],
  },
  {
    name: "graph_list_event_instances",
    args: { event_id: "event-1", start_datetime: "start", end_datetime: "end" },
    responses: [{ value: [] }],
    ownPaths: ["/me/events/event-1/instances"],
    sharedPaths: [`${SHARED_ROOT}/events/event-1/instances`],
  },
];

const RECURRENCE_CASES = [
  {
    label: "daily",
    args: { repeat: "daily", repeat_interval: 2 },
    recurrence: {
      pattern: { type: "daily", interval: 2 },
      range: { type: "noEnd", startDate: "2026-07-14" },
    },
  },
  {
    label: "weekly with an end date",
    args: {
      repeat: "weekly",
      repeat_days: ["monday", "thursday"],
      repeat_until: "2026-12-31",
    },
    recurrence: {
      pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday", "thursday"] },
      range: { type: "endDate", startDate: "2026-07-14", endDate: "2026-12-31" },
    },
  },
  {
    label: "numbered monthly",
    args: { repeat: "monthly", repeat_count: 6 },
    recurrence: {
      pattern: { type: "absoluteMonthly", interval: 1, dayOfMonth: 14 },
      range: { type: "numbered", startDate: "2026-07-14", numberOfOccurrences: 6 },
    },
  },
  {
    label: "yearly",
    args: { repeat: "yearly", repeat_interval: 1 },
    recurrence: {
      pattern: { type: "absoluteYearly", interval: 1, dayOfMonth: 14, month: 7 },
      range: { type: "noEnd", startDate: "2026-07-14" },
    },
  },
];

describe("calendar tool registration", () => {
  test("registers exactly the twelve calendar names and complete descriptions", () => {
    const { harness } = registerCalendarHarness();

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_CALENDAR_TOOLS);
  });

  test("exposes exact public snake_case schemas, defaults, and required fields", () => {
    const { harness } = registerCalendarHarness();

    const calendarsShape = schemaFor(harness, "graph_list_calendars");
    expect(Object.keys(calendarsShape)).toEqual(["user"]);
    expect(z.object(calendarsShape).parse({})).toEqual({ user: "" });

    const listShape = schemaFor(harness, "graph_list_events");
    expect(Object.keys(listShape)).toEqual([
      "start_datetime",
      "end_datetime",
      "calendar_id",
      "top",
      "user",
    ]);
    const listSchema = z.object(listShape);
    expect(listSchema.parse({})).toEqual({
      start_datetime: "",
      end_datetime: "",
      calendar_id: "",
      top: 50,
      user: "",
    });
    expect(listSchema.safeParse({ top: 1.5 }).success).toBe(false);
    expect(listSchema.safeParse({ top: -1 }).success).toBe(true);
    expect(listSchema.safeParse({ top: 500 }).success).toBe(true);

    const getShape = schemaFor(harness, "graph_get_event");
    expect(Object.keys(getShape)).toEqual(["event_id", "user"]);
    expect(z.object(getShape).safeParse({}).success).toBe(false);

    const createShape = schemaFor(harness, "graph_create_event");
    expect(Object.keys(createShape)).toEqual([
      "subject",
      "start_datetime",
      "end_datetime",
      "timezone",
      "body",
      "location",
      "attendees",
      "is_online_meeting",
      "is_html",
      "is_all_day",
      "show_as",
      "sensitivity",
      "reminder_minutes_before_start",
      "optional_attendees",
      "categories",
      "allow_new_time_proposals",
      "response_requested",
      "repeat",
      "repeat_interval",
      "repeat_days",
      "repeat_until",
      "repeat_count",
      "user",
    ]);
    const createSchema = z.object(createShape);
    expect(
      createSchema.parse({
        subject: "Planning",
        start_datetime: "2026-07-14T09:00:00",
        end_datetime: "2026-07-14T10:00:00",
      }),
    ).toEqual({
      subject: "Planning",
      start_datetime: "2026-07-14T09:00:00",
      end_datetime: "2026-07-14T10:00:00",
      timezone: "UTC",
      body: "",
      location: "",
      attendees: null,
      is_online_meeting: false,
      is_html: false,
      is_all_day: false,
      show_as: "busy",
      sensitivity: "normal",
      reminder_minutes_before_start: -1,
      optional_attendees: null,
      categories: [],
      allow_new_time_proposals: true,
      response_requested: true,
      repeat: "none",
      repeat_interval: 1,
      repeat_days: [],
      repeat_until: "",
      repeat_count: 0,
      user: "",
    });
    expect(
      createSchema.safeParse({
        subject: "Planning",
        start_datetime: "2026-07-14T09:00:00",
      }).success,
    ).toBe(false);
    expect(
      createSchema.safeParse({
        subject: "Planning",
        start_datetime: "start",
        end_datetime: "end",
        attendees: [42],
      }).success,
    ).toBe(false);
    for (const invalid of [
      { show_as: "maybe" },
      { sensitivity: "secret" },
      { repeat: "fortnightly" },
      { reminder_minutes_before_start: 2.5 },
      { repeat_interval: 1.5 },
      { repeat_count: 2.5 },
      { optional_attendees: [42] },
      { categories: [42] },
      { repeat_days: [42] },
    ]) {
      expect(
        createSchema.safeParse({
          subject: "Planning",
          start_datetime: "start",
          end_datetime: "end",
          ...invalid,
        }).success,
      ).toBe(false);
    }

    const updateShape = schemaFor(harness, "graph_update_event");
    expect(Object.keys(updateShape)).toEqual([
      "event_id",
      "subject",
      "start_datetime",
      "end_datetime",
      "timezone",
      "body",
      "location",
      "attendees",
      "is_html",
      "is_all_day",
      "show_as",
      "sensitivity",
      "reminder_minutes_before_start",
      "optional_attendees",
      "categories",
      "allow_new_time_proposals",
      "response_requested",
      "user",
    ]);
    expect(z.object(updateShape).parse({ event_id: "event-1" })).toEqual({
      event_id: "event-1",
      subject: "",
      start_datetime: "",
      end_datetime: "",
      timezone: "",
      body: "",
      location: "",
      attendees: null,
      is_html: false,
      is_all_day: false,
      show_as: "busy",
      sensitivity: "normal",
      reminder_minutes_before_start: -1,
      optional_attendees: null,
      categories: [],
      allow_new_time_proposals: true,
      response_requested: true,
      user: "",
    });
    expect(z.object(updateShape).safeParse({ event_id: "event-1", attendees: [42] }).success).toBe(
      false,
    );
    expect(Object.keys(updateShape)).not.toContain("repeat");

    const respondShape = schemaFor(harness, "graph_respond_to_event");
    expect(Object.keys(respondShape)).toEqual([
      "event_id",
      "response",
      "comment",
      "send_response",
      "user",
    ]);
    const respondSchema = z.object(respondShape);
    expect(respondSchema.parse({ event_id: "event-1", response: "accept" })).toEqual({
      event_id: "event-1",
      response: "accept",
      comment: "",
      send_response: true,
      user: "",
    });
    expect(respondSchema.safeParse({ event_id: "event-1" }).success).toBe(false);
    expect(respondSchema.safeParse({ event_id: "event-1", response: "maybe" }).success).toBe(false);

    const scheduleShape = schemaFor(harness, "graph_get_schedule");
    expect(Object.keys(scheduleShape)).toEqual([
      "schedules",
      "start_datetime",
      "end_datetime",
      "timezone",
      "availability_view_interval",
      "user",
    ]);
    const scheduleSchema = z.object(scheduleShape);
    expect(
      scheduleSchema.parse({
        schedules: ["ada@example.com"],
        start_datetime: "2026-07-14T09:00:00",
        end_datetime: "2026-07-14T17:00:00",
      }),
    ).toEqual({
      schedules: ["ada@example.com"],
      start_datetime: "2026-07-14T09:00:00",
      end_datetime: "2026-07-14T17:00:00",
      timezone: "UTC",
      availability_view_interval: 30,
      user: "",
    });
    expect(scheduleSchema.safeParse({ start_datetime: "start", end_datetime: "end" }).success).toBe(
      false,
    );
    expect(
      scheduleSchema.safeParse({
        schedules: ["ada@example.com"],
        start_datetime: "start",
        end_datetime: "end",
        availability_view_interval: 15.5,
      }).success,
    ).toBe(false);

    const deleteShape = schemaFor(harness, "graph_delete_event");
    expect(Object.keys(deleteShape)).toEqual(["event_id", "user"]);
    expect(z.object(deleteShape).safeParse({}).success).toBe(false);

    const findShape = schemaFor(harness, "graph_find_meeting_times");
    expect(Object.keys(findShape)).toEqual([
      "attendees",
      "duration_minutes",
      "start_datetime",
      "end_datetime",
      "timezone",
      "minimum_attendee_percentage",
      "max_candidates",
      "user",
    ]);
    const findSchema = z.object(findShape);
    expect(findSchema.parse({ attendees: ["ada@example.com"] })).toEqual({
      attendees: ["ada@example.com"],
      duration_minutes: 30,
      start_datetime: "",
      end_datetime: "",
      timezone: "UTC",
      minimum_attendee_percentage: 100,
      max_candidates: 10,
      user: "",
    });
    expect(findSchema.safeParse({}).success).toBe(false);
    expect(findSchema.safeParse({ attendees: [42] }).success).toBe(false);
    expect(findSchema.safeParse({ attendees: [], duration_minutes: 30.5 }).success).toBe(false);
    expect(findSchema.safeParse({ attendees: [], max_candidates: 2.5 }).success).toBe(false);
    expect(findSchema.safeParse({ attendees: [], minimum_attendee_percentage: 62.5 }).success).toBe(
      true,
    );

    const cancelShape = schemaFor(harness, "graph_cancel_event");
    expect(Object.keys(cancelShape)).toEqual(["event_id", "comment", "user"]);
    const cancelSchema = z.object(cancelShape);
    expect(cancelSchema.parse({ event_id: "event-1" })).toEqual({
      event_id: "event-1",
      comment: "",
      user: "",
    });
    expect(cancelSchema.safeParse({}).success).toBe(false);

    const instancesShape = schemaFor(harness, "graph_list_event_instances");
    expect(Object.keys(instancesShape)).toEqual([
      "event_id",
      "start_datetime",
      "end_datetime",
      "top",
      "user",
    ]);
    const instancesSchema = z.object(instancesShape);
    expect(
      instancesSchema.parse({
        event_id: "event-1",
        start_datetime: "2026-07-01T00:00:00Z",
        end_datetime: "2026-07-31T23:59:59Z",
      }),
    ).toEqual({
      event_id: "event-1",
      start_datetime: "2026-07-01T00:00:00Z",
      end_datetime: "2026-07-31T23:59:59Z",
      top: 50,
      user: "",
    });
    expect(instancesSchema.safeParse({ event_id: "event-1" }).success).toBe(false);

    const roomsShape = schemaFor(harness, "graph_list_rooms");
    expect(Object.keys(roomsShape)).toEqual(["room_list", "top"]);
    expect(z.object(roomsShape).parse({})).toEqual({ room_list: "", top: 50 });
    expect(z.object(roomsShape).safeParse({ top: 2.5 }).success).toBe(false);

    for (const { name } of EXPECTED_CALENDAR_TOOLS) {
      const keys = Object.keys(schemaFor(harness, name));
      if (name === "graph_list_rooms") {
        expect(keys).not.toContain("user");
      } else {
        expect(keys.at(-1)).toBe("user");
      }
    }
  });

  test("rejects empty and dot-segment resource IDs while allowing the empty calendar sentinel", () => {
    const { harness } = registerCalendarHarness();
    const eventSchemas = [
      z.object(schemaFor(harness, "graph_get_event")),
      z.object(schemaFor(harness, "graph_update_event")),
      z.object(schemaFor(harness, "graph_delete_event")),
    ];

    for (const schema of eventSchemas) {
      for (const event_id of ["", ".", ".."]) {
        expect(schema.safeParse({ event_id }).success).toBe(false);
      }
    }

    const respondSchema = z.object(schemaFor(harness, "graph_respond_to_event"));
    for (const event_id of ["", ".", ".."]) {
      expect(respondSchema.safeParse({ event_id, response: "accept" }).success).toBe(false);
    }

    const cancelSchema = z.object(schemaFor(harness, "graph_cancel_event"));
    const instancesSchema = z.object(schemaFor(harness, "graph_list_event_instances"));
    for (const event_id of ["", ".", ".."]) {
      expect(cancelSchema.safeParse({ event_id }).success).toBe(false);
      expect(
        instancesSchema.safeParse({ event_id, start_datetime: "start", end_datetime: "end" })
          .success,
      ).toBe(false);
    }

    for (const { name } of EXPECTED_CALENDAR_TOOLS) {
      if (name === "graph_list_rooms") {
        continue;
      }
      const userField = schemaFor(harness, name).user;
      if (userField === undefined) {
        throw new Error(`Tool ${name} did not expose a user argument.`);
      }
      const userSchema = z.object({ user: userField });
      expect(userSchema.safeParse({ user: "" }).success).toBe(true);
      expect(userSchema.safeParse({ user: "shared calendar@bp.com" }).success).toBe(true);
      expect(userSchema.safeParse({ user: "." }).success).toBe(false);
      expect(userSchema.safeParse({ user: ".." }).success).toBe(false);
    }

    const roomsSchema = z.object(schemaFor(harness, "graph_list_rooms"));
    expect(roomsSchema.safeParse({ room_list: "" }).success).toBe(true);
    expect(roomsSchema.safeParse({ room_list: "." }).success).toBe(false);
    expect(roomsSchema.safeParse({ room_list: ".." }).success).toBe(false);

    const listSchema = z.object(schemaFor(harness, "graph_list_events"));
    expect(listSchema.safeParse({ calendar_id: "" }).success).toBe(true);
    expect(listSchema.safeParse({ calendar_id: "." }).success).toBe(false);
    expect(listSchema.safeParse({ calendar_id: ".." }).success).toBe(false);
  });
});

describe("calendar list operations", () => {
  test("uses exact calendar select fields and returns collection values", async () => {
    const { harness, graph } = registerCalendarHarness([{ value: [{ id: "calendar-1" }] }]);

    expect(dataFrom(await harness.invoke("graph_list_calendars"))).toEqual([{ id: "calendar-1" }]);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/calendars",
        params: { $select: "id,name,color,isDefaultCalendar" },
      },
    ]);
  });

  test("routes full date ranges to calendarView and every other case to ordered events", async () => {
    const emptyResponses = Array.from({ length: 6 }, () => ({ value: [] }));
    const { harness, graph } = registerCalendarHarness(emptyResponses);

    await harness.invoke("graph_list_events", {
      start_datetime: "2026-07-01T00:00:00Z",
      end_datetime: "2026-07-31T23:59:59Z",
    });
    await harness.invoke("graph_list_events", {
      start_datetime: "2026-07-01T00:00:00Z",
      end_datetime: "2026-07-31T23:59:59Z",
      calendar_id: "calendar-1",
      top: 500,
    });
    await harness.invoke("graph_list_events", { start_datetime: "start-only" });
    await harness.invoke("graph_list_events", {
      end_datetime: "end-only",
      calendar_id: "calendar-1",
    });
    await harness.invoke("graph_list_events", {
      start_datetime: "start",
      end_datetime: "",
      top: -2,
    });
    await harness.invoke("graph_list_events");

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/calendarView",
        params: {
          $select: EVENT_LIST_FIELDS,
          $top: "50",
          startDateTime: "2026-07-01T00:00:00Z",
          endDateTime: "2026-07-31T23:59:59Z",
        },
      },
      {
        method: "GET",
        path: "/me/calendars/calendar-1/calendarView",
        params: {
          $select: EVENT_LIST_FIELDS,
          $top: "50",
          startDateTime: "2026-07-01T00:00:00Z",
          endDateTime: "2026-07-31T23:59:59Z",
        },
      },
      {
        method: "GET",
        path: "/me/events",
        params: {
          $select: EVENT_LIST_FIELDS,
          $top: "50",
          $orderby: "start/dateTime desc",
        },
      },
      {
        method: "GET",
        path: "/me/calendars/calendar-1/events",
        params: {
          $select: EVENT_LIST_FIELDS,
          $top: "50",
          $orderby: "start/dateTime desc",
        },
      },
      {
        method: "GET",
        path: "/me/events",
        params: {
          $select: EVENT_LIST_FIELDS,
          $top: "-2",
          $orderby: "start/dateTime desc",
        },
      },
      {
        method: "GET",
        path: "/me/events",
        params: {
          $select: EVENT_LIST_FIELDS,
          $top: "50",
          $orderby: "start/dateTime desc",
        },
      },
    ]);
  });

  test.each([
    { name: "graph_list_calendars", args: {} },
    { name: "graph_list_events", args: {} },
  ])("$name treats a missing value property as an empty list", async ({ name, args }) => {
    const { harness } = registerCalendarHarness([{}]);
    expect(dataFrom(await harness.invoke(name, args))).toEqual([]);
  });

  test.each([null, [], "payload-secret", { value: null }, { value: {} }])(
    "rejects malformed calendar collection response %# without leakage",
    async (response) => {
      const { harness } = registerCalendarHarness([response]);
      const result = await harness.invoke("graph_list_events");

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("calendar event operations", () => {
  test("gets a full event from the exact encoded route", async () => {
    const event = { id: "event-1", subject: "Planning" };
    const { harness, graph } = registerCalendarHarness([event]);

    expect(dataFrom(await harness.invoke("graph_get_event", { event_id: "event-1" }))).toEqual(
      event,
    );
    expect(graph.calls).toEqual([{ method: "GET", path: "/me/events/event-1" }]);
  });

  test("creates the exact minimal Python event body with UTC defaults", async () => {
    const created = { id: "event-1", subject: "Planning" };
    const { harness, graph } = registerCalendarHarness([created]);

    expect(
      dataFrom(
        await harness.invoke("graph_create_event", {
          subject: "Planning",
          start_datetime: "2026-07-14T09:00:00",
          end_datetime: "2026-07-14T10:00:00",
        }),
      ),
    ).toEqual(created);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/events",
        body: {
          subject: "Planning",
          start: { dateTime: "2026-07-14T09:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-07-14T10:00:00", timeZone: "UTC" },
        },
      },
    ]);
  });

  test.each([
    { is_html: false, contentType: "Text" },
    { is_html: true, contentType: "HTML" },
  ])("creates $contentType bodies, attendees, locations, and online meetings", async (row) => {
    const attendees = Object.freeze(["ada@example.com", "grace@example.com"]);
    const before = [...attendees];
    const { harness, graph } = registerCalendarHarness([{ id: "event-2" }]);

    await harness.invokeRaw("graph_create_event", {
      subject: "Planning",
      start_datetime: "2026-07-14T09:00:00",
      end_datetime: "2026-07-14T10:00:00",
      timezone: "Europe/London",
      body: "Agenda",
      location: "Room 101",
      attendees,
      is_online_meeting: true,
      is_html: row.is_html,
      is_all_day: false,
      show_as: "busy",
      sensitivity: "normal",
      reminder_minutes_before_start: -1,
      optional_attendees: null,
      categories: [],
      allow_new_time_proposals: true,
      response_requested: true,
      repeat: "none",
      repeat_interval: 1,
      repeat_days: [],
      repeat_until: "",
      repeat_count: 0,
      user: "",
    });

    expect(attendees).toEqual(before);
    expect(graph.calls[0]).toEqual({
      method: "POST",
      path: "/me/events",
      body: {
        subject: "Planning",
        start: { dateTime: "2026-07-14T09:00:00", timeZone: "Europe/London" },
        end: { dateTime: "2026-07-14T10:00:00", timeZone: "Europe/London" },
        body: { contentType: row.contentType, content: "Agenda" },
        location: { displayName: "Room 101" },
        attendees: [
          { emailAddress: { address: "ada@example.com" }, type: "required" },
          { emailAddress: { address: "grace@example.com" }, type: "required" },
        ],
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
      },
    });
  });

  test("omits empty create-event optional fields, including an empty attendee list", async () => {
    const { harness, graph } = registerCalendarHarness([{ id: "event-1" }]);

    await harness.invoke("graph_create_event", {
      subject: "Planning",
      start_datetime: "start",
      end_datetime: "end",
      attendees: [],
      body: "",
      location: "",
    });

    expect(graph.calls[0]?.body).toEqual({
      subject: "Planning",
      start: { dateTime: "start", timeZone: "UTC" },
      end: { dateTime: "end", timeZone: "UTC" },
    });
  });

  test("updates only non-empty fields and falls back to UTC for provided times", async () => {
    const updated = { id: "event-1", subject: "Updated" };
    const { harness, graph } = registerCalendarHarness([updated, { id: "event-2" }]);

    expect(
      dataFrom(
        await harness.invoke("graph_update_event", {
          event_id: "event-1",
          subject: "Updated",
          start_datetime: "new-start",
          end_datetime: "new-end",
          body: "<p>Agenda</p>",
          location: "Room 202",
          is_html: true,
        }),
      ),
    ).toEqual(updated);
    await harness.invoke("graph_update_event", { event_id: "event-2" });

    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: "/me/events/event-1",
        body: {
          subject: "Updated",
          start: { dateTime: "new-start", timeZone: "UTC" },
          end: { dateTime: "new-end", timeZone: "UTC" },
          body: { contentType: "HTML", content: "<p>Agenda</p>" },
          location: { displayName: "Room 202" },
        },
      },
      {
        method: "PATCH",
        path: "/me/events/event-2",
        body: {},
      },
    ]);
  });

  test("uses the provided update timezone and Text content type", async () => {
    const { harness, graph } = registerCalendarHarness([{ id: "event-1" }]);

    await harness.invoke("graph_update_event", {
      event_id: "event-1",
      start_datetime: "new-start",
      end_datetime: "new-end",
      timezone: "Europe/London",
      body: "Agenda",
    });

    expect(graph.calls[0]?.body).toEqual({
      start: { dateTime: "new-start", timeZone: "Europe/London" },
      end: { dateTime: "new-end", timeZone: "Europe/London" },
      body: { contentType: "Text", content: "Agenda" },
    });
  });

  test("deletes the exact event route, ignores the Graph response, and returns legacy status", async () => {
    const { harness, graph } = registerCalendarHarness(["ignored-response"]);

    expect(dataFrom(await harness.invoke("graph_delete_event", { event_id: "event-1" }))).toEqual({
      status: "Event deleted",
    });
    expect(graph.calls).toEqual([{ method: "DELETE", path: "/me/events/event-1" }]);
  });

  test("maps attendees onto the update patch and omits an empty list", async () => {
    const attendees = Object.freeze(["ada@example.com", "grace@example.com"]);
    const before = [...attendees];
    const { harness, graph } = registerCalendarHarness([{ id: "event-1" }, { id: "event-2" }]);

    await harness.invokeRaw("graph_update_event", {
      event_id: "event-1",
      subject: "",
      start_datetime: "",
      end_datetime: "",
      timezone: "",
      body: "",
      location: "",
      attendees,
      is_html: false,
      is_all_day: false,
      show_as: "busy",
      sensitivity: "normal",
      reminder_minutes_before_start: -1,
      optional_attendees: null,
      categories: [],
      allow_new_time_proposals: true,
      response_requested: true,
      user: "",
    });
    await harness.invoke("graph_update_event", { event_id: "event-2", attendees: [] });

    expect(attendees).toEqual(before);
    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: "/me/events/event-1",
        body: {
          attendees: [
            { emailAddress: { address: "ada@example.com" }, type: "required" },
            { emailAddress: { address: "grace@example.com" }, type: "required" },
          ],
        },
      },
      {
        method: "PATCH",
        path: "/me/events/event-2",
        body: {},
      },
    ]);
  });

  test.each([
    { name: "graph_get_event", args: { event_id: "event-1" } },
    { name: "graph_update_event", args: { event_id: "event-1" } },
  ])("$name rejects malformed full-object responses without leakage", async ({ name, args }) => {
    const { harness } = registerCalendarHarness([[{ secret: "payload-secret" }]]);
    const result = await harness.invoke(name, args);

    expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
    expect(JSON.stringify(result)).not.toContain("payload-secret");
    expect(JSON.stringify(result)).not.toContain("TypeError");
  });

  test.each([null, [], {}, { id: "" }, { id: 42 }, { id: "", secret: "payload-secret" }])(
    "create event rejects a malformed object or unusable ID: %#",
    async (response) => {
      const { harness } = registerCalendarHarness([response]);
      const result = await harness.invoke("graph_create_event", {
        subject: "Planning",
        start_datetime: "start",
        end_datetime: "end",
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("calendar event responses", () => {
  test.each([
    { response: "accept", action: "accept", status: "Event accepted" },
    { response: "decline", action: "decline", status: "Event declined" },
    {
      response: "tentative",
      action: "tentativelyAccept",
      status: "Event tentatively accepted",
    },
  ])("routes the $response response to /$action", async ({ response, action, status }) => {
    const { harness, graph } = registerCalendarHarness(["ignored-response"]);

    expect(
      dataFrom(
        await harness.invoke("graph_respond_to_event", {
          event_id: "event-1",
          response,
          comment: "See you there",
        }),
      ),
    ).toEqual({ status });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: `/me/events/event-1/${action}`,
        body: { comment: "See you there", sendResponse: true },
      },
    ]);
  });

  test("omits an empty comment and passes sendResponse through", async () => {
    const { harness, graph } = registerCalendarHarness([null, null]);

    await harness.invoke("graph_respond_to_event", { event_id: "event-1", response: "decline" });
    await harness.invoke("graph_respond_to_event", {
      event_id: "event-2",
      response: "accept",
      send_response: false,
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/events/event-1/decline",
        body: { sendResponse: true },
      },
      {
        method: "POST",
        path: "/me/events/event-2/accept",
        body: { sendResponse: false },
      },
    ]);
  });

  test("encodes event IDs in the response route", async () => {
    const hostileId = "../event/path\\name#fragment?query=:value%";
    const { harness, graph } = registerCalendarHarness([null]);

    await harness.invoke("graph_respond_to_event", { event_id: hostileId, response: "accept" });

    expect(graph.calls[0]?.path).toBe(`/me/events/${encodeURIComponent(hostileId)}/accept`);
  });
});

describe("calendar schedule lookups", () => {
  test("posts the exact getSchedule body and returns collection values", async () => {
    const schedules = Object.freeze(["ada@example.com", "room-101@example.com"]);
    const before = [...schedules];
    const { harness, graph } = registerCalendarHarness([
      { value: [{ scheduleId: "ada@example.com" }] },
    ]);

    expect(
      dataFrom(
        await harness.invokeRaw("graph_get_schedule", {
          schedules,
          start_datetime: "2026-07-14T09:00:00",
          end_datetime: "2026-07-14T17:00:00",
          timezone: "Europe/London",
          availability_view_interval: 15,
          user: "",
        }),
      ),
    ).toEqual([{ scheduleId: "ada@example.com" }]);
    expect(schedules).toEqual(before);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/calendar/getSchedule",
        body: {
          schedules: ["ada@example.com", "room-101@example.com"],
          startTime: { dateTime: "2026-07-14T09:00:00", timeZone: "Europe/London" },
          endTime: { dateTime: "2026-07-14T17:00:00", timeZone: "Europe/London" },
          availabilityViewInterval: 15,
        },
      },
    ]);
  });

  test("applies UTC and the default interval, and treats a missing value as empty", async () => {
    const { harness, graph } = registerCalendarHarness([{}]);

    expect(
      dataFrom(
        await harness.invoke("graph_get_schedule", {
          schedules: ["ada@example.com"],
          start_datetime: "2026-07-14T09:00:00",
          end_datetime: "2026-07-14T17:00:00",
        }),
      ),
    ).toEqual([]);
    expect(graph.calls[0]?.body).toEqual({
      schedules: ["ada@example.com"],
      startTime: { dateTime: "2026-07-14T09:00:00", timeZone: "UTC" },
      endTime: { dateTime: "2026-07-14T17:00:00", timeZone: "UTC" },
      availabilityViewInterval: 30,
    });
  });

  test.each([null, [], "payload-secret", { value: null }])(
    "rejects malformed getSchedule response %# without leakage",
    async (response) => {
      const { harness } = registerCalendarHarness([response]);
      const result = await harness.invoke("graph_get_schedule", {
        schedules: ["ada@example.com"],
        start_datetime: "start",
        end_datetime: "end",
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("calendar path safety", () => {
  test.each([
    "../me/events",
    "calendar/child",
    "domain\\calendar",
    "calendar#fragment",
    "calendar?query=value",
    ":@!$&'()*+,;= %",
  ])("keeps adversarial calendar ID %s inside one encoded segment", async (calendarId) => {
    const { harness, graph } = registerCalendarHarness([{ value: [] }]);

    await harness.invoke("graph_list_events", { calendar_id: calendarId });

    expect(graph.calls[0]?.path).toBe(`/me/calendars/${encodeURIComponent(calendarId)}/events`);
  });

  test.each([
    { name: "graph_get_event", response: { id: "event-1" }, method: "GET" },
    { name: "graph_update_event", response: { id: "event-1" }, method: "PATCH" },
    { name: "graph_delete_event", response: undefined, method: "DELETE" },
  ])("encodes event IDs in the $name route", async ({ name, response, method }) => {
    const hostileId = "../event/path\\name#fragment?query=:value%";
    const { harness, graph } = registerCalendarHarness([response]);

    await harness.invoke(name, { event_id: hostileId });

    expect(graph.calls[0]).toMatchObject({
      method,
      path: `/me/events/${encodeURIComponent(hostileId)}`,
    });
  });
});

describe("shared and delegated calendar routing", () => {
  test("covers every registered calendar tool that accepts a user", () => {
    expect(USER_ROUTING_CASES.map(({ name }) => name)).toEqual(
      EXPECTED_CALENDAR_TOOLS.filter(({ name }) => name !== "graph_list_rooms").map(
        ({ name }) => name,
      ),
    );
  });

  test.each(USER_ROUTING_CASES)(
    "$name targets the encoded delegated calendar root and never /me",
    async ({ name, args, responses, sharedPaths }) => {
      const { harness, graph } = registerCalendarHarness(responses);

      await harness.invoke(name, { ...args, user: SHARED_USER });

      const paths = graph.calls.map(({ path }) => path);
      expect(paths).toEqual(sharedPaths);
      for (const path of paths) {
        expect(path.startsWith(`${SHARED_ROOT}/`)).toBe(true);
        expect(path).not.toContain("/me/");
      }
    },
  );

  test.each(USER_ROUTING_CASES)(
    "$name still targets /me when user is omitted",
    async ({ name, args, responses, ownPaths }) => {
      const { harness, graph } = registerCalendarHarness(responses);

      await harness.invoke(name, args);

      const paths = graph.calls.map(({ path }) => path);
      expect(paths).toEqual(ownPaths);
      for (const path of paths) {
        expect(path.startsWith("/me/")).toBe(true);
        expect(path).not.toContain("/users/");
      }
    },
  );

  test("routes delegated calendar collections through the user root", async () => {
    const { harness, graph } = registerCalendarHarness([{ value: [] }, { value: [] }]);

    await harness.invoke("graph_list_events", {
      start_datetime: "2026-07-01T00:00:00Z",
      end_datetime: "2026-07-31T23:59:59Z",
      user: SHARED_USER,
    });
    await harness.invoke("graph_list_events", { calendar_id: "calendar-1", user: SHARED_USER });

    expect(graph.calls.map(({ path }) => path)).toEqual([
      `${SHARED_ROOT}/calendarView`,
      `${SHARED_ROOT}/calendars/calendar-1/events`,
    ]);
  });

  test("rejects dot-segment users before any Graph call", () => {
    const { harness, graph } = registerCalendarHarness([{ value: [] }]);

    for (const user of [".", ".."]) {
      expect(z.object(schemaFor(harness, "graph_list_events")).safeParse({ user }).success).toBe(
        false,
      );
    }
    expect(graph.calls).toEqual([]);
  });
});

describe("calendar meeting time suggestions", () => {
  test("posts the exact findMeetingTimes body with a time constraint", async () => {
    const attendees = Object.freeze(["ada@example.com", "grace@example.com"]);
    const before = [...attendees];
    const suggestions = { meetingTimeSuggestions: [{ confidence: 100 }] };
    const { harness, graph } = registerCalendarHarness([suggestions]);

    expect(
      dataFrom(
        await harness.invokeRaw("graph_find_meeting_times", {
          attendees,
          duration_minutes: 45,
          start_datetime: "2026-07-14T09:00:00",
          end_datetime: "2026-07-14T17:00:00",
          timezone: "Europe/London",
          minimum_attendee_percentage: 75,
          max_candidates: 5,
          user: "",
        }),
      ),
    ).toEqual(suggestions);
    expect(attendees).toEqual(before);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/findMeetingTimes",
        body: {
          attendees: [
            { emailAddress: { address: "ada@example.com" }, type: "required" },
            { emailAddress: { address: "grace@example.com" }, type: "required" },
          ],
          meetingDuration: "PT45M",
          maxCandidates: 5,
          minimumAttendeePercentage: 75,
          isOrganizerOptional: false,
          timeConstraint: {
            activityDomain: "work",
            timeSlots: [
              {
                start: { dateTime: "2026-07-14T09:00:00", timeZone: "Europe/London" },
                end: { dateTime: "2026-07-14T17:00:00", timeZone: "Europe/London" },
              },
            ],
          },
        },
      },
    ]);
  });

  test.each([
    { label: "no window", args: {} },
    { label: "only a start", args: { start_datetime: "2026-07-14T09:00:00" } },
    { label: "only an end", args: { end_datetime: "2026-07-14T17:00:00" } },
  ])("omits the time constraint with $label", async ({ args }) => {
    const { harness, graph } = registerCalendarHarness([{}]);

    await harness.invoke("graph_find_meeting_times", {
      attendees: ["ada@example.com"],
      ...args,
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/findMeetingTimes",
        body: {
          attendees: [{ emailAddress: { address: "ada@example.com" }, type: "required" }],
          meetingDuration: "PT30M",
          maxCandidates: 10,
          minimumAttendeePercentage: 100,
          isOrganizerOptional: false,
        },
      },
    ]);
  });

  test.each([null, [], "payload-secret"])(
    "rejects malformed findMeetingTimes response %# without leakage",
    async (response) => {
      const { harness } = registerCalendarHarness([response]);
      const result = await harness.invoke("graph_find_meeting_times", {
        attendees: ["ada@example.com"],
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("calendar cancellations", () => {
  test("posts a cancellation comment and returns the cancelled status", async () => {
    const { harness, graph } = registerCalendarHarness(["ignored-response"]);

    expect(
      dataFrom(
        await harness.invoke("graph_cancel_event", {
          event_id: "event-1",
          comment: "Rescheduling next week",
        }),
      ),
    ).toEqual({ status: "Event cancelled" });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/events/event-1/cancel",
        body: { comment: "Rescheduling next week" },
      },
    ]);
  });

  test("omits an empty cancellation comment and encodes the event ID", async () => {
    const hostileId = "../event/path\\name#fragment?query=:value%";
    const { harness, graph } = registerCalendarHarness([null]);

    await harness.invoke("graph_cancel_event", { event_id: hostileId });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: `/me/events/${encodeURIComponent(hostileId)}/cancel`,
        body: {},
      },
    ]);
  });
});

describe("calendar occurrence listing", () => {
  test("lists instances with the exact window, select fields, and capped top", async () => {
    const { harness, graph } = registerCalendarHarness([
      { value: [{ id: "occurrence-1" }] },
      { value: [] },
    ]);

    expect(
      dataFrom(
        await harness.invoke("graph_list_event_instances", {
          event_id: "series 1",
          start_datetime: "2026-07-01T00:00:00Z",
          end_datetime: "2026-07-31T23:59:59Z",
        }),
      ),
    ).toEqual([{ id: "occurrence-1" }]);
    await harness.invoke("graph_list_event_instances", {
      event_id: "series-2",
      start_datetime: "2026-07-01T00:00:00Z",
      end_datetime: "2026-07-31T23:59:59Z",
      top: 500,
    });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/events/${encodeURIComponent("series 1")}/instances`,
        params: {
          startDateTime: "2026-07-01T00:00:00Z",
          endDateTime: "2026-07-31T23:59:59Z",
          $select: EVENT_LIST_FIELDS,
          $top: "50",
        },
      },
      {
        method: "GET",
        path: "/me/events/series-2/instances",
        params: {
          startDateTime: "2026-07-01T00:00:00Z",
          endDateTime: "2026-07-31T23:59:59Z",
          $select: EVENT_LIST_FIELDS,
          $top: "50",
        },
      },
    ]);
  });

  test.each([
    { label: "an empty start", args: { start_datetime: "", end_datetime: "end" } },
    { label: "an empty end", args: { start_datetime: "start", end_datetime: "" } },
    { label: "an empty window", args: { start_datetime: "", end_datetime: "" } },
  ])("rejects $label without calling Graph", async ({ args }) => {
    const { harness, graph } = registerCalendarHarness();

    const result = await harness.invoke("graph_list_event_instances", {
      event_id: "series-1",
      ...args,
    });

    expect(payloadFrom(result)).toEqual({
      data: { error: "start_datetime and end_datetime are required to list event instances." },
      message: "error",
    });
    expect(graph.calls).toEqual([]);
  });

  test("treats a missing value property as an empty occurrence list", async () => {
    const { harness } = registerCalendarHarness([{}]);

    expect(
      dataFrom(
        await harness.invoke("graph_list_event_instances", {
          event_id: "series-1",
          start_datetime: "start",
          end_datetime: "end",
        }),
      ),
    ).toEqual([]);
  });
});

describe("calendar room listing", () => {
  test("lists every tenant room from the places cast", async () => {
    const { harness, graph } = registerCalendarHarness([{ value: [{ id: "room-1" }] }]);

    expect(dataFrom(await harness.invoke("graph_list_rooms"))).toEqual([{ id: "room-1" }]);
    expect(graph.calls).toEqual([
      { method: "GET", path: "/places/microsoft.graph.room", params: { $top: "50" } },
    ]);
  });

  test("lists a single room list through the encoded roomlist route with a capped top", async () => {
    const roomList = "building-1@bp.com";
    const { harness, graph } = registerCalendarHarness([{ value: [] }]);

    await harness.invoke("graph_list_rooms", { room_list: roomList, top: 500 });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/places/${encodeURIComponent(roomList)}/microsoft.graph.roomlist/rooms`,
        params: { $top: "50" },
      },
    ]);
  });

  test("keeps an adversarial room list inside one encoded segment", async () => {
    const roomList = "../places/rooms#fragment?query=:value%";
    const { harness, graph } = registerCalendarHarness([{ value: [] }]);

    await harness.invoke("graph_list_rooms", { room_list: roomList });

    expect(graph.calls[0]?.path).toBe(
      `/places/${encodeURIComponent(roomList)}/microsoft.graph.roomlist/rooms`,
    );
  });
});

describe("calendar rich event fields", () => {
  test("adds every non-default create field, merging optional attendees", async () => {
    const { harness, graph } = registerCalendarHarness([{ id: "event-1" }]);

    await harness.invoke("graph_create_event", {
      subject: "Planning",
      start_datetime: "2026-07-14T00:00:00",
      end_datetime: "2026-07-15T00:00:00",
      attendees: ["ada@example.com"],
      is_all_day: true,
      show_as: "workingElsewhere",
      sensitivity: "private",
      reminder_minutes_before_start: 15,
      optional_attendees: ["grace@example.com", "linus@example.com"],
      categories: ["Delivery", "Cloud"],
      allow_new_time_proposals: false,
      response_requested: false,
    });

    expect(graph.calls[0]?.body).toEqual({
      subject: "Planning",
      start: { dateTime: "2026-07-14T00:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-07-15T00:00:00", timeZone: "UTC" },
      attendees: [
        { emailAddress: { address: "ada@example.com" }, type: "required" },
        { emailAddress: { address: "grace@example.com" }, type: "optional" },
        { emailAddress: { address: "linus@example.com" }, type: "optional" },
      ],
      isAllDay: true,
      showAs: "workingElsewhere",
      sensitivity: "private",
      reminderMinutesBeforeStart: 15,
      isReminderOn: true,
      categories: ["Delivery", "Cloud"],
      allowNewTimeProposals: false,
      responseRequested: false,
    });
  });

  test("adds every non-default update field, merging optional attendees", async () => {
    const { harness, graph } = registerCalendarHarness([{ id: "event-1" }]);

    await harness.invoke("graph_update_event", {
      event_id: "event-1",
      is_all_day: true,
      show_as: "oof",
      sensitivity: "confidential",
      reminder_minutes_before_start: 0,
      optional_attendees: ["grace@example.com"],
      categories: ["Delivery"],
      allow_new_time_proposals: false,
      response_requested: false,
    });

    expect(graph.calls[0]).toEqual({
      method: "PATCH",
      path: "/me/events/event-1",
      body: {
        attendees: [{ emailAddress: { address: "grace@example.com" }, type: "optional" }],
        isAllDay: true,
        showAs: "oof",
        sensitivity: "confidential",
        reminderMinutesBeforeStart: 0,
        isReminderOn: true,
        categories: ["Delivery"],
        allowNewTimeProposals: false,
        responseRequested: false,
      },
    });
  });

  test.each([
    { name: "graph_create_event", args: { subject: "Planning" } },
    { name: "graph_update_event", args: { event_id: "event-1" } },
  ])("$name omits every default rich field", async ({ name, args }) => {
    const { harness, graph } = registerCalendarHarness([{ id: "event-1" }]);

    await harness.invoke(name, {
      ...args,
      start_datetime: name === "graph_create_event" ? "start" : "",
      end_datetime: name === "graph_create_event" ? "end" : "",
      is_all_day: false,
      show_as: "busy",
      sensitivity: "normal",
      reminder_minutes_before_start: -1,
      optional_attendees: [],
      categories: [],
      allow_new_time_proposals: true,
      response_requested: true,
    });

    const body = graph.calls[0]?.body;
    for (const key of [
      "isAllDay",
      "showAs",
      "sensitivity",
      "reminderMinutesBeforeStart",
      "isReminderOn",
      "categories",
      "allowNewTimeProposals",
      "responseRequested",
      "attendees",
      "recurrence",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  test("does not mutate the caller's category and optional attendee arrays", async () => {
    const categories = Object.freeze(["Delivery"]);
    const optional = Object.freeze(["grace@example.com"]);
    const { harness, graph } = registerCalendarHarness([{ id: "event-1" }]);

    await harness.invoke("graph_create_event", {
      subject: "Planning",
      start_datetime: "start",
      end_datetime: "end",
      categories,
      optional_attendees: optional,
    });

    expect(categories).toEqual(["Delivery"]);
    expect(optional).toEqual(["grace@example.com"]);
    expect(graph.calls[0]?.body).toMatchObject({ categories: ["Delivery"] });
  });
});

describe("calendar event recurrence", () => {
  test.each(RECURRENCE_CASES)("builds the $label recurrence", async ({ args, recurrence }) => {
    const { harness, graph } = registerCalendarHarness([{ id: "event-1" }]);

    await harness.invoke("graph_create_event", {
      subject: "Standup",
      start_datetime: "2026-07-14T09:00:00",
      end_datetime: "2026-07-14T09:15:00",
      ...args,
    });

    expect(graph.calls[0]).toEqual({
      method: "POST",
      path: "/me/events",
      body: {
        subject: "Standup",
        start: { dateTime: "2026-07-14T09:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-07-14T09:15:00", timeZone: "UTC" },
        recurrence,
      },
    });
  });

  test("omits the recurrence when repeat is none even with other repeat arguments", async () => {
    const { harness, graph } = registerCalendarHarness([{ id: "event-1" }]);

    await harness.invoke("graph_create_event", {
      subject: "Standup",
      start_datetime: "2026-07-14T09:00:00",
      end_datetime: "2026-07-14T09:15:00",
      repeat_interval: 3,
      repeat_days: ["monday"],
      repeat_count: 4,
    });

    expect(graph.calls[0]?.body).not.toHaveProperty("recurrence");
  });

  test.each([
    {
      label: "weekly recurrence with no repeat_days",
      args: { repeat: "weekly" },
      error: "repeat_days is required when repeat is weekly.",
    },
    {
      label: "both repeat_until and repeat_count",
      args: { repeat: "daily", repeat_until: "2026-12-31", repeat_count: 5 },
      error: "Provide either repeat_until or repeat_count, not both.",
    },
  ])("rejects $label without calling Graph", async ({ args, error }) => {
    const { harness, graph } = registerCalendarHarness();

    const result = await harness.invoke("graph_create_event", {
      subject: "Standup",
      start_datetime: "2026-07-14T09:00:00",
      end_datetime: "2026-07-14T09:15:00",
      ...args,
    });

    expect(payloadFrom(result)).toEqual({ data: { error }, message: "error" });
    expect(graph.calls).toEqual([]);
  });
});

describe("calendar authenticated wrapper errors", () => {
  test.each([
    { name: "graph_list_calendars", args: {} },
    { name: "graph_list_events", args: {} },
    { name: "graph_get_event", args: { event_id: "event-1" } },
    {
      name: "graph_create_event",
      args: { subject: "Planning", start_datetime: "start", end_datetime: "end" },
    },
    { name: "graph_update_event", args: { event_id: "event-1" } },
    { name: "graph_delete_event", args: { event_id: "event-1" } },
    { name: "graph_respond_to_event", args: { event_id: "event-1", response: "accept" } },
    {
      name: "graph_get_schedule",
      args: { schedules: ["ada@example.com"], start_datetime: "start", end_datetime: "end" },
    },
    { name: "graph_find_meeting_times", args: { attendees: ["ada@example.com"] } },
    { name: "graph_cancel_event", args: { event_id: "event-1" } },
    {
      name: "graph_list_event_instances",
      args: { event_id: "event-1", start_datetime: "start", end_datetime: "end" },
    },
    { name: "graph_list_rooms", args: {} },
  ])("$name returns the stable authentication error envelope", async ({ name, args }) => {
    const { harness } = registerCalendarHarness([new AuthenticationError("Not authenticated.")]);

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });
});
