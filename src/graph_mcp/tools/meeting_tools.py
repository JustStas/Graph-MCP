from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response


def register_meeting_tools(mcp):
    @mcp.tool()
    @require_auth
    async def graph_list_online_meetings(join_url: str = "") -> str:
        """List online meetings. Filter by join URL to find a specific meeting.

        Args:
            join_url: Teams meeting join URL to look up a specific meeting.
                      If empty, returns recent meetings.
        """
        params: dict[str, str] = {}
        if join_url:
            params["$filter"] = f"JoinWebUrl eq '{join_url}'"

        result = await graph_client.get("/me/onlineMeetings", params=params)
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_list_meeting_transcripts(meeting_id: str) -> str:
        """List available transcripts for an online meeting.

        Args:
            meeting_id: The online meeting ID (from graph_list_online_meetings).
        """
        result = await graph_client.get(
            f"/me/onlineMeetings/{meeting_id}/transcripts",
            params={"$select": "id,meetingId,createdDateTime,meetingOrganizer"},
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_get_meeting_transcript_content(
        meeting_id: str, transcript_id: str
    ) -> str:
        """Get the text content of a meeting transcript.

        Returns the transcript in VTT (Web Video Text Tracks) format,
        which includes timestamps and speaker attribution.

        Args:
            meeting_id: The online meeting ID.
            transcript_id: The transcript ID (from graph_list_meeting_transcripts).
        """
        content = await graph_client.get(
            f"/me/onlineMeetings/{meeting_id}/transcripts/{transcript_id}/content",
            params={"$format": "text/vtt"},
        )
        # Content is returned as raw text (VTT), not JSON
        return success_response({"format": "text/vtt", "content": content})

    @mcp.tool()
    @require_auth
    async def graph_list_meeting_recordings(meeting_id: str) -> str:
        """List available recordings for an online meeting.

        Args:
            meeting_id: The online meeting ID (from graph_list_online_meetings).
        """
        result = await graph_client.get(
            f"/me/onlineMeetings/{meeting_id}/recordings",
            params={"$select": "id,meetingId,createdDateTime,meetingOrganizer"},
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_get_meeting_recording_url(
        meeting_id: str, recording_id: str
    ) -> str:
        """Get metadata and download URL for a meeting recording.

        Returns recording metadata including a temporary download URL.
        The recording content itself is binary video and is not returned inline.

        Args:
            meeting_id: The online meeting ID.
            recording_id: The recording ID (from graph_list_meeting_recordings).
        """
        result = await graph_client.get(
            f"/me/onlineMeetings/{meeting_id}/recordings/{recording_id}",
        )
        return success_response(result)
