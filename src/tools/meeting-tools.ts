import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const MEETING_METADATA_FIELDS = "id,meetingId,createdDateTime,meetingOrganizer";
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
              If empty, returns recent meetings.`,
      inputSchema: {
        join_url: z.string().default(""),
      },
    },
    async ({ join_url }) => {
      const params: Record<string, string> = {};
      if (join_url !== "") {
        const escapedJoinUrl = join_url.replaceAll("'", "''");
        params.$filter = `JoinWebUrl eq '${encodeURIComponent(escapedJoinUrl)}'`;
      }
      const result = await dependencies.graphClient.get("/me/onlineMeetings", params);
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_meeting_transcripts",
    {
      description: `List available transcripts for an online meeting.

Args:
    meeting_id: The online meeting ID (from graph_list_online_meetings).`,
      inputSchema: {
        meeting_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ meeting_id }) => {
      const result = await dependencies.graphClient.get(`${meetingPath(meeting_id)}/transcripts`, {
        $select: MEETING_METADATA_FIELDS,
      });
      return successResponse(collectionValue(result));
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
    meeting_id: The online meeting ID (from graph_list_online_meetings).`,
      inputSchema: {
        meeting_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ meeting_id }) => {
      const result = await dependencies.graphClient.get(`${meetingPath(meeting_id)}/recordings`, {
        $select: MEETING_METADATA_FIELDS,
      });
      return successResponse(collectionValue(result));
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
}
