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
const ALLOWED_PRESENTERS_SCHEMA = z
  .enum(["everyone", "organization", "roleIsPresenter", "organizer"])
  .default("everyone");
const RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value !== "" && value !== "." && value !== "..", {
    message: "Resource IDs must not be empty, '.' or '..'.",
  });

type GraphObject = Record<string, unknown>;

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

export function registerMeetingTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_list_online_meetings",
    {
      description: `List online meetings. Filter by join URL to find a specific meeting.

Args:
    join_url: Teams meeting join URL to look up a specific meeting.
              If empty, returns recent meetings.
${PAGING_ARGS_DOC}`,
      inputSchema: {
        join_url: z.string().default(""),
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ join_url, next_link, include_next_link }) => {
      const params: Record<string, string> = {};
      if (join_url !== "") {
        const escapedJoinUrl = join_url.replaceAll("'", "''");
        params.$filter = `JoinWebUrl eq '${encodeURIComponent(escapedJoinUrl)}'`;
      }
      const result =
        next_link === ""
          ? await dependencies.graphClient.get("/me/onlineMeetings", params)
          : await dependencies.graphClient.get(next_link);
      return successResponse(collectionResult(collectionValue(result), result, include_next_link));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_meeting_transcripts",
    {
      description: `List available transcripts for an online meeting.

Args:
    meeting_id: The online meeting ID (from graph_list_online_meetings).
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
    "graph_get_meeting_transcript_content",
    {
      description: `Get the text content of a meeting transcript.

Returns the transcript in VTT (Web Video Text Tracks) format,
which includes timestamps and speaker attribution.

Args:
    meeting_id: The online meeting ID.
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
    meeting_id: The online meeting ID (from graph_list_online_meetings).
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
    meeting_id: The online meeting ID.
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
    meeting_id: The online meeting ID (from graph_list_online_meetings).`,
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
    meeting_id: The online meeting ID (from graph_list_online_meetings).
    report_id: Attendance report ID. Empty lists the available reports.
${PAGING_ARGS_DOC}`,
      inputSchema: {
        meeting_id: RESOURCE_ID_SCHEMA,
        report_id: z
          .string()
          .refine((value) => value !== "." && value !== "..", {
            message: "Resource IDs must not be '.' or '..'.",
          })
          .default(""),
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
