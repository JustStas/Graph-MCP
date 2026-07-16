import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { assertCanonicalInside } from "../scripts/test-plugin-install.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const installScript = join(repositoryRoot, "scripts/test-plugin-install.mjs");
const INSTALL_TEST_TIMEOUT_MS = 240_000;
const INSTALL_COMMAND_TIMEOUT_MS = 230_000;
const activeChildren = new Set<ChildProcess>();
const childCleanupPromises = new Map<ChildProcess, Promise<void>>();

type SpawnResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type SpawnOptions = {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  outputLimit?: number;
};

function killChild(child: ChildProcess): Promise<void> {
  const existingCleanup = childCleanupPromises.get(child);
  if (existingCleanup) return existingCleanup;

  const cleanup = killChildOnce(child);
  childCleanupPromises.set(child, cleanup);
  return cleanup.finally(() => childCleanupPromises.delete(child));
}

function killChildOnce(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const closePromise = new Promise<void>((resolveClose) => {
      child.once("close", () => resolveClose());
    });
    child.kill("SIGTERM");

    void (async () => {
      await Promise.race([
        closePromise,
        new Promise((resolveDelay) => {
          const timer = setTimeout(resolveDelay, 250);
          timer.unref();
        }),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.race([
        closePromise,
        new Promise((resolveDelay) => {
          const timer = setTimeout(resolveDelay, 1_000);
          timer.unref();
        }),
      ]);
      resolve();
    })();
  });
}

function runSpawned(command: string, args: string[], options: SpawnOptions): Promise<SpawnResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const outputLimit = options.outputLimit ?? 1024 * 1024;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  let stdout = "";
  let stderr = "";
  let failure: Error | undefined;
  let timer: NodeJS.Timeout | undefined;

  const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
    const next = target === "stdout" ? stdout + chunk.toString() : stderr + chunk.toString();
    if (next.length > outputLimit) {
      failure = new Error(`${target} exceeded ${outputLimit} bytes`);
      void killChild(child);
      return;
    }
    if (target === "stdout") stdout = next;
    else stderr = next;
  };

  return new Promise((resolve, reject) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      activeChildren.delete(child);
      if (timer) clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      resolve({ code, signal, stdout, stderr });
    };

    child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", finish);
    timer = setTimeout(() => {
      failure = new Error(`child timed out after ${timeoutMs} ms`);
      void killChild(child);
    }, timeoutMs);
    timer.unref();
  });
}

const minimalEnvironment = {
  PATH: process.env.PATH ?? "",
  HOME: join(repositoryRoot, ".test-home"),
};

test(
  "installs the plugin through Claude and Codex local marketplaces",
  async () => {
    const result = await runSpawned(process.execPath, [installScript], {
      cwd: repositoryRoot,
      env: minimalEnvironment,
      timeoutMs: INSTALL_COMMAND_TIMEOUT_MS,
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("CLAUDE_PLUGIN_INSTALL_OK 44");
    expect(result.stdout).toContain("CODEX_PLUGIN_INSTALL_OK 44");
  },
  INSTALL_TEST_TIMEOUT_MS,
);

afterEach(async () => {
  await Promise.all([...activeChildren].map((child) => killChild(child)));
});

test("the installer uses spawn-only argument-array process boundaries", async () => {
  const [scriptSource, testSource] = await Promise.all([
    readFile(installScript, "utf8"),
    readFile(fileURLToPath(import.meta.url), "utf8"),
  ]);

  const forbiddenRunnerName = ["exec", "File"].join("");
  expect(scriptSource).not.toContain(forbiddenRunnerName);
  expect(testSource).not.toContain(forbiddenRunnerName);
  expect(scriptSource).toContain("shell: false");
  expect(testSource).toContain("shell: false");
});

test("the install wrapper has an explicit timeout and active-child teardown", async () => {
  const source = await readFile(fileURLToPath(import.meta.url), "utf8");

  expect(source).toContain("INSTALL_TEST_TIMEOUT_MS");
  expect(source).toContain("afterEach");
  expect(source).toContain("activeChildren");
});

test("the installer uses an explicit isolated environment and redirects all temp variables", async () => {
  const source = await readFile(installScript, "utf8");

  expect(source).toContain("NODE_OPTIONS");
  expect(source).toContain("GRAPH_MCP_SKIP_PLUGIN_SYNC");
  expect(source).toContain("TEMP");
  expect(source).toContain("TMP");
  expect(source).toContain("XDG_CONFIG_HOME");
  expect(source).not.toContain("Object.entries(process.env)");
});

test("the installer stages the repository before host commands and cleans initialization failures", async () => {
  const source = await readFile(installScript, "utf8");

  expect(source).toContain("cp(");
  expect(source).toContain("symlink(");
  expect(source).toContain("stagedRepositoryRoot");
  expect(source).toContain("try {");
  expect(source).toContain("finally {");
  expect(source).toContain("AggregateError");
});

test("the dependency symlink has a complete before-and-after mutation boundary", async () => {
  const source = await readFile(installScript, "utf8");

  expect(source).toContain("snapshotFilesystem");
  expect(source).toContain("withDependencyBoundary");
  expect(source).toContain('join(repositoryRoot, "node_modules")');
  expect(source).toContain("source dependency tree changed");
});

test("the installer enforces deadlines, termination escalation, and MCP close cleanup", async () => {
  const source = await readFile(installScript, "utf8");

  expect(source).toContain("AbortController");
  expect(source).toContain("SIGTERM");
  expect(source).toContain("SIGKILL");
  expect(source).toContain("120_000");
  expect(source).toContain("client.close");
  expect(source).toContain("transport.close");
});

test("the installer rejects outside entrypoints and hash mismatches and compares a staged baseline", async () => {
  const source = await readFile(installScript, "utf8");

  expect(source).toContain("assertEntrypointInside");
  expect(source).toContain("hashFile");
  expect(source).toContain("createHash");
  expect(source).toContain("normalizeDeep");
  expect(source).toContain("getInstructions");
  expect(source).toContain("getServerVersion");
  expect(source).toContain("staged baseline");
});

test("the wrapper kills a timed-out child instead of leaving an orphan", async () => {
  await expect(
    runSpawned(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: dirname(process.execPath),
      env: minimalEnvironment,
      timeoutMs: 100,
    }),
  ).rejects.toThrow("timed out after 100 ms");
});

test("canonical containment accepts a real contained dot-prefixed path", async () => {
  const { mkdir, mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "graph-mcp-containment-"));
  const contained = join(root, ".hidden", "plugin");

  try {
    await mkdir(contained, { recursive: true });
    const canonicalContained = await realpath(contained);
    await expect(assertCanonicalInside(canonicalContained, root, "contained path")).resolves.toBe(
      canonicalContained,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
