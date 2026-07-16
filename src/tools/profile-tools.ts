import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { successResponse } from "../responses.js";
import { USER_PROFILE_FIELDS } from "../select-fields.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

export function registerProfileTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_get_profile",
    {
      description: "Get the authenticated user's Microsoft 365 profile.",
      inputSchema: {},
    },
    async () => {
      const result = await dependencies.graphClient.get("/me", {
        $select: USER_PROFILE_FIELDS,
      });
      return successResponse(result);
    },
  );
}
