import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
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

const TOKEN_FILE_SIZE_LIMIT = 16 * 1024 * 1024;

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

async function expectGenericRejection(
  promise: Promise<unknown>,
  secretMarker: string,
): Promise<Error> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    rejection = error;
  }

  expect(rejection).toBeInstanceOf(Error);
  const result = rejection as Error;
  expect(result.message).toMatch(/token|encryption/i);
  if (secretMarker.length > 0) {
    expect(result.message).not.toContain(secretMarker);
  }
  return result;
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

  test.skipIf(process.platform === "win32")(
    "rejects a symlinked config directory without touching its target",
    async () => {
      const externalDir = await mkdtemp(join(tmpdir(), "graph-mcp-external-config-"));
      const sentinel = join(externalDir, "outside-sentinel.txt");
      const secretMarker = "outside-config-secret-marker";
      await writeFile(sentinel, secretMarker);
      await chmod(externalDir, 0o755);
      await rm(configDir, { recursive: true, force: true });
      await symlink(externalDir, configDir, "dir");

      try {
        await expectGenericRejection(new TokenStore(settings).initialize(), secretMarker);
        expect(await readFile(sentinel, "utf8")).toBe(secretMarker);
        expect((await stat(externalDir)).mode & 0o777).toBe(0o755);
        await expect(stat(join(externalDir, ".key-v2"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(configDir, { force: true });
        await rm(externalDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects symlinked key and token files without reading or chmodding their targets",
    async () => {
      const externalDir = await mkdtemp(join(tmpdir(), "graph-mcp-external-secrets-"));
      const externalKey = join(externalDir, "outside-key");
      const externalToken = join(externalDir, "outside-token");
      const keyText = randomBytes(32).toString("base64");
      const tokenMarker = "outside-token-secret-marker";
      await writeFile(externalKey, keyText);
      await writeFile(externalToken, tokenMarker);
      await chmod(externalKey, 0o644);
      await chmod(externalToken, 0o644);

      try {
        await symlink(externalKey, settings.keyFile);
        await expectGenericRejection(new TokenStore(settings).initialize(), keyText);
        expect(await readFile(externalKey, "utf8")).toBe(keyText);
        expect((await stat(externalKey)).mode & 0o777).toBe(0o644);

        await rm(settings.keyFile, { force: true });
        settings = settingsFor(configDir, "explicit-key-for-token-symlink");
        await symlink(externalToken, settings.tokenFile);
        await expectGenericRejection(new TokenStore(settings).initialize(), tokenMarker);
        expect(await readFile(externalToken, "utf8")).toBe(tokenMarker);
        expect((await stat(externalToken)).mode & 0o777).toBe(0o644);
      } finally {
        await rm(externalDir, { recursive: true, force: true });
      }
    },
  );

  test("rejects token symlinks before opening them when Windows cannot use O_NOFOLLOW", async () => {
    const externalDir = await mkdtemp(join(tmpdir(), "graph-mcp-windows-fallback-secret-"));
    const externalToken = join(externalDir, "outside-token");
    const tokenMarker = "windows-fallback-token-secret-marker";
    settings = settingsFor(configDir, "windows-fallback-encryption-key");
    await writeFile(externalToken, tokenMarker);
    await symlink(externalToken, settings.tokenFile);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      await expectGenericRejection(new TokenStore(settings).initialize(), tokenMarker);
      expect(await readFile(externalToken, "utf8")).toBe(tokenMarker);
    } finally {
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  test("rejects Windows token reads when the opened file identity cannot be verified", async () => {
    const tokenMarker = "unverifiable-windows-token-secret-marker";
    settings = settingsFor(configDir, "unverifiable-windows-encryption-key");
    await new TokenStore(settings).store({ access_token: tokenMarker });

    const probe = await open(settings.tokenFile, "r");
    const originalStats = await probe.stat();
    const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    expect(originalStats.dev).toBeGreaterThan(0);
    expect(originalStats.ino).toBeGreaterThan(0);
    const originalStat = Object.getOwnPropertyDescriptor(fileHandlePrototype, "stat")?.value as
      ((this: FileHandle) => ReturnType<FileHandle["stat"]>) | undefined;
    if (originalStat === undefined) {
      throw new Error("FileHandle.stat is unavailable");
    }
    let identityRemoved = false;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fileHandlePrototype, "stat").mockImplementation(async function (this: FileHandle) {
      const stats = await originalStat.call(this);
      if (
        !identityRemoved &&
        stats.isFile() &&
        stats.dev === originalStats.dev &&
        stats.ino === originalStats.ino
      ) {
        identityRemoved = true;
        const statsWithoutIdentity = Object.create(stats) as typeof stats;
        Object.defineProperties(statsWithoutIdentity, {
          dev: { value: 0 },
          ino: { value: 0 },
        });
        return statsWithoutIdentity;
      }
      return stats;
    });

    await expectGenericRejection(new TokenStore(settings).initialize(), tokenMarker);
    expect(identityRemoved).toBe(true);
  });

  test.skipIf(process.platform === "win32")(
    "rejects secret paths outside the validated directory without touching them",
    async () => {
      const externalDir = await mkdtemp(join(tmpdir(), "graph-mcp-outside-paths-"));
      const outsideKey = join(externalDir, "outside-key");
      const outsideToken = join(externalDir, "outside-token");
      const keyMarker = "outside-direct-key-marker";
      const tokenMarker = "outside-direct-token-marker";
      await writeFile(outsideKey, keyMarker);
      await writeFile(outsideToken, tokenMarker);
      await chmod(outsideKey, 0o644);
      await chmod(outsideToken, 0o644);

      try {
        await expectGenericRejection(
          new TokenStore({ ...settings, keyFile: outsideKey }).initialize(),
          keyMarker,
        );
        expect(await readFile(outsideKey, "utf8")).toBe(keyMarker);
        expect((await stat(outsideKey)).mode & 0o777).toBe(0o644);

        await expectGenericRejection(
          new TokenStore({
            ...settings,
            graphTokenEncryptionKey: "explicit-direct-child-key",
            tokenFile: outsideToken,
          }).initialize(),
          tokenMarker,
        );
        expect(await readFile(outsideToken, "utf8")).toBe(tokenMarker);
        expect((await stat(outsideToken)).mode & 0o777).toBe(0o644);
      } finally {
        await rm(externalDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects multiply-linked key and token files",
    async () => {
      await writeFile(settings.keyFile, randomBytes(32).toString("base64"));
      await link(settings.keyFile, join(configDir, "key-hard-link"));
      await expectGenericRejection(new TokenStore(settings).initialize(), "unused-marker");

      await rm(settings.keyFile, { force: true });
      await rm(join(configDir, "key-hard-link"), { force: true });
      settings = settingsFor(configDir, "hard-link-token-encryption-key");
      await new TokenStore(settings).store({ access_token: "hard-link-access" });
      await link(settings.tokenFile, join(configDir, "token-hard-link"));
      await expectGenericRejection(new TokenStore(settings).initialize(), "hard-link-access");
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

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a failed clear preserves memory and disk and does not poison a later clear",
    async () => {
      const store = new TokenStore(settings);
      await store.store({
        access_token: "clear-failure-access",
        refresh_token: "clear-failure-refresh",
      });
      const encryptedBefore = await readFile(settings.tokenFile, "utf8");
      await chmod(configDir, 0o500);

      try {
        await expect(store.clear()).rejects.toThrow();
        expect(store.getAccessToken()).toBe("clear-failure-access");
        expect(store.getRefreshToken()).toBe("clear-failure-refresh");
      } finally {
        await chmod(configDir, 0o700);
      }

      expect(await readFile(settings.tokenFile, "utf8")).toBe(encryptedBefore);
      const reloaded = new TokenStore(settings);
      await reloaded.initialize();
      expect(reloaded.getAccessToken()).toBe("clear-failure-access");
      await store.clear();
      expect(store.getAccessToken()).toBeUndefined();
      await expect(stat(settings.tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

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
      { ...validEnvelope, authTag: "AAAA" },
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
    const encryptedBefore = await readFile(settings.tokenFile, "utf8");
    const invalidResponses: unknown[] = [
      null,
      [],
      { access_token: "" },
      { access_token: 123 },
      { access_token: "invalid-refresh", refresh_token: 123 },
      { access_token: "invalid-scope", scope: 123 },
      { access_token: "invalid-expiry", expires_in: 0 },
      { access_token: "invalid-expiry", expires_in: -1 },
      { access_token: "invalid-expiry", expires_in: 1.5 },
      { access_token: "invalid-expiry", expires_in: Number.NaN },
      { access_token: "invalid-expiry", expires_in: Number.POSITIVE_INFINITY },
      { access_token: "invalid-expiry", expires_in: Number.MAX_VALUE },
      { access_token: "overflow-expiry", expires_in: Number.MAX_SAFE_INTEGER },
    ];

    for (const response of invalidResponses) {
      await expect(store.store(response as TokenResponse)).rejects.toThrow();
      expect(store.getAccessToken()).toBe("original-access");
      expect(store.getRefreshToken()).toBe("original-refresh");
      expect(await readFile(settings.tokenFile, "utf8")).toBe(encryptedBefore);
    }

    const reloaded = new TokenStore(settings);
    await reloaded.initialize();
    expect(reloaded.getAccessToken()).toBe("original-access");
    expect(reloaded.getRefreshToken()).toBe("original-refresh");
  });

  test("invalid clocks and expiry arithmetic reject without replacing prior tokens", async () => {
    const original = new TokenStore(settings, { now: () => 1_000_000 });
    await original.store({
      access_token: "clock-original-access",
      refresh_token: "clock-original-refresh",
    });
    const encryptedBefore = await readFile(settings.tokenFile, "utf8");

    for (const invalidNow of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER]) {
      const store = new TokenStore(settings, { now: () => invalidNow });
      await store.initialize();
      await expect(store.store({ access_token: "invalid-clock-access" })).rejects.toThrow();
      expect(store.getAccessToken()).toBe("clock-original-access");
      expect(await readFile(settings.tokenFile, "utf8")).toBe(encryptedBefore);
    }
  });

  test("expiry checks reject invalid clocks and buffer arithmetic", async () => {
    const store = new TokenStore(settings, { now: () => 1_000_000 });
    await store.store({ access_token: "buffer-access", expires_in: 3600 });

    for (const invalidBuffer of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() => store.isAccessTokenExpired(invalidBuffer)).toThrow();
    }

    const invalidClock = new TokenStore(settings, { now: () => Number.NaN });
    await invalidClock.initialize();
    expect(() => invalidClock.isAccessTokenExpired()).toThrow();
  });

  test("repeated identical token content uses a unique IV", async () => {
    const store = new TokenStore(settings, { now: () => 1_000_000 });
    const response = {
      access_token: "identical-access",
      refresh_token: "identical-refresh",
      expires_in: 3600,
      scope: "User.Read",
    };

    await store.store(response);
    const first = JSON.parse(await readFile(settings.tokenFile, "utf8")) as EncryptedPayload;
    await store.store(response);
    const second = JSON.parse(await readFile(settings.tokenFile, "utf8")) as EncryptedPayload;

    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  test("oversized key and token files reject before their contents are accepted", async () => {
    const keyMarker = "oversized-key-secret-marker";
    await writeFile(settings.keyFile, `${keyMarker}${"x".repeat(129)}`);
    await expectGenericRejection(new TokenStore(settings).initialize(), keyMarker);

    await rm(settings.keyFile, { force: true });
    settings = settingsFor(configDir, "oversized-token-explicit-key");
    const tokenMarker = "oversized-token-secret-marker";
    await writeFile(
      settings.tokenFile,
      Buffer.concat([
        Buffer.from(tokenMarker),
        Buffer.alloc(TOKEN_FILE_SIZE_LIMIT + 1 - tokenMarker.length, "x"),
      ]),
    );
    await expectGenericRejection(new TokenStore(settings).initialize(), tokenMarker);
  });

  test("rejects a token file that grows after its initial handle stat without exposing its contents", async () => {
    const tokenMarker = "growing-token-secret-marker";
    settings = settingsFor(configDir, "growing-token-encryption-key");
    await new TokenStore(settings).store({ access_token: "initial-token" });

    const probe = await open(settings.tokenFile, "r");
    const originalStats = await probe.stat();
    const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const originalStat = Object.getOwnPropertyDescriptor(fileHandlePrototype, "stat")?.value as
      ((this: FileHandle) => ReturnType<FileHandle["stat"]>) | undefined;
    if (originalStat === undefined) {
      throw new Error("FileHandle.stat is unavailable");
    }
    let appended = false;
    vi.spyOn(fileHandlePrototype, "stat").mockImplementation(async function (this: FileHandle) {
      const stats = await originalStat.call(this);
      if (!appended && stats.dev === originalStats.dev && stats.ino === originalStats.ino) {
        appended = true;
        await writeFile(
          settings.tokenFile,
          Buffer.concat([Buffer.from(tokenMarker), Buffer.alloc(TOKEN_FILE_SIZE_LIMIT + 1)]),
          { flag: "a" },
        );
      }
      return stats;
    });

    await expectGenericRejection(new TokenStore(settings).initialize(), tokenMarker);
    expect(appended).toBe(true);
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
      scope: "x".repeat(8 * 1024 * 1024),
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

  test("stores targeting different token paths retain independent write progress", async () => {
    const otherConfigDir = await mkdtemp(join(tmpdir(), "graph-mcp-other-token-store-"));
    const otherSettings = settingsFor(otherConfigDir);
    let largeWriteFinished = false;

    try {
      const largeWrite = new TokenStore(settings)
        .store({ access_token: "large-independent", scope: "x".repeat(8 * 1024 * 1024) })
        .then(() => {
          largeWriteFinished = true;
        });
      await new TokenStore(otherSettings).store({ access_token: "small-independent" });

      expect(largeWriteFinished).toBe(false);
      await largeWrite;
    } finally {
      await rm(otherConfigDir, { recursive: true, force: true });
    }
  });

  test("initialize ordered before clear leaves no stale memory or token file", async () => {
    await new TokenStore(settings).store({
      access_token: "initialize-clear-access",
      refresh_token: "initialize-clear-refresh",
      scope: "x".repeat(8 * 1024 * 1024),
    });
    const store = new TokenStore(settings);

    const initializing = store.initialize();
    const clearing = store.clear();
    await Promise.all([initializing, clearing]);

    expect(store.getAccessToken()).toBeUndefined();
    expect(store.getRefreshToken()).toBeUndefined();
    await expect(stat(settings.tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("initialize ordered before store commits the later token consistently", async () => {
    await new TokenStore(settings).store({
      access_token: "initialize-store-old",
      scope: "x".repeat(8 * 1024 * 1024),
    });
    const store = new TokenStore(settings);

    const initializing = store.initialize();
    const storing = store.store({
      access_token: "initialize-store-new",
      refresh_token: "initialize-store-refresh",
    });
    await Promise.all([initializing, storing]);

    expect(store.getAccessToken()).toBe("initialize-store-new");
    const reloaded = new TokenStore(settings);
    await reloaded.initialize();
    expect(reloaded.getAccessToken()).toBe("initialize-store-new");
    expect(reloaded.getRefreshToken()).toBe("initialize-store-refresh");
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
        expect(store.getAccessToken()).toBe("atomic-original");
        expect(store.getRefreshToken()).toBe("atomic-refresh");
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
    const secondSettings = { ...settings, tokenFile: join(configDir, "tokens-other-v2.enc") };
    const second = new TokenStore(secondSettings);
    await Promise.all([first.initialize(), second.initialize()]);

    const keyText = await readFile(settings.keyFile, "utf8");
    expect(Buffer.from(keyText.trim(), "base64")).toHaveLength(32);

    await first.store({ access_token: "first-race-value" });
    await second.store({ access_token: "second-race-value", refresh_token: "race-refresh" });

    const firstReloaded = new TokenStore(settings);
    const secondReloaded = new TokenStore(secondSettings);
    await Promise.all([firstReloaded.initialize(), secondReloaded.initialize()]);
    expect(firstReloaded.getAccessToken()).toBe("first-race-value");
    expect(secondReloaded.getAccessToken()).toBe("second-race-value");
    expect(secondReloaded.getRefreshToken()).toBe("race-refresh");
    expect(await readFile(settings.keyFile, "utf8")).toBe(keyText);
    expect((await stat(settings.keyFile)).nlink).toBe(1);
    expect((await readdir(configDir)).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });

  test("key generation failures leave no final or temporary key file", async () => {
    const generationSecret = "random-generation-secret-marker";
    await expectGenericRejection(
      new TokenStore(settings, {
        randomBytes: () => {
          throw new Error(generationSecret);
        },
      }).initialize(),
      generationSecret,
    );
    await expect(stat(settings.keyFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(configDir)).filter((entry) => entry.includes(".tmp"))).toEqual([]);

    await expectGenericRejection(
      new TokenStore(settings, { randomBytes: () => Buffer.alloc(31) }).initialize(),
      "unused-marker",
    );
    await expect(stat(settings.keyFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(configDir)).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });

  test("empty or partial pre-existing key files fail without replacement", async () => {
    for (const partial of ["", "AAAA", randomBytes(16).toString("base64")]) {
      await writeFile(settings.keyFile, partial);
      await expectGenericRejection(new TokenStore(settings).initialize(), partial);
      expect(await readFile(settings.keyFile, "utf8")).toBe(partial);
      expect((await readdir(configDir)).filter((entry) => entry.includes(".tmp"))).toEqual([]);
    }
  });
});
