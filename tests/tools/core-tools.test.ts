import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import type { LoginMethod, LoginStatus } from "../../src/auth/auth-manager.js";
import { AuthenticationError } from "../../src/errors.js";
import { USER_COMPACT_FIELDS, USER_PROFILE_FIELDS } from "../../src/select-fields.js";
import { registerAuthTools } from "../../src/tools/auth-tools.js";
import { registerPresenceTools } from "../../src/tools/presence-tools.js";
import { registerProfileTools } from "../../src/tools/profile-tools.js";
import { registerSearchTools } from "../../src/tools/search-tools.js";
import type { ToolDependencies } from "../../src/tools/tool-types.js";
import { registerUserTools } from "../../src/tools/user-tools.js";

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

interface AuthFakeOptions {
  readonly status?: LoginStatus;
  readonly statusError?: unknown;
  readonly loginResult?: LoginStatus;
  readonly loginError?: unknown;
  readonly validTokenError?: unknown;
  readonly logoutError?: unknown;
  readonly logoutImplementation?: () => Promise<void>;
}

interface AuthFake {
  readonly authManager: ToolDependencies["authManager"];
  readonly loginMethods: LoginMethod[];
  readonly validTokenCalls: { count: number };
  readonly logoutCalls: { count: number };
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

const USERS_NEXT_LINK = "https://graph.microsoft.com/v1.0/users?%24skiptoken=abc";
const REPORTS_NEXT_LINK = "https://graph.microsoft.com/v1.0/me/directReports?%24skip=50";

const EXPECTED_TOOLS = [
  {
    name: "graph_auth_status",
    description: "Check Microsoft Graph authentication status. Attempts token refresh if needed.",
  },
  {
    name: "graph_auth_login",
    description: "Log in to Microsoft 365. Opens a browser for OAuth2 authentication.",
  },
  {
    name: "graph_auth_logout",
    description: "Log out from Microsoft 365. Clears stored tokens.",
  },
  {
    name: "graph_get_profile",
    description: "Get the authenticated user's Microsoft 365 profile.",
  },
  {
    name: "graph_search_users",
    description: `Search for users in the organization directory by name or email.

Graph does not support \`$skip\` alongside \`$search\` on /users, so page with
next_link instead of an offset.

Args:
    query: Name or email address to look up.
    top: Maximum number of users to return (default 10, maximum 25).
    compact: Whether to return only the identifying fields instead of the full
        record (default false). Use it to page through large collections cheaply.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
  },
  {
    name: "graph_get_manager",
    description: `Get a user's manager from the organization directory.

Reading someone else's manager requires the User.Read.All permission.

Args:
    user_id: User ID or email address. Empty targets the signed-in user.`,
  },
  {
    name: "graph_list_direct_reports",
    description: `List the people who report directly to a user.

Reading someone else's direct reports requires the User.Read.All permission.

Args:
    user_id: User ID or email address. Empty targets the signed-in user.
    top: Maximum number of reports to return (default 50, maximum 50).
    skip: Number of items to skip before returning results (default 0). Graph
        returns at most 50 per call, so page by raising skip in steps of top.
    compact: Whether to return only the identifying fields instead of the full
        record (default false). Use it to page through large collections cheaply.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
  },
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
  {
    name: "graph_search_messages",
    description: "Search messages across Teams chats and channels.",
  },
  {
    name: "graph_search_all",
    description: `Search mail, calendar, files, and Teams in one relevance-ranked query.

Use this when you do not know where something lives. chatMessage cannot be
combined with SharePoint entity types like site, list, listItem, drive, or
driveItem, so search Teams messages separately.

Args:
    query: Search query string (KQL is supported).
    entity_types: Resource types to search (default ["message", "event", "driveItem"]).
        One or more of: message, event, driveItem, drive, site, list, listItem,
        chatMessage, person.
    size: Maximum number of hits to return (default 25, maximum 50).
    from: Number of hits to skip for paging (default 0).
    compact: Whether to flatten the response into one list of hits, each reduced to
        {id, rank, summary, resource_type, name_or_subject, web_url} (default false,
        which returns the full hitsContainers payload). id is the hitId, falling back
        to the resource id; name_or_subject is the resource subject, name, displayName
        or title; web_url is its webUrl or webLink; a field the hit does not carry is
        omitted.`,
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

function unknownThrow(value: unknown): never {
  throw value;
}

function countUnquotedOrOperators(search: string): number {
  let count = 0;
  let inQuotedValue = false;

  for (let index = 0; index < search.length; index += 1) {
    if (search[index] === '"') {
      if (inQuotedValue && search[index + 1] === '"') {
        index += 1;
      } else {
        inQuotedValue = !inQuotedValue;
      }
      continue;
    }
    if (!inQuotedValue && search.startsWith(" OR ", index)) {
      count += 1;
      index += 3;
    }
  }

  return count;
}

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
    getBytes: () => Promise.reject(new Error("These tools never read raw bytes.")),
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

function createAuthFake(options: AuthFakeOptions = {}): AuthFake {
  const loginMethods: LoginMethod[] = [];
  const validTokenCalls = { count: 0 };
  const logoutCalls = { count: 0 };
  const authManager: ToolDependencies["authManager"] = {
    getStatus: () => {
      if (options.statusError !== undefined) {
        return unknownThrow(options.statusError);
      }
      return options.status ?? { state: "unauthenticated" };
    },
    login: (method = "browser") => {
      loginMethods.push(method);
      if (options.loginError !== undefined) {
        return unknownThrow(options.loginError);
      }
      return Promise.resolve(options.loginResult ?? { state: "authenticated" });
    },
    logout: async () => {
      logoutCalls.count += 1;
      if (options.logoutError !== undefined) {
        return unknownThrow(options.logoutError);
      }
      await options.logoutImplementation?.();
    },
    getValidAccessToken: () => {
      validTokenCalls.count += 1;
      if (options.validTokenError !== undefined) {
        return unknownThrow(options.validTokenError);
      }
      return Promise.resolve("access-token");
    },
    refreshAccessToken: () => Promise.resolve(true),
  };

  return { authManager, loginMethods, validTokenCalls, logoutCalls };
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
  const server = { registerTool };

  return {
    server,
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

function createDependencies(
  authOptions: AuthFakeOptions = {},
  graphResponses: readonly unknown[] = [],
): {
  readonly dependencies: ToolDependencies;
  readonly auth: AuthFake;
  readonly graph: GraphFake;
} {
  const auth = createAuthFake(authOptions);
  const graph = createGraphFake(graphResponses);
  return {
    dependencies: {
      authManager: auth.authManager,
      graphClient: graph.graphClient,
    },
    auth,
    graph,
  };
}

function registerAll(harness: ToolHarness, dependencies: ToolDependencies): void {
  registerAuthTools(harness.server, dependencies);
  registerProfileTools(harness.server, dependencies);
  registerUserTools(harness.server, dependencies);
  registerPresenceTools(harness.server, dependencies);
  registerSearchTools(harness.server, dependencies);
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

describe("core tool registration", () => {
  test("registers exactly the twelve core names and descriptions", () => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies();

    registerAll(harness, dependencies);

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_TOOLS);
  });

  test("exposes exact zero-argument, required string, integer default, and Python-name schemas", () => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies();
    registerAll(harness, dependencies);

    for (const name of [
      "graph_auth_status",
      "graph_auth_logout",
      "graph_get_profile",
      "graph_get_my_presence",
    ]) {
      expect(schemaFor(harness, name)).toEqual({});
    }

    const loginSchema = z.object(schemaFor(harness, "graph_auth_login"));
    expect(loginSchema.parse({})).toEqual({ method: "browser" });
    expect(loginSchema.parse({ method: "device_code" })).toEqual({
      method: "device_code",
    });
    expect(loginSchema.safeParse({ method: "password" }).success).toBe(false);

    expect(Object.keys(schemaFor(harness, "graph_search_users"))).toEqual([
      "query",
      "top",
      "compact",
      "next_link",
      "include_next_link",
    ]);
    const userSearchSchema = z.object(schemaFor(harness, "graph_search_users"));
    expect(userSearchSchema.parse({ query: "Ada" })).toEqual({
      query: "Ada",
      top: 10,
      compact: false,
      next_link: "",
      include_next_link: false,
    });
    expect(userSearchSchema.safeParse({ query: "Ada", top: 1.5 }).success).toBe(false);
    expect(userSearchSchema.safeParse({ top: 10 }).success).toBe(false);
    expect(userSearchSchema.parse({ query: "Ada", skip: 25 })).not.toHaveProperty("skip");

    const userPresenceSchema = z.object(schemaFor(harness, "graph_get_user_presence"));
    expect(userPresenceSchema.parse({ user_id: "user-1" })).toEqual({
      user_id: "user-1",
    });
    expect(userPresenceSchema.safeParse({}).success).toBe(false);
    for (const userId of ["", ".", ".."]) {
      const result = userPresenceSchema.safeParse({ user_id: userId });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe("user_id must not be empty, '.' or '..'.");
      }
    }

    const setPresenceShape = schemaFor(harness, "graph_set_my_presence");
    expect(Object.keys(setPresenceShape)).toEqual([
      "availability",
      "activity",
      "expiration_duration",
    ]);
    const setPresenceSchema = z.object(setPresenceShape);
    expect(
      setPresenceSchema.parse({
        availability: "Available",
        activity: "Available",
      }),
    ).toEqual({
      availability: "Available",
      activity: "Available",
      expiration_duration: "PT1H",
    });
    expect(setPresenceSchema.safeParse({ availability: "Available" }).success).toBe(false);

    const messageSearchSchema = z.object(schemaFor(harness, "graph_search_messages"));
    expect(messageSearchSchema.parse({ query: "release" })).toEqual({
      query: "release",
      top: 25,
    });
    expect(messageSearchSchema.safeParse({ query: "release", top: 2.5 }).success).toBe(false);
    expect(messageSearchSchema.safeParse({ top: 25 }).success).toBe(false);
  });
});

describe("authentication tools", () => {
  test("status validates authenticated credentials through getValidAccessToken", async () => {
    const harness = createToolHarness();
    const { dependencies, auth } = createDependencies({ status: { state: "authenticated" } });
    registerAuthTools(harness.server, dependencies);

    await expect(harness.invoke("graph_auth_status")).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"authenticated":true,"message":"Authenticated"},"message":"success"}',
        },
      ],
    });
    expect(auth.validTokenCalls.count).toBe(1);
  });

  test("status converts refresh AuthenticationError into the legacy session-expired success", async () => {
    const harness = createToolHarness();
    const { dependencies, auth } = createDependencies({
      status: { state: "authenticated" },
      validTokenError: new AuthenticationError("Not authenticated. Please log in first."),
    });
    registerAuthTools(harness.server, dependencies);

    await expect(harness.invoke("graph_auth_status")).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"authenticated":false,"message":"Session expired. Please log in again."},"message":"success"}',
        },
      ],
    });
    expect(auth.validTokenCalls.count).toBe(1);
  });

  test("status returns other refresh errors as ordinary auth errors", async () => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies({
      status: { state: "authenticated" },
      validTokenError: new Error("Refresh failed."),
    });
    registerAuthTools(harness.server, dependencies);

    await expect(harness.invoke("graph_auth_status")).resolves.toEqual({
      content: [{ type: "text", text: '{"error":"Refresh failed."}' }],
    });
  });

  test("status preserves unauthenticated, pending, and failed states without token refresh", async () => {
    const cases: Array<{
      readonly status: LoginStatus;
      readonly expectedText: string;
    }> = [
      {
        status: { state: "unauthenticated" },
        expectedText:
          '{"data":{"authenticated":false,"message":"Not authenticated","action_required":{"setup_command":"graph-mcp setup","login_tool":"graph_auth_login"}},"message":"success"}',
      },
      {
        status: {
          state: "pending",
          method: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: 1_234_567,
          message: "Enter the code.",
        },
        expectedText:
          '{"data":{"authenticated":false,"state":"pending","method":"device_code","userCode":"ABCD-EFGH","verificationUri":"https://microsoft.com/devicelogin","expiresAt":1234567,"message":"Enter the code."},"message":"success"}',
      },
      {
        status: { state: "failed", message: "Device-code login failed." },
        expectedText:
          '{"data":{"authenticated":false,"state":"failed","message":"Device-code login failed."},"message":"success"}',
      },
    ];

    for (const { status, expectedText } of cases) {
      const harness = createToolHarness();
      const { dependencies, auth } = createDependencies({ status });
      registerAuthTools(harness.server, dependencies);

      await expect(harness.invoke("graph_auth_status")).resolves.toEqual({
        content: [{ type: "text", text: expectedText }],
      });
      expect(auth.validTokenCalls.count).toBe(0);
    }
  });

  test("browser login remains the default and returns the exact legacy success", async () => {
    const harness = createToolHarness();
    const { dependencies, auth } = createDependencies({
      loginResult: { state: "authenticated" },
    });
    registerAuthTools(harness.server, dependencies);

    await expect(harness.invoke("graph_auth_login")).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"authenticated":true,"message":"Successfully logged in to Microsoft 365."},"message":"success"}',
        },
      ],
    });
    expect(auth.loginMethods).toEqual(["browser"]);
  });

  test("device-code login preserves the pending state additively", async () => {
    const harness = createToolHarness();
    const { dependencies, auth } = createDependencies({
      loginResult: {
        state: "pending",
        method: "device_code",
        userCode: "WXYZ-1234",
        verificationUri: "https://microsoft.com/devicelogin",
        expiresAt: 9_876_543,
        message: "Use the code to sign in.",
      },
    });
    registerAuthTools(harness.server, dependencies);

    await expect(harness.invoke("graph_auth_login", { method: "device_code" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"authenticated":false,"state":"pending","method":"device_code","userCode":"WXYZ-1234","verificationUri":"https://microsoft.com/devicelogin","expiresAt":9876543,"message":"Use the code to sign in."},"message":"success"}',
        },
      ],
    });
    expect(auth.loginMethods).toEqual(["device_code"]);
  });

  test("login failures include the exact Azure registration action", async () => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies({
      loginError: new Error("Browser login failed."),
    });
    registerAuthTools(harness.server, dependencies);

    await expect(harness.invoke("graph_auth_login")).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"error":"Browser login failed.","action_required":"Check Azure app registration and try again."}',
        },
      ],
    });
  });

  test("logout is awaited before returning the exact legacy success", async () => {
    let resolveLogout: (() => void) | undefined;
    const logoutGate = new Promise<void>((resolve) => {
      resolveLogout = resolve;
    });
    const harness = createToolHarness();
    const { dependencies, auth } = createDependencies({
      logoutImplementation: () => logoutGate,
    });
    registerAuthTools(harness.server, dependencies);

    let settled = false;
    const invocation = harness.invoke("graph_auth_logout").then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(auth.logoutCalls.count).toBe(1);
    expect(settled).toBe(false);

    resolveLogout?.();
    await expect(invocation).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"authenticated":false,"message":"Successfully logged out."},"message":"success"}',
        },
      ],
    });
  });

  test("logout failures return the error without an action", async () => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies({
      logoutError: new Error("Unable to clear authentication tokens."),
    });
    registerAuthTools(harness.server, dependencies);

    await expect(harness.invoke("graph_auth_logout")).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"error":"Unable to clear authentication tokens."}',
        },
      ],
    });
  });

  test("auth handlers sanitize non-Error thrown values deterministically", async () => {
    const privateValue = { secret: "must-not-leak" };
    const cases: Array<{
      readonly name: "graph_auth_status" | "graph_auth_login" | "graph_auth_logout";
      readonly options: AuthFakeOptions;
      readonly expectedText: string;
    }> = [
      {
        name: "graph_auth_status",
        options: { statusError: privateValue },
        expectedText: '{"error":"Unknown error."}',
      },
      {
        name: "graph_auth_login",
        options: { loginError: privateValue },
        expectedText:
          '{"error":"Unknown error.","action_required":"Check Azure app registration and try again."}',
      },
      {
        name: "graph_auth_logout",
        options: { logoutError: privateValue },
        expectedText: '{"error":"Unknown error."}',
      },
    ];

    for (const { name, options, expectedText } of cases) {
      const harness = createToolHarness();
      const { dependencies } = createDependencies(options);
      registerAuthTools(harness.server, dependencies);

      const result = await harness.invoke(name);
      expect(result).toEqual({
        content: [{ type: "text", text: expectedText }],
      });
      expect(JSON.stringify(result)).not.toContain("must-not-leak");
    }
  });
});

describe("Graph-backed core tools", () => {
  test("gets the full profile with the exact centralized select fields", async () => {
    const profile = { id: "me", displayName: "Ada Lovelace", mail: "ada@example.com" };
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [profile]);
    registerProfileTools(harness.server, dependencies);

    await expect(harness.invoke("graph_get_profile")).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"id":"me","displayName":"Ada Lovelace","mail":"ada@example.com"},"message":"success"}',
        },
      ],
    });
    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me",
        params: { $select: USER_PROFILE_FIELDS },
      },
    ]);
  });

  test("searches users with eventual consistency, the default top, and the handler cap", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [
      { value: [{ id: "user-1" }] },
      { value: [{ id: "user-2" }] },
      {},
    ]);
    registerUserTools(harness.server, dependencies);

    await expect(harness.invoke("graph_search_users", { query: "Ada" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":[{"id":"user-1"}],"message":"success"}',
        },
      ],
    });
    await expect(
      harness.invoke("graph_search_users", { query: "ada@example.com", top: 100 }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":[{"id":"user-2"}],"message":"success"}',
        },
      ],
    });
    await expect(harness.invoke("graph_search_users", { query: "missing" })).resolves.toEqual({
      content: [{ type: "text", text: '{"data":[],"message":"success"}' }],
    });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/users",
        params: {
          $search: '"displayName:Ada" OR "mail:Ada"',
          $select: USER_PROFILE_FIELDS,
          $top: "10",
        },
        headers: { ConsistencyLevel: "eventual" },
      },
      {
        method: "GET",
        path: "/users",
        params: {
          $search: '"displayName:ada@example.com" OR "mail:ada@example.com"',
          $select: USER_PROFILE_FIELDS,
          $top: "25",
        },
        headers: { ConsistencyLevel: "eventual" },
      },
      {
        method: "GET",
        path: "/users",
        params: {
          $search: '"displayName:missing" OR "mail:missing"',
          $select: USER_PROFILE_FIELDS,
          $top: "10",
        },
        headers: { ConsistencyLevel: "eventual" },
      },
    ]);
  });

  test("selects the compact user fields and pages users with a bare next_link", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [
      { value: [{ id: "user-1" }] },
      { value: [{ id: "user-2" }], "@odata.nextLink": USERS_NEXT_LINK },
    ]);
    registerUserTools(harness.server, dependencies);

    expect(
      dataFrom(await harness.invoke("graph_search_users", { query: "Ada", compact: true })),
    ).toEqual([{ id: "user-1" }]);
    expect(
      dataFrom(
        await harness.invoke("graph_search_users", {
          query: "ignored",
          top: 25,
          compact: true,
          next_link: USERS_NEXT_LINK,
          include_next_link: true,
        }),
      ),
    ).toEqual({ items: [{ id: "user-2" }], next_link: USERS_NEXT_LINK });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/users",
        params: {
          $search: '"displayName:Ada" OR "mail:Ada"',
          $select: USER_COMPACT_FIELDS,
          $top: "10",
        },
        headers: { ConsistencyLevel: "eventual" },
      },
      {
        method: "GET",
        path: USERS_NEXT_LINK,
        headers: { ConsistencyLevel: "eventual" },
      },
    ]);
  });

  test.each([
    {
      query: 'Ada" OR "displayName:Bob',
      expectedSearch:
        '"displayName:Ada"" OR ""displayName:Bob" OR "mail:Ada"" OR ""displayName:Bob"',
    },
    {
      query: "domain\\user",
      expectedSearch: '"displayName:domain\\user" OR "mail:domain\\user"',
    },
    {
      query: "Ada OR Bob",
      expectedSearch: '"displayName:Ada OR Bob" OR "mail:Ada OR Bob"',
    },
  ])(
    "keeps user search query $query inside two quoted KQL values",
    async ({ query, expectedSearch }) => {
      const harness = createToolHarness();
      const { dependencies, graph } = createDependencies({}, [{ value: [] }]);
      registerUserTools(harness.server, dependencies);

      await harness.invoke("graph_search_users", { query });

      expect(graph.calls).toEqual([
        {
          method: "GET",
          path: "/users",
          params: {
            $search: expectedSearch,
            $select: USER_PROFILE_FIELDS,
            $top: "10",
          },
          headers: { ConsistencyLevel: "eventual" },
        },
      ]);
      const params = graph.calls[0]?.params as Record<string, string> | undefined;
      expect(countUnquotedOrOperators(params?.$search ?? "")).toBe(1);
    },
  );

  test.each([
    {
      label: "null result",
      response: null,
    },
    {
      label: "text result",
      response: "payload-secret-text-result",
    },
    {
      label: "scalar result",
      response: 42,
    },
    {
      label: "array result",
      response: [{ secret: "payload-secret-array-result" }],
    },
    {
      label: "null value",
      response: { value: null, secret: "payload-secret-null-value" },
    },
    {
      label: "text value",
      response: { value: "payload-secret-text-value" },
    },
    {
      label: "scalar value",
      response: { value: 42, secret: "payload-secret-scalar-value" },
    },
    {
      label: "object value",
      response: { value: { secret: "payload-secret-object-value" } },
    },
  ])("rejects malformed user search response: $label", async ({ response }) => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies({}, [response]);
    registerUserTools(harness.server, dependencies);

    const result = await harness.invoke("graph_search_users", { query: "Ada" });

    expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("payload-secret");
    expect(serialized).not.toContain("TypeError");
    expect(serialized).not.toContain("Cannot read");
    expect(serialized).not.toContain("not iterable");
  });

  test("gets the full current-user and selected-user presence results", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [
      { id: "me", availability: "Available", activity: "Available" },
      { id: "user-42", availability: "Busy", activity: "InAMeeting" },
    ]);
    registerPresenceTools(harness.server, dependencies);

    await expect(harness.invoke("graph_get_my_presence")).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"id":"me","availability":"Available","activity":"Available"},"message":"success"}',
        },
      ],
    });
    await expect(
      harness.invoke("graph_get_user_presence", { user_id: "user-42" }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"id":"user-42","availability":"Busy","activity":"InAMeeting"},"message":"success"}',
        },
      ],
    });
    expect(graph.calls).toEqual([
      { method: "GET", path: "/me/presence" },
      { method: "GET", path: "/users/user-42/presence" },
    ]);
  });

  test.each([
    {
      userId: "../me/messages#",
      encodedUserId: "..%2Fme%2Fmessages%23",
    },
    {
      userId: "domain\\user",
      encodedUserId: "domain%5Cuser",
    },
    {
      userId: "team/user",
      encodedUserId: "team%2Fuser",
    },
    {
      userId: "user#fragment",
      encodedUserId: "user%23fragment",
    },
    {
      userId: "ada.lovelace@example.com",
      encodedUserId: "ada.lovelace%40example.com",
    },
  ])(
    "keeps user_id $userId inside one encoded Graph path segment",
    async ({ userId, encodedUserId }) => {
      const harness = createToolHarness();
      const { dependencies, graph } = createDependencies({}, [
        { id: userId, availability: "Available", activity: "Available" },
      ]);
      registerPresenceTools(harness.server, dependencies);

      await harness.invoke("graph_get_user_presence", { user_id: userId });

      expect(graph.calls).toEqual([
        {
          method: "GET",
          path: `/users/${encodedUserId}/presence`,
        },
      ]);
      const path = graph.calls[0]?.path;
      if (path === undefined) {
        throw new Error("Expected a recorded Graph path.");
      }
      const resolved = new URL(path.replace(/^\/+/, ""), "https://graph.microsoft.com/v1.0/");
      expect(resolved.href).toBe(
        `https://graph.microsoft.com/v1.0/users/${encodedUserId}/presence`,
      );
      expect(resolved.hash).toBe("");
      expect(resolved.pathname.split("/")).toEqual([
        "",
        "v1.0",
        "users",
        encodedUserId,
        "presence",
      ]);
      expect(decodeURIComponent(resolved.pathname.split("/")[3] ?? "")).toBe(userId);
    },
  );

  test("sets presence with the exact body and public expiration_duration default", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [{ ignored: true }, { ignored: true }]);
    registerPresenceTools(harness.server, dependencies);

    await expect(
      harness.invoke("graph_set_my_presence", {
        availability: "Busy",
        activity: "InAMeeting",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"status":"Presence updated","availability":"Busy","activity":"InAMeeting"},"message":"success"}',
        },
      ],
    });
    await expect(
      harness.invoke("graph_set_my_presence", {
        availability: "Away",
        activity: "Away",
        expiration_duration: "PT30M",
      }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"status":"Presence updated","availability":"Away","activity":"Away"},"message":"success"}',
        },
      ],
    });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/presence/setUserPreferredPresence",
        body: {
          sessionId: "graph-mcp",
          availability: "Busy",
          activity: "InAMeeting",
          expirationDuration: "PT1H",
        },
      },
      {
        method: "POST",
        path: "/me/presence/setUserPreferredPresence",
        body: {
          sessionId: "graph-mcp",
          availability: "Away",
          activity: "Away",
          expirationDuration: "PT30M",
        },
      },
    ]);
  });

  test("searches messages with the handler cap and flattens all containers with hit fallback", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [
      {
        value: [
          {
            hitsContainers: [
              {
                hits: [
                  { resource: { id: "message-1", subject: "First" } },
                  { id: "fallback-hit", score: 0.8 },
                  { resource: null },
                ],
              },
              {
                hits: [{ resource: { id: "message-2", subject: "Second" } }],
              },
            ],
          },
          {
            hitsContainers: [
              {
                hits: [{ resource: { id: "message-3", subject: "Third" } }],
              },
            ],
          },
        ],
      },
    ]);
    registerSearchTools(harness.server, dependencies);

    await expect(
      harness.invoke("graph_search_messages", { query: "launch", top: 100 }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":[{"id":"message-1","subject":"First"},{"id":"fallback-hit","score":0.8},null,{"id":"message-2","subject":"Second"},{"id":"message-3","subject":"Third"}],"message":"success"}',
        },
      ],
    });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/search/query",
        body: {
          requests: [
            {
              entityTypes: ["chatMessage"],
              query: { queryString: "launch" },
              from: 0,
              size: 25,
            },
          ],
        },
      },
    ]);
  });

  test.each([{}, { value: [{}] }, { value: [{ hitsContainers: [{}] }] }])(
    "treats missing optional message search collections as empty",
    async (response) => {
      const harness = createToolHarness();
      const { dependencies } = createDependencies({}, [response]);
      registerSearchTools(harness.server, dependencies);

      await expect(
        harness.invoke("graph_search_messages", { query: "missing collections" }),
      ).resolves.toEqual({
        content: [{ type: "text", text: '{"data":[],"message":"success"}' }],
      });
    },
  );

  test.each([
    {
      label: "null result",
      response: null,
    },
    {
      label: "text result",
      response: "payload-secret-text-result",
    },
    {
      label: "scalar result",
      response: 42,
    },
    {
      label: "array result",
      response: [{ secret: "payload-secret-array-result" }],
    },
    {
      label: "null value",
      response: { value: null, secret: "payload-secret-null-value" },
    },
    {
      label: "object value",
      response: { value: { secret: "payload-secret-object-value" } },
    },
    {
      label: "text value",
      response: { value: "payload-secret-text-value" },
    },
    {
      label: "scalar value",
      response: { value: 42, secret: "payload-secret-scalar-value" },
    },
    {
      label: "null response entry",
      response: { value: [null] },
    },
    {
      label: "text response entry",
      response: { value: ["payload-secret-text-response"] },
    },
    {
      label: "array response entry",
      response: { value: [[{ secret: "payload-secret-array-response" }]] },
    },
    {
      label: "scalar response entry",
      response: { value: [42] },
    },
    {
      label: "null hitsContainers",
      response: {
        value: [{ hitsContainers: null, secret: "payload-secret-null-containers" }],
      },
    },
    {
      label: "object hitsContainers",
      response: {
        value: [{ hitsContainers: { secret: "payload-secret-object-containers" } }],
      },
    },
    {
      label: "text hitsContainers",
      response: {
        value: [{ hitsContainers: "payload-secret-text-containers" }],
      },
    },
    {
      label: "scalar hitsContainers",
      response: {
        value: [{ hitsContainers: 42, secret: "payload-secret-scalar-containers" }],
      },
    },
    {
      label: "null container entry",
      response: { value: [{ hitsContainers: [null] }] },
    },
    {
      label: "text container entry",
      response: {
        value: [{ hitsContainers: ["payload-secret-text-container"] }],
      },
    },
    {
      label: "array container entry",
      response: {
        value: [{ hitsContainers: [[{ secret: "payload-secret-array-container" }]] }],
      },
    },
    {
      label: "scalar container entry",
      response: {
        value: [{ hitsContainers: [42] }],
      },
    },
    {
      label: "null hits",
      response: {
        value: [
          {
            hitsContainers: [{ hits: null, secret: "payload-secret-null-hits" }],
          },
        ],
      },
    },
    {
      label: "object hits",
      response: {
        value: [
          {
            hitsContainers: [{ hits: { secret: "payload-secret-object-hits" } }],
          },
        ],
      },
    },
    {
      label: "text hits",
      response: {
        value: [
          {
            hitsContainers: [{ hits: "payload-secret-text-hits" }],
          },
        ],
      },
    },
    {
      label: "scalar hits",
      response: {
        value: [
          {
            hitsContainers: [{ hits: 42, secret: "payload-secret-scalar-hits" }],
          },
        ],
      },
    },
    {
      label: "null hit entry",
      response: { value: [{ hitsContainers: [{ hits: [null] }] }] },
    },
    {
      label: "text hit entry",
      response: {
        value: [{ hitsContainers: [{ hits: ["payload-secret-text-hit"] }] }],
      },
    },
    {
      label: "array hit entry",
      response: {
        value: [
          {
            hitsContainers: [{ hits: [[{ secret: "payload-secret-array-hit" }]] }],
          },
        ],
      },
    },
    {
      label: "scalar hit entry",
      response: {
        value: [{ hitsContainers: [{ hits: [42] }] }],
      },
    },
  ])("rejects malformed message search response: $label", async ({ response }) => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies({}, [response]);
    registerSearchTools(harness.server, dependencies);

    const result = await harness.invoke("graph_search_messages", { query: "launch" });

    expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("payload-secret");
    expect(serialized).not.toContain("TypeError");
    expect(serialized).not.toContain("Cannot read");
    expect(serialized).not.toContain("not iterable");
  });

  test("converts a Graph-backed AuthenticationError through the authenticated wrapper", async () => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies({}, [
      new AuthenticationError("Not authenticated."),
    ]);
    registerProfileTools(harness.server, dependencies);

    await expect(harness.invoke("graph_get_profile")).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"error":"Not authenticated.","action_required":"Please call the graph_auth_login tool first."}',
        },
      ],
    });
  });
});

describe("organization hierarchy tools", () => {
  test("exposes exact snake_case schemas and defaults", () => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies();
    registerUserTools(harness.server, dependencies);

    const managerSchema = z.object(schemaFor(harness, "graph_get_manager"));
    expect(managerSchema.parse({})).toEqual({ user_id: "" });
    for (const userId of [".", ".."]) {
      expect(managerSchema.safeParse({ user_id: userId }).success).toBe(false);
    }

    expect(Object.keys(schemaFor(harness, "graph_list_direct_reports"))).toEqual([
      "user_id",
      "top",
      "skip",
      "compact",
      "next_link",
      "include_next_link",
    ]);
    const reportsSchema = z.object(schemaFor(harness, "graph_list_direct_reports"));
    expect(reportsSchema.parse({})).toEqual({
      user_id: "",
      top: 50,
      skip: 0,
      compact: false,
      next_link: "",
      include_next_link: false,
    });
    expect(reportsSchema.safeParse({ top: 1.5 }).success).toBe(false);
    expect(reportsSchema.safeParse({ skip: -1 }).success).toBe(false);
    expect(reportsSchema.safeParse({ skip: 2.5 }).success).toBe(false);
    for (const userId of [".", ".."]) {
      expect(reportsSchema.safeParse({ user_id: userId }).success).toBe(false);
    }
  });

  test.each([
    { name: "graph_search_users", nextLink: USERS_NEXT_LINK },
    { name: "graph_list_direct_reports", nextLink: REPORTS_NEXT_LINK },
  ])("$name rejects a next_link that is not a Graph v1.0 URL", ({ name, nextLink }) => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies();
    registerUserTools(harness.server, dependencies);
    const schema = z.object(schemaFor(harness, name));

    for (const rejected of [
      "https://evil.example.com/v1.0/users",
      "https://graph.microsoft.com/beta/users",
      "/users?$skiptoken=abc",
    ]) {
      const result = schema.safeParse({ query: "Ada", next_link: rejected });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "next_link must be a Microsoft Graph v1.0 URL returned by a previous call.",
        );
      }
    }
    expect(schema.safeParse({ query: "Ada", next_link: nextLink }).success).toBe(true);
  });

  test("gets my manager and another user's manager with the centralized select fields", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [
      { id: "manager-1" },
      { id: "manager-2" },
    ]);
    registerUserTools(harness.server, dependencies);

    await expect(harness.invoke("graph_get_manager")).resolves.toEqual({
      content: [{ type: "text", text: '{"data":{"id":"manager-1"},"message":"success"}' }],
    });
    await expect(
      harness.invoke("graph_get_manager", { user_id: "ada lovelace@example.com" }),
    ).resolves.toEqual({
      content: [{ type: "text", text: '{"data":{"id":"manager-2"},"message":"success"}' }],
    });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/manager",
        params: { $select: USER_PROFILE_FIELDS },
      },
      {
        method: "GET",
        path: "/users/ada%20lovelace%40example.com/manager",
        params: { $select: USER_PROFILE_FIELDS },
      },
    ]);
  });

  test("lists direct reports for me and another user, capping top at fifty", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [
      { value: [{ id: "report-1" }] },
      { value: [{ id: "report-2" }] },
      {},
    ]);
    registerUserTools(harness.server, dependencies);

    await expect(harness.invoke("graph_list_direct_reports")).resolves.toEqual({
      content: [{ type: "text", text: '{"data":[{"id":"report-1"}],"message":"success"}' }],
    });
    await expect(
      harness.invoke("graph_list_direct_reports", { user_id: "ada/1", top: 900 }),
    ).resolves.toEqual({
      content: [{ type: "text", text: '{"data":[{"id":"report-2"}],"message":"success"}' }],
    });
    await expect(harness.invoke("graph_list_direct_reports", { top: 10 })).resolves.toEqual({
      content: [{ type: "text", text: '{"data":[],"message":"success"}' }],
    });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/directReports",
        params: { $select: USER_PROFILE_FIELDS, $top: "50" },
      },
      {
        method: "GET",
        path: "/users/ada%2F1/directReports",
        params: { $select: USER_PROFILE_FIELDS, $top: "50" },
      },
      {
        method: "GET",
        path: "/me/directReports",
        params: { $select: USER_PROFILE_FIELDS, $top: "10" },
      },
    ]);
  });

  test("sends report skip only above zero, selects compact fields, and pages bare", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [
      { value: [] },
      { value: [] },
      { value: [{ id: "report-3" }] },
    ]);
    registerUserTools(harness.server, dependencies);

    await harness.invoke("graph_list_direct_reports", { skip: 50, compact: true });
    await harness.invoke("graph_list_direct_reports", { skip: 0 });
    expect(
      dataFrom(
        await harness.invoke("graph_list_direct_reports", {
          user_id: "ada@example.com",
          top: 10,
          skip: 50,
          compact: true,
          next_link: REPORTS_NEXT_LINK,
          include_next_link: true,
        }),
      ),
    ).toEqual({ items: [{ id: "report-3" }], next_link: "" });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/directReports",
        params: { $select: USER_COMPACT_FIELDS, $top: "50", $skip: "50" },
      },
      {
        method: "GET",
        path: "/me/directReports",
        params: { $select: USER_PROFILE_FIELDS, $top: "50" },
      },
      { method: "GET", path: REPORTS_NEXT_LINK },
    ]);
  });

  test.each([
    { name: "graph_get_manager", response: null },
    { name: "graph_get_manager", response: [{ secret: "payload-secret" }] },
    { name: "graph_list_direct_reports", response: { value: "payload-secret" } },
    { name: "graph_list_direct_reports", response: "payload-secret" },
  ])("rejects a malformed $name response", async ({ name, response }) => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies({}, [response]);
    registerUserTools(harness.server, dependencies);

    const result = await harness.invoke(name);

    expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
    expect(JSON.stringify(result)).not.toContain("payload-secret");
  });

  test.each(["graph_get_manager", "graph_list_direct_reports"])(
    "converts an AuthenticationError from %s",
    async (name) => {
      const harness = createToolHarness();
      const { dependencies } = createDependencies({}, [
        new AuthenticationError("Not authenticated."),
      ]);
      registerUserTools(harness.server, dependencies);

      await expect(harness.invoke(name)).resolves.toEqual({
        content: [
          {
            type: "text",
            text: '{"error":"Not authenticated.","action_required":"Please call the graph_auth_login tool first."}',
          },
        ],
      });
    },
  );
});

describe("unified search tool", () => {
  test("exposes exact snake_case schema, defaults, and the entity type enum", () => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies();
    registerSearchTools(harness.server, dependencies);

    expect(Object.keys(schemaFor(harness, "graph_search_all"))).toEqual([
      "query",
      "entity_types",
      "size",
      "from",
      "compact",
    ]);
    const schema = z.object(schemaFor(harness, "graph_search_all"));
    expect(schema.parse({ query: "budget" })).toEqual({
      query: "budget",
      entity_types: ["message", "event", "driveItem"],
      size: 25,
      from: 0,
      compact: false,
    });
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ query: "budget", size: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ query: "budget", from: 2.5 }).success).toBe(false);
    for (const entityType of [
      "message",
      "event",
      "driveItem",
      "drive",
      "site",
      "list",
      "listItem",
      "chatMessage",
      "person",
    ]) {
      expect(schema.safeParse({ query: "budget", entity_types: [entityType] }).success).toBe(true);
    }
    expect(schema.safeParse({ query: "budget", entity_types: ["mailbox"] }).success).toBe(false);
  });

  test("posts the default request and returns the parsed response", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [{ value: [{ hitsContainers: [] }] }]);
    registerSearchTools(harness.server, dependencies);

    await expect(harness.invoke("graph_search_all", { query: "budget" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"value":[{"hitsContainers":[]}]},"message":"success"}',
        },
      ],
    });
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/search/query",
        body: {
          requests: [
            {
              entityTypes: ["message", "event", "driveItem"],
              query: { queryString: "budget" },
              from: 0,
              size: 25,
            },
          ],
        },
      },
    ]);
  });

  test("caps size at fifty and passes from through for paging", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [{}]);
    registerSearchTools(harness.server, dependencies);

    await harness.invoke("graph_search_all", {
      query: "budget",
      entity_types: ["driveItem"],
      size: 500,
      from: 75,
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/search/query",
        body: {
          requests: [
            {
              entityTypes: ["driveItem"],
              query: { queryString: "budget" },
              from: 75,
              size: 50,
            },
          ],
        },
      },
    ]);
  });

  test.each([
    { label: "chatMessage", entityTypes: ["chatMessage"] },
    { label: "person", entityTypes: ["person"] },
    { label: "person with mail", entityTypes: ["message", "person"] },
  ])("sends the Prefer header for $label", async ({ entityTypes }) => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [{}]);
    registerSearchTools(harness.server, dependencies);

    await harness.invoke("graph_search_all", { query: "budget", entity_types: entityTypes });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/search/query",
        body: {
          requests: [
            {
              entityTypes,
              query: { queryString: "budget" },
              from: 0,
              size: 25,
            },
          ],
        },
        headers: { Prefer: "include-unknown-enum-members" },
      },
    ]);
  });

  test("omits the Prefer header when no unknown enum entity type is requested", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [{}]);
    registerSearchTools(harness.server, dependencies);

    await harness.invoke("graph_search_all", {
      query: "budget",
      entity_types: ["message", "site"],
    });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/search/query",
        body: {
          requests: [
            {
              entityTypes: ["message", "site"],
              query: { queryString: "budget" },
              from: 0,
              size: 25,
            },
          ],
        },
      },
    ]);
  });

  test.each([
    { label: "site", entityTypes: ["chatMessage", "site"] },
    { label: "listItem", entityTypes: ["chatMessage", "listItem"] },
    { label: "driveItem", entityTypes: ["chatMessage", "driveItem"] },
    { label: "drive", entityTypes: ["drive", "chatMessage"] },
    { label: "list", entityTypes: ["list", "chatMessage"] },
  ])("rejects chatMessage combined with $label without calling Graph", async ({ entityTypes }) => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies();
    registerSearchTools(harness.server, dependencies);

    await expect(
      harness.invoke("graph_search_all", { query: "budget", entity_types: entityTypes }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"data":{"error":"chatMessage cannot be combined with SharePoint entity types."},"message":"error"}',
        },
      ],
    });
    expect(graph.calls).toEqual([]);
  });

  test("reduces every hit when compact is set, omitting the fields a hit lacks", async () => {
    const harness = createToolHarness();
    const { dependencies, graph } = createDependencies({}, [
      {
        value: [
          {
            searchTerms: ["budget"],
            hitsContainers: [
              {
                total: 3,
                moreResultsAvailable: true,
                hits: [
                  {
                    hitId: "message-1",
                    rank: 1,
                    summary: "The <c0>budget</c0> review is on Friday.",
                    resource: {
                      "@odata.type": "#microsoft.graph.message",
                      id: "message-1",
                      subject: "Budget review",
                      webLink: "https://outlook.office.com/mail/message-1",
                      bodyPreview: "a long preview that compact drops",
                      from: { emailAddress: { address: "ada@example.com" } },
                    },
                  },
                  {
                    hitId: "drive-item-1",
                    rank: 2,
                    resource: {
                      "@odata.type": "#microsoft.graph.driveItem",
                      id: "drive-item-1",
                      name: "Budget.xlsx",
                      webUrl: "https://contoso.sharepoint.com/Budget.xlsx",
                      size: 4096,
                    },
                  },
                  {
                    rank: 3,
                    resource: { displayName: "Ada Lovelace", id: "person-1" },
                  },
                  { summary: "no resource at all" },
                ],
              },
              { hits: [] },
            ],
          },
          { hitsContainers: [] },
        ],
      },
    ]);
    registerSearchTools(harness.server, dependencies);

    const result = await harness.invoke("graph_search_all", { query: "budget", compact: true });

    expect(dataFrom(result)).toEqual([
      {
        id: "message-1",
        rank: 1,
        summary: "The <c0>budget</c0> review is on Friday.",
        resource_type: "#microsoft.graph.message",
        name_or_subject: "Budget review",
        web_url: "https://outlook.office.com/mail/message-1",
      },
      {
        id: "drive-item-1",
        rank: 2,
        resource_type: "#microsoft.graph.driveItem",
        name_or_subject: "Budget.xlsx",
        web_url: "https://contoso.sharepoint.com/Budget.xlsx",
      },
      { id: "person-1", rank: 3, name_or_subject: "Ada Lovelace" },
      { summary: "no resource at all" },
    ]);
    const hits = dataFrom(result) as Record<string, unknown>[];
    expect(Object.keys(hits[0] ?? {})).toEqual([
      "id",
      "rank",
      "summary",
      "resource_type",
      "name_or_subject",
      "web_url",
    ]);
    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/search/query",
        body: {
          requests: [
            {
              entityTypes: ["message", "event", "driveItem"],
              query: { queryString: "budget" },
              from: 0,
              size: 25,
            },
          ],
        },
      },
    ]);
  });

  test.each([
    { label: "text hits", response: { value: [{ hitsContainers: [{ hits: "payload-secret" }] }] } },
    {
      label: "text hit",
      response: { value: [{ hitsContainers: [{ hits: ["payload-secret"] }] }] },
    },
    { label: "text container", response: { value: [{ hitsContainers: ["payload-secret"] }] } },
    { label: "text response", response: { value: ["payload-secret"] } },
  ])("rejects a malformed compact search payload: $label", async ({ response }) => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies({}, [response]);
    registerSearchTools(harness.server, dependencies);

    const result = await harness.invoke("graph_search_all", { query: "budget", compact: true });

    expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
    expect(JSON.stringify(result)).not.toContain("payload-secret");
  });

  test.each([null, "payload-secret", 42, [{ secret: "payload-secret" }]])(
    "rejects a malformed unified search response",
    async (response) => {
      const harness = createToolHarness();
      const { dependencies } = createDependencies({}, [response]);
      registerSearchTools(harness.server, dependencies);

      const result = await harness.invoke("graph_search_all", { query: "budget" });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
    },
  );

  test("converts an AuthenticationError from the unified search tool", async () => {
    const harness = createToolHarness();
    const { dependencies } = createDependencies({}, [
      new AuthenticationError("Not authenticated."),
    ]);
    registerSearchTools(harness.server, dependencies);

    await expect(harness.invoke("graph_search_all", { query: "budget" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"error":"Not authenticated.","action_required":"Please call the graph_auth_login tool first."}',
        },
      ],
    });
  });
});
