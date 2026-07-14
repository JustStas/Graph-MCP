import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError } from "../../src/errors.js";
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
    description: `List online meetings. Filter by join URL to find a specific meeting.

Args:
    join_url: Teams meeting join URL to look up a specific meeting.
              If empty, returns recent meetings.`,
  },
  {
    name: "graph_list_meeting_transcripts",
    description: `List available transcripts for an online meeting.

Args:
    meeting_id: The online meeting ID (from graph_list_online_meetings).`,
  },
  {
    name: "graph_get_meeting_transcript_content",
    description: `Get the text content of a meeting transcript.

Returns the transcript in VTT (Web Video Text Tracks) format,
which includes timestamps and speaker attribution.

Args:
    meeting_id: The online meeting ID.
    transcript_id: The transcript ID (from graph_list_meeting_transcripts).`,
  },
  {
    name: "graph_list_meeting_recordings",
    description: `List available recordings for an online meeting.

Args:
    meeting_id: The online meeting ID (from graph_list_online_meetings).`,
  },
  {
    name: "graph_get_meeting_recording_url",
    description: `Get metadata and download URL for a meeting recording.

Returns recording metadata including a temporary download URL.
The recording content itself is binary video and is not returned inline.

Args:
    meeting_id: The online meeting ID.
    recording_id: The recording ID (from graph_list_meeting_recordings).`,
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
  test("registers exactly the five legacy meeting names and complete descriptions", () => {
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
    expect(Object.keys(listShape)).toEqual(["join_url"]);
    expect(z.object(listShape).parse({})).toEqual({ join_url: "" });

    const transcriptsShape = schemaFor(harness, "graph_list_meeting_transcripts");
    expect(Object.keys(transcriptsShape)).toEqual(["meeting_id"]);
    expect(z.object(transcriptsShape).safeParse({}).success).toBe(false);

    const contentShape = schemaFor(harness, "graph_get_meeting_transcript_content");
    expect(Object.keys(contentShape)).toEqual(["meeting_id", "transcript_id"]);
    expect(z.object(contentShape).safeParse({ meeting_id: "meeting-1" }).success).toBe(false);

    const recordingsShape = schemaFor(harness, "graph_list_meeting_recordings");
    expect(Object.keys(recordingsShape)).toEqual(["meeting_id"]);
    expect(z.object(recordingsShape).safeParse({}).success).toBe(false);

    const recordingShape = schemaFor(harness, "graph_get_meeting_recording_url");
    expect(Object.keys(recordingShape)).toEqual(["meeting_id", "recording_id"]);
    expect(z.object(recordingShape).safeParse({ meeting_id: "meeting-1" }).success).toBe(false);
  });

  test("rejects empty and dot-segment meeting, transcript, and recording IDs", () => {
    const { harness } = registerMeetingHarness();
    const cases = [
      { name: "graph_list_meeting_transcripts", key: "meeting_id", base: {} },
      {
        name: "graph_get_meeting_transcript_content",
        key: "meeting_id",
        base: { transcript_id: "transcript-1" },
      },
      {
        name: "graph_get_meeting_transcript_content",
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
  test("lists meetings with exact empty params and encodes a join URL inside the filter", async () => {
    const joinUrl = "https://teams.example/join/abc?tenant=bp&name=R&D#agenda";
    const { harness, graph } = registerMeetingHarness([
      { value: [{ id: "meeting-1" }] },
      { value: [{ id: "meeting-2" }] },
    ]);

    expect(dataFrom(await harness.invoke("graph_list_online_meetings"))).toEqual([
      { id: "meeting-1" },
    ]);
    expect(
      dataFrom(await harness.invoke("graph_list_online_meetings", { join_url: joinUrl })),
    ).toEqual([{ id: "meeting-2" }]);
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/onlineMeetings",
        params: {},
      },
      {
        method: "GET",
        path: "/me/onlineMeetings",
        params: { $filter: `JoinWebUrl eq '${encodeURIComponent(joinUrl)}'` },
      },
    ]);
  });

  test("keeps apostrophes and an injected OR inside one encoded OData string literal", async () => {
    const joinUrl = "https://teams.example/join/x' OR JoinWebUrl ne 'https://evil.example/";
    const escapedJoinUrl = joinUrl.replaceAll("'", "''");
    const { harness, graph } = registerMeetingHarness([{ value: [] }]);

    await harness.invoke("graph_list_online_meetings", { join_url: joinUrl });

    const filter = (graph.calls[0]?.params as Record<string, unknown> | undefined)?.$filter;
    expect(filter).toBe(`JoinWebUrl eq '${encodeURIComponent(escapedJoinUrl)}'`);
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
    { name: "graph_list_online_meetings", args: {} },
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
      const result = await harness.invoke("graph_list_online_meetings");

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
        await harness.invoke("graph_get_meeting_transcript_content", {
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
      const result = await harness.invoke("graph_get_meeting_transcript_content", {
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

    await harness.invoke("graph_get_meeting_transcript_content", {
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
    { name: "graph_list_online_meetings", args: {} },
    { name: "graph_list_meeting_transcripts", args: { meeting_id: "meeting-1" } },
    {
      name: "graph_get_meeting_transcript_content",
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
