import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function successResponse(data: unknown, message = "success"): string {
  return JSON.stringify({ data, message });
}

export function errorResponse(error: string, actionRequired?: string): string {
  return JSON.stringify({
    error,
    ...(actionRequired ? { action_required: actionRequired } : {}),
  });
}

export function asToolResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}
