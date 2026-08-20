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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function combineCloseErrors(closeError: unknown, disposeError: unknown): Error | undefined {
  if (closeError === undefined) {
    return disposeError === undefined ? undefined : asError(disposeError);
  }
  if (disposeError === undefined) {
    return asError(closeError);
  }
  return new AggregateError(
    [asError(closeError), asError(disposeError)],
    "Graph MCP shutdown failed.",
  );
}

interface DefaultDependencies {
  readonly toolDependencies: ToolDependencies;
  readonly authManager: AuthManager;
}

async function createDefaultDependencies(): Promise<DefaultDependencies> {
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

  return {
    toolDependencies: { authManager, graphClient },
    authManager,
  };
}

export async function createServer(dependencies?: ToolDependencies): Promise<McpServer> {
  let resolvedDependencies: ToolDependencies;
  let ownedAuthManager: AuthManager | undefined;
  if (dependencies !== undefined) {
    resolvedDependencies = dependencies;
  } else {
    const defaults = await createDefaultDependencies();
    resolvedDependencies = defaults.toolDependencies;
    ownedAuthManager = defaults.authManager;
  }
  const server = new McpServer(
    { name: "Graph MCP", version: "0.10.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server, resolvedDependencies);

  if (ownedAuthManager !== undefined) {
    const closeServer = server.close.bind(server);
    let closePromise: Promise<void> | undefined;
    const disposeAuthManager = ownedAuthManager;
    server.close = (): Promise<void> => {
      if (closePromise === undefined) {
        closePromise = (async () => {
          let closeError: unknown;
          let disposeError: unknown;
          try {
            await closeServer();
          } catch (error: unknown) {
            closeError = error;
          } finally {
            try {
              await disposeAuthManager.dispose();
            } catch (error: unknown) {
              disposeError = error;
            }
          }
          const shutdownError = combineCloseErrors(closeError, disposeError);
          if (shutdownError !== undefined) {
            throw shutdownError;
          }
        })();
      }
      return closePromise;
    };
  }

  return server;
}
