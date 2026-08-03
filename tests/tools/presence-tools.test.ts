import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError, GraphApiError } from "../../src/errors.js";
import { registerPresenceTools } from "../../src/tools/presence-tools.js";
import type { ToolDependencies } from "../../src/tools/tool-types.js";

type RecordedCallback = (args: unknown, extra: unknown) => CallToolResult | Promise<CallToolResult>;

interface RecordedToolConfig {
  readonly description?: string;
  readonly inputSchema?: ZodRawShape;
}

interface RecordedRegistration {
  readonly name: string;
  readonly config: RecordedToolConfig;
  readonly callback: RecordedCallback;
}

interface GraphCall {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly params?: unknown;
  readonly body?: unknown;
  readonly headers?: unknown;
}

interface GraphFake {
  readonly graphClient: ToolDependencies["graphClient"];
  readonly calls: GraphCall[];
}

interface ToolHarness {
  readonly server: Pick<McpServer, "registerTool">;
  readonly registrations: RecordedRegistration[];
  registration(name: string): RecordedRegistration;
  invoke(name: string, args?: unknown): Promise<CallToolResult>;
}

const EXPECTED_PRESENCE_TOOLS = [
  {
    name: "graph_get_my_presence",
    description: "Get the authenticated user's current presence status.",
  },
  {
    name: "graph_get_user_presence",
    description: "Get another user's presence status.",
  },
  {
    name: "graph_set_my_presence",
    description: "Set the authenticated user's presence status.",
  },
  {
    name: "graph_get_presences_by_user_ids",
    description: `Get presence for up to 650 users in one round trip.

Use this instead of calling graph_get_user_presence once per person. Needs
the Presence.Read.All permission.

Args:
    user_ids: User IDs to look up (1-650 per call).`,
  },
  {
    name: "graph_set_status_message",
    description: `Set your Teams status message, the note shown under your name.

This is separate from availability, which graph_set_my_presence controls.

Args:
    message: The status message text.
    expiry_datetime: Optional expiry in ISO 8601
        (e.g. "2026-03-01T17:00:00"). Empty means the message does not expire.
    timezone: Timezone for expiry_datetime (default "UTC").`,
  },
  {
    name: "graph_clear_my_presence",
    description: `Clear your presence. This is how you undo graph_set_my_presence.

graph_set_my_presence sets a preferred presence, so pass preferred=true to
undo it and let Teams calculate your availability again.

Args:
    preferred: Whether to clear the preferred presence set by
        graph_set_my_presence (default false clears only this app's session
        presence).`,
  },
] as const;

const INVALID_GRAPH_RESPONSE_RESULT = {
  content: [
    {
      type: "text",
      text: '{"error":"Graph API error: Invalid Microsoft Graph response."}',
    },
  ],
} as const;

const GRAPH_API_ERROR_RESULT = {
  content: [
    {
      type: "text",
      text: '{"error":"Graph API error: 403: Access denied"}',
    },
  ],
} as const;

const AUTHENTICATION_ERROR_RESULT = {
  content: [
    {
      type: "text",
      text: '{"error":"Not authenticated.","action_required":"Please call the graph_auth_login tool first."}',
    },
  ],
} as const;

function nextGraphResponse(responses: unknown[]): unknown {
  if (responses.length === 0) {
    throw new Error("No fake Graph response was configured.");
  }
  const response = responses.shift();
  if (response instanceof Error) {
    throw response;
  }
  return response;
}

function createGraphFake(initialResponses: readonly unknown[] = []): GraphFake {
  const responses = [...initialResponses];
  const calls: GraphCall[] = [];
  const graphClient: ToolDependencies["graphClient"] = {
    get: (path, params, headers) => {
      calls.push({
        method: "GET",
        path,
        ...(params === undefined ? {} : { params }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    post: (path, body, params, headers) => {
      calls.push({
        method: "POST",
        path,
        ...(body === undefined ? {} : { body }),
        ...(params === undefined ? {} : { params }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    patch: (path, body, headers) => {
      calls.push({
        method: "PATCH",
        path,
        ...(body === undefined ? {} : { body }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    put: (path, data, body, headers) => {
      calls.push({
        method: "PUT",
        path,
        ...(data === undefined ? {} : { body: data }),
        ...(body === undefined ? {} : { params: body }),
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
    delete: (path, headers) => {
      calls.push({
        method: "DELETE",
        path,
        ...(headers === undefined ? {} : { headers }),
      });
      return Promise.resolve(nextGraphResponse(responses));
    },
  };

  return { graphClient, calls };
}

function createToolHarness(): ToolHarness {
  const registrations: RecordedRegistration[] = [];
  const registerTool = ((name: string, config: unknown, callback: unknown) => {
    if (typeof callback !== "function") {
      throw new Error("Expected a registered callback.");
    }
    registrations.push({
      name,
      config: config as RecordedToolConfig,
      callback: callback as RecordedCallback,
    });
    return {} as RegisteredTool;
  }) as McpServer["registerTool"];

  return {
    server: { registerTool },
    registrations,
    registration(name) {
      const registration = registrations.find((candidate) => candidate.name === name);
      if (registration === undefined) {
        throw new Error(`Tool ${name} was not registered.`);
      }
      return registration;
    },
    async invoke(name, args = {}) {
      const registration = this.registration(name);
      const parsedArgs = z.object(registration.config.inputSchema ?? {}).parse(args);
      return await registration.callback(parsedArgs, {});
    },
  };
}

function schemaFor(harness: ToolHarness, name: string): ZodRawShape {
  const schema = harness.registration(name).config.inputSchema;
  if (schema === undefined) {
    throw new Error(`Tool ${name} did not expose an input schema.`);
  }
  return schema;
}

function dataFrom(result: CallToolResult): unknown {
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("Expected a text tool result.");
  }
  const payload: unknown = JSON.parse(content.text);
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    throw new Error("Expected a success response.");
  }
  return payload.data;
}

function registerPresenceHarness(graphResponses: readonly unknown[] = []): {
  readonly harness: ToolHarness;
  readonly graph: GraphFake;
} {
  const harness = createToolHarness();
  const graph = createGraphFake(graphResponses);
  const dependencies: ToolDependencies = {
    authManager: {
      getStatus: () => ({ state: "unauthenticated" }),
      login: () => Promise.resolve({ state: "authenticated" }),
      logout: () => Promise.resolve(),
      getValidAccessToken: () => Promise.resolve("access-token"),
      refreshAccessToken: () => Promise.resolve(true),
    },
    graphClient: graph.graphClient,
  };
  registerPresenceTools(harness.server, dependencies);
  return { harness, graph };
}

function userIds(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `user-${String(index)}`);
}

describe("presence tool registration", () => {
  test("registers exactly the six presence names and complete descriptions", () => {
    const { harness } = registerPresenceHarness();

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_PRESENCE_TOOLS);
  });

  test("exposes exact public snake_case schemas, defaults, and required fields", () => {
    const { harness } = registerPresenceHarness();

    const presencesShape = schemaFor(harness, "graph_get_presences_by_user_ids");
    expect(Object.keys(presencesShape)).toEqual(["user_ids"]);
    const presencesSchema = z.object(presencesShape);
    expect(presencesSchema.parse({ user_ids: ["user-1"] })).toEqual({ user_ids: ["user-1"] });
    expect(presencesSchema.safeParse({}).success).toBe(false);

    const statusShape = schemaFor(harness, "graph_set_status_message");
    expect(Object.keys(statusShape)).toEqual(["message", "expiry_datetime", "timezone"]);
    expect(z.object(statusShape).parse({ message: "Heads down" })).toEqual({
      message: "Heads down",
      expiry_datetime: "",
      timezone: "UTC",
    });
    expect(z.object(statusShape).safeParse({}).success).toBe(false);

    const clearShape = schemaFor(harness, "graph_clear_my_presence");
    expect(Object.keys(clearShape)).toEqual(["preferred"]);
    expect(z.object(clearShape).parse({})).toEqual({ preferred: false });
    expect(z.object(clearShape).safeParse({ preferred: "yes" }).success).toBe(false);
  });

  test("rejects empty, oversized, and dot-segment user_ids collections", () => {
    const { harness } = registerPresenceHarness();
    const schema = z.object(schemaFor(harness, "graph_get_presences_by_user_ids"));

    expect(schema.safeParse({ user_ids: [] }).success).toBe(false);
    expect(schema.safeParse({ user_ids: userIds(651) }).success).toBe(false);
    expect(schema.safeParse({ user_ids: userIds(650) }).success).toBe(true);
    expect(schema.safeParse({ user_ids: userIds(1) }).success).toBe(true);
    for (const invalidValue of ["", ".", ".."]) {
      expect(schema.safeParse({ user_ids: ["user-1", invalidValue] }).success).toBe(false);
    }
  });
});

describe("bulk presence lookup", () => {
  test("posts the exact ids body to getPresencesByUserId and returns the collection", async () => {
    const presences = [
      { id: "user-1", availability: "Available" },
      { id: "user-2", availability: "Busy" },
    ];
    const { harness, graph } = registerPresenceHarness([{ value: presences }]);

    expect(
      dataFrom(
        await harness.invoke("graph_get_presences_by_user_ids", {
          user_ids: ["user-1", "user-2"],
        }),
      ),
    ).toEqual(presences);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/communications/getPresencesByUserId",
        body: { ids: ["user-1", "user-2"] },
      },
    ]);
  });

  test("treats a missing value property as an empty list", async () => {
    const { harness } = registerPresenceHarness([{}]);

    expect(
      dataFrom(await harness.invoke("graph_get_presences_by_user_ids", { user_ids: ["user-1"] })),
    ).toEqual([]);
  });

  test.each([null, [], "payload-secret", 42, { value: null }, { value: {} }])(
    "rejects malformed bulk presence responses %# without leakage",
    async (response) => {
      const { harness } = registerPresenceHarness([response]);
      const result = await harness.invoke("graph_get_presences_by_user_ids", {
        user_ids: ["user-1"],
      });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("payload-secret");
      expect(serialized).not.toContain("TypeError");
      expect(serialized).not.toContain("Cannot read");
    },
  );
});

describe("status message and presence clearing", () => {
  test("omits expiryDateTime when expiry_datetime is empty and includes it otherwise", async () => {
    const { harness, graph } = registerPresenceHarness([{}, {}]);

    expect(
      dataFrom(await harness.invoke("graph_set_status_message", { message: "Heads down" })),
    ).toEqual({ status: "Status message updated" });
    await harness.invoke("graph_set_status_message", {
      message: "Back at 5",
      expiry_datetime: "2026-03-01T17:00:00",
      timezone: "Pacific Standard Time",
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/presence/setStatusMessage",
        body: {
          statusMessage: {
            message: { content: "Heads down", contentType: "text" },
          },
        },
      },
      {
        method: "POST",
        path: "/me/presence/setStatusMessage",
        body: {
          statusMessage: {
            message: { content: "Back at 5", contentType: "text" },
            expiryDateTime: {
              dateTime: "2026-03-01T17:00:00",
              timeZone: "Pacific Standard Time",
            },
          },
        },
      },
    ]);
  });

  test("clears the session presence by default and the preferred presence when asked", async () => {
    const { harness, graph } = registerPresenceHarness([{}, {}]);

    expect(dataFrom(await harness.invoke("graph_clear_my_presence"))).toEqual({
      status: "Presence cleared",
    });
    expect(dataFrom(await harness.invoke("graph_clear_my_presence", { preferred: true }))).toEqual({
      status: "Preferred presence cleared",
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/presence/clearPresence",
        body: { sessionId: "Graph-MCP" },
      },
      {
        method: "POST",
        path: "/me/presence/clearUserPreferredPresence",
        body: {},
      },
    ]);
  });
});

describe("presence authenticated wrapper errors", () => {
  test.each([
    { name: "graph_get_presences_by_user_ids", args: { user_ids: ["user-1"] } },
    { name: "graph_set_status_message", args: { message: "Heads down" } },
    { name: "graph_clear_my_presence", args: {} },
    { name: "graph_clear_my_presence", args: { preferred: true } },
  ])("$name returns the stable error envelopes", async ({ name, args }) => {
    const auth = registerPresenceHarness([new AuthenticationError("Not authenticated.")]);
    await expect(auth.harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);

    const graphError = registerPresenceHarness([new GraphApiError("403: Access denied", 403)]);
    await expect(graphError.harness.invoke(name, args)).resolves.toEqual(GRAPH_API_ERROR_RESULT);
  });
});
