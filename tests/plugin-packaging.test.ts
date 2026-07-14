import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryUrl = "https://github.com/JustStas/Graph-MCP";
const expectedScopes = [
  "offline_access",
  "openid",
  "profile",
  "User.Read",
  "User.ReadBasic.All",
  "Chat.Read",
  "Chat.ReadWrite",
  "ChatMessage.Send",
  "ChannelMessage.Read.All",
  "ChannelMessage.Send",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "ChannelMember.Read.All",
  "Calendars.ReadWrite",
  "Mail.Read",
  "Mail.Send",
  "Presence.Read",
  "Presence.Read.All",
  "Presence.ReadWrite",
  "OnlineMeetings.Read",
  "OnlineMeetingTranscript.Read.All",
  "OnlineMeetingRecording.Read.All",
  "Files.ReadWrite.All",
];

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
    version: "0.6.0",
    repository: repositoryUrl,
    license: "MIT",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
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

  test("the shared MCP config launches the plugin-root-relative Node bundle", async () => {
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

  test("the setup skill has valid trigger-only frontmatter and exact delegated scopes", async () => {
    const skill = await readText("plugins/graph-mcp/skills/setup/SKILL.md");
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter?.[1]).toBeDefined();
    expect(frontmatter?.[1]).toMatch(/^name: [a-z0-9-]+$/m);
    expect(frontmatter?.[1]).toMatch(/^description: Use when .+$/m);
    expect(frontmatter?.[1]).not.toMatch(/description:.*(?:run|follow|step|guide|install)/i);

    const listedScopes = [...skill.matchAll(/^\s*-\s+`([^`]+)`\s*$/gm)].map((match) => match[1]);
    expect(listedScopes).toEqual(expectedScopes);
    expect(listedScopes).toHaveLength(23);

    expect(skill).toContain("public client");
    expect(skill).toContain("Mobile and desktop applications");
    expect(skill).toContain("http://localhost:3000/auth/callback");
    expect(skill).toContain('node "${CLAUDE_PLUGIN_ROOT}/dist/graph-mcp.js" setup');
    expect(skill).toContain(
      "The setup command only persists the Client ID and Tenant ID; it does not perform login.",
    );
    expect(skill).toMatch(/After setup, `graph_auth_login` uses browser login by default\./);
    expect(skill).toContain('method: "device_code"');
    expect(skill).toMatch(/`method: "device_code"` is the fallback\./);
    expect(skill).not.toMatch(/The setup command uses browser login by default\./);
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

    const unsafeInstructionLines = skill
      .split("\n")
      .filter((line) => !/never|do not|without/i.test(line));
    expect(unsafeInstructionLines.join("\n")).not.toMatch(
      /(?:ask|request|collect|enter|paste|provide|store|save)\s+(?:your\s+)?(?:client secret|access token|refresh token|authorization code|MFA(?: code)?|credentials)/i,
    );
  });

  test("the authored plugin documentation and copied release artifacts exist", async () => {
    await expectFile("plugins/graph-mcp/dist/graph-mcp.js");
    await expectFile("plugins/graph-mcp/README.md");
    await expectFile("plugins/graph-mcp/LICENSE");

    const pluginReadme = await readText("plugins/graph-mcp/README.md");
    expect(pluginReadme).toContain("Graph MCP");
    expect(pluginReadme).toContain("organizational policy");
    expect(await readText("plugins/graph-mcp/LICENSE")).toContain("MIT License");
  });

  test("the build keeps the root bundle behavior and synchronizes the plugin bundle and license", async () => {
    const buildScript = await readText("scripts/build.mjs");

    expect(buildScript).toContain('outfile: "dist/cli.js"');
    expect(buildScript).toContain("copyFile");
    expect(buildScript).toContain("plugins/graph-mcp/dist/graph-mcp.js");
    expect(buildScript).toContain("plugins/graph-mcp/LICENSE");
    expect(buildScript).not.toContain('copyFile("README.md"');
    await expectFile("plugins/graph-mcp/dist/graph-mcp.js");
  });

  test("package and both plugin manifest versions are synchronized by the verifier", async () => {
    const packageJson = await readJson("package.json");
    const claudeManifest = await readJson("plugins/graph-mcp/.claude-plugin/plugin.json");
    const codexManifest = await readJson("plugins/graph-mcp/.codex-plugin/plugin.json");

    expect(packageJson.version).toBe("0.6.0");
    expect(claudeManifest.version).toBe(packageJson.version);
    expect(codexManifest.version).toBe(packageJson.version);

    const verifier = await readText("scripts/verify-plugin-versions.mjs");
    expect(verifier).toContain("package.json");
    expect(verifier).toContain(".claude-plugin/plugin.json");
    expect(verifier).toContain(".codex-plugin/plugin.json");
  });
});
