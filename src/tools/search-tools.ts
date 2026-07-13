import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { successResponse } from "../responses.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

interface SearchHit {
  readonly resource?: unknown;
  readonly [key: string]: unknown;
}

interface SearchHitContainer {
  readonly hits?: SearchHit[];
}

interface SearchResponse {
  readonly hitsContainers?: SearchHitContainer[];
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
      const result = (await dependencies.graphClient.post("/search/query", {
        requests: [
          {
            entityTypes: ["chatMessage"],
            query: { queryString: query },
            from: 0,
            size: Math.min(top, 25),
          },
        ],
      })) as { readonly value?: SearchResponse[] };
      const hits: unknown[] = [];

      for (const response of result.value ?? []) {
        for (const container of response.hitsContainers ?? []) {
          for (const hit of container.hits ?? []) {
            hits.push("resource" in hit ? hit.resource : hit);
          }
        }
      }

      return successResponse(hits);
    },
  );
}
