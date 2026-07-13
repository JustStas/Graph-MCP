import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { successResponse } from "../responses.js";
import { USER_PROFILE_FIELDS } from "../select-fields.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

export function registerUserTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_search_users",
    {
      description: "Search for users in the organization directory by name or email.",
      inputSchema: {
        query: z.string(),
        top: z.number().int().default(10),
      },
    },
    async ({ query, top }) => {
      const result = (await dependencies.graphClient.get(
        "/users",
        {
          $search: `"displayName:${query}" OR "mail:${query}"`,
          $select: USER_PROFILE_FIELDS,
          $top: String(Math.min(top, 25)),
        },
        { ConsistencyLevel: "eventual" },
      )) as { readonly value?: unknown };
      return successResponse(result.value ?? []);
    },
  );
}
