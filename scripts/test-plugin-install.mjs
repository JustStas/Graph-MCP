import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const execPath = process.execPath;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMAND_TIMEOUT_MS = 120_000;
const MCP_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 500;
const SNAPSHOT_CONCURRENCY = 32;
/** @type {string[]} */
const activeSensitiveValues = [];
let activeTempRoot = "";

/**
 * @returns {Promise<{
 *   Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client,
 *   StdioClientTransport: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport,
 * }>}
 */
async function loadMcpSdk() {
  const [clientModule, stdioModule] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  return {
    Client: clientModule.Client,
    StdioClientTransport: stdioModule.StdioClientTransport,
  };
}

const ALLOWLISTED_ENV_KEYS = [
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
];

const FORBIDDEN_ENV_KEYS = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "GRAPH_MCP_SKIP_PLUGIN_SYNC",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_ACCESS_TOKEN",
  "GRAPH_ACCESS_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
];

const expectedToolNames = [
  "graph_add_mail_attachment",
  "graph_auth_login",
  "graph_auth_logout",
  "graph_auth_status",
  "graph_create_chat",
  "graph_create_event",
  "graph_create_folder",
  "graph_create_mail_draft",
  "graph_create_mail_folder",
  "graph_delete_event",
  "graph_delete_file",
  "graph_delete_mail",
  "graph_flag_mail",
  "graph_forward_mail",
  "graph_get_channel_message_replies",
  "graph_get_channel_messages",
  "graph_get_chat_messages",
  "graph_get_event",
  "graph_get_file_content",
  "graph_get_mail_attachment",
  "graph_get_mailbox_settings",
  "graph_get_meeting_recording_url",
  "graph_get_meeting_transcript_content",
  "graph_get_my_presence",
  "graph_get_profile",
  "graph_get_schedule",
  "graph_get_user_presence",
  "graph_list_calendars",
  "graph_list_channel_members",
  "graph_list_channels",
  "graph_list_chat_members",
  "graph_list_chats",
  "graph_list_events",
  "graph_list_files",
  "graph_list_mail",
  "graph_list_mail_attachments",
  "graph_list_mail_folders",
  "graph_list_meeting_recordings",
  "graph_list_meeting_transcripts",
  "graph_list_online_meetings",
  "graph_list_shared_files",
  "graph_list_teams",
  "graph_mark_mail_read",
  "graph_move_file",
  "graph_move_mail",
  "graph_read_mail",
  "graph_reply_mail",
  "graph_reply_to_channel_message",
  "graph_respond_to_event",
  "graph_search_files",
  "graph_search_mail",
  "graph_search_messages",
  "graph_search_users",
  "graph_send_channel_message",
  "graph_send_chat_message",
  "graph_send_mail",
  "graph_send_mail_draft",
  "graph_set_automatic_replies",
  "graph_set_my_presence",
  "graph_share_file",
  "graph_update_event",
  "graph_upload_file",
];

/**
 * @typedef {Record<string, string>} Environment
 * @typedef {{ home: string, claudeConfigDir: string, codexHome: string, tempRoot: string, pluginRoot?: string }} EnvironmentOptions
 * @typedef {{ command?: unknown, args?: unknown, cwd?: unknown }} McpServerConfig
 * @typedef {{ stdout: string, stderr: string, code: number | null, signal: NodeJS.Signals | null }} CommandResult
 * @typedef {{ serverVersion: unknown, instructions: unknown, tools: unknown }} McpSmokeResult
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is unknown[]} */
function isUnknownArray(value) {
  return Array.isArray(value);
}

/** @param {unknown} value @param {string} field @returns {unknown} */
function unknownProperty(value, field) {
  return isRecord(value) ? value[field] : undefined;
}

/** @param {unknown} value */
function stringValue(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "<unserializable>" : serialized;
}

/** @param {unknown} value @returns {Error} */
function errorValue(value) {
  return value instanceof Error ? value : new Error(stringValue(value));
}

/**
 * @param {unknown} value
 * @param {string} tempRoot
 * @param {readonly string[]} [sensitiveValues]
 */
function sanitize(value, tempRoot, sensitiveValues = activeSensitiveValues) {
  let result = stringValue(value)
    .replaceAll(repositoryRoot, "<source-repo>")
    .replaceAll(tempRoot, "<temp-root>")
    .replaceAll(String.fromCharCode(27), "")
    .replace(/\s+/g, " ");

  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 3) result = result.replaceAll(sensitiveValue, "<redacted>");
  }

  return result
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>")
    .replace(
      /("(?:access|refresh)[_-]?token"|"authorization(?:[_-]?code)?"|"code[_-]?verifier"|"pkce[_-]?verifier"|"client[_-]?secret"|"encryption[_-]?key")\s*:\s*"[^"]*"/gi,
      (match) => `${match.slice(0, match.indexOf(":") + 1)}"<redacted>"`,
    )
    .replace(
      /((?:access|refresh)[_-]?token|authorization(?:[_-]?code)?|code[_-]?verifier|pkce[_-]?verifier|client[_-]?secret|encryption[_-]?key)\s*[=:]\s*[^\s;,]+/gi,
      "$1=<redacted>",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+):([^/@\s]+)@/gi, "$1<redacted>@")
    .trim()
    .slice(0, 2_000);
}

/** @param {string} text @param {string} stage @param {string} tempRoot @returns {unknown} */
function jsonValue(text, stage, tempRoot) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${stage} returned invalid JSON: ${sanitize(text, tempRoot)} (${sanitize(error, tempRoot)})`,
    );
  }
}

/** @param {string} root @param {string} candidate */
function relativePathInside(root, candidate) {
  const childRelativePath = relative(root, candidate);
  return (
    childRelativePath === "" ||
    (childRelativePath !== ".." &&
      !childRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(childRelativePath))
  );
}

/** @param {string} root @param {string} candidate @param {string} label */
function assertLexicalInside(root, candidate, label) {
  if (!relativePathInside(root, candidate)) {
    throw new Error(`${label} escaped the isolated temporary root.`);
  }
}

/** @param {string} child @param {string} parent */
async function pathIsInside(child, parent) {
  const [realChild, realParent] = await Promise.all([realpath(child), realpath(parent)]);
  return relativePathInside(realParent, realChild);
}

/** @param {string} path @param {string} root @param {string} label */
async function assertCanonicalInside(path, root, label) {
  const [realPath, realRoot] = await Promise.all([realpath(path), realpath(root)]);
  if (!relativePathInside(realRoot, realPath)) {
    throw new Error(`${label} escaped its canonical root.`);
  }
  return realPath;
}

/** @param {string} path @param {string} root @param {string} label */
async function assertEntrypointInside(path, root, label) {
  return assertCanonicalInside(path, root, `${label} installed plugin root`);
}

/** @param {string} path */
async function hashFile(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

/** @param {string} first @param {string} second @param {string} label */
async function assertFileHashEqual(first, second, label) {
  const [firstHash, secondHash] = await Promise.all([hashFile(first), hashFile(second)]);
  if (firstHash !== secondHash) {
    throw new Error(`${label} hash mismatch.`);
  }
}

/** @param {unknown} value */
/** @param {unknown} value @returns {unknown} */
function normalizeDeep(value) {
  if (Array.isArray(value)) return value.map(normalizeDeep);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeDeep(value[key])]),
  );
}

/** @param {unknown} actual @param {unknown} expected @param {string} label */
function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(normalizeDeep(actual)) !== JSON.stringify(normalizeDeep(expected))) {
    throw new Error(`${label} did not match the staged source.`);
  }
}

/** @param {unknown} value @param {string} stage @returns {Record<string, unknown>} */
function requireRecord(value, stage) {
  if (!isRecord(value)) throw new Error(`${stage} did not return an object.`);
  return value;
}

/** @param {unknown} value @param {string} stage @returns {unknown[]} */
function requireArray(value, stage) {
  if (!isUnknownArray(value)) throw new Error(`${stage} did not return an array.`);
  return value;
}

/** @param {unknown} value @param {string} field @param {string} stage */
function requireString(value, field, stage) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${stage} did not return a non-empty ${field}.`);
  }
  return value;
}

/** @param {import("node:child_process").ChildProcess} child @returns {Promise<void>} */
function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveClose) => child.once("close", () => resolveClose()));
}

/** @param {import("node:child_process").ChildProcess} child */
async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closePromise = waitForClose(child);
  try {
    child.kill("SIGTERM");
  } catch (error) {
    throw new Error(`SIGTERM failed: ${stringValue(error)}`);
  }
  await Promise.race([
    closePromise,
    new Promise((resolveDelay) => {
      const timer = globalThis.setTimeout(resolveDelay, TERMINATION_GRACE_MS);
      timer.unref();
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      throw new Error(`SIGKILL failed: ${stringValue(error)}`);
    }
    await closePromise;
  }
}

/**
 * @param {string} stage
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: Environment, tempRoot: string, timeoutMs?: number }} options
 * @returns {Promise<CommandResult>}
 */
async function runCaptured(
  stage,
  command,
  args,
  { cwd, env, tempRoot, timeoutMs = COMMAND_TIMEOUT_MS },
) {
  assertLexicalInside(tempRoot, cwd, `${stage} cwd`);
  for (const argument of args) {
    if (isAbsolute(argument)) assertLexicalInside(tempRoot, argument, `${stage} argument`);
    else if (argument.includes("/") || argument.includes("\\")) {
      assertLexicalInside(tempRoot, resolve(cwd, argument), `${stage} argument`);
    }
  }
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_ENV_KEYS.includes(key)) {
      throw new Error(`${stage} received forbidden environment variable ${key}.`);
    }
  }

  const controller = new AbortController();
  /** @type {import("node:child_process").ChildProcess} */
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      signal: controller.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`${stage} spawn failed: ${sanitize(error, tempRoot)}`);
  }

  let stdout = "";
  let stderr = "";
  /** @type {Error | undefined} */
  let failure;
  /** @type {Promise<void> | undefined} */
  let terminationPromise;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const requestTermination = () => {
    terminationPromise ??= terminateChild(child);
    return terminationPromise;
  };
  /** @param {"stdout" | "stderr"} target @param {Buffer|string} chunk */
  const append = (target, chunk) => {
    const next = target === "stdout" ? stdout + chunk.toString() : stderr + chunk.toString();
    if (next.length > OUTPUT_LIMIT) {
      failure ??= new Error(`${stage} ${target} exceeded ${OUTPUT_LIMIT} bytes.`);
      void requestTermination();
      return;
    }
    if (target === "stdout") stdout = next;
    else stderr = next;
  };

  return new Promise((resolveResult, rejectResult) => {
    /** @param {number|null} code @param {NodeJS.Signals|null} signal */
    const finish = (code, signal) => {
      if (timer) globalThis.clearTimeout(timer);
      void (async () => {
        let cleanupError;
        try {
          if (terminationPromise) await terminationPromise;
        } catch (error) {
          cleanupError = errorValue(error);
        }
        const commandText = [command, ...args]
          .map((argument) => JSON.stringify(argument))
          .join(" ");
        const primaryError =
          failure ??
          (code === 0 && signal === null
            ? undefined
            : new Error(
                `${stage} failed: ${commandText}; exit=${stringValue(code ?? signal ?? "unknown")}; stdout=${sanitize(stdout, tempRoot) || "<empty>"}; stderr=${sanitize(stderr, tempRoot) || "<empty>"}`,
              ));
        if (primaryError && cleanupError) {
          rejectResult(
            new AggregateError([primaryError, cleanupError], `${stage} failed and cleanup failed.`),
          );
        } else if (primaryError) {
          rejectResult(primaryError);
        } else if (cleanupError) {
          rejectResult(cleanupError);
        } else {
          resolveResult({ stdout, stderr, code, signal });
        }
      })();
    };

    /** @param {Buffer|string} chunk */
    const appendStdout = (chunk) => append("stdout", chunk);
    /** @param {Buffer|string} chunk */
    const appendStderr = (chunk) => append("stderr", chunk);
    child.stdout?.on("data", appendStdout);
    child.stderr?.on("data", appendStderr);
    child.once("error", (error) => {
      failure ??= new Error(`${stage} process error: ${sanitize(error, tempRoot)}`);
      void requestTermination();
    });
    child.once("close", finish);
    timer = globalThis.setTimeout(() => {
      failure ??= new Error(`${stage} timed out after ${timeoutMs} ms.`);
      controller.abort();
      void requestTermination();
    }, timeoutMs);
    timer.unref();
  });
}

/**
 * @param {EnvironmentOptions} options
 * @param {NodeJS.ProcessEnv} [inheritedEnvironment]
 * @returns {Environment}
 */
function environmentFor(
  { home, claudeConfigDir, codexHome, tempRoot, pluginRoot },
  inheritedEnvironment = process.env,
) {
  /** @type {Environment} */
  const environment = {};
  for (const key of ALLOWLISTED_ENV_KEYS) {
    const value = inheritedEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }

  /** @type {Environment & { CLAUDE_PLUGIN_ROOT?: string }} */
  const isolated = {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: "",
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(tempRoot, "xdg-config"),
    XDG_DATA_HOME: join(tempRoot, "xdg-data"),
    XDG_CACHE_HOME: join(tempRoot, "xdg-cache"),
    APPDATA: join(tempRoot, "appdata"),
    LOCALAPPDATA: join(tempRoot, "localappdata"),
    AZURE_CONFIG_DIR: join(tempRoot, "azure-config"),
    TMPDIR: join(tempRoot, "tmp"),
    TEMP: join(tempRoot, "tmp"),
    TMP: join(tempRoot, "tmp"),
  };
  if (pluginRoot) isolated.CLAUDE_PLUGIN_ROOT = pluginRoot;
  activeSensitiveValues.push(...Object.values(isolated).filter((value) => value.length > 3));
  return isolated;
}

/** @param {string} root */
async function snapshotFilesystem(root) {
  /** @type {{ path: string, relativePath: string }[]} */
  const paths = [];
  /** @param {string} current @param {string} prefix */
  async function visit(current, prefix) {
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children) {
      const childPath = join(current, child.name);
      const childRelativePath = join(prefix, child.name);
      paths.push({ path: childPath, relativePath: childRelativePath });
      if (child.isDirectory()) await visit(childPath, childRelativePath);
    }
  }
  await visit(root, "");

  /** @type {string[]} */
  const entries = new Array(paths.length);
  let nextIndex = 0;
  const workerCount = Math.min(SNAPSHOT_CONCURRENCY, paths.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < paths.length) {
        const index = nextIndex;
        nextIndex += 1;
        const entry = paths[index];
        if (!entry) continue;
        const metadata = await lstat(entry.path);
        const { path, relativePath } = entry;
        if (metadata.isDirectory()) {
          entries[index] = `${relativePath}\0directory\0${metadata.mode}`;
        } else if (metadata.isSymbolicLink()) {
          entries[index] = `${relativePath}\0symlink\0${await readlink(path)}`;
        } else if (metadata.isFile()) {
          entries[index] =
            `${relativePath}\0file\0${metadata.mode}\0${metadata.size}\0${await hashFile(path)}`;
        } else {
          entries[index] = `${relativePath}\0other\0${metadata.mode}\0${metadata.size}`;
        }
      }
    }),
  );
  return entries.sort().join("\n");
}

/** @param {string} sourceRoot @param {() => Promise<unknown>} callback */
async function withDependencyBoundary(sourceRoot, callback) {
  const before = await snapshotFilesystem(sourceRoot);
  let primaryError;
  let result;
  try {
    result = await callback();
  } catch (error) {
    primaryError = errorValue(error);
  }
  let cleanupError;
  try {
    const after = await snapshotFilesystem(sourceRoot);
    if (before !== after) throw new Error("source dependency tree changed during isolated smoke.");
  } catch (error) {
    cleanupError = errorValue(error);
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "isolated smoke failed and source dependency cleanup failed.",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

/** @param {string} root @param {string} sourceRoot */
async function stageRepository(root, sourceRoot) {
  const stagedRepositoryRoot = join(root, "staged-repository");
  const excludedTopLevel = new Set([".git", "node_modules", "dist", "coverage", "tmp", ".tmp"]);
  await cp(sourceRoot, stagedRepositoryRoot, {
    recursive: true,
    filter: (sourcePath) => {
      const sourceRelativePath = relative(sourceRoot, sourcePath);
      if (sourceRelativePath === "") return true;
      const topLevel = sourceRelativePath.split(sep)[0] ?? "";
      return !excludedTopLevel.has(topLevel);
    },
  });
  const sourceNodeModules = join(sourceRoot, "node_modules");
  await access(sourceNodeModules);
  await symlink(
    sourceNodeModules,
    join(stagedRepositoryRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return stagedRepositoryRoot;
}

/** @param {string} path */
async function readJson(path) {
  /** @type {unknown} */
  const payload = JSON.parse(await readFile(path, "utf8"));
  return payload;
}

/** @param {string} root @param {string} rawPath @param {string} label @param {boolean} allowPlaceholder */
async function resolveManifestPath(root, rawPath, label, allowPlaceholder) {
  const hasPlaceholder = rawPath.includes("${CLAUDE_PLUGIN_ROOT}");
  if (hasPlaceholder && !allowPlaceholder)
    throw new Error(`${label} has an unsupported plugin-root placeholder.`);
  const expandedPath = rawPath.replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
  if (!hasPlaceholder && isAbsolute(expandedPath))
    throw new Error(`${label} must not be absolute.`);
  if (expandedPath.split(/[\\/]/).includes("..")) throw new Error(`${label} contains traversal.`);
  const candidate = isAbsolute(expandedPath) ? expandedPath : resolve(root, expandedPath);
  return assertEntrypointInside(candidate, root, label);
}

/** @param {string} pluginRoot @param {McpServerConfig} server @param {string} label */
async function resolveServer(pluginRoot, server, label) {
  const rawArgs = server.args;
  if (!Array.isArray(rawArgs) || !rawArgs.every((argument) => typeof argument === "string")) {
    throw new Error(`${label} args must be an array of strings.`);
  }
  /** @type {string[]} */
  const stringArgs = rawArgs;
  const rawCwd = server.cwd === undefined ? "." : requireString(server.cwd, "cwd", label);
  const cwd = await resolveManifestPath(pluginRoot, rawCwd, `${label} cwd`, false);
  const pathIndexes = stringArgs
    .map((argument, index) => (argument.includes("/") || argument.includes("\\") ? index : -1))
    .filter((index) => index >= 0);
  if (pathIndexes.length !== 1)
    throw new Error(`${label} must contain exactly one file entrypoint.`);
  const entrypointIndex = pathIndexes[0];
  if (entrypointIndex === undefined) throw new Error(`${label} entrypoint was missing.`);
  const rawEntrypoint = stringArgs[entrypointIndex];
  if (rawEntrypoint === undefined) throw new Error(`${label} entrypoint was missing.`);
  const entrypoint = await resolveManifestPath(
    pluginRoot,
    rawEntrypoint,
    `${label} entrypoint`,
    true,
  );
  const args = stringArgs.map((argument, index) =>
    index === entrypointIndex ? entrypoint : argument,
  );
  const command = requireString(server.command, "command", label);
  return { command, args, cwd, entrypoint };
}

/**
 * @param {string} label
 * @param {string} path
 * @param {string} expectedInstallRoot
 * @param {string} tempRoot
 * @param {string} stagedPluginRoot
 * @param {string} sourceRoot
 */
async function assertInstalledAuthenticity(
  label,
  path,
  expectedInstallRoot,
  tempRoot,
  stagedPluginRoot,
  sourceRoot,
) {
  const installedPluginRoot = await assertEntrypointInside(path, tempRoot, `${label} plugin`);
  const canonicalExpectedRoot = await assertEntrypointInside(
    expectedInstallRoot,
    tempRoot,
    `${label} expected host cache`,
  );
  if (installedPluginRoot !== canonicalExpectedRoot) {
    throw new Error(`${label} installed plugin did not resolve to the expected host cache path.`);
  }
  const canonicalStagedRoot = await realpath(stagedPluginRoot);
  if (await pathIsInside(installedPluginRoot, canonicalStagedRoot)) {
    throw new Error(`${label} installed plugin resolved to the staged plugin.`);
  }
  const realSourceRoot = await realpath(sourceRoot);
  if (await pathIsInside(installedPluginRoot, realSourceRoot)) {
    throw new Error(`${label} installed plugin resolved to the source repository.`);
  }
  const stagedBundle = join(stagedPluginRoot, "dist/graph-mcp.js");
  const installedBundle = join(installedPluginRoot, "dist/graph-mcp.js");
  await access(installedBundle);
  await assertFileHashEqual(installedBundle, stagedBundle, `${label} graph-mcp.js`);
  const canonicalEntrypoint = await assertEntrypointInside(
    installedBundle,
    installedPluginRoot,
    `${label} entrypoint`,
  );
  if (await pathIsInside(canonicalEntrypoint, realSourceRoot)) {
    throw new Error(`${label} entrypoint resolved to the source repository.`);
  }
  return { installedPluginRoot, canonicalEntrypoint };
}

/** @param {{ close: () => Promise<void> }} client @param {{ close: () => Promise<void> }} transport */
async function closeMcp(client, transport) {
  const errors = [];
  try {
    await client.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await transport.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "MCP transport cleanup failed.");
}

/**
 * @template T
 * @param {Promise<T>} operation
 * @param {string} label
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
async function withDeadline(operation, label, timeoutMs) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {Promise<never>} */
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)),
      timeoutMs,
    );
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) globalThis.clearTimeout(timer);
  }
}

/** @param {{ label: string, pluginRoot: string, server: McpServerConfig, environment: Environment }} options @returns {Promise<McpSmokeResult>} */
async function runMcpSmoke({ label, pluginRoot, server, environment }) {
  const { Client, StdioClientTransport } = await loadMcpSdk();
  const resolvedServer = await resolveServer(pluginRoot, server, `${label} MCP manifest`);
  await assertCanonicalInside(resolvedServer.cwd, activeTempRoot, `${label} MCP cwd`);
  await assertCanonicalInside(resolvedServer.entrypoint, activeTempRoot, `${label} MCP entrypoint`);
  const client = new Client({
    name: `${label.toLowerCase()}-plugin-install-smoke`,
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: resolvedServer.command,
    args: resolvedServer.args,
    cwd: resolvedServer.cwd,
    env: environment,
    stderr: "pipe",
  });
  let stderr = "";
  /** @param {Buffer|string} chunk */
  const appendTransportStderr = (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > OUTPUT_LIMIT) stderr = stderr.slice(0, OUTPUT_LIMIT);
  };
  transport.stderr?.on("data", appendTransportStderr);
  let primaryError;
  let cleanupError;
  let result;
  try {
    await withDeadline(client.connect(transport), `${label} MCP initialize`, MCP_TIMEOUT_MS);
    const listed = requireRecord(
      await withDeadline(client.listTools(), `${label} MCP tools/list`, MCP_TIMEOUT_MS),
      `${label} MCP tools/list`,
    );
    const tools = requireArray(listed.tools, `${label} MCP tools/list`).map((tool) =>
      requireRecord(tool, `${label} MCP tool`),
    );
    const serverVersion = client.getServerVersion();
    if (serverVersion?.version !== "0.7.0" || serverVersion.name !== "Graph MCP") {
      throw new Error(`${label} MCP server version was not Graph MCP 0.7.0.`);
    }
    const actualNames = tools
      .map((tool) => requireString(tool.name, "tool name", `${label} MCP tools/list`))
      .sort();
    const names = [...expectedToolNames].sort();
    if (actualNames.length !== 62 || actualNames.some((name, index) => name !== names[index])) {
      throw new Error(`${label} MCP tools mismatch: got ${actualNames.length} names.`);
    }
    result = {
      serverVersion,
      instructions: client.getInstructions() ?? null,
      tools: { ...listed, tools },
    };
  } catch (error) {
    primaryError = errorValue(error);
  } finally {
    try {
      await closeMcp(client, transport);
    } catch (error) {
      cleanupError = errorValue(error);
    }
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `${label} MCP failed and cleanup failed.`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  if (stderr.trim())
    throw new Error(`${label} MCP wrote unexpected stderr: ${sanitize(stderr, activeTempRoot)}`);
  if (!result) throw new Error(`${label} MCP returned no result.`);
  return result;
}

/** @param {string} root */
function assertTempPaths(root) {
  const paths = [
    join(root, "home"),
    join(root, "claude-config"),
    join(root, "codex-home"),
    join(root, "xdg-config"),
    join(root, "xdg-data"),
    join(root, "xdg-cache"),
    join(root, "appdata"),
    join(root, "localappdata"),
    join(root, "azure-config"),
    join(root, "tmp"),
  ];
  for (const path of paths) assertLexicalInside(root, path, "configured isolated path");
}

/** @param {string} root @param {(tempRoot: string) => Promise<unknown>} callback */
async function withTempWorkspace(root, callback) {
  const tempRoot = await mkdtemp(join(root, "graph-mcp-plugin-install-"));
  activeTempRoot = tempRoot;
  let primaryError;
  let cleanupError;
  let result;
  try {
    result = await callback(tempRoot);
  } catch (error) {
    primaryError = errorValue(error);
  }
  try {
    await rm(tempRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError = errorValue(error);
  }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "workspace cleanup failed.");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

async function main() {
  await withTempWorkspace(tmpdir(), async (tempRoot) => {
    return withDependencyBoundary(join(repositoryRoot, "node_modules"), async () => {
      const home = join(tempRoot, "home");
      const claudeConfigDir = join(tempRoot, "claude-config");
      const codexHome = join(tempRoot, "codex-home");
      const tempPaths = [
        home,
        claudeConfigDir,
        codexHome,
        join(tempRoot, "xdg-config"),
        join(tempRoot, "xdg-data"),
        join(tempRoot, "xdg-cache"),
        join(tempRoot, "appdata"),
        join(tempRoot, "localappdata"),
        join(tempRoot, "azure-config"),
        join(tempRoot, "tmp"),
      ];
      await Promise.all(tempPaths.map((path) => mkdir(path, { recursive: true })));
      assertTempPaths(tempRoot);

      const stagedRepositoryRoot = await stageRepository(tempRoot, repositoryRoot);
      const stagedPluginRoot = join(stagedRepositoryRoot, "plugins/graph-mcp");
      const stagedClaudeMarketplace = requireRecord(
        await readJson(join(stagedRepositoryRoot, ".claude-plugin/marketplace.json")),
        "staged Claude marketplace",
      );
      const stagedCodexMarketplace = requireRecord(
        await readJson(join(stagedRepositoryRoot, ".agents/plugins/marketplace.json")),
        "staged Codex marketplace",
      );
      const claudeMarketplaceName = requireString(
        stagedClaudeMarketplace.name,
        "marketplace name",
        "Claude marketplace",
      );
      const codexMarketplaceName = requireString(
        stagedCodexMarketplace.name,
        "marketplace name",
        "Codex marketplace",
      );
      const stagedManifest = requireRecord(
        await readJson(join(stagedPluginRoot, ".claude-plugin/plugin.json")),
        "staged Claude plugin manifest",
      );
      const pluginName = requireString(
        stagedManifest.name,
        "plugin name",
        "staged plugin manifest",
      );
      const pluginVersion = requireString(
        stagedManifest.version,
        "plugin version",
        "staged plugin manifest",
      );
      const stagedClaudeMcpConfig = requireRecord(
        await readJson(join(stagedPluginRoot, ".mcp.json")),
        "staged Claude MCP config",
      );
      const stagedClaudeServer = requireRecord(
        requireRecord(stagedClaudeMcpConfig.mcpServers, "staged Claude MCP servers").graph,
        "staged Claude MCP server",
      );
      const buildEnvironment = environmentFor({ home, claudeConfigDir, codexHome, tempRoot });
      await runCaptured("Build staged plugin", execPath, ["scripts/build.mjs"], {
        cwd: stagedRepositoryRoot,
        env: buildEnvironment,
        tempRoot,
      });
      const baseline = await runMcpSmoke({
        label: "staged baseline",
        pluginRoot: stagedPluginRoot,
        server: stagedClaudeServer,
        environment: environmentFor({
          home,
          claudeConfigDir,
          codexHome,
          tempRoot,
          pluginRoot: stagedPluginRoot,
        }),
      });

      const claudeEnvironment = environmentFor({ home, claudeConfigDir, codexHome, tempRoot });
      const expectedClaudeInstall = join(
        claudeConfigDir,
        "plugins/cache",
        claudeMarketplaceName,
        pluginName,
        pluginVersion,
      );
      await assertNotExists(expectedClaudeInstall, "Claude expected installed plugin");
      await runCaptured(
        "Claude marketplace add",
        "claude",
        ["plugin", "marketplace", "add", stagedRepositoryRoot, "--scope", "user"],
        { cwd: stagedRepositoryRoot, env: claudeEnvironment, tempRoot },
      );
      await runCaptured(
        "Claude plugin install",
        "claude",
        ["plugin", "install", `${pluginName}@${claudeMarketplaceName}`, "--scope", "user"],
        { cwd: stagedRepositoryRoot, env: claudeEnvironment, tempRoot },
      );
      const claudePlugins = requireArray(
        jsonValue(
          (
            await runCaptured("Claude plugin list", "claude", ["plugin", "list", "--json"], {
              cwd: stagedRepositoryRoot,
              env: claudeEnvironment,
              tempRoot,
            })
          ).stdout,
          "Claude plugin list",
          tempRoot,
        ),
        "Claude plugin list",
      );
      const claudePlugin = claudePlugins.find(
        (plugin) => unknownProperty(plugin, "id") === `${pluginName}@${claudeMarketplaceName}`,
      );
      const claudePluginRoot = requireString(
        unknownProperty(claudePlugin, "installPath"),
        "installPath",
        "Claude plugin list",
      );
      const claudeInstalled = await resolveInstalledPath(
        claudePluginRoot,
        expectedClaudeInstall,
        tempRoot,
        "Claude",
        stagedPluginRoot,
        repositoryRoot,
      );
      assertDeepEqual(
        await readJson(join(claudeInstalled.installedPluginRoot, ".claude-plugin/plugin.json")),
        await readJson(join(stagedPluginRoot, ".claude-plugin/plugin.json")),
        "Claude plugin manifest",
      );
      assertDeepEqual(
        await readJson(join(claudeInstalled.installedPluginRoot, ".mcp.json")),
        await readJson(join(stagedPluginRoot, ".mcp.json")),
        "Claude MCP config",
      );
      const claudeServer = requireRecord(
        requireRecord(
          requireRecord(
            await readJson(join(claudeInstalled.installedPluginRoot, ".mcp.json")),
            "installed Claude MCP config",
          ).mcpServers,
          "installed Claude MCP servers",
        ).graph,
        "installed Claude MCP server",
      );
      const claudeSmoke = await runMcpSmoke({
        label: "Claude",
        pluginRoot: claudeInstalled.installedPluginRoot,
        server: claudeServer,
        environment: environmentFor({
          home,
          claudeConfigDir,
          codexHome,
          tempRoot,
          pluginRoot: claudeInstalled.installedPluginRoot,
        }),
      });
      assertMcpFidelity("Claude", claudeSmoke, baseline);
      process.stdout.write(
        `CLAUDE_PLUGIN_INSTALL_PATH ${await relativeToTempRoot(tempRoot, claudeInstalled.installedPluginRoot)}\n`,
      );
      process.stdout.write("CLAUDE_PLUGIN_INSTALL_OK 62\n");

      const codexEnvironment = environmentFor({ home, claudeConfigDir, codexHome, tempRoot });
      const expectedCodexInstall = join(
        codexHome,
        "plugins/cache",
        codexMarketplaceName,
        pluginName,
        pluginVersion,
      );
      await assertNotExists(expectedCodexInstall, "Codex expected installed plugin");
      const codexMarketplaceAdd = requireRecord(
        jsonValue(
          (
            await runCaptured(
              "Codex marketplace add",
              "codex",
              ["plugin", "marketplace", "add", stagedRepositoryRoot, "--json"],
              { cwd: stagedRepositoryRoot, env: codexEnvironment, tempRoot },
            )
          ).stdout,
          "Codex marketplace add",
          tempRoot,
        ),
        "Codex marketplace add",
      );
      if (codexMarketplaceAdd.marketplaceName !== codexMarketplaceName) {
        throw new Error(`Codex marketplace name mismatch: expected ${codexMarketplaceName}.`);
      }
      const codexInstall = requireRecord(
        jsonValue(
          (
            await runCaptured(
              "Codex plugin install",
              "codex",
              ["plugin", "add", `${pluginName}@${codexMarketplaceName}`, "--json"],
              { cwd: stagedRepositoryRoot, env: codexEnvironment, tempRoot },
            )
          ).stdout,
          "Codex plugin install",
          tempRoot,
        ),
        "Codex plugin install",
      );
      const codexPluginRoot = requireString(
        codexInstall.installedPath,
        "installedPath",
        "Codex plugin install",
      );
      const codexInstalled = await resolveInstalledPath(
        codexPluginRoot,
        expectedCodexInstall,
        tempRoot,
        "Codex",
        stagedPluginRoot,
        repositoryRoot,
      );
      const stagedCodexManifest = await readJson(
        join(stagedPluginRoot, ".codex-plugin/plugin.json"),
      );
      const installedCodexManifest = await readJson(
        join(codexInstalled.installedPluginRoot, ".codex-plugin/plugin.json"),
      );
      assertDeepEqual(installedCodexManifest, stagedCodexManifest, "Codex plugin manifest");
      const codexManifest = requireRecord(
        installedCodexManifest,
        "installed Codex plugin manifest",
      );
      const codexServer = requireRecord(
        requireRecord(codexManifest.mcpServers, "installed Codex MCP servers").graph,
        "installed Codex MCP server",
      );
      const codexSmoke = await runMcpSmoke({
        label: "Codex",
        pluginRoot: codexInstalled.installedPluginRoot,
        server: codexServer,
        environment: environmentFor({
          home,
          claudeConfigDir,
          codexHome,
          tempRoot,
          pluginRoot: codexInstalled.installedPluginRoot,
        }),
      });
      assertMcpFidelity("Codex", codexSmoke, baseline);
      process.stdout.write(
        `CODEX_PLUGIN_INSTALL_PATH ${await relativeToTempRoot(tempRoot, codexInstalled.installedPluginRoot)}\n`,
      );
      process.stdout.write("CODEX_PLUGIN_INSTALL_OK 62\n");
    });
  });
}

/** @param {string} path @param {string} label */
async function assertNotExists(path, label) {
  try {
    await access(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw new Error(`${label} preflight failed: ${stringValue(error)}`);
  }
  throw new Error(`${label} already exists before installation.`);
}

/** @param {string} root @param {string} path */
async function relativeToTempRoot(root, path) {
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
  return relative(realRoot, realPath);
}

/**
 * @param {string} path
 * @param {string} expectedInstallRoot
 * @param {string} tempRoot
 * @param {string} label
 * @param {string} stagedPluginRoot
 * @param {string} sourceRoot
 */
async function resolveInstalledPath(
  path,
  expectedInstallRoot,
  tempRoot,
  label,
  stagedPluginRoot,
  sourceRoot,
) {
  const { installedPluginRoot } = await assertInstalledAuthenticity(
    label,
    path,
    expectedInstallRoot,
    tempRoot,
    stagedPluginRoot,
    sourceRoot,
  );
  const manifestPath = join(
    installedPluginRoot,
    label === "Claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json",
  );
  const canonicalManifestPath = await assertEntrypointInside(
    manifestPath,
    installedPluginRoot,
    `${label} manifest`,
  );
  await stat(canonicalManifestPath);
  return { installedPluginRoot, manifestPath: canonicalManifestPath };
}

/** @param {string} label @param {McpSmokeResult} actual @param {McpSmokeResult} baseline */
function assertMcpFidelity(label, actual, baseline) {
  if (
    JSON.stringify(normalizeDeep(actual.serverVersion)) !==
    JSON.stringify(normalizeDeep(baseline.serverVersion))
  ) {
    throw new Error(`${label} server version differed from staged baseline.`);
  }
  if (actual.instructions !== baseline.instructions)
    throw new Error(`${label} instructions differed from staged baseline.`);
  assertDeepEqual(actual.tools, baseline.tools, `${label} tools/list metadata`);
}

export {
  assertCanonicalInside,
  assertFileHashEqual,
  assertInstalledAuthenticity,
  assertMcpFidelity,
  environmentFor,
  runCaptured,
  sanitize,
  withDependencyBoundary,
  withTempWorkspace,
};

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`PLUGIN_INSTALL_SMOKE_FAILED ${sanitize(error, activeTempRoot)}\n`);
    process.exitCode = 1;
  }
}
