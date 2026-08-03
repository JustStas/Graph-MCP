import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "vitest";

import { loadSettings } from "../src/config.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = join(repositoryRoot, "plugins/graph-mcp");
const repositoryUrl = "https://github.com/JustStas/Graph-MCP";

async function readText(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), "utf8");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readText(path)) as Record<string, unknown>;
}

async function expectFile(path: string): Promise<void> {
  await expect(access(join(repositoryRoot, path))).resolves.toBeUndefined();
}

function expectManifestMetadata(manifest: Record<string, unknown>): void {
  expect(manifest).toMatchObject({
    name: "graph-mcp",
    version: "0.7.0",
    repository: repositoryUrl,
    license: "MIT",
    skills: "./skills/",
    author: {
      name: "JustStas",
      url: "https://github.com/JustStas",
    },
  });
  expect(typeof manifest.description).toBe("string");
  expect((manifest.description as string).length).toBeGreaterThan(0);
}

describe("Graph MCP plugin packaging", () => {
  test("both plugin manifests contain the shared release metadata and component paths", async () => {
    const claudeManifest = await readJson("plugins/graph-mcp/.claude-plugin/plugin.json");
    const codexManifest = await readJson("plugins/graph-mcp/.codex-plugin/plugin.json");

    expectManifestMetadata(claudeManifest);
    expect(claudeManifest.mcpServers).toBe("./.mcp.json");
    expectManifestMetadata(codexManifest);
  });

  test("the Codex manifest uses only supported fields and complete interface metadata", async () => {
    const manifest = await readJson("plugins/graph-mcp/.codex-plugin/plugin.json");
    const supportedFields = new Set([
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "skills",
      "mcpServers",
      "interface",
    ]);
    expect(Object.keys(manifest).every((key) => supportedFields.has(key))).toBe(true);

    const userInterface = manifest.interface as Record<string, unknown>;
    expect(userInterface).toMatchObject({
      displayName: "Graph MCP",
      shortDescription: "Connect Codex to Microsoft Graph.",
      longDescription: "Read and act on approved Microsoft Graph data through a local MCP server.",
      developerName: "JustStas",
      category: "Productivity",
      capabilities: ["Read", "Write", "Interactive"],
      websiteURL: repositoryUrl,
    });

    expect(manifest.mcpServers).toEqual({
      graph: {
        command: "node",
        args: ["./dist/graph-mcp.js"],
        cwd: ".",
      },
    });

    const starterPrompts = userInterface.defaultPrompt;
    expect(Array.isArray(starterPrompts)).toBe(true);
    expect((starterPrompts as string[]).length).toBeLessThanOrEqual(3);
    expect((starterPrompts as string[]).every((prompt) => prompt.length < 128)).toBe(true);
  });

  test("the Claude marketplace points to the repository plugin directory", async () => {
    const marketplace = await readJson(".claude-plugin/marketplace.json");
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;

    expect(plugins).toContainEqual({
      name: "graph-mcp",
      source: "./plugins/graph-mcp",
    });
  });

  test("the Codex marketplace has the required local install policy without its own version", async () => {
    const marketplace = await readJson(".agents/plugins/marketplace.json");
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    const graphPlugin = plugins.find((plugin) => plugin.name === "graph-mcp");

    expect(marketplace.name).toBe("personal");
    expect(graphPlugin).toEqual({
      name: "graph-mcp",
      source: {
        source: "local",
        path: "./plugins/graph-mcp",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Productivity",
    });
    expect(graphPlugin).not.toHaveProperty("version");
    expect(marketplace).not.toHaveProperty("version");
  });

  test("the Claude MCP config uses the Claude plugin-root placeholder", async () => {
    const config = await readJson("plugins/graph-mcp/.mcp.json");

    expect(config).toEqual({
      mcpServers: {
        graph: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/dist/graph-mcp.js"],
        },
      },
    });
  });

  test("the Codex-relative MCP bundle launches from the installed plugin root", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["./dist/graph-mcp.js", "--version"],
      { cwd: pluginRoot },
    );

    expect(stdout).toBe("0.7.0\n");
    expect(stderr).toBe("");
  });

  test("the Codex-relative MCP bundle serves tools/list from its plugin root", async () => {
    const home = await mkdtemp(join(tmpdir(), "graph-mcp-plugin-smoke-"));
    const client = new Client({ name: "graph-mcp-plugin-smoke", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["./dist/graph-mcp.js"],
      cwd: pluginRoot,
      env: {
        ...getDefaultEnvironment(),
        HOME: home,
        USERPROFILE: home,
        HOMEDRIVE: "",
        HOMEPATH: "",
      },
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toEqual({ name: "Graph MCP", version: "0.7.0" });
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(62);
    } finally {
      await client.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("the setup skill has valid trigger-only frontmatter and exact delegated scopes", async () => {
    const skill = await readText("plugins/graph-mcp/skills/setup/SKILL.md");
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter?.[1]).toBeDefined();
    expect(frontmatter?.[1]).toMatch(/^name: [a-z0-9-]+$/m);
    expect(frontmatter?.[1]).toContain(
      "description: Use when installing Graph MCP, configuring Microsoft Graph permissions, handling permission or admin-consent errors, reauthentication, device-code fallback, or Graph authentication failures.",
    );
    expect(frontmatter?.[1]).not.toMatch(/description:.*(?:run|follow|step|guide|command)/i);

    const listedScopes = [...skill.matchAll(/^\s*-\s+`([^`]+)`\s*$/gm)].map((match) => match[1]);
    const settings = await loadSettings({ homeDir: repositoryRoot });
    expect(listedScopes).toEqual(settings.scopes);
    expect(listedScopes).toHaveLength(settings.scopes.length);

    expect(skill).toContain("public client");
    expect(skill).toContain("Mobile and desktop applications");
    expect(skill).toContain("http://localhost:3000/auth/callback");
    expect(skill).toContain('node "${CLAUDE_PLUGIN_ROOT}/dist/graph-mcp.js" setup');
    expect(skill).toContain('node "./dist/graph-mcp.js" setup');
    expect(skill).toContain(
      "For Codex, resolve the installed plugin root as the parent directory of the loaded skills/setup/SKILL.md.",
    );
    expect(skill).toContain("AZURE_CLIENT_ID");
    expect(skill).toContain("AZURE_TENANT_ID");
    expect(skill).toContain("common");
    expect(skill).toContain("Always use the bundled host-specific command.");
    expect(skill).toContain(
      "Quote the host-specific bundled command verbatim when responding; this skill is authoritative over legacy README commands.",
    );
    expect(skill).toContain(
      "Never substitute generic graph-mcp setup, invent host-registration or TOML commands, or use undocumented env-registration commands.",
    );
    expect(skill).toContain(
      "The setup command only persists the Client ID and Tenant ID; it does not perform login.",
    );
    expect(skill).toMatch(/After setup, `graph_auth_login` uses browser login by default\./);
    expect(skill).toContain('method: "device_code"');
    expect(skill).toMatch(/`method: "device_code"` is the fallback\./);
    expect(skill).not.toMatch(/The setup command uses browser login by default\./);
    expect(skill).toContain("tokens-v2.enc");
    expect(skill).toContain(".key-v2");
    expect(skill).not.toContain("tokens.enc");
    expect(skill).not.toMatch(/~\/\.graph-mcp\/\.key(?:\b|[`.)])/);
  });

  test("the setup skill gives deterministic credential, token, and scope-safety guidance", async () => {
    const skill = await readText("plugins/graph-mcp/skills/setup/SKILL.md");
    const lowerSkill = skill.toLowerCase();

    expect(skill).toMatch(/Client ID and Tenant ID are identifiers, not secrets\./);
    expect(skill).toMatch(
      /Never request or store a client secret, access token, refresh token, authorization code, MFA code, or credentials in conversation\./,
    );
    expect(lowerSkill).toContain("tokens are encrypted locally under ~/.graph-mcp");
    expect(lowerSkill).toContain("graph data is passed to the invoking model");
    expect(lowerSkill).toContain("bp");
    expect(lowerSkill).toContain("organizational policy");
    expect(lowerSkill).toContain("least privilege");
    expect(lowerSkill).toContain("admin consent");

    const safeSecuritySentences = [
      "Client ID and Tenant ID are identifiers, not secrets.",
      "Never request or store a client secret, access token, refresh token, authorization code, MFA code, or credentials in conversation.",
    ];
    const sentences = skill
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0 && !safeSecuritySentences.includes(sentence));
    expect(sentences.join("\n")).not.toMatch(
      /\b(?:ask|request|collect|enter|paste|provide|store|save)\s+(?:your\s+)?(?:client secret|access token|refresh token|authorization code|MFA(?: code)?|credentials)\b/i,
    );
  });

  test("the authored plugin documentation and copied release artifacts exist", async () => {
    await expectFile("plugins/graph-mcp/dist/graph-mcp.js");
    await expectFile("plugins/graph-mcp/dist/cli.js.map");
    await expectFile("plugins/graph-mcp/README.md");
    await expectFile("plugins/graph-mcp/LICENSE");

    const pluginReadme = await readText("plugins/graph-mcp/README.md");
    expect(pluginReadme).toContain("Graph MCP");
    expect(pluginReadme).toContain("organizational policy");
    expect(await readText("plugins/graph-mcp/LICENSE")).toContain("MIT License");
  });

  test("the build keeps the root bundle behavior and synchronizes the plugin bundle and license", async () => {
    const buildScript = await readText("scripts/build.mjs");
    const pluginBundleBeforeBuild = await readFile(join(pluginRoot, "dist/graph-mcp.js"));
    const pluginMapBeforeBuild = await readFile(join(pluginRoot, "dist/cli.js.map"));

    try {
      await execFileAsync(process.execPath, ["scripts/build.mjs"], { cwd: repositoryRoot });
      expect(buildScript).toContain('outfile: "dist/cli.js"');
      expect(buildScript).toContain("copyFile");
      expect(buildScript).toContain("plugins/graph-mcp/dist/graph-mcp.js");
      expect(buildScript).toContain("plugins/graph-mcp/LICENSE");
      expect(buildScript).not.toContain('copyFile("README.md"');
      expect(buildScript).not.toContain("replace(/[ \\t]+$/gm");
      expect(buildScript).toContain("GRAPH_MCP_SKIP_PLUGIN_SYNC");
      await expectFile("plugins/graph-mcp/dist/graph-mcp.js");
      await expectFile("plugins/graph-mcp/dist/cli.js.map");
      expect(await readFile(join(pluginRoot, "dist/graph-mcp.js"))).toEqual(
        pluginBundleBeforeBuild,
      );
      expect(await readFile(join(pluginRoot, "dist/cli.js.map"))).toEqual(pluginMapBeforeBuild);
      expect(await readFile(join(repositoryRoot, "dist/cli.js"))).toEqual(
        await readFile(join(pluginRoot, "dist/graph-mcp.js")),
      );
      expect(await readFile(join(repositoryRoot, "dist/cli.js.map"))).toEqual(
        await readFile(join(pluginRoot, "dist/cli.js.map")),
      );
      expect(buildScript).toContain("verifyPluginVersions");
      expect(buildScript).toContain("plugins/graph-mcp/dist/cli.js.map");
    } finally {
      await writeFile(join(pluginRoot, "dist/graph-mcp.js"), pluginBundleBeforeBuild);
      await writeFile(join(pluginRoot, "dist/cli.js.map"), pluginMapBeforeBuild);
    }
  }, 30_000);

  test("root-only build opt-out leaves a plugin artifact sentinel untouched", async () => {
    const pluginBundlePath = join(pluginRoot, "dist/graph-mcp.js");
    const originalPluginBundle = await readFile(pluginBundlePath);
    const sentinelPluginBundle = Buffer.concat([
      originalPluginBundle,
      Buffer.from("\n// stale-plugin-artifact-sentinel\n"),
    ]);

    await writeFile(pluginBundlePath, sentinelPluginBundle);
    try {
      await execFileAsync(process.execPath, ["scripts/build.mjs"], {
        cwd: repositoryRoot,
        env: { ...process.env, GRAPH_MCP_SKIP_PLUGIN_SYNC: "1" },
      });
      expect(await readFile(pluginBundlePath)).toEqual(sentinelPluginBundle);
    } finally {
      await writeFile(pluginBundlePath, originalPluginBundle);
    }
  }, 30_000);

  test("package and both plugin manifest versions are synchronized by the verifier", async () => {
    const packageJson = await readJson("package.json");
    const claudeManifest = await readJson("plugins/graph-mcp/.claude-plugin/plugin.json");
    const codexManifest = await readJson("plugins/graph-mcp/.codex-plugin/plugin.json");

    expect(packageJson.version).toBe("0.7.0");
    expect(claudeManifest.version).toBe(packageJson.version);
    expect(codexManifest.version).toBe(packageJson.version);

    const verifier = await readText("scripts/verify-plugin-versions.mjs");
    expect(verifier).toContain("package.json");
    expect(verifier).toContain(".claude-plugin/plugin.json");
    expect(verifier).toContain(".codex-plugin/plugin.json");
    expect(verifier).toContain("src/cli.ts");
    expect(verifier).toContain("src/server.ts");
    const { verifyPluginVersions } = await import("../scripts/verify-plugin-versions.mjs");
    await expect(verifyPluginVersions()).resolves.toBe("0.7.0");
  });
});
