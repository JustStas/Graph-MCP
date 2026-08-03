import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const USER_ID_SCHEMA = z
  .string()
  .refine((value) => value !== "" && value !== "." && value !== "..", {
    message: "user_id must not be empty, '.' or '..'.",
  });

const USER_IDS_SCHEMA = z.array(USER_ID_SCHEMA).min(1).max(650);
const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
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

export function registerPresenceTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_get_my_presence",
    {
      description: "Get the authenticated user's current presence status.",
      inputSchema: {},
    },
    async () => {
      const result = await dependencies.graphClient.get("/me/presence");
      return successResponse(result);
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_user_presence",
    {
      description: "Get another user's presence status.",
      inputSchema: {
        user_id: USER_ID_SCHEMA,
      },
    },
    async ({ user_id }) => {
      const encodedUserId = encodeURIComponent(user_id);
      const result = await dependencies.graphClient.get(`/users/${encodedUserId}/presence`);
      return successResponse(result);
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_set_my_presence",
    {
      description: "Set the authenticated user's presence status.",
      inputSchema: {
        availability: z.string(),
        activity: z.string(),
        expiration_duration: z.string().default("PT1H"),
      },
    },
    async ({ availability, activity, expiration_duration }) => {
      await dependencies.graphClient.post("/me/presence/setUserPreferredPresence", {
        sessionId: "graph-mcp",
        availability,
        activity,
        expirationDuration: expiration_duration,
      });
      return successResponse({
        status: "Presence updated",
        availability,
        activity,
      });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_presences_by_user_ids",
    {
      description: `Get presence for up to 650 users in one round trip.

Use this instead of calling graph_get_user_presence once per person. Needs
the Presence.Read.All permission.

Args:
    user_ids: User IDs to look up (1-650 per call).`,
      inputSchema: {
        user_ids: USER_IDS_SCHEMA,
      },
    },
    async ({ user_ids }) => {
      const result = await dependencies.graphClient.post("/communications/getPresencesByUserId", {
        ids: user_ids,
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_set_status_message",
    {
      description: `Set your Teams status message, the note shown under your name.

This is separate from availability, which graph_set_my_presence controls.

Args:
    message: The status message text.
    expiry_datetime: Optional expiry in ISO 8601
        (e.g. "2026-03-01T17:00:00"). Empty means the message does not expire.
    timezone: Timezone for expiry_datetime (default "UTC").`,
      inputSchema: {
        message: z.string(),
        expiry_datetime: z.string().default(""),
        timezone: z.string().default("UTC"),
      },
    },
    async ({ message, expiry_datetime, timezone }) => {
      const statusMessage: Record<string, unknown> = {
        message: { content: message, contentType: "text" },
      };
      if (expiry_datetime !== "") {
        statusMessage.expiryDateTime = { dateTime: expiry_datetime, timeZone: timezone };
      }

      await dependencies.graphClient.post("/me/presence/setStatusMessage", { statusMessage });
      return successResponse({ status: "Status message updated" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_clear_my_presence",
    {
      description: `Clear your presence. This is how you undo graph_set_my_presence.

graph_set_my_presence sets a preferred presence, so pass preferred=true to
undo it and let Teams calculate your availability again.

Args:
    preferred: Whether to clear the preferred presence set by
        graph_set_my_presence (default false clears only this app's session
        presence).`,
      inputSchema: {
        preferred: z.boolean().default(false),
      },
    },
    async ({ preferred }) => {
      if (preferred) {
        await dependencies.graphClient.post("/me/presence/clearUserPreferredPresence", {});
        return successResponse({ status: "Preferred presence cleared" });
      }

      await dependencies.graphClient.post("/me/presence/clearPresence", {
        sessionId: "Graph-MCP",
      });
      return successResponse({ status: "Presence cleared" });
    },
  );
}
