import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { describe, expect, expectTypeOf, test } from "vitest";

import { AuthenticationError, GraphApiError } from "../../src/errors.js";
import {
  registerAuthenticatedTool,
  toTextResult,
  type ToolDependencies,
} from "../../src/tools/tool-types.js";

type RecordedCallback = (args: unknown, extra: unknown) => CallToolResult | Promise<CallToolResult>;

interface RecordedRegistration {
  readonly name: string;
  readonly config: unknown;
  readonly callback: RecordedCallback;
}

function createRecordingServer(): {
  readonly server: Pick<McpServer, "registerTool">;
  getRegistration(): RecordedRegistration;
} {
  let registration: RecordedRegistration | undefined;
  const registerTool = ((name: string, config: unknown, callback: unknown) => {
    if (typeof callback !== "function") {
      throw new Error("Expected a registered callback");
    }
    registration = {
      name,
      config,
      callback: callback as RecordedCallback,
    };
    return {} as RegisteredTool;
  }) as McpServer["registerTool"];

  return {
    server: { registerTool },
    getRegistration() {
      if (registration === undefined) {
        throw new Error("No tool was registered");
      }
      return registration;
    },
  };
}

function createDependencies(): ToolDependencies {
  return {
    authManager: {
      getStatus: () => ({ state: "unauthenticated" }),
      login: () => Promise.resolve({ state: "authenticated" }),
      logout: () => Promise.resolve(),
      getValidAccessToken: () => Promise.resolve("access-token"),
      refreshAccessToken: () => Promise.resolve(true),
    },
    graphClient: {
      get: () => Promise.resolve({ method: "GET" }),
      post: () => Promise.resolve({ method: "POST" }),
      patch: () => Promise.resolve({ method: "PATCH" }),
      put: () => Promise.resolve({ method: "PUT" }),
      delete: () => Promise.resolve({ method: "DELETE" }),
    },
  };
}

function throwUnknown(value: unknown): never {
  throw value;
}

describe("tool contracts", () => {
  test("toTextResult returns exactly one MCP text content item", () => {
    expect(toTextResult("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  test("ToolDependencies accepts structural AuthManager and GraphClient fakes", () => {
    const dependencies = createDependencies();

    expectTypeOf(dependencies).toMatchTypeOf<ToolDependencies>();
    expect(Object.keys(dependencies.authManager).sort()).toEqual([
      "getStatus",
      "getValidAccessToken",
      "login",
      "logout",
      "refreshAccessToken",
    ]);
    expect(Object.keys(dependencies.graphClient).sort()).toEqual([
      "delete",
      "get",
      "patch",
      "post",
      "put",
    ]);
  });
});

describe("registerAuthenticatedTool", () => {
  test("forwards name, config, schema, callback arguments, and wraps serialized success", async () => {
    const recording = createRecordingServer();
    const inputSchema = { value: z.string() };
    const config = {
      title: "Echo",
      description: "Echo a value",
      inputSchema,
      _meta: { owner: "tests" },
    };
    const args = { value: "hello" };
    const extra = { marker: "request-extra" };
    let receivedArgs: unknown;
    let receivedExtra: unknown;

    registerAuthenticatedTool(
      recording.server,
      "graph_echo",
      config,
      (handlerArgs, handlerExtra) => {
        expectTypeOf(handlerArgs).toEqualTypeOf<{ value: string }>();
        receivedArgs = handlerArgs;
        receivedExtra = handlerExtra;
        return '{"data":{"echo":"hello"},"message":"success"}';
      },
    );

    const registration = recording.getRegistration();
    expect(registration.name).toBe("graph_echo");
    expect(registration.config).toBe(config);
    expect((registration.config as typeof config).inputSchema).toBe(inputSchema);
    await expect(registration.callback(args, extra)).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"echo":"hello"},"message":"success"}',
        },
      ],
    });
    expect(receivedArgs).toBe(args);
    expect(receivedExtra).toBe(extra);
  });

  test("wraps AuthenticationError with the exact login action", async () => {
    const recording = createRecordingServer();

    registerAuthenticatedTool(
      recording.server,
      "graph_auth_required",
      { inputSchema: { value: z.string() } },
      () => {
        throw new AuthenticationError("Not authenticated.");
      },
    );

    await expect(recording.getRegistration().callback({}, {})).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"error":"Not authenticated.","action_required":"Please call the graph_auth_login tool first."}',
        },
      ],
    });
  });

  test("wraps GraphApiError with the exact Graph API prefix", async () => {
    const recording = createRecordingServer();

    registerAuthenticatedTool(
      recording.server,
      "graph_api_failure",
      { inputSchema: { value: z.string() } },
      () => {
        throw new GraphApiError("404: Message not found", 404);
      },
    );

    await expect(recording.getRegistration().callback({}, {})).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"error":"Graph API error: 404: Message not found"}',
        },
      ],
    });
  });

  test("wraps other Error instances with the exact unexpected error prefix", async () => {
    const recording = createRecordingServer();

    registerAuthenticatedTool(
      recording.server,
      "graph_unexpected_failure",
      { inputSchema: { value: z.string() } },
      () => {
        throw new Error("boom");
      },
    );

    await expect(recording.getRegistration().callback({}, {})).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"error":"Unexpected error: boom"}',
        },
      ],
    });
  });

  test.each(["private string", { private: "object internals" }])(
    "handles a non-Error thrown value without exposing it: %j",
    async (thrownValue) => {
      const recording = createRecordingServer();

      registerAuthenticatedTool(
        recording.server,
        "graph_non_error_failure",
        { inputSchema: { value: z.string() } },
        () => {
          throwUnknown(thrownValue);
        },
      );

      await expect(recording.getRegistration().callback({}, {})).resolves.toEqual({
        content: [
          {
            type: "text",
            text: '{"error":"Unexpected error: Unknown error."}',
          },
        ],
      });
    },
  );
});
