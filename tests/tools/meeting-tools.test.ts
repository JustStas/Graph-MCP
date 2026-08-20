import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError, GraphApiError } from "../../src/errors.js";
import { registerMeetingTools } from "../../src/tools/meeting-tools.js";
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
}

const MEETING_METADATA_FIELDS = "id,meetingId,createdDateTime,meetingOrganizer";

const EXPECTED_MEETING_TOOLS = [
  {
    name: "graph_list_online_meetings",
    description: `Look up an online meeting by join URL or by the numeric meeting ID.

Microsoft Graph has no unfiltered list of online meetings, so exactly one of
join_url or join_meeting_id is required; without one the request fails with "One
of the required parameters to lookup meeting by QueryOptions is null or empty".
Either lookup returns a collection holding at most one meeting. When you only
have a calendar event or a meeting chat thread, call graph_get_meeting_id.

Args:
    join_url: Teams meeting join URL, passed exactly as Graph reports it in
        onlineMeeting.joinUrl. Empty to look up by join_meeting_id.
    join_meeting_id: The numeric meeting ID printed in the invite, with or
        without spaces (for example "359 232 213 325 013"). Empty to look up by
        join_url.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
  },
  {
    name: "graph_get_meeting_id",
    description: `Resolve the online meeting ID that the other meeting tools require.

Takes a calendar event, a Teams join URL, or a meeting chat thread and returns
the ID used by graph_get_online_meeting, graph_list_meeting_transcripts,
graph_get_transcript_content, graph_list_meeting_recordings,
graph_get_meeting_recording_url and graph_get_meeting_attendance. It prefers the
join URL lookup Graph documents and, when that finds nothing, derives the ID
from the meeting thread and organizer instead, so it still answers for meetings
the lookup misses. The returned "source" says which route produced the ID.

Only meetings the signed-in user organized are reachable through the delegated
meeting tools, whoever owns the calendar item.

Args:
    event_id: Calendar event ID to resolve. Empty to use join_url or thread_id.
    join_url: Teams meeting join URL to resolve. Empty to use event_id or
        thread_id.
    thread_id: Meeting chat thread ID such as "19:meeting_<id>@thread.v2".
        Empty to use event_id or join_url.
    organizer_id: The organizer's Microsoft Entra object ID. Used only with
        thread_id; empty resolves the signed-in user.`,
  },
  {
    name: "graph_list_meeting_transcripts",
    description: `List available transcripts for an online meeting.

Args:
    meeting_id: The online meeting ID, from graph_get_meeting_id or the id
        field of graph_list_online_meetings.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
  },
  {
    name: "graph_get_transcript_content",
    description: `Get the text content of a meeting transcript.

Returns the transcript in VTT (Web Video Text Tracks) format,
which includes timestamps and speaker attribution.

Args:
    meeting_id: The online meeting ID, from graph_get_meeting_id or the id
        field of graph_list_online_meetings.
    transcript_id: The transcript ID (from graph_list_meeting_transcripts).`,
  },
  {
    name: "graph_list_meeting_recordings",
    description: `List available recordings for an online meeting.

Args:
    meeting_id: The online meeting ID, from graph_get_meeting_id or the id
        field of graph_list_online_meetings.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
  },
  {
    name: "graph_get_meeting_recording_url",
    description: `Get metadata and download URL for a meeting recording.

Returns recording metadata including a temporary download URL.
The recording content itself is binary video and is not returned inline.

Args:
    meeting_id: The online meeting ID, from graph_get_meeting_id or the id
        field of graph_list_online_meetings.
    recording_id: The recording ID (from graph_list_meeting_recordings).`,
  },
  {
    name: "graph_create_online_meeting",
    description: `Create a Teams online meeting and get its join link.

The \`joinWebUrl\` field in the response is the link to share. This creates a
meeting without a calendar event; use graph_create_event with
is_online_meeting for a meeting that also appears on calendars. Needs the
OnlineMeetings.ReadWrite permission.

Args:
    subject: Meeting subject.
    start_datetime: Start time in ISO 8601 with an offset or Z
        (e.g. "2026-03-01T10:00:00Z").
    end_datetime: End time in ISO 8601 with an offset or Z.
    attendees: Optional list of attendee email addresses or user IDs.
    allowed_presenters: Who can present: "everyone", "organization",
        "roleIsPresenter", or "organizer" (default "everyone").`,
  },
  {
    name: "graph_get_online_meeting",
    description: `Get a single online meeting, including its join link and settings.

Args:
    meeting_id: The online meeting ID, from graph_get_meeting_id or the id
        field of graph_list_online_meetings.`,
  },
  {
    name: "graph_get_meeting_attendance",
    description: `Get meeting attendance: who actually joined and for how long.

Without report_id this lists the available attendance reports. With
report_id it returns that report expanded with per-attendee join and leave
times, and the paging arguments do not apply. Needs the
OnlineMeetingArtifact.Read.All permission, which requires admin consent.

Args:
    meeting_id: The online meeting ID, from graph_get_meeting_id or the id
        field of graph_list_online_meetings.
    report_id: Attendance report ID. Empty lists the available reports.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
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

function countODataStringLiterals(filter: string): number {
  let literals = 0;
  let insideLiteral = false;

  for (let index = 0; index < filter.length; index += 1) {
    if (filter[index] !== "'") {
      continue;
    }
    if (insideLiteral && filter[index + 1] === "'") {
      index += 1;
      continue;
    }
    insideLiteral = !insideLiteral;
    if (!insideLiteral) {
      literals += 1;
    }
  }

  if (insideLiteral) {
    throw new Error("Expected a balanced OData string literal.");
  }
  return literals;
}

function registerMeetingHarness(graphResponses: readonly unknown[] = []): {
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
  registerMeetingTools(harness.server, dependencies);
  return { harness, graph };
}

describe("meeting tool registration", () => {
  test("registers exactly the nine meeting names and complete descriptions", () => {
    const { harness } = registerMeetingHarness();

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_MEETING_TOOLS);
  });

  test("exposes exact public snake_case schemas, defaults, and required fields", () => {
    const { harness } = registerMeetingHarness();

    const listShape = schemaFor(harness, "graph_list_online_meetings");
    expect(Object.keys(listShape)).toEqual([
      "join_url",
      "join_meeting_id",
      "next_link",
      "include_next_link",
    ]);
    expect(z.object(listShape).parse({})).toEqual({
      join_url: "",
      join_meeting_id: "",
      next_link: "",
      include_next_link: false,
    });
    for (const join_url of ["teams.example/join", "http://teams.example/join"]) {
      expect(z.object(listShape).safeParse({ join_url }).success).toBe(false);
    }
    for (const join_meeting_id of ["359 232 213 325 013", "359232213325013"]) {
      expect(z.object(listShape).safeParse({ join_meeting_id }).success).toBe(true);
    }
    expect(z.object(listShape).safeParse({ join_meeting_id: "359-232" }).success).toBe(false);

    const transcriptsShape = schemaFor(harness, "graph_list_meeting_transcripts");
    expect(Object.keys(transcriptsShape)).toEqual(["meeting_id", "next_link", "include_next_link"]);
    expect(z.object(transcriptsShape).safeParse({}).success).toBe(false);
    expect(z.object(transcriptsShape).parse({ meeting_id: "meeting-1" })).toEqual({
      meeting_id: "meeting-1",
      next_link: "",
      include_next_link: false,
    });

    const contentShape = schemaFor(harness, "graph_get_transcript_content");
    expect(Object.keys(contentShape)).toEqual(["meeting_id", "transcript_id"]);
    expect(z.object(contentShape).safeParse({ meeting_id: "meeting-1" }).success).toBe(false);

    const resolveShape = schemaFor(harness, "graph_get_meeting_id");
    expect(Object.keys(resolveShape)).toEqual([
      "event_id",
      "join_url",
      "thread_id",
      "organizer_id",
    ]);
    const resolveSchema = z.object(resolveShape);
    expect(resolveSchema.parse({})).toEqual({
      event_id: "",
      join_url: "",
      thread_id: "",
      organizer_id: "",
    });
    for (const thread_id of ["19:meeting_abc@thread.v2", "19:meeting_a-b_c=@thread.v2"]) {
      expect(resolveSchema.safeParse({ thread_id }).success).toBe(true);
    }
    for (const thread_id of ["19:meeting_abc@thread.skype", "meeting_abc", "19:abc@thread.v2"]) {
      expect(resolveSchema.safeParse({ thread_id }).success).toBe(false);
    }
    expect(
      resolveSchema.safeParse({ organizer_id: "a322b5f4-8a0a-4ca0-a507-4517dcfffa11" }).success,
    ).toBe(true);
    expect(resolveSchema.safeParse({ organizer_id: "not-a-guid" }).success).toBe(false);
    for (const event_id of [".", ".."]) {
      expect(resolveSchema.safeParse({ event_id }).success).toBe(false);
    }

    const recordingsShape = schemaFor(harness, "graph_list_meeting_recordings");
    expect(Object.keys(recordingsShape)).toEqual(["meeting_id", "next_link", "include_next_link"]);
    expect(z.object(recordingsShape).safeParse({}).success).toBe(false);
    expect(z.object(recordingsShape).parse({ meeting_id: "meeting-1" })).toEqual({
      meeting_id: "meeting-1",
      next_link: "",
      include_next_link: false,
    });

    const recordingShape = schemaFor(harness, "graph_get_meeting_recording_url");
    expect(Object.keys(recordingShape)).toEqual(["meeting_id", "recording_id"]);
    expect(z.object(recordingShape).safeParse({ meeting_id: "meeting-1" }).success).toBe(false);
  });

  test("rejects empty and dot-segment meeting, transcript, and recording IDs", () => {
    const { harness } = registerMeetingHarness();
    const cases = [
      { name: "graph_list_meeting_transcripts", key: "meeting_id", base: {} },
      {
        name: "graph_get_transcript_content",
        key: "meeting_id",
        base: { transcript_id: "transcript-1" },
      },
      {
        name: "graph_get_transcript_content",
        key: "transcript_id",
        base: { meeting_id: "meeting-1" },
      },
      { name: "graph_list_meeting_recordings", key: "meeting_id", base: {} },
      {
        name: "graph_get_meeting_recording_url",
        key: "meeting_id",
        base: { recording_id: "recording-1" },
      },
      {
        name: "graph_get_meeting_recording_url",
        key: "recording_id",
        base: { meeting_id: "meeting-1" },
      },
    ];

    for (const row of cases) {
      const schema = z.object(schemaFor(harness, row.name));
      for (const value of ["", ".", ".."]) {
        expect(schema.safeParse({ ...row.base, [row.key]: value }).success).toBe(false);
      }
    }
  });
});

describe("meeting list operations", () => {
  test("filters on the join URL verbatim so Graph can match what it stores", async () => {
    const joinUrl =
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d";
    const { harness, graph } = registerMeetingHarness([{ value: [{ id: "meeting-1" }] }]);

    expect(
      dataFrom(await harness.invoke("graph_list_online_meetings", { join_url: joinUrl })),
    ).toEqual([{ id: "meeting-1" }]);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/onlineMeetings",
        params: { $filter: `JoinWebUrl eq '${joinUrl}'` },
      },
    ]);
    // Encoding the value here as well as in the transport layer is what made every
    // joinWebUrl lookup answer 404 3004 "Specified meeting is not found".
    expect(graph.calls[0]?.params).not.toEqual({
      $filter: `JoinWebUrl eq '${encodeURIComponent(joinUrl)}'`,
    });
  });

  test("filters on joinMeetingId and drops the spaces the invite prints", async () => {
    const { harness, graph } = registerMeetingHarness([{ value: [{ id: "meeting-1" }] }]);

    expect(
      dataFrom(
        await harness.invoke("graph_list_online_meetings", {
          join_meeting_id: "359 232 213 325 013",
        }),
      ),
    ).toEqual([{ id: "meeting-1" }]);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/onlineMeetings",
        params: { $filter: "joinMeetingIdSettings/joinMeetingId eq '359232213325013'" },
      },
    ]);
  });

  test("refuses a lookup with no filter or with two, without calling Graph", async () => {
    const missing = registerMeetingHarness();
    expect(dataFrom(await missing.harness.invoke("graph_list_online_meetings"))).toEqual({
      error:
        "One of join_url or join_meeting_id is required. Microsoft Graph cannot list online meetings without a lookup filter; call graph_get_meeting_id to resolve a calendar event or a meeting chat thread.",
    });
    expect(missing.graph.calls).toEqual([]);

    const ambiguous = registerMeetingHarness();
    expect(
      dataFrom(
        await ambiguous.harness.invoke("graph_list_online_meetings", {
          join_url: "https://teams.example/join/abc",
          join_meeting_id: "359232213325013",
        }),
      ),
    ).toEqual({ error: "Pass only one of join_url or join_meeting_id." });
    expect(ambiguous.graph.calls).toEqual([]);
  });

  test("keeps apostrophes and an injected OR inside one OData string literal", async () => {
    const joinUrl = "https://teams.example/join/x' OR JoinWebUrl ne 'https://evil.example/";
    const escapedJoinUrl = joinUrl.replaceAll("'", "''");
    const { harness, graph } = registerMeetingHarness([{ value: [] }]);

    await harness.invoke("graph_list_online_meetings", { join_url: joinUrl });

    const filter = (graph.calls[0]?.params as Record<string, unknown> | undefined)?.$filter;
    expect(filter).toBe(`JoinWebUrl eq '${escapedJoinUrl}'`);
    expect(typeof filter).toBe("string");
    expect(countODataStringLiterals(filter as string)).toBe(1);
  });

  test("lists transcript metadata from the exact encoded meeting path and select", async () => {
    const meetingId = "meeting/with#fragment?query=value";
    const { harness, graph } = registerMeetingHarness([{ value: [{ id: "transcript-1" }] }]);

    expect(
      dataFrom(await harness.invoke("graph_list_meeting_transcripts", { meeting_id: meetingId })),
    ).toEqual([{ id: "transcript-1" }]);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`,
        params: { $select: MEETING_METADATA_FIELDS },
      },
    ]);
  });

  test("lists recording metadata from the exact encoded meeting path and select", async () => {
    const meetingId = "meeting/with#fragment?query=value";
    const { harness, graph } = registerMeetingHarness([{ value: [{ id: "recording-1" }] }]);

    expect(
      dataFrom(await harness.invoke("graph_list_meeting_recordings", { meeting_id: meetingId })),
    ).toEqual([{ id: "recording-1" }]);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/onlineMeetings/${encodeURIComponent(meetingId)}/recordings`,
        params: { $select: MEETING_METADATA_FIELDS },
      },
    ]);
  });

  test.each([
    { name: "graph_list_online_meetings", args: { join_url: "https://teams.example/meet" } },
    { name: "graph_list_meeting_transcripts", args: { meeting_id: "meeting-1" } },
    { name: "graph_list_meeting_recordings", args: { meeting_id: "meeting-1" } },
  ])("$name treats a missing value property as an empty list", async ({ name, args }) => {
    const { harness } = registerMeetingHarness([{}]);
    expect(dataFrom(await harness.invoke(name, args))).toEqual([]);
  });

  test.each([null, [], "payload-secret", { value: null }, { value: {} }])(
    "rejects malformed meeting collection response %# without leakage",
    async (response) => {
      const { harness } = registerMeetingHarness([response]);
      const result = await harness.invoke("graph_list_online_meetings", {
        join_url: "https://teams.example/meet",
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("meeting transcript and recording operations", () => {
  test("gets raw VTT transcript content from the exact encoded route and format", async () => {
    const meetingId = "meeting/../id#fragment";
    const transcriptId = "transcript/../id?query=value";
    const vtt = "WEBVTT\n\n00:00.000 --> 00:01.000\nSpeaker: Hello";
    const { harness, graph } = registerMeetingHarness([vtt]);

    expect(
      dataFrom(
        await harness.invoke("graph_get_transcript_content", {
          meeting_id: meetingId,
          transcript_id: transcriptId,
        }),
      ),
    ).toEqual({ format: "text/vtt", content: vtt });
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`,
        params: { $format: "text/vtt" },
      },
    ]);
  });

  test.each([null, [], {}, 42, { secret: "payload-secret" }])(
    "rejects malformed transcript content %# without leakage",
    async (response) => {
      const { harness } = registerMeetingHarness([response]);
      const result = await harness.invoke("graph_get_transcript_content", {
        meeting_id: "meeting-1",
        transcript_id: "transcript-1",
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );

  test("returns the complete recording metadata object unchanged", async () => {
    const recording = {
      id: "recording-1",
      meetingId: "meeting-1",
      createdDateTime: "2026-07-14T10:00:00Z",
      recordingContentUrl: "https://download.example/temporary",
      nested: { custom: true },
    };
    const { harness, graph } = registerMeetingHarness([recording]);

    expect(
      dataFrom(
        await harness.invoke("graph_get_meeting_recording_url", {
          meeting_id: "meeting-1",
          recording_id: "recording-1",
        }),
      ),
    ).toEqual(recording);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/onlineMeetings/meeting-1/recordings/recording-1",
      },
    ]);
  });

  test.each([null, [], "payload-secret", 42])(
    "rejects malformed recording metadata %# without leakage",
    async (response) => {
      const { harness } = registerMeetingHarness([response]);
      const result = await harness.invoke("graph_get_meeting_recording_url", {
        meeting_id: "meeting-1",
        recording_id: "recording-1",
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );

  test("encodes both meeting and child IDs as individual path segments", async () => {
    const meetingId = "../meeting/path\\name#fragment?query=:value%";
    const transcriptId = "../transcript/path\\name#fragment?query=:value%";
    const recordingId = "../recording/path\\name#fragment?query=:value%";
    const { harness, graph } = registerMeetingHarness(["WEBVTT", { id: recordingId }]);

    await harness.invoke("graph_get_transcript_content", {
      meeting_id: meetingId,
      transcript_id: transcriptId,
    });
    await harness.invoke("graph_get_meeting_recording_url", {
      meeting_id: meetingId,
      recording_id: recordingId,
    });

    expect(graph.calls.map(({ path }) => path)).toEqual([
      `/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`,
      `/me/onlineMeetings/${encodeURIComponent(meetingId)}/recordings/${encodeURIComponent(recordingId)}`,
    ]);
  });
});

describe("meeting authenticated wrapper errors", () => {
  test.each([
    { name: "graph_list_online_meetings", args: { join_url: "https://teams.example/meet" } },
    { name: "graph_get_meeting_id", args: { join_url: "https://teams.example/meet" } },
    { name: "graph_list_meeting_transcripts", args: { meeting_id: "meeting-1" } },
    {
      name: "graph_get_transcript_content",
      args: { meeting_id: "meeting-1", transcript_id: "transcript-1" },
    },
    { name: "graph_list_meeting_recordings", args: { meeting_id: "meeting-1" } },
    {
      name: "graph_get_meeting_recording_url",
      args: { meeting_id: "meeting-1", recording_id: "recording-1" },
    },
  ])("$name returns the stable authentication error envelope", async ({ name, args }) => {
    const { harness } = registerMeetingHarness([new AuthenticationError("Not authenticated.")]);

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });
});

describe("online meeting creation and lookup", () => {
  test("exposes exact schemas, defaults, and required fields for the new meeting tools", () => {
    const { harness } = registerMeetingHarness();

    const createShape = schemaFor(harness, "graph_create_online_meeting");
    expect(Object.keys(createShape)).toEqual([
      "subject",
      "start_datetime",
      "end_datetime",
      "attendees",
      "allowed_presenters",
    ]);
    const createSchema = z.object(createShape);
    expect(
      createSchema.parse({
        subject: "Sync",
        start_datetime: "2026-03-01T10:00:00Z",
        end_datetime: "2026-03-01T11:00:00Z",
      }),
    ).toEqual({
      subject: "Sync",
      start_datetime: "2026-03-01T10:00:00Z",
      end_datetime: "2026-03-01T11:00:00Z",
      attendees: null,
      allowed_presenters: "everyone",
    });
    expect(
      createSchema.safeParse({
        subject: "Sync",
        start_datetime: "2026-03-01T10:00:00Z",
        end_datetime: "2026-03-01T11:00:00Z",
        allowed_presenters: "nobody",
      }).success,
    ).toBe(false);
    for (const presenters of ["everyone", "organization", "roleIsPresenter", "organizer"]) {
      expect(
        createSchema.safeParse({
          subject: "Sync",
          start_datetime: "2026-03-01T10:00:00Z",
          end_datetime: "2026-03-01T11:00:00Z",
          allowed_presenters: presenters,
        }).success,
      ).toBe(true);
    }
    expect(createSchema.safeParse({ subject: "Sync" }).success).toBe(false);

    const getShape = schemaFor(harness, "graph_get_online_meeting");
    expect(Object.keys(getShape)).toEqual(["meeting_id"]);
    expect(z.object(getShape).safeParse({}).success).toBe(false);
    for (const value of ["", ".", ".."]) {
      expect(z.object(getShape).safeParse({ meeting_id: value }).success).toBe(false);
    }

    const attendanceShape = schemaFor(harness, "graph_get_meeting_attendance");
    expect(Object.keys(attendanceShape)).toEqual([
      "meeting_id",
      "report_id",
      "next_link",
      "include_next_link",
    ]);
    const attendanceSchema = z.object(attendanceShape);
    expect(attendanceSchema.parse({ meeting_id: "meeting-1" })).toEqual({
      meeting_id: "meeting-1",
      report_id: "",
      next_link: "",
      include_next_link: false,
    });
    for (const value of [".", ".."]) {
      expect(
        attendanceSchema.safeParse({ meeting_id: "meeting-1", report_id: value }).success,
      ).toBe(false);
    }
    for (const value of ["", ".", ".."]) {
      expect(attendanceSchema.safeParse({ meeting_id: value }).success).toBe(false);
    }
  });

  test("creates a meeting with only the required body fields at defaults", async () => {
    const created = { id: "meeting-1", joinWebUrl: "https://teams.example/join/abc" };
    const { harness, graph } = registerMeetingHarness([created]);

    expect(
      dataFrom(
        await harness.invoke("graph_create_online_meeting", {
          subject: "Sync",
          start_datetime: "2026-03-01T10:00:00Z",
          end_datetime: "2026-03-01T11:00:00+01:00",
        }),
      ),
    ).toEqual(created);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/onlineMeetings",
        body: {
          subject: "Sync",
          startDateTime: "2026-03-01T10:00:00Z",
          endDateTime: "2026-03-01T11:00:00+01:00",
        },
      },
    ]);
  });

  test("adds attendees as upn participants and a non-default allowedPresenters", async () => {
    const { harness, graph } = registerMeetingHarness([{ id: "meeting-1" }, { id: "meeting-2" }]);

    await harness.invoke("graph_create_online_meeting", {
      subject: "Sync",
      start_datetime: "2026-03-01T10:00:00Z",
      end_datetime: "2026-03-01T11:00:00Z",
      attendees: ["ada@example.com", "grace@example.com"],
      allowed_presenters: "organizer",
    });
    await harness.invoke("graph_create_online_meeting", {
      subject: "Sync",
      start_datetime: "2026-03-01T10:00:00Z",
      end_datetime: "2026-03-01T11:00:00Z",
      attendees: [],
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/onlineMeetings",
        body: {
          subject: "Sync",
          startDateTime: "2026-03-01T10:00:00Z",
          endDateTime: "2026-03-01T11:00:00Z",
          participants: {
            attendees: [{ upn: "ada@example.com" }, { upn: "grace@example.com" }],
          },
          allowedPresenters: "organizer",
        },
      },
      {
        method: "POST",
        path: "/me/onlineMeetings",
        body: {
          subject: "Sync",
          startDateTime: "2026-03-01T10:00:00Z",
          endDateTime: "2026-03-01T11:00:00Z",
        },
      },
    ]);
  });

  test("gets a single meeting from the exact encoded path", async () => {
    const meetingId = "meeting/../id#fragment?query=value";
    const meeting = { id: "meeting-1", joinWebUrl: "https://teams.example/join/abc" };
    const { harness, graph } = registerMeetingHarness([meeting]);

    expect(
      dataFrom(await harness.invoke("graph_get_online_meeting", { meeting_id: meetingId })),
    ).toEqual(meeting);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/onlineMeetings/${encodeURIComponent(meetingId)}`,
      },
    ]);
  });

  test("lists attendance reports without report_id and expands one report with it", async () => {
    const meetingId = "meeting/../id";
    const reportId = "report/../id#fragment";
    const report = {
      id: "report-1",
      attendanceRecords: [{ emailAddress: "ada@example.com", totalAttendanceInSeconds: 1800 }],
    };
    const { harness, graph } = registerMeetingHarness([{ value: [{ id: "report-1" }] }, report]);

    expect(
      dataFrom(await harness.invoke("graph_get_meeting_attendance", { meeting_id: meetingId })),
    ).toEqual([{ id: "report-1" }]);
    expect(
      dataFrom(
        await harness.invoke("graph_get_meeting_attendance", {
          meeting_id: meetingId,
          report_id: reportId,
        }),
      ),
    ).toEqual(report);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/onlineMeetings/${encodeURIComponent(meetingId)}/attendanceReports`,
      },
      {
        method: "GET",
        path: `/me/onlineMeetings/${encodeURIComponent(meetingId)}/attendanceReports/${encodeURIComponent(reportId)}`,
        params: { $expand: "attendanceRecords" },
      },
    ]);
  });

  test("treats a missing attendance value property as an empty list", async () => {
    const { harness } = registerMeetingHarness([{}]);

    expect(
      dataFrom(await harness.invoke("graph_get_meeting_attendance", { meeting_id: "meeting-1" })),
    ).toEqual([]);
  });

  test.each([null, [], "payload-secret", 42])(
    "rejects malformed created meeting, meeting, and report objects %# without leakage",
    async (response) => {
      const invocations = [
        {
          name: "graph_create_online_meeting",
          args: {
            subject: "Sync",
            start_datetime: "2026-03-01T10:00:00Z",
            end_datetime: "2026-03-01T11:00:00Z",
          },
        },
        { name: "graph_get_online_meeting", args: { meeting_id: "meeting-1" } },
        {
          name: "graph_get_meeting_attendance",
          args: { meeting_id: "meeting-1", report_id: "report-1" },
        },
      ] as const;

      for (const { name, args } of invocations) {
        const { harness } = registerMeetingHarness([response]);
        const result = await harness.invoke(name, args);

        expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
        expect(JSON.stringify(result)).not.toContain("payload-secret");
        expect(JSON.stringify(result)).not.toContain("TypeError");
      }
    },
  );

  test.each([
    {
      name: "graph_create_online_meeting",
      args: {
        subject: "Sync",
        start_datetime: "2026-03-01T10:00:00Z",
        end_datetime: "2026-03-01T11:00:00Z",
      },
    },
    { name: "graph_get_online_meeting", args: { meeting_id: "meeting-1" } },
    { name: "graph_get_meeting_attendance", args: { meeting_id: "meeting-1" } },
    {
      name: "graph_get_meeting_attendance",
      args: { meeting_id: "meeting-1", report_id: "report-1" },
    },
  ])("$name returns the stable error envelopes", async ({ name, args }) => {
    const auth = registerMeetingHarness([new AuthenticationError("Not authenticated.")]);
    await expect(auth.harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);

    const graphError = registerMeetingHarness([new GraphApiError("403: Access denied", 403)]);
    await expect(graphError.harness.invoke(name, args)).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"error":"Graph API error: 403: Access denied"}',
        },
      ],
    });
  });
});

describe("meeting id resolution", () => {
  const ORGANIZER_ID = "11111111-2222-3333-4444-555555555555";
  const THREAD_ID = "19:meeting_ZmFrZS10aHJlYWQ@thread.v2";
  /** base64("1*<organizer>*0**<thread>"), the shape Graph reports as onlineMeeting.id. */
  const DERIVED_MEETING_ID =
    "MSoxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUqMCoqMTk6bWVldGluZ19abUZyWlMxMGFISmxZV1FAdGhyZWFkLnYy";
  const JOIN_URL =
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmFrZS10aHJlYWQ%40thread.v2/0?context=%7b%22Tid%22%3a%22aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee%22%2c%22Oid%22%3a%2211111111-2222-3333-4444-555555555555%22%7d";
  const LOOKUP_FILTER = `JoinWebUrl eq '${JOIN_URL}'`;

  test("prefers the join URL lookup and reports Graph's own id", async () => {
    const { harness, graph } = registerMeetingHarness([
      {
        value: [
          {
            id: "graph-supplied-id",
            joinWebUrl: "https://teams.microsoft.com/canonical",
            chatInfo: { threadId: THREAD_ID, messageId: "0" },
            participants: {
              organizer: { identity: { user: { id: ORGANIZER_ID } } },
            },
          },
        ],
      },
    ]);

    expect(dataFrom(await harness.invoke("graph_get_meeting_id", { join_url: JOIN_URL }))).toEqual({
      meeting_id: "graph-supplied-id",
      thread_id: THREAD_ID,
      organizer_id: ORGANIZER_ID,
      join_web_url: "https://teams.microsoft.com/canonical",
      source: "joinWebUrl",
    });
    expect(graph.calls).toEqual([
      { method: "GET", path: "/me/onlineMeetings", params: { $filter: LOOKUP_FILTER } },
    ]);
  });

  test.each([
    {
      label: "404 3004",
      error: new GraphApiError("404: 3004: Specified meeting is not found", 404),
    },
    { label: "400 1026", error: new GraphApiError("400: 1026: An error has occurred.", 400) },
    { label: "an empty collection", error: { value: [] } },
    { label: "a meeting without an id", error: { value: [{ subject: "Sync" }] } },
  ])("derives the id from the join URL when the lookup answers $label", async ({ error }) => {
    const { harness, graph } = registerMeetingHarness([error]);

    expect(dataFrom(await harness.invoke("graph_get_meeting_id", { join_url: JOIN_URL }))).toEqual({
      meeting_id: DERIVED_MEETING_ID,
      thread_id: THREAD_ID,
      organizer_id: ORGANIZER_ID,
      join_web_url: JOIN_URL,
      source: "derived",
    });
    expect(graph.calls).toEqual([
      { method: "GET", path: "/me/onlineMeetings", params: { $filter: LOOKUP_FILTER } },
    ]);
  });

  test("still reports a Graph error the lookup miss statuses do not cover", async () => {
    const { harness } = registerMeetingHarness([new GraphApiError("403: Access denied", 403)]);

    await expect(harness.invoke("graph_get_meeting_id", { join_url: JOIN_URL })).resolves.toEqual({
      content: [{ type: "text", text: '{"error":"Graph API error: 403: Access denied"}' }],
    });
  });

  test("reads the join URL off an event before looking it up", async () => {
    const eventId = "event/../id#fragment";
    const { harness, graph } = registerMeetingHarness([
      { id: "event-1", isOnlineMeeting: true, onlineMeeting: { joinUrl: JOIN_URL } },
      { value: [{ id: "graph-supplied-id" }] },
    ]);

    expect(dataFrom(await harness.invoke("graph_get_meeting_id", { event_id: eventId }))).toEqual({
      meeting_id: "graph-supplied-id",
      thread_id: THREAD_ID,
      organizer_id: ORGANIZER_ID,
      join_web_url: JOIN_URL,
      source: "joinWebUrl",
    });
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: `/me/events/${encodeURIComponent(eventId)}`,
        params: { $select: "id,subject,isOnlineMeeting,onlineMeeting" },
      },
      { method: "GET", path: "/me/onlineMeetings", params: { $filter: LOOKUP_FILTER } },
    ]);
  });

  test("reports an event with no online meeting without attempting a lookup", async () => {
    const { harness, graph } = registerMeetingHarness([{ id: "event-1", isOnlineMeeting: false }]);

    expect(dataFrom(await harness.invoke("graph_get_meeting_id", { event_id: "event-1" }))).toEqual(
      {
        error:
          "That event has no online meeting. Only events whose onlineMeeting.joinUrl is set have a meeting ID.",
      },
    );
    expect(graph.calls).toHaveLength(1);
  });

  test("derives the id from a thread and an explicit organizer without calling Graph", async () => {
    const { harness, graph } = registerMeetingHarness();

    expect(
      dataFrom(
        await harness.invoke("graph_get_meeting_id", {
          thread_id: THREAD_ID,
          organizer_id: ORGANIZER_ID,
        }),
      ),
    ).toEqual({
      meeting_id: DERIVED_MEETING_ID,
      thread_id: THREAD_ID,
      organizer_id: ORGANIZER_ID,
      join_web_url: "",
      source: "derived",
    });
    expect(graph.calls).toEqual([]);
  });

  test("falls back to the signed-in user as the thread's organizer", async () => {
    const { harness, graph } = registerMeetingHarness([{ id: ORGANIZER_ID }]);

    expect(
      dataFrom(await harness.invoke("graph_get_meeting_id", { thread_id: THREAD_ID })),
    ).toEqual({
      meeting_id: DERIVED_MEETING_ID,
      thread_id: THREAD_ID,
      organizer_id: ORGANIZER_ID,
      join_web_url: "",
      source: "derived",
    });
    expect(graph.calls).toEqual([{ method: "GET", path: "/me", params: { $select: "id" } }]);
  });

  test("reports an unidentifiable signed-in user instead of a malformed id", async () => {
    const { harness } = registerMeetingHarness([{ displayName: "Ada" }]);

    expect(
      dataFrom(await harness.invoke("graph_get_meeting_id", { thread_id: THREAD_ID })),
    ).toEqual({
      error:
        "Could not resolve the signed-in user to use as the meeting organizer. Pass organizer_id explicitly.",
    });
  });

  test.each([
    { label: "no source", args: {} },
    { label: "two sources", args: { event_id: "event-1", thread_id: THREAD_ID } },
    { label: "three sources", args: { event_id: "e", join_url: JOIN_URL, thread_id: THREAD_ID } },
  ])("refuses $label without calling Graph", async ({ args }) => {
    const { harness, graph } = registerMeetingHarness();

    expect(dataFrom(await harness.invoke("graph_get_meeting_id", args))).toEqual({
      error: "Pass exactly one of event_id, join_url or thread_id.",
    });
    expect(graph.calls).toEqual([]);
  });

  test("explains that a short meet link carries nothing to derive an id from", async () => {
    const shortLink = "https://teams.microsoft.com/meet/359232213325013?p=secret";
    const { harness } = registerMeetingHarness([{ value: [] }]);

    expect(dataFrom(await harness.invoke("graph_get_meeting_id", { join_url: shortLink }))).toEqual(
      {
        error:
          "Microsoft Graph did not resolve that join URL, and the URL carries no meeting thread ID and organizer to derive an ID from. Short teams.microsoft.com/meet links omit both; look the meeting up with graph_list_online_meetings using the numeric join_meeting_id from the invite instead.",
      },
    );
  });

  test("reads a double-encoded context parameter", async () => {
    const doubleEncoded =
      "https://teams.microsoft.com/l/meetup-join/19%253ameeting_ZmFrZS10aHJlYWQ%2540thread.v2/0?context=%257b%2522Oid%2522%253a%252211111111-2222-3333-4444-555555555555%2522%257d";
    const { harness } = registerMeetingHarness([{ value: [] }]);

    expect(
      dataFrom(await harness.invoke("graph_get_meeting_id", { join_url: doubleEncoded })),
    ).toEqual({
      meeting_id: DERIVED_MEETING_ID,
      thread_id: THREAD_ID,
      organizer_id: ORGANIZER_ID,
      join_web_url: doubleEncoded,
      source: "derived",
    });
  });
});

describe("meeting list paging", () => {
  const MEETING_NEXT_LINK =
    "https://graph.microsoft.com/v1.0/me/onlineMeetings/meeting-1/transcripts?$skiptoken=abc123";

  const PAGING_INVOCATIONS = [
    { name: "graph_list_online_meetings", args: { join_url: "https://teams.example/meet" } },
    { name: "graph_list_meeting_transcripts", args: { meeting_id: "meeting-1" } },
    { name: "graph_list_meeting_recordings", args: { meeting_id: "meeting-1" } },
    { name: "graph_get_meeting_attendance", args: { meeting_id: "meeting-1" } },
  ] as const;

  test.each(PAGING_INVOCATIONS)(
    "$name fetches next_link as a bare absolute URL and ignores the other arguments",
    async ({ name, args }) => {
      const { harness, graph } = registerMeetingHarness([{ value: [{ id: "page-2" }] }]);

      expect(
        dataFrom(await harness.invoke(name, { ...args, next_link: MEETING_NEXT_LINK })),
      ).toEqual([{ id: "page-2" }]);
      expect(graph.calls).toEqual([{ method: "GET", path: MEETING_NEXT_LINK }]);
    },
  );

  test.each(PAGING_INVOCATIONS)(
    "$name wraps the result as {items, next_link} only when include_next_link is set",
    async ({ name, args }) => {
      const bare = registerMeetingHarness([
        { value: [{ id: "item-1" }], "@odata.nextLink": MEETING_NEXT_LINK },
      ]);
      expect(dataFrom(await bare.harness.invoke(name, args))).toEqual([{ id: "item-1" }]);

      const wrapped = registerMeetingHarness([
        { value: [{ id: "item-1" }], "@odata.nextLink": MEETING_NEXT_LINK },
      ]);
      expect(
        dataFrom(await wrapped.harness.invoke(name, { ...args, include_next_link: true })),
      ).toEqual({ items: [{ id: "item-1" }], next_link: MEETING_NEXT_LINK });

      const lastPage = registerMeetingHarness([{ value: [{ id: "item-1" }] }]);
      expect(
        dataFrom(await lastPage.harness.invoke(name, { ...args, include_next_link: true })),
      ).toEqual({ items: [{ id: "item-1" }], next_link: "" });
    },
  );

  test.each(PAGING_INVOCATIONS)("$name only accepts a Graph v1.0 next_link", ({ name, args }) => {
    const { harness } = registerMeetingHarness();
    const schema = z.object(schemaFor(harness, name));

    for (const next_link of [
      "https://evil.example.com/v1.0/me/onlineMeetings",
      "https://graph.microsoft.com/beta/me/onlineMeetings",
      "/me/onlineMeetings?$skiptoken=abc",
    ]) {
      expect(schema.safeParse({ ...args, next_link }).success).toBe(false);
    }
    expect(schema.safeParse({ ...args, next_link: MEETING_NEXT_LINK }).success).toBe(true);
  });

  test("ignores next_link when a single attendance report is requested", async () => {
    const report = { id: "report-1", attendanceRecords: [] };
    const { harness, graph } = registerMeetingHarness([report]);

    expect(
      dataFrom(
        await harness.invoke("graph_get_meeting_attendance", {
          meeting_id: "meeting-1",
          report_id: "report-1",
          next_link: MEETING_NEXT_LINK,
          include_next_link: true,
        }),
      ),
    ).toEqual(report);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/onlineMeetings/meeting-1/attendanceReports/report-1",
        params: { $expand: "attendanceRecords" },
      },
    ]);
  });
});
