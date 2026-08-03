import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { USER_PROFILE_FIELDS } from "../select-fields.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";

const OPTIONAL_RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value === "" || (value !== "." && value !== ".."), {
    message: "Resource IDs must not be '.' or '..'.",
  })
  .default("");

function escapeKqlStringToken(value: string): string {
  return value.replaceAll('"', '""');
}

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userSearchValues(response: unknown): unknown[] {
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

function requireGraphObject(response: unknown): Record<string, unknown> {
  if (!isNonArrayObject(response)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response;
}

function userRoot(userId: string): string {
  return userId === "" ? "/me" : `/users/${encodeURIComponent(userId)}`;
}

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
      const escapedQuery = escapeKqlStringToken(query);
      const result = await dependencies.graphClient.get(
        "/users",
        {
          $search: `"displayName:${escapedQuery}" OR "mail:${escapedQuery}"`,
          $select: USER_PROFILE_FIELDS,
          $top: String(Math.min(top, 25)),
        },
        { ConsistencyLevel: "eventual" },
      );
      return successResponse(userSearchValues(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_get_manager",
    {
      description: `Get a user's manager from the organization directory.

Reading someone else's manager requires the User.Read.All permission.

Args:
    user_id: User ID or email address. Empty targets the signed-in user.`,
      inputSchema: {
        user_id: OPTIONAL_RESOURCE_ID_SCHEMA,
      },
    },
    async ({ user_id }) => {
      const result = await dependencies.graphClient.get(`${userRoot(user_id)}/manager`, {
        $select: USER_PROFILE_FIELDS,
      });
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_direct_reports",
    {
      description: `List the people who report directly to a user.

Reading someone else's direct reports requires the User.Read.All permission.

Args:
    user_id: User ID or email address. Empty targets the signed-in user.
    top: Maximum number of reports to return (default 50, maximum 50).`,
      inputSchema: {
        user_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        top: z.number().int().default(50),
      },
    },
    async ({ user_id, top }) => {
      const result = await dependencies.graphClient.get(`${userRoot(user_id)}/directReports`, {
        $select: USER_PROFILE_FIELDS,
        $top: String(Math.min(top, 50)),
      });
      return successResponse(userSearchValues(result));
    },
  );
}
