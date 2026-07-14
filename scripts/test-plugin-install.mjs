import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let activeTempRoot = "";

/**
 * @typedef {Record<string, string>} Environment
 * @typedef {{ home: string, claudeConfigDir: string, codexHome: string, tempRoot: string, pluginRoot?: string }} EnvironmentOptions
 * @typedef {{ command?: unknown, args?: unknown, cwd?: unknown }} McpServerConfig
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is unknown[]}
 */
function isUnknownArray(value) {
  return Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {unknown}
 */
function unknownProperty(value, field) {
  return isRecord(value) ? value[field] : undefined;
}

const expectedToolNames = [
  "graph_auth_status",
  "graph_auth_login",
  "graph_auth_logout",
  "graph_get_profile",
  "graph_search_users",
  "graph_get_my_presence",
  "graph_get_user_presence",
  "graph_set_my_presence",
  "graph_search_messages",
  "graph_list_chats",
  "graph_get_chat_messages",
  "graph_send_chat_message",
  "graph_create_chat",
  "graph_list_chat_members",
  "graph_list_teams",
  "graph_list_channels",
  "graph_get_channel_messages",
  "graph_send_channel_message",
  "graph_list_channel_members",
  "graph_get_channel_message_replies",
  "graph_reply_to_channel_message",
  "graph_list_calendars",
  "graph_list_events",
  "graph_get_event",
  "graph_create_event",
  "graph_update_event",
  "graph_delete_event",
  "graph_list_mail",
  "graph_read_mail",
  "graph_search_mail",
  "graph_send_mail",
  "graph_reply_mail",
  "graph_list_mail_attachments",
  "graph_get_mail_attachment",
  "graph_list_online_meetings",
  "graph_list_meeting_transcripts",
  "graph_get_meeting_transcript_content",
  "graph_list_meeting_recordings",
  "graph_get_meeting_recording_url",
  "graph_list_files",
  "graph_search_files",
  "graph_get_file_content",
  "graph_upload_file",
  "graph_share_file",
];

/** @param {unknown} value */
function stringValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "<unserializable>" : serialized;
}

/** @param {unknown} value @param {string} tempRoot */
function sanitize(value, tempRoot) {
  return stringValue(value)
    .replaceAll(repositoryRoot, "<repo-root>")
    .replaceAll(tempRoot, "<temp-root>")
    .replaceAll(String.fromCharCode(27), "")
    .replace(/\s+/g, " ")
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

/** @param {EnvironmentOptions} options @returns {Environment} */
function environmentFor({ home, claudeConfigDir, codexHome, tempRoot, pluginRoot }) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  );

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
  };

  if (pluginRoot) {
    isolated.CLAUDE_PLUGIN_ROOT = pluginRoot;
  } else {
    delete isolated.CLAUDE_PLUGIN_ROOT;
  }

  return isolated;
}

/** @param {string} stage @param {string} command @param {string[]} args @param {{ cwd: string, env: Environment, tempRoot: string }} options */
async function runCommand(stage, command, args, { cwd, env, tempRoot }) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const commandText = [command, ...args].map((argument) => JSON.stringify(argument)).join(" ");
    const stdout = sanitize(unknownProperty(error, "stdout"), tempRoot);
    const stderr = sanitize(unknownProperty(error, "stderr"), tempRoot);
    const details = [
      `${stage} failed: ${commandText}`,
      `exit=${stringValue(unknownProperty(error, "code") || unknownProperty(error, "signal") || "unknown")}`,
      stdout ? `stdout=${stdout}` : "stdout=<empty>",
      stderr ? `stderr=${stderr}` : "stderr=<empty>",
    ].join("; ");
    throw new Error(details);
  }
}

/** @param {string} child @param {string} parent */
async function pathIsInside(child, parent) {
  const [realChild, realParent] = await Promise.all([realpath(child), realpath(parent)]);
  const childRelativeToParent = relative(realParent, realChild);
  return (
    childRelativeToParent === "" ||
    (!childRelativeToParent.startsWith("..") && !isAbsolute(childRelativeToParent))
  );
}

/** @param {string} root */
async function snapshotTree(root) {
  /** @type {Set<string>} */
  const entries = new Set();

  /** @param {string} current @param {string} prefix */
  async function visit(current, prefix) {
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children) {
      const childRelativePath = join(prefix, child.name);
      entries.add(childRelativePath);
      if (child.isDirectory()) {
        await visit(join(current, child.name), childRelativePath);
      }
    }
  }

  await visit(root, "");
  return entries;
}

/** @param {string} label @param {string} installedPath @param {string} tempRoot @param {Set<string>} snapshot */
async function assertInstallInsideTempRoot(label, installedPath, tempRoot, snapshot) {
  const [realInstalledPath, realTempRoot] = await Promise.all([
    realpath(installedPath),
    realpath(tempRoot),
  ]);
  if (!(await pathIsInside(realInstalledPath, realTempRoot))) {
    throw new Error(
      `${label} resolved outside the isolated temporary root: ${sanitize(installedPath, tempRoot)}`,
    );
  }

  const currentSnapshot = await snapshotTree(tempRoot);
  if (currentSnapshot.size <= snapshot.size) {
    throw new Error(`${label} did not create any files in the isolated temporary root.`);
  }

  return relative(realTempRoot, realInstalledPath);
}

/** @param {string} path @returns {Promise<unknown>} */
async function readJson(path) {
  /** @type {unknown} */
  const payload = JSON.parse(await readFile(path, "utf8"));
  return payload;
}

/** @param {unknown} value @param {string} stage @returns {Record<string, unknown>} */
function requireRecord(value, stage) {
  if (!isRecord(value)) {
    throw new Error(`${stage} did not return an object.`);
  }
  return value;
}

/** @param {unknown} value @param {string} stage @returns {unknown[]} */
function requireArray(value, stage) {
  if (!isUnknownArray(value)) {
    throw new Error(`${stage} did not return an array.`);
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {string} stage */
function requireString(value, field, stage) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${stage} did not return a non-empty ${field}.`);
  }
  return value;
}

/** @param {{ label: string, pluginRoot: string, server: McpServerConfig, environment: Environment, tempRoot: string }} options */
async function runMcpSmoke({ label, pluginRoot, server, environment, tempRoot }) {
  const command = requireString(server.command, "command", `${label} MCP manifest`);
  const rawArgs = server.args ?? [];
  if (!Array.isArray(rawArgs) || !rawArgs.every((argument) => typeof argument === "string")) {
    throw new Error(`${label} MCP manifest args must be an array of strings.`);
  }

  const cwd = resolve(pluginRoot, requireString(server.cwd ?? ".", "cwd", `${label} MCP manifest`));
  if (!(await pathIsInside(cwd, pluginRoot))) {
    throw new Error(`${label} MCP cwd escaped its installed plugin root.`);
  }

  const args = rawArgs.map((argument) => argument.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot));
  const client = new Client({
    name: `${label.toLowerCase()}-plugin-install-smoke`,
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: environment,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on(
    "data",
    /** @param {Buffer|string} chunk */ (chunk) => {
      stderr += chunk.toString();
    },
  );

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const actualNames = listed.tools.map((tool) => tool.name).sort();
    const expectedNames = [...expectedToolNames].sort();
    if (
      actualNames.length !== expectedNames.length ||
      actualNames.some((name, index) => name !== expectedNames[index])
    ) {
      throw new Error(
        `${label} MCP tools mismatch: expected 44 exact names, got ${actualNames.length}: ${actualNames.join(",")}`,
      );
    }
  } catch (error) {
    throw new Error(
      `${label} MCP initialize/listTools failed: ${sanitize(error, tempRoot)}${
        stderr.trim() ? `; stderr=${sanitize(stderr, tempRoot)}` : "; stderr=<empty>"
      }`,
    );
  } finally {
    await client.close().catch(() => undefined);
  }

  if (stderr.trim()) {
    throw new Error(`${label} MCP wrote unexpected stderr: ${sanitize(stderr, tempRoot)}`);
  }
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), "graph-mcp-plugin-install-"));
  activeTempRoot = tempRoot;
  const claudeHome = join(tempRoot, "claude-home");
  const claudeConfigDir = join(tempRoot, "claude-config");
  const codexHome = join(tempRoot, "codex-home");
  await mkdir(join(tempRoot, "tmp"), { recursive: true });
  await Promise.all([
    mkdir(claudeHome, { recursive: true }),
    mkdir(claudeConfigDir, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(join(tempRoot, "xdg-config"), { recursive: true }),
    mkdir(join(tempRoot, "xdg-data"), { recursive: true }),
    mkdir(join(tempRoot, "xdg-cache"), { recursive: true }),
    mkdir(join(tempRoot, "appdata"), { recursive: true }),
    mkdir(join(tempRoot, "localappdata"), { recursive: true }),
    mkdir(join(tempRoot, "azure-config"), { recursive: true }),
  ]);

  try {
    await runCommand("Build plugin", process.execPath, ["scripts/build.mjs"], {
      cwd: repositoryRoot,
      env: environmentFor({
        home: claudeHome,
        claudeConfigDir,
        codexHome,
        tempRoot,
      }),
      tempRoot,
    });

    const claudeMarketplace = requireRecord(
      await readJson(join(repositoryRoot, ".claude-plugin/marketplace.json")),
      "Claude marketplace",
    );
    const claudeMarketplaceName = requireString(
      claudeMarketplace.name,
      "marketplace name",
      "Claude marketplace",
    );
    const claudeEnvironment = environmentFor({
      home: claudeHome,
      claudeConfigDir,
      codexHome,
      tempRoot,
    });
    const claudeSnapshot = await snapshotTree(tempRoot);
    await runCommand(
      "Claude marketplace add",
      "claude",
      ["plugin", "marketplace", "add", repositoryRoot, "--scope", "user"],
      { cwd: repositoryRoot, env: claudeEnvironment, tempRoot },
    );
    await runCommand(
      "Claude plugin install",
      "claude",
      ["plugin", "install", `graph-mcp@${claudeMarketplaceName}`, "--scope", "user"],
      { cwd: repositoryRoot, env: claudeEnvironment, tempRoot },
    );
    const claudePlugins = requireArray(
      jsonValue(
        (
          await runCommand("Claude plugin list", "claude", ["plugin", "list", "--json"], {
            cwd: repositoryRoot,
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
      (plugin) => unknownProperty(plugin, "id") === `graph-mcp@${claudeMarketplaceName}`,
    );
    const claudePluginRoot = requireString(
      unknownProperty(claudePlugin, "installPath"),
      "installPath",
      "Claude plugin list",
    );
    await access(join(claudePluginRoot, ".claude-plugin/plugin.json"));
    const claudePluginRelativePath = await assertInstallInsideTempRoot(
      "Claude plugin",
      claudePluginRoot,
      tempRoot,
      claudeSnapshot,
    );
    const claudeMcpConfig = requireRecord(
      await readJson(join(claudePluginRoot, ".mcp.json")),
      "Claude MCP config",
    );
    const claudeMcp = requireRecord(
      requireRecord(claudeMcpConfig.mcpServers, "Claude MCP servers").graph,
      "Claude MCP config",
    );
    await runMcpSmoke({
      label: "Claude",
      pluginRoot: claudePluginRoot,
      server: claudeMcp,
      environment: environmentFor({
        home: claudeHome,
        claudeConfigDir,
        codexHome,
        tempRoot,
        pluginRoot: claudePluginRoot,
      }),
      tempRoot,
    });
    process.stdout.write(`CLAUDE_PLUGIN_INSTALL_PATH ${claudePluginRelativePath}\n`);
    process.stdout.write("CLAUDE_PLUGIN_INSTALL_OK 44\n");

    const codexMarketplace = requireRecord(
      await readJson(join(repositoryRoot, ".agents/plugins/marketplace.json")),
      "Codex marketplace",
    );
    const codexMarketplaceName = requireString(
      codexMarketplace.name,
      "marketplace name",
      "Codex marketplace",
    );
    const codexEnvironment = environmentFor({
      home: claudeHome,
      claudeConfigDir,
      codexHome,
      tempRoot,
    });
    const codexSnapshot = await snapshotTree(tempRoot);
    const codexMarketplaceAdd = requireRecord(
      jsonValue(
        (
          await runCommand(
            "Codex marketplace add",
            "codex",
            ["plugin", "marketplace", "add", repositoryRoot, "--json"],
            { cwd: repositoryRoot, env: codexEnvironment, tempRoot },
          )
        ).stdout,
        "Codex marketplace add",
        tempRoot,
      ),
      "Codex marketplace add",
    );
    if (codexMarketplaceAdd.marketplaceName !== codexMarketplaceName) {
      throw new Error(
        `Codex marketplace name mismatch: expected ${codexMarketplaceName}, got ${stringValue(codexMarketplaceAdd.marketplaceName)}.`,
      );
    }
    const codexInstall = requireRecord(
      jsonValue(
        (
          await runCommand(
            "Codex plugin install",
            "codex",
            ["plugin", "add", `graph-mcp@${codexMarketplaceName}`, "--json"],
            { cwd: repositoryRoot, env: codexEnvironment, tempRoot },
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
    await access(join(codexPluginRoot, ".codex-plugin/plugin.json"));
    const codexPluginRelativePath = await assertInstallInsideTempRoot(
      "Codex plugin",
      codexPluginRoot,
      tempRoot,
      codexSnapshot,
    );
    const codexManifest = requireRecord(
      await readJson(join(codexPluginRoot, ".codex-plugin/plugin.json")),
      "Codex plugin manifest",
    );
    const codexMcp = requireRecord(
      requireRecord(codexManifest.mcpServers, "Codex MCP servers").graph,
      "Codex MCP manifest",
    );
    await runMcpSmoke({
      label: "Codex",
      pluginRoot: codexPluginRoot,
      server: codexMcp,
      environment: environmentFor({
        home: claudeHome,
        claudeConfigDir,
        codexHome,
        tempRoot,
        pluginRoot: codexPluginRoot,
      }),
      tempRoot,
    });
    process.stdout.write(`CODEX_PLUGIN_INSTALL_PATH ${codexPluginRelativePath}\n`);
    process.stdout.write("CODEX_PLUGIN_INSTALL_OK 44\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`PLUGIN_INSTALL_SMOKE_FAILED ${sanitize(error, activeTempRoot)}\n`);
  process.exitCode = 1;
}
