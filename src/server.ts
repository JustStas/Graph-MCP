import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AuthManager } from "./auth/auth-manager.js";
import { loadSettings } from "./config.js";
import { GraphClient } from "./graph-client.js";
import { RateLimiter } from "./rate-limiter.js";
import { TokenStore } from "./token-store.js";
import { registerAllTools } from "./tools/index.js";
import type { ToolDependencies } from "./tools/tool-types.js";

const SERVER_INSTRUCTIONS =
  "Microsoft Teams, Outlook Calendar, Mail, meetings, users, presence, and OneDrive integration via Microsoft Graph API";
const GRAPH_TIMEOUT_MS = 30_000;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

async function createDefaultDependencies(): Promise<ToolDependencies> {
  const settings = await loadSettings();
  const tokenStore = new TokenStore(settings);
  await tokenStore.initialize();

  const authManager = new AuthManager(settings, tokenStore);
  const rateLimiter = new RateLimiter({
    maxRequests: settings.graphRateLimitMaxRequests,
    windowMs: settings.graphRateLimitWindow * 1_000,
  });
  const graphClient = new GraphClient({
    authManager,
    rateLimiter,
    fetch: globalThis.fetch,
    sleep,
    timeoutMs: GRAPH_TIMEOUT_MS,
  });

  return { authManager, graphClient };
}

export async function createServer(dependencies?: ToolDependencies): Promise<McpServer> {
  const resolvedDependencies = dependencies ?? (await createDefaultDependencies());
  const server = new McpServer(
    { name: "Graph MCP", version: "0.6.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server, resolvedDependencies);
  return server;
}
