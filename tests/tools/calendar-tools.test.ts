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
    description: "List the authenticated user's calendars.",
  },
  {
    name: "graph_list_events",
    description: "List calendar events. Uses calendarView for date ranges, /events otherwise.",
  },
  {
    name: "graph_get_event",
    description: "Get full details of a specific calendar event.",
  },
  {
    name: "graph_create_event",
    description: "Create a new calendar event.",
  },
  {
    name: "graph_update_event",
    description: "Update an existing calendar event. Only provided fields are updated.",
  },
  {
    name: "graph_delete_event",
    description: "Delete a calendar event.",
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

describe("calendar tool registration", () => {
  test("registers exactly the six legacy calendar names and first-line descriptions", () => {
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

    expect(schemaFor(harness, "graph_list_calendars")).toEqual({});

    const listShape = schemaFor(harness, "graph_list_events");
    expect(Object.keys(listShape)).toEqual([
      "start_datetime",
      "end_datetime",
      "calendar_id",
      "top",
    ]);
    const listSchema = z.object(listShape);
    expect(listSchema.parse({})).toEqual({
      start_datetime: "",
      end_datetime: "",
      calendar_id: "",
      top: 50,
    });
    expect(listSchema.safeParse({ top: 1.5 }).success).toBe(false);
    expect(listSchema.safeParse({ top: -1 }).success).toBe(true);
    expect(listSchema.safeParse({ top: 500 }).success).toBe(true);

    const getShape = schemaFor(harness, "graph_get_event");
    expect(Object.keys(getShape)).toEqual(["event_id"]);
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

    const updateShape = schemaFor(harness, "graph_update_event");
    expect(Object.keys(updateShape)).toEqual([
      "event_id",
      "subject",
      "start_datetime",
      "end_datetime",
      "timezone",
      "body",
      "location",
      "is_html",
    ]);
    expect(z.object(updateShape).parse({ event_id: "event-1" })).toEqual({
      event_id: "event-1",
      subject: "",
      start_datetime: "",
      end_datetime: "",
      timezone: "",
      body: "",
      location: "",
      is_html: false,
    });

    const deleteShape = schemaFor(harness, "graph_delete_event");
    expect(Object.keys(deleteShape)).toEqual(["event_id"]);
    expect(z.object(deleteShape).safeParse({}).success).toBe(false);
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
  ])("$name returns the stable authentication error envelope", async ({ name, args }) => {
    const { harness } = registerCalendarHarness([new AuthenticationError("Not authenticated.")]);

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });
});
