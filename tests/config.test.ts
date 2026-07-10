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
    expect(settings.scopes).toHaveLength(23);
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
