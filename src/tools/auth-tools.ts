import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AuthenticationError } from "../errors.js";
import { errorResponse, successResponse } from "../responses.js";
import { toTextResult, type ToolDependencies } from "./tool-types.js";

const LOGIN_ACTION = "Check Azure app registration and try again.";
const SESSION_EXPIRED_MESSAGE = "Session expired. Please log in again.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

function pendingResponse(
  status: Extract<ReturnType<ToolDependencies["authManager"]["getStatus"]>, { state: "pending" }>,
): string {
  return successResponse({
    authenticated: false,
    state: status.state,
    method: status.method,
    userCode: status.userCode,
    verificationUri: status.verificationUri,
    expiresAt: status.expiresAt,
    message: status.message,
  });
}

export function registerAuthTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  server.registerTool(
    "graph_auth_status",
    {
      description: "Check Microsoft Graph authentication status. Attempts token refresh if needed.",
      inputSchema: {},
    },
    async () => {
      try {
        const status = dependencies.authManager.getStatus();
        if (status.state === "pending") {
          return toTextResult(pendingResponse(status));
        }
        if (status.state === "failed") {
          return toTextResult(
            successResponse({
              authenticated: false,
              state: status.state,
              message: status.message,
            }),
          );
        }
        if (status.state === "unauthenticated") {
          return toTextResult(
            successResponse({
              authenticated: false,
              message: "Not authenticated",
            }),
          );
        }

        try {
          await dependencies.authManager.getValidAccessToken();
        } catch (error: unknown) {
          if (error instanceof AuthenticationError) {
            return toTextResult(
              successResponse({
                authenticated: false,
                message: SESSION_EXPIRED_MESSAGE,
              }),
            );
          }
          throw error;
        }

        return toTextResult(
          successResponse({
            authenticated: true,
            message: "Authenticated",
          }),
        );
      } catch (error: unknown) {
        return toTextResult(errorResponse(errorMessage(error)));
      }
    },
  );

  server.registerTool(
    "graph_auth_login",
    {
      description: "Log in to Microsoft 365. Opens a browser for OAuth2 authentication.",
      inputSchema: {
        method: z.enum(["browser", "device_code"]).default("browser"),
      },
    },
    async ({ method }) => {
      try {
        const status = await dependencies.authManager.login(method);
        if (status.state === "pending") {
          return toTextResult(pendingResponse(status));
        }
        return toTextResult(
          successResponse({
            authenticated: true,
            message: "Successfully logged in to Microsoft 365.",
          }),
        );
      } catch (error: unknown) {
        return toTextResult(errorResponse(errorMessage(error), LOGIN_ACTION));
      }
    },
  );

  server.registerTool(
    "graph_auth_logout",
    {
      description: "Log out from Microsoft 365. Clears stored tokens.",
      inputSchema: {},
    },
    async () => {
      try {
        await dependencies.authManager.logout();
        return toTextResult(
          successResponse({
            authenticated: false,
            message: "Successfully logged out.",
          }),
        );
      } catch (error: unknown) {
        return toTextResult(errorResponse(errorMessage(error)));
      }
    },
  );
}
