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
