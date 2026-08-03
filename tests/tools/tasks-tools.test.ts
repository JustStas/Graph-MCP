import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { describe, expect, test } from "vitest";

import { AuthenticationError } from "../../src/errors.js";
import { registerTasksTools } from "../../src/tools/tasks-tools.js";
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

const LISTS_NEXT_LINK = "https://graph.microsoft.com/v1.0/me/todo/lists?%24skip=25";
const TASKS_NEXT_LINK =
  "https://graph.microsoft.com/v1.0/me/todo/lists/list-1/tasks?%24skiptoken=abc";
const PLANNER_NEXT_LINK = "https://graph.microsoft.com/v1.0/me/planner/tasks?%24skip=25";

const EXPECTED_TASKS_TOOLS = [
  {
    name: "graph_list_todo_lists",
    description: `List Microsoft To Do task lists.

Use the returned list IDs with the other To Do tools.

Args:
    top: Maximum number of lists to return (default 25, maximum 50).
    skip: Number of items to skip before returning results (default 0). Graph
        returns at most 50 per call, so page by raising skip in steps of top.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
  },
  {
    name: "graph_list_todo_tasks",
    description: `List tasks in a Microsoft To Do list.

Args:
    list_id: The task list ID (from graph_list_todo_lists).
    top: Maximum number of tasks to return (default 25, maximum 50).
    filter_query: Optional OData filter (e.g. "status eq 'completed'"). Replaces
        the default incomplete-only filter.
    include_completed: Whether to include completed tasks (default false). When
        false and no filter_query is given, only incomplete tasks are returned.
    skip: Number of items to skip before returning results (default 0). Graph
        returns at most 50 per call, so page by raising skip in steps of top.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
  },
  {
    name: "graph_create_todo_task",
    description: `Create a task in a Microsoft To Do list. Requires the Tasks.ReadWrite permission.

Empty fields are omitted from the created task.

Args:
    list_id: The task list ID (from graph_list_todo_lists).
    title: Task title.
    notes: Optional plain-text notes stored in the task body.
    due_datetime: Optional due date and time (ISO 8601, e.g. "2025-03-01T17:00:00").
    timezone: Timezone for due_datetime and reminder_datetime (default "UTC").
    importance: Task importance: "low", "normal", or "high" (default "normal").
    reminder_datetime: Optional reminder date and time (ISO 8601).`,
  },
  {
    name: "graph_update_todo_task",
    description: `Update a task in a Microsoft To Do list. Only the supplied fields are changed.

Complete a task by setting status to "completed".

Args:
    list_id: The task list ID (from graph_list_todo_lists).
    task_id: The task ID to update.
    title: New task title.
    notes: New plain-text notes for the task body.
    due_datetime: New due date and time (ISO 8601).
    timezone: Timezone for due_datetime (default "UTC").
    status: New status: "notStarted", "inProgress", "completed",
        "waitingOnOthers", or "deferred". Empty leaves the status unchanged.
    importance: New importance: "low", "normal", or "high". Empty leaves the
        importance unchanged.`,
  },
  {
    name: "graph_delete_todo_task",
    description: `Delete a task from a Microsoft To Do list.

Args:
    list_id: The task list ID (from graph_list_todo_lists).
    task_id: The task ID to delete.`,
  },
  {
    name: "graph_list_my_planner_tasks",
    description: `List Microsoft Planner tasks assigned to the user.

Planner tasks live on plans owned by Microsoft 365 groups, so this is separate
from Microsoft To Do. Requires the Tasks.Read permission.

Args:
    top: Maximum number of tasks to return (default 25, maximum 50).
    skip: Number of items to skip before returning results (default 0). Graph
        returns at most 50 per call, so page by raising skip in steps of top.
    next_link: Opaque nextLink URL from a previous call, used to fetch the next
        page. Overrides the other paging arguments when supplied.
    include_next_link: Whether to wrap the result as {items, next_link} so paging
        can continue (default false, which returns a bare list).`,
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

function messageFrom(result: CallToolResult): unknown {
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("Expected a text tool result.");
  }
  const payload: unknown = JSON.parse(content.text);
  if (typeof payload !== "object" || payload === null || !("message" in payload)) {
    throw new Error("Expected a response envelope.");
  }
  return payload.message;
}

const FAKE_AUTH_MANAGER: ToolDependencies["authManager"] = {
  getStatus: () => ({ state: "unauthenticated" }),
  login: () => Promise.resolve({ state: "authenticated" }),
  logout: () => Promise.resolve(),
  getValidAccessToken: () => Promise.resolve("access-token"),
  refreshAccessToken: () => Promise.resolve(true),
};

function registerTasksHarness(graphResponses: readonly unknown[] = []): {
  readonly harness: ToolHarness;
  readonly graph: GraphFake;
} {
  const harness = createToolHarness();
  const graph = createGraphFake(graphResponses);
  registerTasksTools(harness.server, {
    authManager: FAKE_AUTH_MANAGER,
    graphClient: graph.graphClient,
  });
  return { harness, graph };
}

function alwaysRejectingGraphClient(reason: unknown): ToolDependencies["graphClient"] {
  const reject = (): Promise<never> =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    Promise.reject(reason);
  return { get: reject, post: reject, patch: reject, put: reject, delete: reject };
}

describe("tasks tool registration", () => {
  test("registers exactly the six task names and complete descriptions", () => {
    const { harness } = registerTasksHarness();

    expect(
      harness.registrations.map(({ name, config }) => ({
        name,
        description: config.description,
      })),
    ).toEqual(EXPECTED_TASKS_TOOLS);
  });

  test("exposes exact snake_case schemas, defaults, enums, and required fields", () => {
    const { harness } = registerTasksHarness();

    expect(Object.keys(schemaFor(harness, "graph_list_todo_lists"))).toEqual([
      "top",
      "skip",
      "next_link",
      "include_next_link",
    ]);
    const listsSchema = z.object(schemaFor(harness, "graph_list_todo_lists"));
    expect(listsSchema.parse({})).toEqual({
      top: 25,
      skip: 0,
      next_link: "",
      include_next_link: false,
    });
    expect(listsSchema.safeParse({ top: 1.5 }).success).toBe(false);
    expect(listsSchema.safeParse({ skip: -1 }).success).toBe(false);
    expect(listsSchema.safeParse({ skip: 1.5 }).success).toBe(false);

    expect(Object.keys(schemaFor(harness, "graph_list_todo_tasks"))).toEqual([
      "list_id",
      "top",
      "filter_query",
      "include_completed",
      "skip",
      "next_link",
      "include_next_link",
    ]);
    const tasksSchema = z.object(schemaFor(harness, "graph_list_todo_tasks"));
    expect(tasksSchema.parse({ list_id: "list-1" })).toEqual({
      list_id: "list-1",
      top: 25,
      filter_query: "",
      include_completed: false,
      skip: 0,
      next_link: "",
      include_next_link: false,
    });
    for (const listId of ["", ".", ".."]) {
      expect(tasksSchema.safeParse({ list_id: listId }).success).toBe(false);
    }

    expect(Object.keys(schemaFor(harness, "graph_create_todo_task"))).toEqual([
      "list_id",
      "title",
      "notes",
      "due_datetime",
      "timezone",
      "importance",
      "reminder_datetime",
    ]);
    const createSchema = z.object(schemaFor(harness, "graph_create_todo_task"));
    expect(createSchema.parse({ list_id: "list-1", title: "Ship it" })).toEqual({
      list_id: "list-1",
      title: "Ship it",
      notes: "",
      due_datetime: "",
      timezone: "UTC",
      importance: "normal",
      reminder_datetime: "",
    });
    expect(createSchema.safeParse({ list_id: "list-1" }).success).toBe(false);
    expect(
      createSchema.safeParse({ list_id: "list-1", title: "Ship it", importance: "urgent" }).success,
    ).toBe(false);
    expect(
      createSchema.safeParse({ list_id: "list-1", title: "Ship it", importance: "" }).success,
    ).toBe(false);

    expect(Object.keys(schemaFor(harness, "graph_update_todo_task"))).toEqual([
      "list_id",
      "task_id",
      "title",
      "notes",
      "due_datetime",
      "timezone",
      "status",
      "importance",
    ]);
    const updateSchema = z.object(schemaFor(harness, "graph_update_todo_task"));
    expect(updateSchema.parse({ list_id: "list-1", task_id: "task-1" })).toEqual({
      list_id: "list-1",
      task_id: "task-1",
      title: "",
      notes: "",
      due_datetime: "",
      timezone: "UTC",
      status: "",
      importance: "",
    });
    for (const status of [
      "notStarted",
      "inProgress",
      "completed",
      "waitingOnOthers",
      "deferred",
      "",
    ]) {
      expect(updateSchema.safeParse({ list_id: "list-1", task_id: "task-1", status }).success).toBe(
        true,
      );
    }
    expect(
      updateSchema.safeParse({ list_id: "list-1", task_id: "task-1", status: "done" }).success,
    ).toBe(false);
    expect(
      updateSchema.safeParse({ list_id: "list-1", task_id: "task-1", importance: "urgent" })
        .success,
    ).toBe(false);

    const deleteSchema = z.object(schemaFor(harness, "graph_delete_todo_task"));
    expect(deleteSchema.parse({ list_id: "list-1", task_id: "task-1" })).toEqual({
      list_id: "list-1",
      task_id: "task-1",
    });
    expect(deleteSchema.safeParse({ list_id: "list-1", task_id: "" }).success).toBe(false);

    expect(Object.keys(schemaFor(harness, "graph_list_my_planner_tasks"))).toEqual([
      "top",
      "skip",
      "next_link",
      "include_next_link",
    ]);
    const plannerSchema = z.object(schemaFor(harness, "graph_list_my_planner_tasks"));
    expect(plannerSchema.parse({})).toEqual({
      top: 25,
      skip: 0,
      next_link: "",
      include_next_link: false,
    });
    expect(plannerSchema.safeParse({ top: 2.5 }).success).toBe(false);
  });

  test.each(["graph_list_todo_lists", "graph_list_todo_tasks", "graph_list_my_planner_tasks"])(
    "%s rejects a next_link that is not a Graph v1.0 URL",
    (name) => {
      const { harness } = registerTasksHarness();
      const schema = z.object(schemaFor(harness, name));

      for (const nextLink of [
        "https://evil.example.com/v1.0/me/todo/lists",
        "https://graph.microsoft.com/beta/me/todo/lists",
        "/me/todo/lists?$skip=25",
      ]) {
        const result = schema.safeParse({ list_id: "list-1", next_link: nextLink });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.message).toBe(
            "next_link must be a Microsoft Graph v1.0 URL returned by a previous call.",
          );
        }
      }
      expect(schema.safeParse({ list_id: "list-1", next_link: LISTS_NEXT_LINK }).success).toBe(
        true,
      );
    },
  );
});

describe("todo listing", () => {
  test("lists task lists with the capped top", async () => {
    const { harness, graph } = registerTasksHarness([{ value: [{ id: "list-1" }] }, {}]);

    expect(dataFrom(await harness.invoke("graph_list_todo_lists", { top: 200 }))).toEqual([
      { id: "list-1" },
    ]);
    expect(dataFrom(await harness.invoke("graph_list_todo_lists"))).toEqual([]);

    expect(graph.calls).toEqual([
      { method: "GET", path: "/me/todo/lists", params: { $top: "50" } },
      { method: "GET", path: "/me/todo/lists", params: { $top: "25" } },
    ]);
  });

  test("applies the incomplete filter, include_completed, an explicit filter, and the top cap", async () => {
    const { harness, graph } = registerTasksHarness([
      { value: [{ id: "task-1" }] },
      { value: [] },
      { value: [] },
      { value: [] },
    ]);

    expect(
      dataFrom(await harness.invoke("graph_list_todo_tasks", { list_id: "list/one id" })),
    ).toEqual([{ id: "task-1" }]);
    await harness.invoke("graph_list_todo_tasks", {
      list_id: "list-1",
      include_completed: true,
      top: 300,
    });
    await harness.invoke("graph_list_todo_tasks", {
      list_id: "list-1",
      filter_query: "importance eq 'high'",
    });
    await harness.invoke("graph_list_todo_tasks", {
      list_id: "list-1",
      filter_query: "importance eq 'high'",
      include_completed: true,
    });

    expect(graph.calls).toEqual([
      {
        method: "GET",
        path: "/me/todo/lists/list%2Fone%20id/tasks",
        params: { $top: "25", $filter: "status ne 'completed'" },
      },
      {
        method: "GET",
        path: "/me/todo/lists/list-1/tasks",
        params: { $top: "50" },
      },
      {
        method: "GET",
        path: "/me/todo/lists/list-1/tasks",
        params: { $top: "25", $filter: "importance eq 'high'" },
      },
      {
        method: "GET",
        path: "/me/todo/lists/list-1/tasks",
        params: { $top: "25", $filter: "importance eq 'high'" },
      },
    ]);
  });

  test("sends skip only above zero and keeps the incomplete filter", async () => {
    const { harness, graph } = registerTasksHarness([
      { value: [] },
      { value: [] },
      { value: [] },
      { value: [] },
    ]);

    await harness.invoke("graph_list_todo_lists", { skip: 25 });
    await harness.invoke("graph_list_todo_lists", { skip: 0 });
    await harness.invoke("graph_list_todo_tasks", { list_id: "list-1", skip: 50 });
    await harness.invoke("graph_list_my_planner_tasks", { skip: 25 });

    expect(graph.calls).toEqual([
      { method: "GET", path: "/me/todo/lists", params: { $top: "25", $skip: "25" } },
      { method: "GET", path: "/me/todo/lists", params: { $top: "25" } },
      {
        method: "GET",
        path: "/me/todo/lists/list-1/tasks",
        params: { $top: "25", $filter: "status ne 'completed'", $skip: "50" },
      },
      { method: "GET", path: "/me/planner/tasks", params: { $top: "25", $skip: "25" } },
    ]);
  });

  test("fetches each next_link bare and ignores the other arguments", async () => {
    const { harness, graph } = registerTasksHarness([
      { value: [{ id: "list-2" }], "@odata.nextLink": LISTS_NEXT_LINK },
      { value: [{ id: "task-2" }] },
      { value: [{ id: "planner-2" }], "@odata.nextLink": PLANNER_NEXT_LINK },
    ]);

    expect(
      dataFrom(
        await harness.invoke("graph_list_todo_lists", {
          top: 50,
          skip: 25,
          next_link: LISTS_NEXT_LINK,
          include_next_link: true,
        }),
      ),
    ).toEqual({ items: [{ id: "list-2" }], next_link: LISTS_NEXT_LINK });
    expect(
      dataFrom(
        await harness.invoke("graph_list_todo_tasks", {
          list_id: "list-1",
          top: 50,
          filter_query: "importance eq 'high'",
          include_completed: true,
          skip: 25,
          next_link: TASKS_NEXT_LINK,
          include_next_link: true,
        }),
      ),
    ).toEqual({ items: [{ id: "task-2" }], next_link: "" });
    expect(
      dataFrom(
        await harness.invoke("graph_list_my_planner_tasks", { next_link: PLANNER_NEXT_LINK }),
      ),
    ).toEqual([{ id: "planner-2" }]);

    expect(graph.calls).toEqual([
      { method: "GET", path: LISTS_NEXT_LINK },
      { method: "GET", path: TASKS_NEXT_LINK },
      { method: "GET", path: PLANNER_NEXT_LINK },
    ]);
  });

  test("lists Planner tasks with the capped top", async () => {
    const { harness, graph } = registerTasksHarness([{ value: [{ id: "planner-1" }] }, {}]);

    expect(dataFrom(await harness.invoke("graph_list_my_planner_tasks", { top: 80 }))).toEqual([
      { id: "planner-1" },
    ]);
    expect(dataFrom(await harness.invoke("graph_list_my_planner_tasks"))).toEqual([]);

    expect(graph.calls).toEqual([
      { method: "GET", path: "/me/planner/tasks", params: { $top: "50" } },
      { method: "GET", path: "/me/planner/tasks", params: { $top: "25" } },
    ]);
  });

  test.each(["graph_list_todo_lists", "graph_list_my_planner_tasks"])(
    "rejects a malformed collection response from %s",
    async (name) => {
      const { harness } = registerTasksHarness([{ value: "payload-secret" }]);

      const result = await harness.invoke(name, {});

      expect(result).toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      expect(JSON.stringify(result)).not.toContain("payload-secret");
    },
  );
});

describe("todo task writes", () => {
  test("creates a task with only the supplied parts", async () => {
    const { harness, graph } = registerTasksHarness([{ id: "task-1" }, { id: "task-2" }]);

    expect(
      dataFrom(
        await harness.invoke("graph_create_todo_task", {
          list_id: "list/one id",
          title: "Ship it",
          notes: "Do the thing",
          due_datetime: "2026-09-01T17:00:00",
          timezone: "Europe/London",
          importance: "high",
          reminder_datetime: "2026-08-31T09:00:00",
        }),
      ),
    ).toEqual({ id: "task-1" });
    await harness.invoke("graph_create_todo_task", { list_id: "list-1", title: "Bare" });

    expect(graph.calls).toEqual([
      {
        method: "POST",
        path: "/me/todo/lists/list%2Fone%20id/tasks",
        body: {
          title: "Ship it",
          body: { content: "Do the thing", contentType: "text" },
          dueDateTime: { dateTime: "2026-09-01T17:00:00", timeZone: "Europe/London" },
          importance: "high",
          reminderDateTime: { dateTime: "2026-08-31T09:00:00", timeZone: "Europe/London" },
        },
      },
      {
        method: "POST",
        path: "/me/todo/lists/list-1/tasks",
        body: { title: "Bare" },
      },
    ]);
  });

  test("patches only the supplied task fields and encodes both ids", async () => {
    const { harness, graph } = registerTasksHarness([{ id: "task-1" }, { id: "task-1" }]);

    expect(
      dataFrom(
        await harness.invoke("graph_update_todo_task", {
          list_id: "list/one id",
          task_id: "task/one id",
          status: "completed",
        }),
      ),
    ).toEqual({ id: "task-1" });
    await harness.invoke("graph_update_todo_task", {
      list_id: "list-1",
      task_id: "task-1",
      title: "Renamed",
      notes: "New notes",
      due_datetime: "2026-09-02T12:00:00",
      timezone: "Europe/London",
      importance: "normal",
    });

    expect(graph.calls).toEqual([
      {
        method: "PATCH",
        path: "/me/todo/lists/list%2Fone%20id/tasks/task%2Fone%20id",
        body: { status: "completed" },
      },
      {
        method: "PATCH",
        path: "/me/todo/lists/list-1/tasks/task-1",
        body: {
          title: "Renamed",
          body: { content: "New notes", contentType: "text" },
          dueDateTime: { dateTime: "2026-09-02T12:00:00", timeZone: "Europe/London" },
          importance: "normal",
        },
      },
    ]);
  });

  test("returns an error envelope with no Graph call when no task field is supplied", async () => {
    const { harness, graph } = registerTasksHarness();

    const result = await harness.invoke("graph_update_todo_task", {
      list_id: "list-1",
      task_id: "task-1",
    });

    expect(dataFrom(result)).toEqual({ error: "At least one task field is required." });
    expect(messageFrom(result)).toBe("error");
    expect(graph.calls).toEqual([]);
  });

  test("deletes a task and encodes both ids", async () => {
    const { harness, graph } = registerTasksHarness([{}]);

    expect(
      dataFrom(
        await harness.invoke("graph_delete_todo_task", {
          list_id: "list/one id",
          task_id: "task/one id",
        }),
      ),
    ).toEqual({ status: "Task deleted" });
    expect(graph.calls).toEqual([
      {
        method: "DELETE",
        path: "/me/todo/lists/list%2Fone%20id/tasks/task%2Fone%20id",
      },
    ]);
  });

  test.each([null, "text", 42, [{ id: "task-1" }]])(
    "rejects a malformed task write response",
    async (response) => {
      const { harness } = registerTasksHarness([response, response]);

      await expect(
        harness.invoke("graph_create_todo_task", { list_id: "list-1", title: "Ship it" }),
      ).resolves.toEqual(INVALID_GRAPH_RESPONSE_RESULT);
      await expect(
        harness.invoke("graph_update_todo_task", {
          list_id: "list-1",
          task_id: "task-1",
          title: "Renamed",
        }),
      ).resolves.toEqual(INVALID_GRAPH_RESPONSE_RESULT);
    },
  );
});

describe("tasks authenticated wrapper errors", () => {
  test.each([
    { name: "graph_list_todo_lists", args: {} },
    { name: "graph_list_todo_tasks", args: { list_id: "list-1" } },
    { name: "graph_create_todo_task", args: { list_id: "list-1", title: "Ship it" } },
    {
      name: "graph_update_todo_task",
      args: { list_id: "list-1", task_id: "task-1", status: "completed" },
    },
    { name: "graph_delete_todo_task", args: { list_id: "list-1", task_id: "task-1" } },
    { name: "graph_list_my_planner_tasks", args: {} },
  ])("converts an AuthenticationError from $name", async ({ name, args }) => {
    const harness = createToolHarness();
    registerTasksTools(harness.server, {
      authManager: FAKE_AUTH_MANAGER,
      graphClient: alwaysRejectingGraphClient(new AuthenticationError("Not authenticated.")),
    });

    await expect(harness.invoke(name, args)).resolves.toEqual(AUTHENTICATION_ERROR_RESULT);
  });
});
