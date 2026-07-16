import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";

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
}
