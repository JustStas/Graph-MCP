import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError } from "../../src/errors.js";
import { registerMailboxTools } from "../../src/tools/mailbox-tools.js";
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
  invokeRaw(name: string, args: unknown): Promise<CallToolResult>;
}

const EXPECTED_MAILBOX_TOOLS = [
  {
    name: "graph_get_mailbox_settings",
    description: `Get mailbox settings, including automatic replies, time zone, and working hours.`,
  },
  {
    name: "graph_set_automatic_replies",
    description: `Set or clear the automatic reply (out of office) message.

Args:
    status: "disabled", "alwaysEnabled", or "scheduled". Scheduled requires
        start_datetime and end_datetime.
    internal_message: Reply sent to people inside the organization. When
        \`is_html\` is true, send explicit HTML; markdown is not converted.
    external_message: Reply sent to people outside the organization. Empty
        reuses internal_message.
    external_audience: Who outside the organization receives a reply: "none",
        "contactsOnly", or "all" (default "none").
    start_datetime: Scheduled window start (ISO 8601, e.g. "2025-03-01T09:00:00").
    end_datetime: Scheduled window end (ISO 8601).
    timezone: Timezone for the scheduled window (default "UTC").
    is_html: Whether the messages are HTML content (default: True). Use false
        for plain text.`,
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

const AUTHENTICATION_ERROR_RESULT = {
  content: [
    {
      type: "text",
      text: '{"error":"Not authenticated.","action_required":"Please call the graph_auth_login tool first."}',
    },
  ],
} as const;

const MISSING_SCHEDULE_RESULT = {
  content: [
    {
      type: "text",
      text: '{"data":{"error":"start_datetime and end_datetime are required when status is \\"scheduled\\"."},"message":"error"}',
    },
  ],
} as const;

const FAKE_AUTH_MANAGER: ToolDependencies["authManager"] = {
  getStatus: () => ({ state: "unauthenticated" }),
  login: () => Promise.resolve({ state: "authenticated" }),
  logout: () => Promise.resolve(),
  getValidAccessToken: () => Promise.resolve("access-token"),
  refreshAccessToken: () => Promise.resolve(true),
};

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
    async invokeRaw(name, args) {
      return await this.registration(name).callback(args, {});
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

function registerMailboxHarness(graphResponses: readonly unknown[] = []): {
  readonly harness: ToolHarness;
  readonly graph: GraphFake;
} {
  const harness = createToolHarness();
  const graph = createGraphFake(graphResponses);
  registerMailboxTools(harness.server, {
    authManager: FAKE_AUTH_MANAGER,
    graphClient: graph.graphClient,
  });
  return { harness, graph };
}

describe("mailbox tool registration", () => {
  test("registers exactly the two mailbox names and complete descriptions", () => {
    const { harness } = registerMailboxHarness();

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_MAILBOX_TOOLS);
  });

  test("exposes exact public snake_case schemas, defaults, and enums", () => {
    const { harness } = registerMailboxHarness();

    expect(Object.keys(schemaFor(harness, "graph_get_mailbox_settings"))).toEqual([]);

    const repliesShape = schemaFor(harness, "graph_set_automatic_replies");
    expect(Object.keys(repliesShape)).toEqual([
      "status",
      "internal_message",
      "external_message",
      "external_audience",
      "start_datetime",
      "end_datetime",
      "timezone",
      "is_html",
    ]);

    const repliesSchema = z.object(repliesShape);
    expect(repliesSchema.parse({ status: "disabled" })).toEqual({
      status: "disabled",
      internal_message: "",
      external_message: "",
      external_audience: "none",
      start_datetime: "",
      end_datetime: "",
      timezone: "UTC",
      is_html: true,
    });
    expect(repliesSchema.safeParse({}).success).toBe(false);
    expect(repliesSchema.safeParse({ status: "enabled" }).success).toBe(false);
    expect(repliesSchema.safeParse({ status: "Disabled" }).success).toBe(false);
    for (const status of ["disabled", "alwaysEnabled", "scheduled"]) {
      expect(repliesSchema.safeParse({ status }).success).toBe(true);
    }
    for (const audience of ["none", "contactsOnly", "all"]) {
      expect(
        repliesSchema.safeParse({ status: "disabled", external_audience: audience }).success,
      ).toBe(true);
    }
    expect(
      repliesSchema.safeParse({ status: "disabled", external_audience: "everyone" }).success,
    ).toBe(false);
    expect(repliesSchema.safeParse({ status: "disabled", is_html: "yes" }).success).toBe(false);
  });
});

describe("mailbox settings reads", () => {
  test("gets mailbox settings from the exact path without parameters", async () => {
    const settings = {
      timeZone: "Pacific Standard Time",
      automaticRepliesSetting: { status: "disabled" },
    };
    const { harness, graph } = registerMailboxHarness([settings]);

    expect(dataFrom(await harness.invoke("graph_get_mailbox_settings"))).toEqual(settings);
    expect(graph.calls).toEqual([{ method: "GET", path: "/me/mailboxSettings" }]);
  });

  test.each([null, [], "payload-secret", 42])(
    "rejects malformed mailbox settings response %# without leakage",
    async (response) => {
      const { harness } = registerMailboxHarness([response]);
      const result = await harness.invoke("graph_get_mailbox_settings");

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("automatic replies updates", () => {
  test("disables replies without sending any reply message", async () => {
    const { harness, graph } = registerMailboxHarness([{ automaticRepliesSetting: {} }]);

    expect(
      dataFrom(
        await harness.invoke("graph_set_automatic_replies", {
          status: "disabled",
          internal_message: "Away",
          external_message: "Away too",
        }),
      ),
    ).toEqual({ automaticRepliesSetting: {} });
    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: "/me/mailboxSettings",
        body: {
          automaticRepliesSetting: {
            status: "disabled",
            externalAudience: "none",
          },
        },
      },
    ]);
  });

  test("enables replies with distinct internal and external HTML messages", async () => {
    const { harness, graph } = registerMailboxHarness([{ automaticRepliesSetting: {} }]);

    await harness.invoke("graph_set_automatic_replies", {
      status: "alwaysEnabled",
      internal_message: "<p>Out of office</p>",
      external_message: "<p>Away until Monday</p>",
      external_audience: "all",
    });

    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: "/me/mailboxSettings",
        body: {
          automaticRepliesSetting: {
            status: "alwaysEnabled",
            externalAudience: "all",
            internalReplyMessage: "<p>Out of office</p>",
            externalReplyMessage: "<p>Away until Monday</p>",
          },
        },
      },
    ]);
  });

  test("falls back to the internal message when the external message is empty", async () => {
    const { harness, graph } = registerMailboxHarness([{ automaticRepliesSetting: {} }]);

    await harness.invoke("graph_set_automatic_replies", {
      status: "alwaysEnabled",
      internal_message: "<p>Out of office</p>",
      external_audience: "contactsOnly",
    });

    expect(graph.calls[0]?.body).toEqual({
      automaticRepliesSetting: {
        status: "alwaysEnabled",
        externalAudience: "contactsOnly",
        internalReplyMessage: "<p>Out of office</p>",
        externalReplyMessage: "<p>Out of office</p>",
      },
    });
  });

  test("schedules a window with the exact dateTime and timeZone payloads", async () => {
    const { harness, graph } = registerMailboxHarness([{ automaticRepliesSetting: {} }]);

    await harness.invoke("graph_set_automatic_replies", {
      status: "scheduled",
      internal_message: "<p>On leave</p>",
      start_datetime: "2026-03-01T09:00:00",
      end_datetime: "2026-03-08T17:00:00",
      timezone: "Pacific Standard Time",
    });

    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: "/me/mailboxSettings",
        body: {
          automaticRepliesSetting: {
            status: "scheduled",
            externalAudience: "none",
            internalReplyMessage: "<p>On leave</p>",
            externalReplyMessage: "<p>On leave</p>",
            scheduledStartDateTime: {
              dateTime: "2026-03-01T09:00:00",
              timeZone: "Pacific Standard Time",
            },
            scheduledEndDateTime: {
              dateTime: "2026-03-08T17:00:00",
              timeZone: "Pacific Standard Time",
            },
          },
        },
      },
    ]);
  });

  test("defaults the scheduled window timezone to UTC", async () => {
    const { harness, graph } = registerMailboxHarness([{ automaticRepliesSetting: {} }]);

    await harness.invoke("graph_set_automatic_replies", {
      status: "scheduled",
      internal_message: "Away",
      start_datetime: "2026-03-01T09:00:00",
      end_datetime: "2026-03-08T17:00:00",
    });

    expect(graph.calls[0]?.body).toEqual({
      automaticRepliesSetting: {
        status: "scheduled",
        externalAudience: "none",
        internalReplyMessage: "Away",
        externalReplyMessage: "Away",
        scheduledStartDateTime: { dateTime: "2026-03-01T09:00:00", timeZone: "UTC" },
        scheduledEndDateTime: { dateTime: "2026-03-08T17:00:00", timeZone: "UTC" },
      },
    });
  });

  test.each([
    { start_datetime: "", end_datetime: "" },
    { start_datetime: "2026-03-01T09:00:00", end_datetime: "" },
    { start_datetime: "", end_datetime: "2026-03-08T17:00:00" },
  ])("rejects an incomplete scheduled window without calling Graph: %#", async (window) => {
    const { harness, graph } = registerMailboxHarness();

    const result = await harness.invoke("graph_set_automatic_replies", {
      status: "scheduled",
      internal_message: "Away",
      ...window,
    });

    expect(result).toEqual(MISSING_SCHEDULE_RESULT);
    expect(graph.calls).toEqual([]);
  });

  test("escapes plain-text reply messages and converts newlines", async () => {
    const { harness, graph } = registerMailboxHarness([{ automaticRepliesSetting: {} }]);

    await harness.invoke("graph_set_automatic_replies", {
      status: "alwaysEnabled",
      internal_message: "Ada & Grace <team>\nBack Monday",
      external_message: "Away <until> Monday & later",
      is_html: false,
    });

    expect(graph.calls[0]?.body).toEqual({
      automaticRepliesSetting: {
        status: "alwaysEnabled",
        externalAudience: "none",
        internalReplyMessage: "Ada &amp; Grace &lt;team&gt;<br>Back Monday",
        externalReplyMessage: "Away &lt;until&gt; Monday &amp; later",
      },
    });
  });

  test("escapes the internal fallback used for the external plain-text message", async () => {
    const { harness, graph } = registerMailboxHarness([{ automaticRepliesSetting: {} }]);

    await harness.invoke("graph_set_automatic_replies", {
      status: "alwaysEnabled",
      internal_message: "Ada & Grace <team>",
      is_html: false,
    });

    expect(graph.calls[0]?.body).toEqual({
      automaticRepliesSetting: {
        status: "alwaysEnabled",
        externalAudience: "none",
        internalReplyMessage: "Ada &amp; Grace &lt;team&gt;",
        externalReplyMessage: "Ada &amp; Grace &lt;team&gt;",
      },
    });
  });

  test.each([null, [], "payload-secret"])(
    "rejects malformed automatic replies response %# without leakage",
    async (response) => {
      const { harness } = registerMailboxHarness([response]);
      const result = await harness.invoke("graph_set_automatic_replies", { status: "disabled" });

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
      expect(JSON.stringify(result)).not.toContain("TypeError");
    },
  );
});

describe("mailbox authenticated wrapper errors", () => {
  test.each([
    { name: "graph_get_mailbox_settings", args: {} },
    { name: "graph_set_automatic_replies", args: { status: "disabled" } },
  ])("$name returns the stable authentication error envelope", async ({ name, args }) => {
    const { harness } = registerMailboxHarness([new AuthenticationError("Not authenticated.")]);

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });
});
