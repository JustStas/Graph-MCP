import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import {
  collectionResult,
  INCLUDE_NEXT_LINK_SCHEMA,
  NEXT_LINK_SCHEMA,
  PAGING_ARGS_DOC,
} from "./list-options.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const MEETING_METADATA_FIELDS = "id,meetingId,createdDateTime,meetingOrganizer";
const EVENT_MEETING_FIELDS = "id,subject,isOnlineMeeting,onlineMeeting";
const ALLOWED_PRESENTERS_SCHEMA = z
  .enum(["everyone", "organization", "roleIsPresenter", "organizer"])
  .default("everyone");
const RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value !== "" && value !== "." && value !== "..", {
    message: "Resource IDs must not be empty, '.' or '..'.",
  });
const OPTIONAL_RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value !== "." && value !== "..", {
    message: "Resource IDs must not be '.' or '..'.",
  })
  .default("");

/** A meeting chat thread, as it appears in `chatInfo.threadId` and in a join URL path. */
const THREAD_ID_PATTERN = /^19:meeting_[\w+/=-]+@thread\.v2$/;
const ORGANIZER_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
/** Teams prints the numeric meeting ID in space-separated groups. */
const JOIN_MEETING_ID_PATTERN = /^[\d ]+$/;

const JOIN_URL_SCHEMA = z
  .string()
  .refine((value) => value === "" || value.startsWith("https://"), {
    message: "join_url must be an https Teams join URL.",
  })
  .default("");
const THREAD_ID_SCHEMA = z
  .string()
  .refine((value) => value === "" || THREAD_ID_PATTERN.test(value), {
    message: "thread_id must look like 19:meeting_<id>@thread.v2.",
  })
  .default("");
const ORGANIZER_ID_SCHEMA = z
  .string()
  .refine((value) => value === "" || ORGANIZER_ID_PATTERN.test(value), {
    message: "organizer_id must be a Microsoft Entra object ID.",
  })
  .default("");
const JOIN_MEETING_ID_SCHEMA = z
  .string()
  .refine((value) => value === "" || JOIN_MEETING_ID_PATTERN.test(value), {
    message: "join_meeting_id must contain only digits and spaces.",
  })
  .default("");

const MISSING_MEETING_LOOKUP_MESSAGE =
  "One of join_url or join_meeting_id is required. Microsoft Graph cannot list online meetings without a lookup filter; call graph_get_meeting_id to resolve a calendar event or a meeting chat thread.";
const AMBIGUOUS_MEETING_LOOKUP_MESSAGE = "Pass only one of join_url or join_meeting_id.";
const MISSING_MEETING_SOURCE_MESSAGE = "Pass exactly one of event_id, join_url or thread_id.";
const EVENT_WITHOUT_MEETING_MESSAGE =
  "That event has no online meeting. Only events whose onlineMeeting.joinUrl is set have a meeting ID.";
const UNRESOLVABLE_JOIN_URL_MESSAGE =
  "Microsoft Graph did not resolve that join URL, and the URL carries no meeting thread ID and organizer to derive an ID from. Short teams.microsoft.com/meet links omit both; look the meeting up with graph_list_online_meetings using the numeric join_meeting_id from the invite instead.";
const UNKNOWN_ORGANIZER_MESSAGE =
  "Could not resolve the signed-in user to use as the meeting organizer. Pass organizer_id explicitly.";

/**
 * Graph answers a join URL it cannot match with 404 3004 "Specified meeting is not found", and a
 * structurally unusable one with 400 1026. Neither means the request was wrong, so the resolver
 * treats both as "no meeting here" and derives the ID instead.
 */
const MEETING_LOOKUP_MISS_STATUSES = new Set([400, 404]);

/** A join URL reaches callers encoded once, or twice when copied out of the HTML invite. */
const MAX_JOIN_URL_DECODE_ROUNDS = 2;

const MEETING_ID_ARGS_DOC =
  "    meeting_id: The online meeting ID, from graph_get_meeting_id or the id\n" +
  "        field of graph_list_online_meetings.";

type GraphObject = Record<string, unknown>;

interface ResolvedMeeting {
  readonly id: string;
  readonly threadId: string;
  readonly organizerId: string;
  readonly joinWebUrl: string;
}

interface JoinUrlParts {
  readonly threadId: string;
  readonly organizerId: string;
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

function requireGraphString(response: unknown): string {
  if (typeof response !== "string") {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response;
}

function meetingPath(meetingId: string): string {
  return `/me/onlineMeetings/${encodeURIComponent(meetingId)}`;
}

/** Keep a caller-supplied value inside a single OData string literal. */
function escapeODataLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Build the lookup filter for the one meeting the caller identified. Graph matches `JoinWebUrl`
 * against the join URL exactly as it stores it, so the value goes in verbatim and only the
 * transport layer encodes it; encoding it here as well makes every lookup miss.
 */
function meetingLookupFilter(joinUrl: string, joinMeetingId: string): string {
  return joinUrl === ""
    ? `joinMeetingIdSettings/joinMeetingId eq '${escapeODataLiteral(joinMeetingId)}'`
    : `JoinWebUrl eq '${escapeODataLiteral(joinUrl)}'`;
}

function optionalGraphString(source: GraphObject, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function nestedObject(source: GraphObject, ...keys: readonly string[]): GraphObject | undefined {
  let current: GraphObject = source;
  for (const key of keys) {
    const next: unknown = current[key];
    if (!isNonArrayObject(next)) {
      return undefined;
    }
    current = next;
  }
  return current;
}

/**
 * The meeting ID Graph reports is base64 of `1*<organizer object ID>*0**<thread ID>`. Deriving it
 * is the only route left when the join URL lookup misses, so the derivation lives here rather than
 * in every caller.
 */
function composeMeetingId(organizerId: string, threadId: string): string {
  return Buffer.from(`1*${organizerId}*0**${threadId}`, "utf8").toString("base64");
}

/** Read the organizer out of a join URL's `context` parameter, which carries `Tid` and `Oid`. */
function organizerIdFromContext(url: URL): string {
  const context = url.searchParams.get("context");
  if (context === null) {
    return "";
  }

  for (const candidate of [context, decodeOnce(context)]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!isNonArrayObject(parsed)) {
      continue;
    }
    const organizerId = parsed.Oid;
    if (typeof organizerId === "string" && ORGANIZER_ID_PATTERN.test(organizerId)) {
      return organizerId;
    }
  }
  return "";
}

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Recover a thread ID from one path segment. Join URLs reach callers with the thread encoded once
 * (`19%3ameeting_...`) or, when copied out of the HTML invite, twice (`19%253ameeting_...`).
 */
function threadIdFromSegment(segment: string): string {
  let candidate = segment;
  for (let round = 0; round <= MAX_JOIN_URL_DECODE_ROUNDS; round += 1) {
    if (THREAD_ID_PATTERN.test(candidate)) {
      return candidate;
    }
    const decoded = decodeOnce(candidate);
    if (decoded === candidate) {
      return "";
    }
    candidate = decoded;
  }
  return "";
}

/**
 * Pull the thread ID and organizer out of a join URL. Long `/l/meetup-join/` links carry both;
 * short `/meet/<code>` links carry neither.
 */
function parseJoinUrl(joinUrl: string): JoinUrlParts {
  let url: URL;
  try {
    url = new URL(joinUrl);
  } catch {
    return { threadId: "", organizerId: "" };
  }

  let threadId = "";
  for (const segment of url.pathname.split("/")) {
    threadId = threadIdFromSegment(segment);
    if (threadId !== "") {
      break;
    }
  }
  return { threadId, organizerId: organizerIdFromContext(url) };
}

function resolvedMeetingFrom(meeting: GraphObject): ResolvedMeeting | undefined {
  const id = optionalGraphString(meeting, "id");
  if (id === "") {
    return undefined;
  }

  const chatInfo = nestedObject(meeting, "chatInfo");
  const organizer = nestedObject(meeting, "participants", "organizer", "identity", "user");
  return {
    id,
    threadId: chatInfo === undefined ? "" : optionalGraphString(chatInfo, "threadId"),
    organizerId: organizer === undefined ? "" : optionalGraphString(organizer, "id"),
    joinWebUrl: optionalGraphString(meeting, "joinWebUrl"),
  };
}

async function lookupMeetingByJoinUrl(
  graphClient: ToolDependencies["graphClient"],
  joinWebUrl: string,
): Promise<ResolvedMeeting | undefined> {
  let response: unknown;
  try {
    response = await graphClient.get("/me/onlineMeetings", {
      $filter: meetingLookupFilter(joinWebUrl, ""),
    });
  } catch (error: unknown) {
    if (
      error instanceof GraphApiError &&
      error.statusCode !== undefined &&
      MEETING_LOOKUP_MISS_STATUSES.has(error.statusCode)
    ) {
      return undefined;
    }
    throw error;
  }

  const [first] = collectionValue(response);
  return isNonArrayObject(first) ? resolvedMeetingFrom(first) : undefined;
}

async function eventJoinUrl(
  graphClient: ToolDependencies["graphClient"],
  eventId: string,
): Promise<string> {
  const event = requireGraphObject(
    await graphClient.get(`/me/events/${encodeURIComponent(eventId)}`, {
      $select: EVENT_MEETING_FIELDS,
    }),
  );
  const onlineMeeting = nestedObject(event, "onlineMeeting");
  return onlineMeeting === undefined ? "" : optionalGraphString(onlineMeeting, "joinUrl");
}

async function signedInUserId(graphClient: ToolDependencies["graphClient"]): Promise<string> {
  const profile = requireGraphObject(await graphClient.get("/me", { $select: "id" }));
  return optionalGraphString(profile, "id");
}

function resolvedMeetingResponse(
  resolved: ResolvedMeeting,
  source: "joinWebUrl" | "derived",
): string {
  return successResponse({
    meeting_id: resolved.id,
    thread_id: resolved.threadId,
    organizer_id: resolved.organizerId,
    join_web_url: resolved.joinWebUrl,
    source,
  });
}

export function registerMeetingTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_list_online_meetings",
    {
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
${PAGING_ARGS_DOC}`,
      inputSchema: {
        join_url: JOIN_URL_SCHEMA,
        join_meeting_id: JOIN_MEETING_ID_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ join_url, join_meeting_id, next_link, include_next_link }) => {
      const joinMeetingId = join_meeting_id.replaceAll(" ", "");
      if (next_link === "") {
        if (join_url !== "" && joinMeetingId !== "") {
          return successResponse({ error: AMBIGUOUS_MEETING_LOOKUP_MESSAGE }, "error");
        }
        if (join_url === "" && joinMeetingId === "") {
          return successResponse({ error: MISSING_MEETING_LOOKUP_MESSAGE }, "error");
        }
      }

      const result =
        next_link === ""
          ? await dependencies.graphClient.get("/me/onlineMeetings", {
              $filter: meetingLookupFilter(join_url, joinMeetingId),
            })
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_meeting_id",
    {
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
      inputSchema: {
        event_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        join_url: JOIN_URL_SCHEMA,
        thread_id: THREAD_ID_SCHEMA,
        organizer_id: ORGANIZER_ID_SCHEMA,
      },
    },
    async ({ event_id, join_url, thread_id, organizer_id }) => {
      const sources = [event_id, join_url, thread_id].filter((value) => value !== "");
      if (sources.length !== 1) {
        return successResponse({ error: MISSING_MEETING_SOURCE_MESSAGE }, "error");
      }

      if (thread_id !== "") {
        const organizerId =
          organizer_id === "" ? await signedInUserId(dependencies.graphClient) : organizer_id;
        if (organizerId === "") {
          return successResponse({ error: UNKNOWN_ORGANIZER_MESSAGE }, "error");
        }
        return resolvedMeetingResponse(
          {
            id: composeMeetingId(organizerId, thread_id),
            threadId: thread_id,
            organizerId,
            joinWebUrl: "",
          },
          "derived",
        );
      }

      const joinWebUrl =
        event_id === "" ? join_url : await eventJoinUrl(dependencies.graphClient, event_id);
      if (joinWebUrl === "") {
        return successResponse({ error: EVENT_WITHOUT_MEETING_MESSAGE }, "error");
      }

      const parts = parseJoinUrl(joinWebUrl);
      const looked = await lookupMeetingByJoinUrl(dependencies.graphClient, joinWebUrl);
      if (looked !== undefined) {
        return resolvedMeetingResponse(
          {
            id: looked.id,
            threadId: looked.threadId === "" ? parts.threadId : looked.threadId,
            organizerId: looked.organizerId === "" ? parts.organizerId : looked.organizerId,
            joinWebUrl: looked.joinWebUrl === "" ? joinWebUrl : looked.joinWebUrl,
          },
          "joinWebUrl",
        );
      }

      if (parts.threadId === "" || parts.organizerId === "") {
        return successResponse({ error: UNRESOLVABLE_JOIN_URL_MESSAGE }, "error");
      }
      return resolvedMeetingResponse(
        {
          id: composeMeetingId(parts.organizerId, parts.threadId),
          threadId: parts.threadId,
          organizerId: parts.organizerId,
          joinWebUrl,
        },
        "derived",
      );
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_meeting_transcripts",
    {
      description: `List available transcripts for an online meeting.

Args:
${MEETING_ID_ARGS_DOC}
${PAGING_ARGS_DOC}`,
      inputSchema: {
        meeting_id: RESOURCE_ID_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ meeting_id, next_link, include_next_link }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get(`${meetingPath(meeting_id)}/transcripts`, {
              $select: MEETING_METADATA_FIELDS,
            })
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_transcript_content",
    {
      description: `Get the text content of a meeting transcript.

Returns the transcript in VTT (Web Video Text Tracks) format,
which includes timestamps and speaker attribution.

Args:
${MEETING_ID_ARGS_DOC}
    transcript_id: The transcript ID (from graph_list_meeting_transcripts).`,
      inputSchema: {
        meeting_id: RESOURCE_ID_SCHEMA,
        transcript_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ meeting_id, transcript_id }) => {
      const result = await dependencies.graphClient.get(
        `${meetingPath(meeting_id)}/transcripts/${encodeURIComponent(transcript_id)}/content`,
        { $format: "text/vtt" },
      );
      return successResponse({ format: "text/vtt", content: requireGraphString(result) });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_meeting_recordings",
    {
      description: `List available recordings for an online meeting.

Args:
${MEETING_ID_ARGS_DOC}
${PAGING_ARGS_DOC}`,
      inputSchema: {
        meeting_id: RESOURCE_ID_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ meeting_id, next_link, include_next_link }) => {
      const result =
        next_link === ""
          ? await dependencies.graphClient.get(`${meetingPath(meeting_id)}/recordings`, {
              $select: MEETING_METADATA_FIELDS,
            })
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_meeting_recording_url",
    {
      description: `Get metadata and download URL for a meeting recording.

Returns recording metadata including a temporary download URL.
The recording content itself is binary video and is not returned inline.

Args:
${MEETING_ID_ARGS_DOC}
    recording_id: The recording ID (from graph_list_meeting_recordings).`,
      inputSchema: {
        meeting_id: RESOURCE_ID_SCHEMA,
        recording_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ meeting_id, recording_id }) => {
      const result = await dependencies.graphClient.get(
        `${meetingPath(meeting_id)}/recordings/${encodeURIComponent(recording_id)}`,
      );
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_create_online_meeting",
    {
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
      inputSchema: {
        subject: z.string(),
        start_datetime: z.string(),
        end_datetime: z.string(),
        attendees: z.array(z.string()).nullable().optional().default(null),
        allowed_presenters: ALLOWED_PRESENTERS_SCHEMA,
      },
    },
    async ({ subject, start_datetime, end_datetime, attendees, allowed_presenters }) => {
      const payload: GraphObject = {
        subject,
        startDateTime: start_datetime,
        endDateTime: end_datetime,
      };
      if (attendees !== null && attendees !== undefined && attendees.length > 0) {
        payload.participants = {
          attendees: attendees.map((attendee) => ({ upn: attendee })),
        };
      }
      if (allowed_presenters !== "everyone") {
        payload.allowedPresenters = allowed_presenters;
      }

      const result = await dependencies.graphClient.post("/me/onlineMeetings", payload);
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_online_meeting",
    {
      description: `Get a single online meeting, including its join link and settings.

Args:
${MEETING_ID_ARGS_DOC}`,
      inputSchema: {
        meeting_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ meeting_id }) => {
      const result = await dependencies.graphClient.get(meetingPath(meeting_id));
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_meeting_attendance",
    {
      description: `Get meeting attendance: who actually joined and for how long.

Without report_id this lists the available attendance reports. With
report_id it returns that report expanded with per-attendee join and leave
times, and the paging arguments do not apply. Needs the
OnlineMeetingArtifact.Read.All permission, which requires admin consent.

Args:
${MEETING_ID_ARGS_DOC}
    report_id: Attendance report ID. Empty lists the available reports.
${PAGING_ARGS_DOC}`,
      inputSchema: {
        meeting_id: RESOURCE_ID_SCHEMA,
        report_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ meeting_id, report_id, next_link, include_next_link }) => {
      const reportsPath = `${meetingPath(meeting_id)}/attendanceReports`;
      if (report_id === "") {
        const result =
          next_link === ""
            ? await dependencies.graphClient.get(reportsPath)
            : await dependencies.graphClient.get(next_link);
        return successResponse(
          collectionResult(collectionValue(result), result, include_next_link),
        );
      }

      const result = await dependencies.graphClient.get(
        `${reportsPath}/${encodeURIComponent(report_id)}`,
        { $expand: "attendanceRecords" },
      );
      return successResponse(requireGraphObject(result));
    },
  );
}
