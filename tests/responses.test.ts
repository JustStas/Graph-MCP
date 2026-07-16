import { describe, expect, test } from "vitest";

import {
  AuthenticationError,
  GraphApiError,
  GraphMcpError,
  RateLimitError,
} from "../src/errors.js";
import { asToolResult, errorResponse, successResponse } from "../src/responses.js";

describe("response helpers", () => {
  test("wraps successful data with the default message", () => {
    expect(successResponse({ ok: true })).toBe('{"data":{"ok":true},"message":"success"}');
  });

  test("preserves a custom success message", () => {
    expect(successResponse([1, 2], "loaded")).toBe('{"data":[1,2],"message":"loaded"}');
  });

  test("omits action_required when no action is provided", () => {
    expect(errorResponse("bad")).toBe('{"error":"bad"}');
  });

  test("includes action_required when an action is provided", () => {
    expect(errorResponse("bad", "login")).toBe('{"error":"bad","action_required":"login"}');
  });

  test("returns exactly one MCP text content item", () => {
    expect(asToolResult("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });
});

describe("error classes", () => {
  test("GraphMcpError preserves its stable name and message", () => {
    const error = new GraphMcpError("base failure");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GraphMcpError");
    expect(error.message).toBe("base failure");
  });

  test("AuthenticationError inherits from GraphMcpError", () => {
    const error = new AuthenticationError("login required");

    expect(error).toBeInstanceOf(GraphMcpError);
    expect(error.name).toBe("AuthenticationError");
    expect(error.message).toBe("login required");
  });

  test("GraphApiError exposes an optional status code", () => {
    const withStatus = new GraphApiError("request failed", 429);
    const withoutStatus = new GraphApiError("request failed");

    expect(withStatus).toBeInstanceOf(GraphMcpError);
    expect(withStatus.name).toBe("GraphApiError");
    expect(withStatus.message).toBe("request failed");
    expect(withStatus.statusCode).toBe(429);
    expect(withoutStatus.statusCode).toBeUndefined();
  });

  test("RateLimitError inherits from GraphMcpError", () => {
    const error = new RateLimitError("slow down");

    expect(error).toBeInstanceOf(GraphMcpError);
    expect(error.name).toBe("RateLimitError");
    expect(error.message).toBe("slow down");
  });
});
