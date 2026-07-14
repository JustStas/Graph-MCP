import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

beforeAll(async () => {
  await rm(join(repositoryRoot, "dist"), { recursive: true, force: true });
  await execFileAsync(process.execPath, ["scripts/build.mjs"], { cwd: repositoryRoot });
}, 30_000);

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

function isolatedEnvironment(home: string): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: "",
  };
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Graph MCP did not exit within ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

test("the compiled CLI serves valid MCP traffic over stdio and shuts down cleanly", async () => {
  const home = await mkdtemp(join(tmpdir(), "graph-mcp-stdio-"));
  const client = new Client({ name: "stdio-smoke-test", version: "1.0.0" });
  const transportErrors: Error[] = [];
  client.onerror = (error) => {
    transportErrors.push(error);
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js"],
    cwd: repositoryRoot,
    env: isolatedEnvironment(home),
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
        action_required: {
          setup_command: "graph-mcp setup",
          login_tool: "graph_auth_login",
        },
      },
      message: "success",
    });
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }

  expect(transport.pid).toBeNull();
  expect(transportErrors).toEqual([]);
  expect(stderr).toBe("");
}, 15_000);

test("the compiled CLI exits normally after its stdin is closed", async () => {
  const home = await mkdtemp(join(tmpdir(), "graph-mcp-exit-"));
  const child = spawn(process.execPath, ["dist/cli.js"], {
    cwd: repositoryRoot,
    env: isolatedEnvironment(home),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    child.stdin.end();
    await expect(waitForExit(child, 5_000)).resolves.toEqual({ code: 0, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await rm(home, { recursive: true, force: true });
  }

  expect(stdout).toBe("");
  expect(stderr).toBe("");
}, 10_000);

test.each(["SIGINT", "SIGTERM"] as const)(
  "the compiled CLI exits normally after %s",
  async (signal) => {
    const home = await mkdtemp(join(tmpdir(), `graph-mcp-${signal.toLowerCase()}-`));
    const child = spawn(process.execPath, ["dist/cli.js"], {
      cwd: repositoryRoot,
      env: isolatedEnvironment(home),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      expect(child.kill(signal)).toBe(true);
      await expect(waitForExit(child, 5_000)).resolves.toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await rm(home, { recursive: true, force: true });
    }

    expect(stdout).toBe("");
    expect(stderr).toBe("");
  },
  10_000,
);
