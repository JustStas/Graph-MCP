import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GraphApiError } from "../errors.js";
import { successResponse } from "../responses.js";
import { registerAuthenticatedTool, type ToolDependencies } from "./tool-types.js";

const INVALID_GRAPH_RESPONSE_MESSAGE = "Invalid Microsoft Graph response.";
const MISSING_TASK_UPDATE_MESSAGE = "At least one task field is required.";
const INCOMPLETE_FILTER = "status ne 'completed'";
const RESOURCE_ID_SCHEMA = z
  .string()
  .refine((value) => value !== "" && value !== "." && value !== "..", {
    message: "Resource IDs must not be empty, '.' or '..'.",
  });
const TOP_SCHEMA = z.number().int().default(25);
const IMPORTANCE_SCHEMA = z.enum(["low", "normal", "high"]);
const UPDATE_IMPORTANCE_SCHEMA = z.enum(["low", "normal", "high", ""]);
const STATUS_SCHEMA = z.enum([
  "notStarted",
  "inProgress",
  "completed",
  "waitingOnOthers",
  "deferred",
  "",
]);

type GraphObject = Record<string, unknown>;

function isNonArrayObject(value: unknown): value is GraphObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectionValue(response: unknown): unknown[] {
  if (!isNonArrayObject(response)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  if (!Object.hasOwn(response, "value")) {
    return [];
  }
  if (!Array.isArray(response.value)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response.value;
}

function requireGraphObject(response: unknown): GraphObject {
  if (!isNonArrayObject(response)) {
    throw new GraphApiError(INVALID_GRAPH_RESPONSE_MESSAGE);
  }
  return response;
}

function taskListPath(listId: string): string {
  return `/me/todo/lists/${encodeURIComponent(listId)}/tasks`;
}

function taskPath(listId: string, taskId: string): string {
  return `${taskListPath(listId)}/${encodeURIComponent(taskId)}`;
}

export function registerTasksTools(
  server: Pick<McpServer, "registerTool">,
  dependencies: ToolDependencies,
): void {
  registerAuthenticatedTool(
    server,
    "graph_list_todo_lists",
    {
      description: `List Microsoft To Do task lists.

Use the returned list IDs with the other To Do tools.

Args:
    top: Maximum number of lists to return (default 25, maximum 50).`,
      inputSchema: {
        top: TOP_SCHEMA,
      },
    },
    async ({ top }) => {
      const result = await dependencies.graphClient.get("/me/todo/lists", {
        $top: String(Math.min(top, 50)),
      });
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_todo_tasks",
    {
      description: `List tasks in a Microsoft To Do list.

Args:
    list_id: The task list ID (from graph_list_todo_lists).
    top: Maximum number of tasks to return (default 25, maximum 50).
    filter_query: Optional OData filter (e.g. "status eq 'completed'"). Replaces
        the default incomplete-only filter.
    include_completed: Whether to include completed tasks (default false). When
        false and no filter_query is given, only incomplete tasks are returned.`,
      inputSchema: {
        list_id: RESOURCE_ID_SCHEMA,
        top: TOP_SCHEMA,
        filter_query: z.string().default(""),
        include_completed: z.boolean().default(false),
      },
    },
    async ({ list_id, top, filter_query, include_completed }) => {
      const params: Record<string, string> = {
        $top: String(Math.min(top, 50)),
      };
      if (filter_query !== "") {
        params.$filter = filter_query;
      } else if (!include_completed) {
        params.$filter = INCOMPLETE_FILTER;
      }

      const result = await dependencies.graphClient.get(taskListPath(list_id), params);
      return successResponse(collectionValue(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_create_todo_task",
    {
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
      inputSchema: {
        list_id: RESOURCE_ID_SCHEMA,
        title: z.string(),
        notes: z.string().default(""),
        due_datetime: z.string().default(""),
        timezone: z.string().default("UTC"),
        importance: IMPORTANCE_SCHEMA.default("normal"),
        reminder_datetime: z.string().default(""),
      },
    },
    async ({ list_id, title, notes, due_datetime, timezone, importance, reminder_datetime }) => {
      const task: GraphObject = { title };
      if (notes !== "") {
        task.body = { content: notes, contentType: "text" };
      }
      if (due_datetime !== "") {
        task.dueDateTime = { dateTime: due_datetime, timeZone: timezone };
      }
      if (importance !== "normal") {
        task.importance = importance;
      }
      if (reminder_datetime !== "") {
        task.reminderDateTime = { dateTime: reminder_datetime, timeZone: timezone };
      }

      const result = await dependencies.graphClient.post(taskListPath(list_id), task);
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_update_todo_task",
    {
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
      inputSchema: {
        list_id: RESOURCE_ID_SCHEMA,
        task_id: RESOURCE_ID_SCHEMA,
        title: z.string().default(""),
        notes: z.string().default(""),
        due_datetime: z.string().default(""),
        timezone: z.string().default("UTC"),
        status: STATUS_SCHEMA.default(""),
        importance: UPDATE_IMPORTANCE_SCHEMA.default(""),
      },
    },
    async ({ list_id, task_id, title, notes, due_datetime, timezone, status, importance }) => {
      const updates: GraphObject = {};
      if (title !== "") {
        updates.title = title;
      }
      if (notes !== "") {
        updates.body = { content: notes, contentType: "text" };
      }
      if (due_datetime !== "") {
        updates.dueDateTime = { dateTime: due_datetime, timeZone: timezone };
      }
      if (status !== "") {
        updates.status = status;
      }
      if (importance !== "") {
        updates.importance = importance;
      }
      if (Object.keys(updates).length === 0) {
        return successResponse({ error: MISSING_TASK_UPDATE_MESSAGE }, "error");
      }

      const result = await dependencies.graphClient.patch(taskPath(list_id, task_id), updates);
      return successResponse(requireGraphObject(result));
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_delete_todo_task",
    {
      description: `Delete a task from a Microsoft To Do list.

Args:
    list_id: The task list ID (from graph_list_todo_lists).
    task_id: The task ID to delete.`,
      inputSchema: {
        list_id: RESOURCE_ID_SCHEMA,
        task_id: RESOURCE_ID_SCHEMA,
      },
    },
    async ({ list_id, task_id }) => {
      await dependencies.graphClient.delete(taskPath(list_id, task_id));
      return successResponse({ status: "Task deleted" });
    },
  );

  registerAuthenticatedTool(
    server,
    "graph_list_my_planner_tasks",
    {
      description: `List Microsoft Planner tasks assigned to the user.

Planner tasks live on plans owned by Microsoft 365 groups, so this is separate
from Microsoft To Do. Requires the Tasks.Read permission.

Args:
    top: Maximum number of tasks to return (default 25, maximum 50).`,
      inputSchema: {
        top: TOP_SCHEMA,
      },
    },
    async ({ top }) => {
      const result = await dependencies.graphClient.get("/me/planner/tasks", {
        $top: String(Math.min(top, 50)),
      });
      return successResponse(collectionValue(result));
    },
  );
}
