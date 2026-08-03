import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

import {
  assertCanonicalInside,
  assertFileHashEqual,
  assertInstalledAuthenticity,
  assertMcpFidelity,
  environmentFor,
  runCaptured,
  sanitize,
  withDependencyBoundary,
  withTempWorkspace,
} from "../scripts/test-plugin-install.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const installScript = join(repositoryRoot, "scripts/test-plugin-install.mjs");
const INSTALL_TEST_TIMEOUT_MS = 240_000;
const INSTALL_COMMAND_TIMEOUT_MS = 230_000;
const activeChildren = new Set<ChildProcess>();
const childCleanupPromises = new Map<ChildProcess, Promise<void>>();
const safeWrapperKeys = [
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "SHELL",
  "USER",
  "LOGNAME",
] as const;

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

function wrapperEnvironment(root: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of safeWrapperKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  const home = join(root, "home");
  const temporaryDirectory = join(root, "tmp");
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: "",
    TMPDIR: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
  };
}

async function withWrapperWorkspace<T>(callback: (root: string) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "graph-mcp-install-wrapper-"));
  try {
    await Promise.all([
      mkdir(join(root, "home"), { recursive: true }),
      mkdir(join(root, "tmp"), { recursive: true }),
    ]);
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all([...activeChildren].map((child) => killChild(child)));
});

test(
  "installs fresh plugins through the exact Claude and Codex cache paths",
  async () => {
    await withWrapperWorkspace(async (wrapperRoot) => {
      const result = await runSpawned(process.execPath, [installScript], {
        cwd: repositoryRoot,
        env: wrapperEnvironment(wrapperRoot),
        timeoutMs: INSTALL_COMMAND_TIMEOUT_MS,
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("CLAUDE_PLUGIN_INSTALL_OK 125");
      expect(result.stdout).toContain("CODEX_PLUGIN_INSTALL_OK 125");
    });
  },
  INSTALL_TEST_TIMEOUT_MS,
);

test("the installer and wrapper use spawn-only argument-array process boundaries", async () => {
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

test("the wrapper preserves safe platform variables and owns all home and temp paths", async () => {
  await withWrapperWorkspace(async (root) => {
    const environment = wrapperEnvironment(root);
    for (const key of safeWrapperKeys) {
      if (process.env[key] !== undefined) expect(environment[key]).toBe(process.env[key]);
    }
    for (const key of ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"] as const) {
      const configuredPath = environment[key];
      if (configuredPath === undefined) throw new Error(`${key} was not configured.`);
      await expect(assertCanonicalInside(configuredPath, root, key)).resolves.toBe(
        await realpath(configuredPath),
      );
    }
  });
});

test("the installer environment redirects state and rejects inherited credentials", async () => {
  await withWrapperWorkspace((root) => {
    const inherited = {
      PATH: "/safe/bin",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      LANG: "en_GB.UTF-8",
      NODE_OPTIONS: "--inspect",
      GRAPH_MCP_SKIP_PLUGIN_SYNC: "1",
      AZURE_CLIENT_SECRET: "must-not-leak",
      CUSTOM_CREDENTIAL: "must-not-leak",
    };
    const environment = environmentFor(
      {
        home: join(root, "home"),
        claudeConfigDir: join(root, "claude"),
        codexHome: join(root, "codex"),
        tempRoot: root,
      },
      inherited,
    );

    expect(environment).toMatchObject({
      PATH: "/safe/bin",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      LANG: "en_GB.UTF-8",
      HOME: join(root, "home"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      TMPDIR: join(root, "tmp"),
      TEMP: join(root, "tmp"),
      TMP: join(root, "tmp"),
    });
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("GRAPH_MCP_SKIP_PLUGIN_SYNC");
    expect(environment).not.toHaveProperty("AZURE_CLIENT_SECRET");
    expect(environment).not.toHaveProperty("CUSTOM_CREDENTIAL");
  });
});

test("the dependency boundary detects a source-tree mutation", async () => {
  await withWrapperWorkspace(async (root) => {
    const dependencies = join(root, "dependencies");
    const dependencyFile = join(dependencies, "package.js");
    await mkdir(dependencies, { recursive: true });
    await writeFile(dependencyFile, "before");

    await expect(
      withDependencyBoundary(dependencies, async () => {
        await writeFile(dependencyFile, "after");
      }),
    ).rejects.toThrow("source dependency tree changed during isolated smoke");
  });
});

test("temporary workspace cleanup runs after a primary initialization failure", async () => {
  const parent = await mkdtemp(join(tmpdir(), "graph-mcp-cleanup-test-"));
  let workspace = "";
  try {
    await expect(
      withTempWorkspace(parent, async (root) => {
        workspace = root;
        await writeFile(join(root, "partial-state"), "created");
        throw new Error("primary initialization failure");
      }),
    ).rejects.toThrow("primary initialization failure");
    await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the script process boundary rejects outside paths and terminates a hanging child", async () => {
  await withWrapperWorkspace(async (root) => {
    const environment = wrapperEnvironment(root);
    await expect(
      runCaptured("outside cwd", process.execPath, ["-e", "process.exit(0)"], {
        cwd: dirname(root),
        env: environment,
        tempRoot: root,
      }),
    ).rejects.toThrow("escaped the isolated temporary root");

    await expect(
      runCaptured("hanging child", process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: root,
        env: environment,
        tempRoot: root,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("timed out after 100 ms");
  });
});

test("canonical containment rejects a symlink that escapes its root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "graph-mcp-containment-"));
  const root = join(parent, "root");
  const outside = join(parent, "outside");
  const link = join(root, "plugin");
  try {
    await Promise.all([mkdir(root), mkdir(outside)]);
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await expect(assertCanonicalInside(link, root, "plugin path")).rejects.toThrow(
      "escaped its canonical root",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("installed authenticity rejects wrong cache paths and the staged plugin", async () => {
  await withWrapperWorkspace(async (root) => {
    const sourceRoot = join(root, "source");
    const stagedPluginRoot = join(root, "staged-repository", "plugins", "graph-mcp");
    const expectedInstallRoot = join(root, "host-cache", "graph-mcp", "0.8.1");
    const wrongInstallRoot = join(root, "other-cache", "graph-mcp", "0.8.1");
    for (const pluginRoot of [stagedPluginRoot, expectedInstallRoot, wrongInstallRoot]) {
      await mkdir(join(pluginRoot, "dist"), { recursive: true });
      await writeFile(join(pluginRoot, "dist", "graph-mcp.js"), "same bundle");
    }
    await mkdir(sourceRoot, { recursive: true });

    await expect(
      assertInstalledAuthenticity(
        "Fake host",
        wrongInstallRoot,
        expectedInstallRoot,
        root,
        stagedPluginRoot,
        sourceRoot,
      ),
    ).rejects.toThrow("did not resolve to the expected host cache path");

    await expect(
      assertInstalledAuthenticity(
        "Fake host",
        stagedPluginRoot,
        stagedPluginRoot,
        root,
        stagedPluginRoot,
        sourceRoot,
      ),
    ).rejects.toThrow("resolved to the staged plugin");
  });
});

test("artifact hashes and full MCP metadata detect hostile changes", async () => {
  await withWrapperWorkspace(async (root) => {
    const first = join(root, "first.js");
    const second = join(root, "second.js");
    await writeFile(first, "first bundle");
    await writeFile(second, "second bundle");
    await expect(assertFileHashEqual(first, second, "installed bundle")).rejects.toThrow(
      "hash mismatch",
    );
  });

  const baseline = {
    serverVersion: { name: "Graph MCP", version: "0.8.1" },
    instructions: "baseline instructions",
    tools: { tools: [{ name: "graph_auth_status", description: "baseline" }] },
  };
  expect(() =>
    assertMcpFidelity(
      "Fake host",
      {
        ...baseline,
        tools: { tools: [{ name: "graph_auth_status", description: "changed" }] },
      },
      baseline,
    ),
  ).toThrow("tools/list metadata did not match the staged source");
});

test("diagnostics redact bearer, JSON, URL, and allowlisted sensitive values", () => {
  const diagnostic = sanitize(
    'Bearer bearer-secret {"access_token":"json-token","client_secret":"json-secret"} https://user:password@example.test allowlisted-secret',
    "/temporary/root",
    ["allowlisted-secret"],
  );

  expect(diagnostic).not.toContain("bearer-secret");
  expect(diagnostic).not.toContain("json-token");
  expect(diagnostic).not.toContain("json-secret");
  expect(diagnostic).not.toContain("user:password");
  expect(diagnostic).not.toContain("allowlisted-secret");
  expect(diagnostic).toContain("Bearer <redacted>");
  expect(diagnostic).toContain('"access_token":"<redacted>"');
  expect(diagnostic).toContain('"client_secret":"<redacted>"');
  expect(diagnostic).toContain("https://<redacted>@example.test");
});

test("the wrapper kills a timed-out child instead of leaving an orphan", async () => {
  await withWrapperWorkspace(async (root) => {
    await expect(
      runSpawned(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: dirname(process.execPath),
        env: wrapperEnvironment(root),
        timeoutMs: 100,
      }),
    ).rejects.toThrow("timed out after 100 ms");
  });
});

test("canonical containment accepts a real contained dot-prefixed path", async () => {
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
