from graph_mcp._select_fields import EVENT_LIST_FIELDS
from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response


def register_calendar_tools(mcp):
    @mcp.tool()
    @require_auth
    async def graph_list_calendars() -> str:
        """List the authenticated user's calendars."""
        result = await graph_client.get(
            "/me/calendars",
            params={"$select": "id,name,color,isDefaultCalendar"},
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_list_events(
        start_datetime: str = "",
        end_datetime: str = "",
        calendar_id: str = "",
        top: int = 50,
    ) -> str:
        """List calendar events. Uses calendarView for date ranges, /events otherwise.

        Args:
            start_datetime: Start of date range (ISO 8601, e.g. "2025-01-01T00:00:00Z"). Required with end_datetime for date range queries.
            end_datetime: End of date range (ISO 8601). Required with start_datetime.
            calendar_id: Optional calendar ID. Defaults to primary calendar.
            top: Maximum number of events to return (default 50).
        """
        params: dict[str, str] = {
            "$select": EVENT_LIST_FIELDS,
            "$top": str(min(top, 50)),
        }

        if start_datetime and end_datetime:
            params["startDateTime"] = start_datetime
            params["endDateTime"] = end_datetime
            if calendar_id:
                path = f"/me/calendars/{calendar_id}/calendarView"
            else:
                path = "/me/calendarView"
        else:
            params["$orderby"] = "start/dateTime desc"
            if calendar_id:
                path = f"/me/calendars/{calendar_id}/events"
            else:
                path = "/me/events"

        result = await graph_client.get(path, params=params)
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_get_event(event_id: str) -> str:
        """Get full details of a specific calendar event.

        Args:
            event_id: The event ID.
        """
        result = await graph_client.get(f"/me/events/{event_id}")
        return success_response(result)

    @mcp.tool()
    @require_auth
    async def graph_create_event(
        subject: str,
        start_datetime: str,
        end_datetime: str,
        timezone: str = "UTC",
        body: str = "",
        location: str = "",
        attendees: list[str] | None = None,
        is_online_meeting: bool = False,
        is_html: bool = False,
    ) -> str:
        """Create a new calendar event.

        Args:
            subject: Event subject/title.
            start_datetime: Start time in ISO 8601 (e.g. "2025-03-01T10:00:00").
            end_datetime: End time in ISO 8601 (e.g. "2025-03-01T11:00:00").
            timezone: Timezone (default "UTC"). Examples: "Pacific Standard Time", "Europe/London".
            body: Optional event body/description.
            location: Optional location name.
            attendees: Optional list of attendee email addresses.
            is_online_meeting: Whether to create a Teams online meeting (default false).
            is_html: Whether the body is HTML (default: plain text).
        """
        event: dict = {
            "subject": subject,
            "start": {"dateTime": start_datetime, "timeZone": timezone},
            "end": {"dateTime": end_datetime, "timeZone": timezone},
        }
        if body:
            content_type = "HTML" if is_html else "Text"
            event["body"] = {"contentType": content_type, "content": body}
        if location:
            event["location"] = {"displayName": location}
        if attendees:
            event["attendees"] = [
                {
                    "emailAddress": {"address": addr},
                    "type": "required",
                }
                for addr in attendees
            ]
        if is_online_meeting:
            event["isOnlineMeeting"] = True
            event["onlineMeetingProvider"] = "teamsForBusiness"

        result = await graph_client.post("/me/events", json_body=event)
        return success_response(result)

    @mcp.tool()
    @require_auth
    async def graph_update_event(
        event_id: str,
        subject: str = "",
        start_datetime: str = "",
        end_datetime: str = "",
        timezone: str = "",
        body: str = "",
        location: str = "",
        is_html: bool = False,
    ) -> str:
        """Update an existing calendar event. Only provided fields are updated.

        Args:
            event_id: The event ID to update.
            subject: New subject/title.
            start_datetime: New start time (ISO 8601). Requires timezone.
            end_datetime: New end time (ISO 8601). Requires timezone.
            timezone: Timezone for start/end times.
            body: New body/description.
            location: New location name.
            is_html: Whether the body is HTML (default: plain text).
        """
        updates: dict = {}
        if subject:
            updates["subject"] = subject
        if start_datetime:
            tz = timezone or "UTC"
            updates["start"] = {"dateTime": start_datetime, "timeZone": tz}
        if end_datetime:
            tz = timezone or "UTC"
            updates["end"] = {"dateTime": end_datetime, "timeZone": tz}
        if body:
            content_type = "HTML" if is_html else "Text"
            updates["body"] = {"contentType": content_type, "content": body}
        if location:
            updates["location"] = {"displayName": location}

        result = await graph_client.patch(
            f"/me/events/{event_id}", json_body=updates
        )
        return success_response(result)

    @mcp.tool()
    @require_auth
    async def graph_delete_event(event_id: str) -> str:
        """Delete a calendar event.

        Args:
            event_id: The event ID to delete.
        """
        await graph_client.delete(f"/me/events/{event_id}")
        return success_response({"status": "Event deleted"})
