import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { successResponse } from "../responses.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

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
        user_id: z.string(),
      },
    },
    async ({ user_id }) => {
      const result = await dependencies.graphClient.get(`/users/${user_id}/presence`);
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
}
