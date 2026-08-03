import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { USER_COMPACT_FIELDS, USER_PROFILE_FIELDS } from "../select-fields.js";
import {
  collectionResult,
  COMPACT_ARGS_DOC,
  COMPACT_SCHEMA,
  INCLUDE_NEXT_LINK_SCHEMA,
  NEXT_LINK_SCHEMA,
  PAGING_ARGS_DOC,
  selectFields,
  SKIP_ARGS_DOC,
  SKIP_SCHEMA,
} from "./list-options.js";
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

interface PagedCollectionRequest {
  /** Absolute nextLink from a previous page. Empty means start from `path`. */
  readonly nextLink: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly includeNextLink: boolean;
  readonly headers: Record<string, string> | undefined;
}

/**
 * Fetch one page of a collection. A nextLink already carries every query parameter Graph
 * needs, so it is requested bare and the caller's paging arguments are ignored. The headers
 * still travel with it, because /users keeps requiring ConsistencyLevel on every page.
 */
async function pagedCollection(
  graphClient: ToolDependencies["graphClient"],
  request: PagedCollectionRequest,
): Promise<string> {
  const response =
    request.nextLink === ""
      ? await graphClient.get(request.path, request.params, request.headers)
      : await graphClient.get(request.nextLink, undefined, request.headers);
  return successResponse(
    collectionResult(userSearchValues(response), response, request.includeNextLink),
  );
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
      description: `Search for users in the organization directory by name or email.

Graph does not support \`$skip\` alongside \`$search\` on /users, so page with
next_link instead of an offset.

Args:
    query: Name or email address to look up.
    top: Maximum number of users to return (default 10, maximum 25).
${COMPACT_ARGS_DOC}
${PAGING_ARGS_DOC}`,
      inputSchema: {
        query: z.string(),
        top: z.number().int().default(10),
        compact: COMPACT_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ query, top, compact, next_link, include_next_link }) => {
      const escapedQuery = escapeKqlStringToken(query);

      return await pagedCollection(dependencies.graphClient, {
        nextLink: next_link,
        path: "/users",
        params: {
          $search: `"displayName:${escapedQuery}" OR "mail:${escapedQuery}"`,
          $select: selectFields(USER_PROFILE_FIELDS, USER_COMPACT_FIELDS, compact),
          $top: String(Math.min(top, 25)),
        },
        includeNextLink: include_next_link,
        headers: { ConsistencyLevel: "eventual" },
      });
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
    top: Maximum number of reports to return (default 50, maximum 50).
${SKIP_ARGS_DOC}
${COMPACT_ARGS_DOC}
${PAGING_ARGS_DOC}`,
      inputSchema: {
        user_id: OPTIONAL_RESOURCE_ID_SCHEMA,
        top: z.number().int().default(50),
        skip: SKIP_SCHEMA,
        compact: COMPACT_SCHEMA,
        next_link: NEXT_LINK_SCHEMA,
        include_next_link: INCLUDE_NEXT_LINK_SCHEMA,
      },
    },
    async ({ user_id, top, skip, compact, next_link, include_next_link }) => {
      const params: Record<string, string> = {
        $select: selectFields(USER_PROFILE_FIELDS, USER_COMPACT_FIELDS, compact),
        $top: String(Math.min(top, 50)),
      };
      if (skip > 0) {
        params.$skip = String(skip);
      }

      return await pagedCollection(dependencies.graphClient, {
        nextLink: next_link,
        path: `${userRoot(user_id)}/directReports`,
        params,
        includeNextLink: include_next_link,
        headers: undefined,
      });
    },
  );
}
