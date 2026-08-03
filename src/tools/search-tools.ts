import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const INVALID_ENTITY_TYPE_COMBINATION_MESSAGE =
  "chatMessage cannot be combined with SharePoint entity types.";
const SHAREPOINT_ENTITY_TYPES = new Set<string>(["drive", "driveItem", "site", "list", "listItem"]);
const UNKNOWN_ENUM_ENTITY_TYPES = new Set<string>(["chatMessage", "person"]);
const ENTITY_TYPE_SCHEMA = z.enum([
  "message",
  "event",
  "driveItem",
  "drive",
  "site",
  "list",
  "listItem",
  "chatMessage",
  "person",
]);

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireGraphObject(value: unknown): Record<string, unknown> {
  if (!isNonArrayObject(value)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return value;
}

function optionalGraphArray(
  response: Readonly<Record<string, unknown>>,
  property: string,
): unknown[] {
  if (!Object.hasOwn(response, property)) {
    return [];
  }
  const value = response[property];
  if (!Array.isArray(value)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return value;
}

export function registerSearchTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_search_messages",
    {
      description: "Search messages across Teams chats and channels.",
      inputSchema: {
        query: z.string(),
        top: z.number().int().default(25),
      },
    },
    async ({ query, top }) => {
      const result = await dependencies.graphClient.post("/search/query", {
        requests: [
          {
            entityTypes: ["chatMessage"],
            query: { queryString: query },
            from: 0,
            size: Math.min(top, 25),
          },
        ],
      });
      const hits: unknown[] = [];

      for (const responseValue of optionalGraphArray(requireGraphObject(result), "value")) {
        const response = requireGraphObject(responseValue);
        for (const containerValue of optionalGraphArray(response, "hitsContainers")) {
          const container = requireGraphObject(containerValue);
          for (const hitValue of optionalGraphArray(container, "hits")) {
            const hit = requireGraphObject(hitValue);
            hits.push(Object.hasOwn(hit, "resource") ? hit.resource : hit);
          }
        }
      }

      return successResponse(hits);
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_search_all",
    {
      description: `Search mail, calendar, files, and Teams in one relevance-ranked query.

Use this when you do not know where something lives. chatMessage cannot be
combined with SharePoint entity types like site, list, listItem, drive, or
driveItem, so search Teams messages separately.

Args:
    query: Search query string (KQL is supported).
    entity_types: Resource types to search (default ["message", "event", "driveItem"]).
        One or more of: message, event, driveItem, drive, site, list, listItem,
        chatMessage, person.
    size: Maximum number of hits to return (default 25, maximum 50).
    from: Number of hits to skip for paging (default 0).`,
      inputSchema: {
        query: z.string(),
        entity_types: z.array(ENTITY_TYPE_SCHEMA).default(["message", "event", "driveItem"]),
        size: z.number().int().default(25),
        from: z.number().int().default(0),
      },
    },
    async ({ query, entity_types, size, from }) => {
      const hasSharePointType = entity_types.some((entityType) =>
        SHAREPOINT_ENTITY_TYPES.has(entityType),
      );
      if (entity_types.includes("chatMessage") && hasSharePointType) {
        return successResponse({ error: INVALID_ENTITY_TYPE_COMBINATION_MESSAGE }, "error");
      }

      const needsUnknownEnumMembers = entity_types.some((entityType) =>
        UNKNOWN_ENUM_ENTITY_TYPES.has(entityType),
      );
      const result = await dependencies.graphClient.post(
        "/search/query",
        {
          requests: [
            {
              entityTypes: entity_types,
              query: { queryString: query },
              from,
              size: Math.min(size, 50),
            },
          ],
        },
        undefined,
        needsUnknownEnumMembers ? { Prefer: "include-unknown-enum-members" } : undefined,
      );
      return successResponse(requireGraphObject(result));
    },
  );
}
