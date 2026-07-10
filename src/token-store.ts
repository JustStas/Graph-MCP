import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { Settings } from "./config.js";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

export interface TokenStoreDependencies {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

interface EncryptedPayload {
  version: 2;
  iv: string;
  authTag: string;
  ciphertext: string;
}

type TokenStoreSettings = Pick<
  Settings,
  "configDir" | "tokenFile" | "keyFile" | "graphTokenEncryptionKey" | "graphTokenRefreshBuffer"
>;

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BASE64_PATTERN = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/;

let temporaryFileSequence = 0;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function decodeBase64(value: unknown): Buffer | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    return undefined;
  }

  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

function parseStoredTokens(value: unknown): StoredTokens | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.accessToken !== "string" ||
    candidate.accessToken.length === 0 ||
    typeof candidate.refreshToken !== "string" ||
    typeof candidate.expiresAt !== "number" ||
    !Number.isFinite(candidate.expiresAt) ||
    typeof candidate.scope !== "string"
  ) {
    return undefined;
  }

  return {
    accessToken: candidate.accessToken,
    refreshToken: candidate.refreshToken,
    expiresAt: candidate.expiresAt,
    scope: candidate.scope,
  };
}

function parseEnvelope(value: unknown):
  | {
      iv: Buffer;
      authTag: Buffer;
      ciphertext: Buffer;
    }
  | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 2) {
    return undefined;
  }

  const iv = decodeBase64(candidate.iv);
  const authTag = decodeBase64(candidate.authTag);
  const ciphertext = decodeBase64(candidate.ciphertext);
  if (
    iv?.length !== IV_BYTES ||
    authTag?.length !== AUTH_TAG_BYTES ||
    ciphertext === undefined ||
    ciphertext.length === 0
  ) {
    return undefined;
  }

  return { iv, authTag, ciphertext };
}

function validateTokenResponse(tokenResponse: TokenResponse): void {
  if (typeof tokenResponse.access_token !== "string" || tokenResponse.access_token.length === 0) {
    throw new Error("Token response must contain a nonempty access token.");
  }

  if (
    tokenResponse.expires_in !== undefined &&
    (!Number.isFinite(tokenResponse.expires_in) || tokenResponse.expires_in <= 0)
  ) {
    throw new Error("Token response expiry must be a positive finite number.");
  }
}

async function enforceMode(path: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  try {
    await chmod(path, mode);
  } catch (error: unknown) {
    if (
      !isNodeError(error, "ENOSYS") &&
      !isNodeError(error, "ENOTSUP") &&
      !isNodeError(error, "EOPNOTSUPP")
    ) {
      throw error;
    }
  }
}

function exclusiveWriteFlags(): number {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
}

function waitForKeyWriter(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

export class TokenStore {
  readonly #settings: TokenStoreSettings;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  #tokens: StoredTokens | undefined;
  #key: Buffer | undefined;
  #initialized = false;
  #initializationPromise: Promise<void> | undefined;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(settings: TokenStoreSettings, dependencies: TokenStoreDependencies = {}) {
    this.#settings = settings;
    this.#now = dependencies.now ?? Date.now;
    this.#randomBytes = dependencies.randomBytes ?? randomBytes;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    if (this.#initializationPromise === undefined) {
      this.#initializationPromise = this.#initializeOnce()
        .then(() => {
          this.#initialized = true;
        })
        .finally(() => {
          this.#initializationPromise = undefined;
        });
    }

    await this.#initializationPromise;
  }

  async store(tokenResponse: TokenResponse): Promise<void> {
    validateTokenResponse(tokenResponse);
    const storedTokens: StoredTokens = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? "",
      expiresAt: this.#now() + (tokenResponse.expires_in ?? 3600) * 1000,
      scope: tokenResponse.scope ?? "",
    };

    await this.#enqueueWrite(async () => {
      await this.initialize();
      await this.#save(storedTokens);
      this.#tokens = storedTokens;
    });
  }

  getAccessToken(): string | undefined {
    return this.#tokens?.accessToken;
  }

  getRefreshToken(): string | undefined {
    return this.#tokens?.refreshToken;
  }

  isAccessTokenExpired(bufferSeconds = this.#settings.graphTokenRefreshBuffer): boolean {
    if (this.#tokens === undefined) {
      return true;
    }

    return this.#now() >= this.#tokens.expiresAt - bufferSeconds * 1000;
  }

  isAuthenticated(): boolean {
    return (
      (this.#tokens?.accessToken !== undefined && !this.isAccessTokenExpired()) ||
      Boolean(this.#tokens?.refreshToken)
    );
  }

  clear(): Promise<void> {
    return this.#enqueueWrite(async () => {
      this.#tokens = undefined;
      await rm(this.#settings.tokenFile, { force: true });
    });
  }

  async #initializeOnce(): Promise<void> {
    await mkdir(this.#settings.configDir, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    await enforceMode(this.#settings.configDir, PRIVATE_DIRECTORY_MODE);

    this.#key = this.#settings.graphTokenEncryptionKey
      ? createHash("sha256").update(this.#settings.graphTokenEncryptionKey, "utf8").digest()
      : await this.#loadOrCreateKey();
    this.#tokens = await this.#loadTokens(this.#key);
  }

  async #loadOrCreateKey(): Promise<Buffer> {
    try {
      return await this.#readKeyFile();
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }

    const candidate = this.#randomBytes(KEY_BYTES);
    if (candidate.length !== KEY_BYTES) {
      throw new Error("Unable to initialize token encryption.");
    }

    let handle;
    try {
      handle = await open(this.#settings.keyFile, exclusiveWriteFlags(), PRIVATE_FILE_MODE);
      await handle.writeFile(candidate.toString("base64"), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await enforceMode(this.#settings.keyFile, PRIVATE_FILE_MODE);
      return candidate;
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) {
        throw new Error("Unable to initialize token encryption.", { cause: error });
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return await this.#readKeyFile();
      } catch (error: unknown) {
        if (attempt === 99) {
          throw new Error("Unable to initialize token encryption.", { cause: error });
        }
        await waitForKeyWriter();
      }
    }

    throw new Error("Unable to initialize token encryption.");
  }

  async #readKeyFile(): Promise<Buffer> {
    const encoded = (await readFile(this.#settings.keyFile, "utf8")).trim();
    const key = decodeBase64(encoded);
    if (key?.length !== KEY_BYTES) {
      throw new Error("Unable to initialize token encryption.");
    }
    await enforceMode(this.#settings.keyFile, PRIVATE_FILE_MODE);
    return key;
  }

  async #loadTokens(key: Buffer): Promise<StoredTokens | undefined> {
    let encryptedText: string;
    try {
      encryptedText = await readFile(this.#settings.tokenFile, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        return undefined;
      }
      throw new Error("Unable to read encrypted token file.", { cause: error });
    }

    await enforceMode(this.#settings.tokenFile, PRIVATE_FILE_MODE);

    try {
      const envelope = parseEnvelope(JSON.parse(encryptedText) as unknown);
      if (envelope === undefined) {
        return undefined;
      }

      const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv);
      decipher.setAuthTag(envelope.authTag);
      const plaintext = Buffer.concat([
        decipher.update(envelope.ciphertext),
        decipher.final(),
      ]).toString("utf8");
      return parseStoredTokens(JSON.parse(plaintext) as unknown);
    } catch {
      return undefined;
    }
  }

  #enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const pending = this.#writeChain.then(operation);
    this.#writeChain = pending.catch(() => undefined);
    return pending;
  }

  async #save(tokens: StoredTokens): Promise<void> {
    if (this.#key === undefined) {
      throw new Error("Token store is not initialized.");
    }

    const iv = this.#randomBytes(IV_BYTES);
    if (iv.length !== IV_BYTES) {
      throw new Error("Unable to encrypt token file.");
    }

    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(tokens), "utf8"),
      cipher.final(),
    ]);
    const payload: EncryptedPayload = {
      version: 2,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const tokenDirectory = dirname(this.#settings.tokenFile);
    temporaryFileSequence += 1;
    const temporaryFile = join(
      tokenDirectory,
      `.${basename(this.#settings.tokenFile)}.${process.pid}.${process.hrtime.bigint()}.${temporaryFileSequence}.tmp`,
    );

    let handle;
    try {
      handle = await open(temporaryFile, exclusiveWriteFlags(), PRIVATE_FILE_MODE);
      await handle.writeFile(JSON.stringify(payload), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryFile, this.#settings.tokenFile);
      await enforceMode(this.#settings.tokenFile, PRIVATE_FILE_MODE);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryFile, { force: true }).catch(() => undefined);
    }
  }
}
