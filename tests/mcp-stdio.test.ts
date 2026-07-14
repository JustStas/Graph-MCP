import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";

type ClientToolResult = Awaited<ReturnType<Client["callTool"]>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstText(result: ClientToolResult): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error("Expected an immediate MCP tool result with content.");
  }
  const content: unknown = result.content[0];
  if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") {
    throw new Error("Expected graph_auth_status to return MCP text content.");
  }
  return content.text;
}

test("the compiled CLI serves valid MCP traffic over stdio and shuts down cleanly", async () => {
  const home = await mkdtemp(join(tmpdir(), "graph-mcp-stdio-"));
  const client = new Client({ name: "stdio-smoke-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js"],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...getDefaultEnvironment(),
      HOME: home,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  try {
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({ name: "Graph MCP", version: "0.6.0" });

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(44);
    expect(new Set(listed.tools.map((tool) => tool.name))).toHaveLength(44);

    const status = await client.callTool({ name: "graph_auth_status", arguments: {} });
    expect(JSON.parse(firstText(status))).toEqual({
      data: {
        authenticated: false,
        message: "Not authenticated",
      },
      message: "success",
    });
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }

  expect(transport.pid).toBeNull();
  expect(stderr).toBe("");
}, 15_000);
