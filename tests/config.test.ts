import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { loadSettings, persistSetupConfig } from "../src/config.js";

const expectedScopes = [
  "offline_access",
  "openid",
  "profile",
  "User.Read",
  "User.ReadBasic.All",
  "User.Read.All",
  "Chat.Read",
  "Chat.ReadWrite",
  "ChatMember.ReadWrite",
  "ChatMessage.Send",
  "ChannelMessage.Read.All",
  "ChannelMessage.Send",
  "ChannelMessage.ReadWrite",
  "Channel.Create",
  "TeamMember.Read.All",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "ChannelMember.Read.All",
  "Calendars.ReadWrite",
  "Calendars.Read.Shared",
  "Calendars.ReadWrite.Shared",
  "Place.Read.All",
  "Mail.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "MailboxSettings.ReadWrite",
  "Mail.ReadWrite.Shared",
  "Mail.Send.Shared",
  "Presence.Read",
  "Presence.Read.All",
  "Presence.ReadWrite",
  "OnlineMeetings.Read",
  "OnlineMeetings.ReadWrite",
  "OnlineMeetingArtifact.Read.All",
  "OnlineMeetingTranscript.Read.All",
  "OnlineMeetingRecording.Read.All",
  "Files.ReadWrite.All",
  "Sites.Read.All",
  "People.Read",
  "Contacts.ReadWrite",
  "Tasks.ReadWrite",
] as const;

describe("loadSettings", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "graph-mcp-config-test-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("returns defaults with derived paths, endpoints, and ordered scopes", async () => {
    const settings = await loadSettings({ homeDir, env: {} });
    const configDir = join(homeDir, ".graph-mcp");

    expect(settings).toEqual({
      azureClientId: "",
      azureTenantId: "common",
      graphRedirectUri: "http://localhost:3000/auth/callback",
      graphTokenEncryptionKey: "",
      graphTokenRefreshBuffer: 300,
      graphRateLimitMaxRequests: 10000,
      graphRateLimitWindow: 600,
      graphDebug: false,
      configDir,
      configFile: join(configDir, "config.json"),
      tokenFile: join(configDir, "tokens-v2.enc"),
      keyFile: join(configDir, ".key-v2"),
      authority: "https://login.microsoftonline.com/common",
      authorizeEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: expectedScopes,
    });
    expect(settings.scopes).toHaveLength(41);
  });

  test("freezes returned settings and scopes at runtime", async () => {
    const settings = await loadSettings({ homeDir, env: {} });

    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.scopes)).toBe(true);
  });

  test("rejects unsafe scalar mutation and preserves the original value", async () => {
    const settings = await loadSettings({ homeDir, env: {} });
    const mutableSettings = settings as unknown as { azureTenantId: string };

    expect(() => {
      mutableSettings.azureTenantId = "mutated-tenant";
    }).toThrow(TypeError);
    expect(settings.azureTenantId).toBe("common");
  });

  test("rejects scope mutation without contaminating other loads", async () => {
    const first = await loadSettings({ homeDir, env: {} });
    const second = await loadSettings({ homeDir, env: {} });
    const mutableScopes = first.scopes as unknown as string[];
    let mutationError: unknown;

    try {
      mutableScopes.push("Directory.ReadWrite.All");
    } catch (error: unknown) {
      mutationError = error;
    }

    const subsequent = await loadSettings({ homeDir, env: {} });

    expect(first).not.toBe(second);
    expect(second.scopes).toEqual(expectedScopes);
    expect(subsequent.scopes).toEqual(expectedScopes);
    expect(subsequent.scopes).toHaveLength(41);
    expect(subsequent.scopes).not.toContain("Directory.ReadWrite.All");
    expect(mutationError).toBeInstanceOf(TypeError);
  });

  test("appends GRAPH_ADDITIONAL_SCOPES after the built-in scopes", async () => {
    const settings = await loadSettings({
      homeDir,
      env: { GRAPH_ADDITIONAL_SCOPES: "Community.Read.All Directory.Read.All" },
    });

    expect(settings.scopes).toEqual([
      ...expectedScopes,
      "Community.Read.All",
      "Directory.Read.All",
    ]);
    expect(Object.isFrozen(settings.scopes)).toBe(true);
  });

  test("accepts commas, extra whitespace, and newlines as separators", async () => {
    const settings = await loadSettings({
      homeDir,
      env: { GRAPH_ADDITIONAL_SCOPES: " Community.Read.All ,,\n Directory.Read.All,\t" },
    });

    expect(settings.scopes).toEqual([
      ...expectedScopes,
      "Community.Read.All",
      "Directory.Read.All",
    ]);
  });

  test("never drops a built-in scope and ignores duplicates case-insensitively", async () => {
    const settings = await loadSettings({
      homeDir,
      env: {
        GRAPH_ADDITIONAL_SCOPES:
          "mail.read,User.Read,Community.Read.All,community.read.all,Community.Read.All",
      },
    });

    expect(settings.scopes).toEqual([...expectedScopes, "Community.Read.All"]);
    for (const scope of expectedScopes) {
      expect(settings.scopes).toContain(scope);
    }
  });

  test("treats an empty or separator-only value as no additional scopes", async () => {
    const empty = await loadSettings({ homeDir, env: { GRAPH_ADDITIONAL_SCOPES: "" } });
    const separatorsOnly = await loadSettings({
      homeDir,
      env: { GRAPH_ADDITIONAL_SCOPES: " , ,\n" },
    });

    expect(empty.scopes).toEqual(expectedScopes);
    expect(separatorsOnly.scopes).toEqual(expectedScopes);
    expect(separatorsOnly.scopes).toHaveLength(41);
  });

  test("rejects quoted or backslash-bearing scope entries", async () => {
    await expect(
      loadSettings({ homeDir, env: { GRAPH_ADDITIONAL_SCOPES: '"Community.Read.All"' } }),
    ).rejects.toThrow(/GRAPH_ADDITIONAL_SCOPES entry .* must not contain quotes or backslashes/);
  });

  test("keeps additional scopes out of unrelated loads", async () => {
    const withExtra = await loadSettings({
      homeDir,
      env: { GRAPH_ADDITIONAL_SCOPES: "Community.Read.All" },
    });
    const withoutExtra = await loadSettings({ homeDir, env: {} });

    expect(withExtra.scopes).toContain("Community.Read.All");
    expect(withoutExtra.scopes).toEqual(expectedScopes);
    expect(withoutExtra.scopes).not.toContain("Community.Read.All");
  });

  test("loads client and tenant values from persisted config", async () => {
    await persistSetupConfig(
      { azureClientId: "file-client", azureTenantId: "file-tenant" },
      { homeDir },
    );

    const settings = await loadSettings({ homeDir, env: {} });

    expect(settings.azureClientId).toBe("file-client");
    expect(settings.azureTenantId).toBe("file-tenant");
    expect(settings.authority).toBe("https://login.microsoftonline.com/file-tenant");
  });

  test("ignores unknown persisted config keys", async () => {
    await persistSetupConfig(
      { azureClientId: "initial-client", azureTenantId: "initial-tenant" },
      { homeDir },
    );
    const configFile = join(homeDir, ".graph-mcp", "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        azureClientId: "file-client",
        azureTenantId: "file-tenant",
        graphDebug: true,
        unexpectedKey: "ignored",
      }),
      "utf8",
    );

    const settings = await loadSettings({ homeDir, env: {} });

    expect(settings.azureClientId).toBe("file-client");
    expect(settings.azureTenantId).toBe("file-tenant");
    expect(settings.graphDebug).toBe(false);
    expect(settings).not.toHaveProperty("unexpectedKey");
  });

  test("environment values override persisted config, including an empty client ID", async () => {
    await persistSetupConfig(
      { azureClientId: "file-client", azureTenantId: "file-tenant" },
      { homeDir },
    );

    const settings = await loadSettings({
      homeDir,
      env: {
        AZURE_CLIENT_ID: "",
        AZURE_TENANT_ID: "env-tenant",
        GRAPH_REDIRECT_URI: "http://127.0.0.1:4444/callback",
        GRAPH_TOKEN_ENCRYPTION_KEY: "env-key",
      },
    });

    expect(settings.azureClientId).toBe("");
    expect(settings.azureTenantId).toBe("env-tenant");
    expect(settings.graphRedirectUri).toBe("http://127.0.0.1:4444/callback");
    expect(settings.graphTokenEncryptionKey).toBe("env-key");
  });

  test("converts numeric environment settings", async () => {
    const settings = await loadSettings({
      homeDir,
      env: {
        GRAPH_TOKEN_REFRESH_BUFFER: "45",
        GRAPH_RATE_LIMIT_MAX_REQUESTS: "250",
        GRAPH_RATE_LIMIT_WINDOW: "30",
      },
    });

    expect(settings.graphTokenRefreshBuffer).toBe(45);
    expect(settings.graphRateLimitMaxRequests).toBe(250);
    expect(settings.graphRateLimitWindow).toBe(30);
  });

  test.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["yes", true],
    ["On", true],
    ["false", false],
    ["FALSE", false],
    ["0", false],
    ["no", false],
    ["Off", false],
  ])("converts GRAPH_DEBUG=%s to %s", async (value, expected) => {
    const settings = await loadSettings({
      homeDir,
      env: { GRAPH_DEBUG: value },
    });

    expect(settings.graphDebug).toBe(expected);
  });

  test.each([
    ["GRAPH_TOKEN_REFRESH_BUFFER", "0"],
    ["GRAPH_TOKEN_REFRESH_BUFFER", "-1"],
    ["GRAPH_TOKEN_REFRESH_BUFFER", "1.5"],
    ["GRAPH_RATE_LIMIT_MAX_REQUESTS", "many"],
    ["GRAPH_RATE_LIMIT_WINDOW", ""],
  ])("rejects invalid positive integer %s=%s", async (variable, value) => {
    await expect(loadSettings({ homeDir, env: { [variable]: value } })).rejects.toThrow(variable);
  });

  test("rejects an invalid GRAPH_DEBUG value", async () => {
    await expect(loadSettings({ homeDir, env: { GRAPH_DEBUG: "sometimes" } })).rejects.toThrow(
      "GRAPH_DEBUG",
    );
  });

  test("uses defaults when config.json does not exist", async () => {
    const settings = await loadSettings({ homeDir, env: {} });

    expect(settings.azureClientId).toBe("");
    expect(settings.azureTenantId).toBe("common");
  });

  test.each([
    ["malformed JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["a non-string client ID", '{"azureClientId":123}'],
    ["a non-string tenant ID", '{"azureTenantId":false}'],
  ])("rejects %s in config.json with an actionable error", async (_name, text) => {
    await persistSetupConfig({ azureClientId: "client", azureTenantId: "tenant" }, { homeDir });
    const configFile = join(homeDir, ".graph-mcp", "config.json");
    await writeFile(configFile, text, "utf8");

    await expect(loadSettings({ homeDir, env: {} })).rejects.toThrow(/config\.json/);
  });
});

describe("persistSetupConfig", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "graph-mcp-persist-test-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  test("writes only trimmed client and tenant fields with private permissions", async () => {
    await persistSetupConfig(
      { azureClientId: "  client-id  ", azureTenantId: "  tenant-id  " },
      { homeDir },
    );

    const configDir = join(homeDir, ".graph-mcp");
    const configFile = join(configDir, "config.json");
    const tokenFile = join(configDir, "tokens-v2.enc");
    const keyFile = join(configDir, ".key-v2");
    const parsed: unknown = JSON.parse(await readFile(configFile, "utf8"));

    expect(parsed).toEqual({
      azureClientId: "client-id",
      azureTenantId: "tenant-id",
    });

    if (process.platform !== "win32") {
      expect((await stat(configDir)).mode & 0o777).toBe(0o700);
      expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    }
    await expect(stat(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(keyFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves an empty client ID and normalizes a blank tenant to common", async () => {
    await persistSetupConfig({ azureClientId: "   ", azureTenantId: "   " }, { homeDir });

    const settings = await loadSettings({ homeDir, env: {} });
    const persisted: unknown = JSON.parse(
      await readFile(join(homeDir, ".graph-mcp", "config.json"), "utf8"),
    );

    expect(persisted).toEqual({
      azureClientId: "",
      azureTenantId: "common",
    });
    expect(settings.azureClientId).toBe("");
    expect(settings.azureTenantId).toBe("common");
  });
});
