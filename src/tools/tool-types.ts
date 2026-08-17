import type {
  McpServer,
  RegisteredTool,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";

import type { AuthManager } from "../auth/auth-manager.js";
import { AuthenticationError, GraphApiError } from "../errors.js";
import type { GraphClient } from "../graph-client.js";
import { asToolResult, errorResponse } from "../responses.js";

type ToolInputSchema = ZodRawShape;

export interface ToolDependencies {
  readonly authManager: Pick<
    AuthManager,
    "getStatus" | "login" | "logout" | "getValidAccessToken" | "refreshAccessToken"
  >;
  readonly graphClient: Pick<GraphClient, "get" | "getBytes" | "post" | "patch" | "put" | "delete">;
}

export interface AuthenticatedToolConfig<InputSchema extends ToolInputSchema> {
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: InputSchema;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: Record<string, unknown>;
}

export type AuthenticatedToolHandler<InputSchema extends ToolInputSchema> = (
  ...args: Parameters<ToolCallback<InputSchema>>
) => string | Promise<string>;

export function toTextResult(text: string) {
  return asToolResult(text);
}

export function registerAuthenticatedTool<
  const Name extends string,
  InputSchema extends ToolInputSchema,
>(
  server: Pick<McpServer, "registerTool">,
  name: Name,
  config: AuthenticatedToolConfig<InputSchema>,
  handler: AuthenticatedToolHandler<InputSchema>,
): RegisteredTool {
  const callback = (async (...args: Parameters<ToolCallback<InputSchema>>) => {
    try {
      return toTextResult(await handler(...args));
    } catch (error: unknown) {
      if (error instanceof AuthenticationError) {
        return toTextResult(
          errorResponse(error.message, "Please call the graph_auth_login tool first."),
        );
      }
      if (error instanceof GraphApiError) {
        return toTextResult(errorResponse(`Graph API error: ${error.message}`));
      }
      if (error instanceof Error) {
        return toTextResult(errorResponse(`Unexpected error: ${error.message}`));
      }
      return toTextResult(errorResponse("Unexpected error: Unknown error."));
    }
  }) as ToolCallback<InputSchema>;

  return server.registerTool(name, config, callback);
}
