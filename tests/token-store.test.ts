import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TokenStore, type StoredTokens, type TokenResponse } from "../src/token-store.js";

interface TestSettings {
  configDir: string;
  tokenFile: string;
  keyFile: string;
  graphTokenEncryptionKey: string;
  graphTokenRefreshBuffer: number;
}

interface EncryptedPayload {
  version: number;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function settingsFor(configDir: string, encryptionKey = ""): TestSettings {
  return {
    configDir,
    tokenFile: join(configDir, "tokens-v2.enc"),
    keyFile: join(configDir, ".key-v2"),
    graphTokenEncryptionKey: encryptionKey,
    graphTokenRefreshBuffer: 300,
  };
}

function encryptionKeyFor(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function encryptPlaintext(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    version: 2,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

async function readGeneratedKey(keyFile: string): Promise<Buffer> {
  return Buffer.from((await readFile(keyFile, "utf8")).trim(), "base64");
}

async function decryptStoredTokens(tokenFile: string, key: Buffer): Promise<StoredTokens> {
  const envelope = JSON.parse(await readFile(tokenFile, "utf8")) as EncryptedPayload;
  const decipher = (await import("node:crypto")).createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as StoredTokens;
}

describe("TokenStore", () => {
  let configDir: string;
  let settings: TestSettings;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "graph-mcp-token-store-"));
    settings = settingsFor(configDir);
  });

  afterEach(async () => {
    await chmod(configDir, 0o700).catch(() => undefined);
    await rm(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("stores the default and provided expiry relative to the injected clock", async () => {
    let now = 1_700_000_000_000;
    const store = new TokenStore(settings, { now: () => now });

    await store.store({ access_token: "default-access" });
    const key = await readGeneratedKey(settings.keyFile);
    expect(await decryptStoredTokens(settings.tokenFile, key)).toEqual({
      accessToken: "default-access",
      refreshToken: "",
      expiresAt: 1_700_003_600_000,
      scope: "",
    });

    now = 1_800_000_000_000;
    await store.store({
      access_token: "provided-access",
      refresh_token: "provided-refresh",
      expires_in: 42,
      scope: "User.Read Mail.Read",
    });
    expect(await decryptStoredTokens(settings.tokenFile, key)).toEqual({
      accessToken: "provided-access",
      refreshToken: "provided-refresh",
      expiresAt: 1_800_000_042_000,
      scope: "User.Read Mail.Read",
    });
  });

  test("encrypts token values and token JSON field names at rest", async () => {
    const store = new TokenStore(settings);
    await store.store({
      access_token: "access-secret-marker",
      refresh_token: "refresh-secret-marker",
      expires_in: 3600,
      scope: "User.Read",
    });

    const encryptedText = await readFile(settings.tokenFile, "utf8");
    const envelope = JSON.parse(encryptedText) as EncryptedPayload;
    expect(envelope.version).toBe(2);
    expect(typeof envelope.iv).toBe("string");
    expect(typeof envelope.authTag).toBe("string");
    expect(typeof envelope.ciphertext).toBe("string");
    expect(encryptedText).not.toContain("access-secret-marker");
    expect(encryptedText).not.toContain("refresh-secret-marker");
    expect(encryptedText).not.toContain("accessToken");
    expect(encryptedText).not.toContain("refreshToken");
    expect(encryptedText).not.toContain("expiresAt");
  });

  test("a second instance decrypts tokens using the generated key", async () => {
    await new TokenStore(settings).store({
      access_token: "persisted-access",
      refresh_token: "persisted-refresh",
      expires_in: 3600,
    });

    const reloaded = new TokenStore(settings);
    await reloaded.initialize();

    expect(reloaded.getAccessToken()).toBe("persisted-access");
    expect(reloaded.getRefreshToken()).toBe("persisted-refresh");
  });

  test("an explicit encryption key round-trips without creating a key file", async () => {
    settings = settingsFor(configDir, "environment-provided-encryption-secret");
    await new TokenStore(settings).store({
      access_token: "explicit-access",
      refresh_token: "explicit-refresh",
    });

    const reloaded = new TokenStore(settings);
    await reloaded.initialize();

    expect(reloaded.getAccessToken()).toBe("explicit-access");
    expect(reloaded.getRefreshToken()).toBe("explicit-refresh");
    await expect(stat(settings.keyFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.skipIf(process.platform === "win32")(
    "enforces private POSIX modes for the directory, key, and token file",
    async () => {
      await chmod(configDir, 0o755);
      await new TokenStore(settings).store({ access_token: "mode-access" });

      await chmod(configDir, 0o755);
      await chmod(settings.keyFile, 0o644);
      await chmod(settings.tokenFile, 0o644);
      await new TokenStore(settings).initialize();

      expect((await stat(configDir)).mode & 0o777).toBe(0o700);
      expect((await stat(settings.keyFile)).mode & 0o777).toBe(0o600);
      expect((await stat(settings.tokenFile)).mode & 0o777).toBe(0o600);
    },
  );

  test("returns stored access and refresh tokens", async () => {
    const store = new TokenStore(settings);
    expect(store.getAccessToken()).toBeUndefined();
    expect(store.getRefreshToken()).toBeUndefined();

    await store.store({
      access_token: "getter-access",
      refresh_token: "getter-refresh",
    });

    expect(store.getAccessToken()).toBe("getter-access");
    expect(store.getRefreshToken()).toBe("getter-refresh");
  });

  test("expiry uses the configured buffer, explicit buffer, exact boundary, and empty state", async () => {
    let now = 10_000_000;
    const store = new TokenStore(settings, { now: () => now });

    expect(store.isAccessTokenExpired()).toBe(true);
    await store.store({ access_token: "expiry-access", expires_in: 600 });

    now = 10_299_999;
    expect(store.isAccessTokenExpired()).toBe(false);
    now = 10_300_000;
    expect(store.isAccessTokenExpired()).toBe(true);

    now = 10_499_999;
    expect(store.isAccessTokenExpired(100)).toBe(false);
    now = 10_500_000;
    expect(store.isAccessTokenExpired(100)).toBe(true);
    expect(store.isAccessTokenExpired(0)).toBe(false);
  });

  test("authentication accepts a current access token or any refresh token", async () => {
    let now = 1_000_000;
    const currentAccess = new TokenStore(settings, { now: () => now });
    expect(currentAccess.isAuthenticated()).toBe(false);

    await currentAccess.store({ access_token: "current", expires_in: 600 });
    expect(currentAccess.isAuthenticated()).toBe(true);

    now = 1_600_000;
    expect(currentAccess.isAuthenticated()).toBe(false);

    await currentAccess.store({
      access_token: "expired-but-refreshable",
      refresh_token: "refresh-present",
      expires_in: 1,
    });
    now = 2_000_000;
    expect(currentAccess.isAuthenticated()).toBe(true);
  });

  test("clear removes only the Node token file, preserves the key, and clears memory", async () => {
    const store = new TokenStore(settings);
    await store.store({
      access_token: "clear-access",
      refresh_token: "clear-refresh",
    });
    const keyBefore = await readFile(settings.keyFile, "utf8");

    await store.clear();

    expect(store.getAccessToken()).toBeUndefined();
    expect(store.getRefreshToken()).toBeUndefined();
    expect(store.isAuthenticated()).toBe(false);
    await expect(stat(settings.tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(settings.keyFile, "utf8")).toBe(keyBefore);
  });

  test("malformed, tampered, wrong-version, and malformed-plaintext files load as empty silently", async () => {
    const explicitKey = "malformed-file-test-key";
    settings = settingsFor(configDir, explicitKey);
    const key = encryptionKeyFor(explicitKey);
    const validEnvelope = encryptPlaintext(
      JSON.stringify({
        accessToken: "never-log-this-access",
        refreshToken: "never-log-this-refresh",
        expiresAt: Date.now() + 60_000,
        scope: "",
      }),
      key,
    );
    const malformedCases: unknown[] = [
      "not-json-never-log-this-access",
      { ...validEnvelope, version: 1 },
      { ...validEnvelope, iv: "AAAA" },
      {
        ...validEnvelope,
        ciphertext: Buffer.from("tampered-never-log-this-access").toString("base64"),
      },
      encryptPlaintext("not-json-never-log-this-refresh", key),
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (const malformed of malformedCases) {
      await writeFile(
        settings.tokenFile,
        typeof malformed === "string" ? malformed : JSON.stringify(malformed),
      );
      const store = new TokenStore(settings);
      await expect(store.initialize()).resolves.toBeUndefined();
      expect(store.getAccessToken()).toBeUndefined();
      expect(store.getRefreshToken()).toBeUndefined();
      expect(store.isAuthenticated()).toBe(false);
    }

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test("rejects noncanonical base64 that Node would otherwise decode permissively", async () => {
    const explicitKey = "strict-base64-test-key";
    settings = settingsFor(configDir, explicitKey);
    const validEnvelope = encryptPlaintext(
      JSON.stringify({
        accessToken: "noncanonical-never-log-access",
        refreshToken: "noncanonical-never-log-refresh",
        expiresAt: Date.now() + 60_000,
        scope: "User.Read",
      }),
      encryptionKeyFor(explicitKey),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (const field of ["iv", "authTag", "ciphertext"] as const) {
      const canonical = validEnvelope[field];
      const noncanonical = `${canonical.slice(0, 4)}!!!!${canonical.slice(4)}`;
      expect(Buffer.from(noncanonical, "base64")).toEqual(Buffer.from(canonical, "base64"));
      await writeFile(
        settings.tokenFile,
        JSON.stringify({ ...validEnvelope, [field]: noncanonical }),
      );

      const store = new TokenStore(settings);
      await expect(store.initialize()).resolves.toBeUndefined();
      expect(store.getAccessToken()).toBeUndefined();
      expect(store.getRefreshToken()).toBeUndefined();
      expect(store.isAuthenticated()).toBe(false);
    }

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test("invalid token responses reject without replacing the prior persisted token", async () => {
    const store = new TokenStore(settings);
    await store.store({
      access_token: "original-access",
      refresh_token: "original-refresh",
      expires_in: 3600,
    });
    const invalidResponses = [
      { access_token: "" },
      { access_token: 123 },
      { access_token: "invalid-expiry", expires_in: 0 },
      { access_token: "invalid-expiry", expires_in: -1 },
      { access_token: "invalid-expiry", expires_in: Number.NaN },
      { access_token: "invalid-expiry", expires_in: Number.POSITIVE_INFINITY },
    ] as unknown as TokenResponse[];

    for (const response of invalidResponses) {
      await expect(store.store(response)).rejects.toThrow();
      expect(store.getAccessToken()).toBe("original-access");
      expect(store.getRefreshToken()).toBe("original-refresh");
    }

    const reloaded = new TokenStore(settings);
    await reloaded.initialize();
    expect(reloaded.getAccessToken()).toBe("original-access");
    expect(reloaded.getRefreshToken()).toBe("original-refresh");
  });

  test("concurrent stores serialize in invocation order and leave one decryptable final file", async () => {
    const store = new TokenStore(settings);
    const writes = [
      store.store({ access_token: "first", refresh_token: "first-refresh" }),
      store.store({ access_token: "second", refresh_token: "second-refresh" }),
      store.store({ access_token: "last", refresh_token: "last-refresh" }),
    ];
    await Promise.all(writes);

    const reloaded = new TokenStore(settings);
    await reloaded.initialize();
    expect(reloaded.getAccessToken()).toBe("last");
    expect(reloaded.getRefreshToken()).toBe("last-refresh");
    expect(await readdir(configDir)).toEqual(
      expect.arrayContaining([basename(settings.keyFile), basename(settings.tokenFile)]),
    );
    expect((await readdir(configDir)).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });

  test("stores targeting the same file serialize across instances in invocation order", async () => {
    const earlier = new TokenStore(settings);
    const later = new TokenStore(settings);
    await earlier.initialize();
    await later.initialize();

    const slowLargeWrite = earlier.store({
      access_token: "earlier-large-access",
      refresh_token: "earlier-large-refresh",
      scope: "x".repeat(16 * 1024 * 1024),
    });
    const fastSmallWrite = later.store({
      access_token: "later-small-access",
      refresh_token: "later-small-refresh",
      scope: "User.Read",
    });
    await Promise.all([slowLargeWrite, fastSmallWrite]);

    const finalTokens = await decryptStoredTokens(
      settings.tokenFile,
      await readGeneratedKey(settings.keyFile),
    );
    expect(finalTokens.accessToken).toBe("later-small-access");
    const reloaded = new TokenStore(settings);
    await reloaded.initialize();
    expect(reloaded.getAccessToken()).toBe("later-small-access");
    expect(reloaded.getRefreshToken()).toBe("later-small-refresh");
    expect((await readdir(configDir)).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });

  test("initialize is idempotent", async () => {
    await new TokenStore(settings).store({
      access_token: "idempotent-access",
      refresh_token: "idempotent-refresh",
    });
    const store = new TokenStore(settings);

    await store.initialize();
    await store.initialize();

    expect(store.getAccessToken()).toBe("idempotent-access");
    expect(store.getRefreshToken()).toBe("idempotent-refresh");
  });

  test("never reads, writes, or deletes Python tokens.enc and .key files", async () => {
    const pythonTokenFile = join(configDir, "tokens.enc");
    const pythonKeyFile = join(configDir, ".key");
    await writeFile(pythonTokenFile, "python-token-sentinel");
    await writeFile(pythonKeyFile, "python-key-sentinel");

    const store = new TokenStore(settings);
    await store.store({ access_token: "node-access", refresh_token: "node-refresh" });
    await store.clear();

    expect(await readFile(pythonTokenFile, "utf8")).toBe("python-token-sentinel");
    expect(await readFile(pythonKeyFile, "utf8")).toBe("python-key-sentinel");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the old file decryptable and cleans temporary files after a filesystem write failure",
    async () => {
      await new TokenStore(settings).store({
        access_token: "atomic-original",
        refresh_token: "atomic-refresh",
      });
      const store = new TokenStore(settings);
      await store.initialize();
      await chmod(configDir, 0o500);

      try {
        await expect(
          store.store({ access_token: "must-not-replace", refresh_token: "must-not-persist" }),
        ).rejects.toThrow();
      } finally {
        await chmod(configDir, 0o700);
      }

      const reloaded = new TokenStore(settings);
      await reloaded.initialize();
      expect(reloaded.getAccessToken()).toBe("atomic-original");
      expect(reloaded.getRefreshToken()).toBe("atomic-refresh");
      expect((await readdir(configDir)).filter((entry) => entry.includes(".tmp"))).toEqual([]);

      await new TokenStore(settings).store({
        access_token: "recovered-after-failure",
        refresh_token: "recovered-refresh",
      });
      const recovered = new TokenStore(settings);
      await recovered.initialize();
      expect(recovered.getAccessToken()).toBe("recovered-after-failure");
      expect(recovered.getRefreshToken()).toBe("recovered-refresh");
    },
  );

  test("concurrent generated-key initialization converges on one key readable by both stores", async () => {
    const first = new TokenStore(settings);
    const second = new TokenStore(settings);
    await Promise.all([first.initialize(), second.initialize()]);

    const keyText = await readFile(settings.keyFile, "utf8");
    expect(Buffer.from(keyText.trim(), "base64")).toHaveLength(32);

    await first.store({ access_token: "first-race-value" });
    await second.store({ access_token: "second-race-value", refresh_token: "race-refresh" });

    const reloaded = new TokenStore(settings);
    await reloaded.initialize();
    expect(reloaded.getAccessToken()).toBe("second-race-value");
    expect(reloaded.getRefreshToken()).toBe("race-refresh");
    expect(await readFile(settings.keyFile, "utf8")).toBe(keyText);
  });
});
