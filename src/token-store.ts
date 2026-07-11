import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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

interface TokenFileWriteQueue {
  tail: Promise<void>;
  pending: number;
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
const MAX_KEY_FILE_BYTES = 128;
const MAX_TOKEN_FILE_BYTES = 16 * 1024 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/;
const SECURITY_ERROR_MESSAGE =
  "Secure token storage validation failed. Check that the directory and secret files are private, regular, owned by the current user, and not links.";
const ENCRYPTION_ERROR_MESSAGE = "Unable to initialize token encryption securely.";
const TOKEN_WRITE_ERROR_MESSAGE = "Unable to persist encrypted token file securely.";
const TOKEN_CLEAR_ERROR_MESSAGE = "Unable to clear encrypted token file securely.";
const DIRECTORY_SYNC_ERROR_MESSAGE = "Unable to durably synchronize token storage.";

let temporaryFileSequence = 0;
const tokenFileWriteQueues = new Map<string, TokenFileWriteQueue>();

class SecurityValidationError extends Error {
  constructor() {
    super(SECURITY_ERROR_MESSAGE);
  }
}

class KeyPublicationInProgressError extends SecurityValidationError {}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function securityError(): SecurityValidationError {
  return new SecurityValidationError();
}

function encryptionError(): Error {
  return new Error(ENCRYPTION_ERROR_MESSAGE);
}

function tokenWriteError(): Error {
  return new Error(TOKEN_WRITE_ERROR_MESSAGE);
}

function tokenClearError(): Error {
  return new Error(TOKEN_CLEAR_ERROR_MESSAGE);
}

function directorySyncError(): Error {
  return new Error(DIRECTORY_SYNC_ERROR_MESSAGE);
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
}

function exclusiveWriteFlags(): number {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag();
}

function readOnlyFlags(): number {
  return constants.O_RDONLY | noFollowFlag();
}

function directoryReadFlags(): number {
  return constants.O_RDONLY | constants.O_DIRECTORY | noFollowFlag();
}

function hasExpectedOwner(uid: number): boolean {
  return process.platform === "win32" || process.getuid === undefined || uid === process.getuid();
}

function isUnsupportedModeError(error: unknown): boolean {
  return (
    isNodeError(error, "ENOSYS") ||
    isNodeError(error, "ENOTSUP") ||
    isNodeError(error, "EOPNOTSUPP")
  );
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return (
    isNodeError(error, "EINVAL") ||
    isNodeError(error, "ENOSYS") ||
    isNodeError(error, "ENOTSUP") ||
    isNodeError(error, "EOPNOTSUPP")
  );
}

async function enforceHandleMode(handle: FileHandle, mode: number): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  try {
    await handle.chmod(mode);
  } catch (error: unknown) {
    if (!isUnsupportedModeError(error)) {
      throw error;
    }
    return;
  }

  const stats = await handle.stat();
  if ((stats.mode & 0o777) !== mode) {
    throw securityError();
  }
}

function validateOwner(uid: number): void {
  if (!hasExpectedOwner(uid)) {
    throw securityError();
  }
}

async function validateConfigDirectory(
  configDir: string,
  options: { create: boolean; enforceMode: boolean },
): Promise<boolean> {
  let pathStats;
  try {
    pathStats = await lstat(configDir);
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) {
      throw securityError();
    }
    if (!options.create) {
      return false;
    }

    try {
      await mkdir(configDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      pathStats = await lstat(configDir);
    } catch {
      throw securityError();
    }
  }

  if (pathStats.isSymbolicLink() || !pathStats.isDirectory()) {
    throw securityError();
  }
  validateOwner(pathStats.uid);

  if (process.platform === "win32") {
    return true;
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(configDir, directoryReadFlags());
    const handleStats = await handle.stat();
    if (!handleStats.isDirectory()) {
      throw securityError();
    }
    validateOwner(handleStats.uid);
    if (options.enforceMode) {
      await enforceHandleMode(handle, PRIVATE_DIRECTORY_MODE);
    }
    return true;
  } catch (error: unknown) {
    if (error instanceof SecurityValidationError) {
      throw error;
    }
    throw securityError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateNewPrivateFile(stats: Stats): void {
  if (!stats.isFile() || stats.nlink !== 1) {
    throw securityError();
  }
  validateOwner(stats.uid);
}

function validateSecureReadFileStats(
  stats: Stats,
  maximumBytes: number,
  options: { reportLinkCountRace?: boolean },
): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw securityError();
  }
  if (stats.nlink !== 1) {
    if (options.reportLinkCountRace) {
      throw new KeyPublicationInProgressError();
    }
    throw securityError();
  }
  validateOwner(stats.uid);
  if (!Number.isSafeInteger(stats.size) || stats.size < 0 || stats.size > maximumBytes) {
    throw securityError();
  }
}

function supportsFileIdentityComparison(stats: Stats): boolean {
  return (
    Number.isSafeInteger(stats.dev) &&
    stats.dev > 0 &&
    Number.isSafeInteger(stats.ino) &&
    stats.ino > 0
  );
}

function validateMatchingFileIdentity(pathStats: Stats, handleStats: Stats): void {
  const pathIdentitySupported = supportsFileIdentityComparison(pathStats);
  const handleIdentitySupported = supportsFileIdentityComparison(handleStats);
  if (process.platform === "win32" && (!pathIdentitySupported || !handleIdentitySupported)) {
    throw securityError();
  }
  if (
    pathIdentitySupported &&
    handleIdentitySupported &&
    (pathStats.dev !== handleStats.dev || pathStats.ino !== handleStats.ino)
  ) {
    throw securityError();
  }
}

async function readBoundedTextFile(handle: FileHandle, maximumBytes: number): Promise<string> {
  const content = Buffer.alloc(maximumBytes + 1);
  let bytesReadTotal = 0;
  while (bytesReadTotal < content.length) {
    const { bytesRead } = await handle.read(
      content,
      bytesReadTotal,
      content.length - bytesReadTotal,
      bytesReadTotal,
    );
    if (bytesRead === 0) {
      break;
    }
    bytesReadTotal += bytesRead;
  }
  if (bytesReadTotal > maximumBytes) {
    throw securityError();
  }
  return content.subarray(0, bytesReadTotal).toString("utf8");
}

async function readSecureTextFile(
  filePath: string,
  maximumBytes: number,
  options: { reportLinkCountRace?: boolean } = {},
): Promise<string> {
  let pathStats: Stats;
  try {
    pathStats = await lstat(filePath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      throw error;
    }
    throw securityError();
  }

  validateSecureReadFileStats(pathStats, maximumBytes, options);

  let handle: FileHandle;
  try {
    handle = await open(filePath, readOnlyFlags());
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      throw error;
    }
    throw securityError();
  }

  try {
    const handleStats = await handle.stat();
    validateSecureReadFileStats(handleStats, maximumBytes, options);
    validateMatchingFileIdentity(pathStats, handleStats);
    await enforceHandleMode(handle, PRIVATE_FILE_MODE);
    return await readBoundedTextFile(handle, maximumBytes);
  } catch (error: unknown) {
    if (error instanceof SecurityValidationError) {
      throw error;
    }
    throw securityError();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writePrivateTemporaryFile(filePath: string, content: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, exclusiveWriteFlags(), PRIVATE_FILE_MODE);
    validateNewPrivateFile(await handle.stat());
    await handle.writeFile(content, "utf8");
    await enforceHandleMode(handle, PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(configDir: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(configDir, directoryReadFlags());
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      throw securityError();
    }
    validateOwner(stats.uid);
    await handle.sync();
  } catch (error: unknown) {
    if (isUnsupportedDirectorySyncError(error)) {
      return;
    }
    if (error instanceof SecurityValidationError) {
      throw error;
    }
    throw directorySyncError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function bestEffortSyncDirectory(configDir: string): Promise<void> {
  await syncDirectory(configDir).catch(() => undefined);
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
    !Number.isSafeInteger(candidate.expiresAt) ||
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
  if (typeof tokenResponse !== "object" || tokenResponse === null || Array.isArray(tokenResponse)) {
    throw new Error("Token response must be an object.");
  }
  if (typeof tokenResponse.access_token !== "string" || tokenResponse.access_token.length === 0) {
    throw new Error("Token response must contain a nonempty access token.");
  }
  if (
    tokenResponse.refresh_token !== undefined &&
    typeof tokenResponse.refresh_token !== "string"
  ) {
    throw new Error("Token response refresh token must be a string.");
  }
  if (tokenResponse.scope !== undefined && typeof tokenResponse.scope !== "string") {
    throw new Error("Token response scope must be a string.");
  }
  if (
    tokenResponse.expires_in !== undefined &&
    (!Number.isSafeInteger(tokenResponse.expires_in) || tokenResponse.expires_in <= 0)
  ) {
    throw new Error("Token response expiry must be a positive safe integer.");
  }
}

function validateNow(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error("Current time must be a safe integer number of epoch milliseconds.");
  }
  return value;
}

function computeExpiresAt(now: number, expiresIn: number): number {
  const durationMilliseconds = expiresIn * 1000;
  const expiresAt = now + durationMilliseconds;
  if (
    !Number.isSafeInteger(durationMilliseconds) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now
  ) {
    throw new Error("Token response expiry is outside the supported time range.");
  }
  return expiresAt;
}

function validateBufferMilliseconds(bufferSeconds: number): number {
  if (!Number.isSafeInteger(bufferSeconds) || bufferSeconds < 0) {
    throw new Error("Token expiry buffer must be a nonnegative safe integer.");
  }
  const milliseconds = bufferSeconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("Token expiry buffer is outside the supported time range.");
  }
  return milliseconds;
}

function enqueueTokenFileWrite(tokenFile: string, operation: () => Promise<void>): Promise<void> {
  const queueKey = resolve(tokenFile);
  let queue = tokenFileWriteQueues.get(queueKey);
  if (queue === undefined) {
    queue = { tail: Promise.resolve(), pending: 0 };
    tokenFileWriteQueues.set(queueKey, queue);
  }

  queue.pending += 1;
  const pendingWrite = queue.tail.then(operation);
  const settledTail = pendingWrite.catch(() => undefined);
  queue.tail = settledTail;

  void settledTail.then(() => {
    queue.pending -= 1;
    if (
      queue.pending === 0 &&
      queue.tail === settledTail &&
      tokenFileWriteQueues.get(queueKey) === queue
    ) {
      tokenFileWriteQueues.delete(queueKey);
    }
  });

  return pendingWrite;
}

function waitForKeyPublisher(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
}

export class TokenStore {
  readonly #settings: TokenStoreSettings;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #configDir: string;
  readonly #tokenFile: string;
  readonly #keyFile: string;
  #tokens: StoredTokens | undefined;
  #key: Buffer | undefined;
  #initialized = false;

  constructor(settings: TokenStoreSettings, dependencies: TokenStoreDependencies = {}) {
    this.#settings = settings;
    this.#now = dependencies.now ?? Date.now;
    this.#randomBytes = dependencies.randomBytes ?? randomBytes;
    this.#configDir = resolve(settings.configDir);
    this.#tokenFile = resolve(settings.tokenFile);
    this.#keyFile = resolve(settings.keyFile);
  }

  initialize(): Promise<void> {
    return enqueueTokenFileWrite(this.#tokenFile, () => this.#initializeUnlocked());
  }

  async store(tokenResponse: TokenResponse): Promise<void> {
    validateTokenResponse(tokenResponse);
    const now = validateNow(this.#now());
    const storedTokens: StoredTokens = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? "",
      expiresAt: computeExpiresAt(now, tokenResponse.expires_in ?? 3600),
      scope: tokenResponse.scope ?? "",
    };

    await enqueueTokenFileWrite(this.#tokenFile, async () => {
      await this.#initializeUnlocked();
      await this.#save(storedTokens);
    });
  }

  getAccessToken(): string | undefined {
    return this.#tokens?.accessToken;
  }

  getRefreshToken(): string | undefined {
    return this.#tokens?.refreshToken;
  }

  isAccessTokenExpired(bufferSeconds = this.#settings.graphTokenRefreshBuffer): boolean {
    const bufferMilliseconds = validateBufferMilliseconds(bufferSeconds);
    const now = validateNow(this.#now());
    if (this.#tokens === undefined) {
      return true;
    }

    const expirationThreshold = this.#tokens.expiresAt - bufferMilliseconds;
    if (!Number.isSafeInteger(expirationThreshold)) {
      throw new Error("Token expiry comparison is outside the supported time range.");
    }
    return now >= expirationThreshold;
  }

  isAuthenticated(): boolean {
    return (
      (this.#tokens?.accessToken !== undefined && !this.isAccessTokenExpired()) ||
      Boolean(this.#tokens?.refreshToken)
    );
  }

  clear(): Promise<void> {
    return enqueueTokenFileWrite(this.#tokenFile, () => this.#clearUnlocked());
  }

  #validateSecretPaths(): void {
    if (
      dirname(this.#keyFile) !== this.#configDir ||
      dirname(this.#tokenFile) !== this.#configDir ||
      this.#keyFile === this.#tokenFile
    ) {
      throw securityError();
    }
  }

  async #initializeUnlocked(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    this.#validateSecretPaths();
    await validateConfigDirectory(this.#configDir, { create: true, enforceMode: true });
    const key = this.#settings.graphTokenEncryptionKey
      ? createHash("sha256").update(this.#settings.graphTokenEncryptionKey, "utf8").digest()
      : await this.#loadOrCreateKey();
    const tokens = await this.#loadTokens(key);

    this.#key = key;
    this.#tokens = tokens;
    this.#initialized = true;
  }

  async #loadOrCreateKey(): Promise<Buffer> {
    try {
      return await this.#readKeyFile();
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }

    let candidate: Buffer;
    try {
      candidate = this.#randomBytes(KEY_BYTES);
    } catch {
      throw encryptionError();
    }
    if (candidate.length !== KEY_BYTES) {
      throw encryptionError();
    }

    return this.#publishGeneratedKey(candidate);
  }

  async #publishGeneratedKey(candidate: Buffer): Promise<Buffer> {
    const temporaryFile = this.#temporaryFilePath(this.#keyFile, "key");
    let published = false;
    try {
      try {
        await writePrivateTemporaryFile(temporaryFile, candidate.toString("base64"));
      } catch {
        throw encryptionError();
      }

      try {
        await link(temporaryFile, this.#keyFile);
        published = true;
      } catch (error: unknown) {
        if (!isNodeError(error, "EEXIST")) {
          throw encryptionError();
        }
        await rm(temporaryFile, { force: true }).catch(() => undefined);
        return await this.#readWinningKey();
      }

      let synchronizationFailure: Error | undefined;
      try {
        await syncDirectory(this.#configDir);
      } catch (error: unknown) {
        synchronizationFailure = error instanceof Error ? error : directorySyncError();
      }

      try {
        await unlink(temporaryFile);
      } catch {
        throw encryptionError();
      }
      await bestEffortSyncDirectory(this.#configDir);

      if (synchronizationFailure !== undefined) {
        throw synchronizationFailure;
      }
      return candidate;
    } finally {
      await rm(temporaryFile, { force: true }).catch(() => undefined);
      if (published) {
        await bestEffortSyncDirectory(this.#configDir);
      }
    }
  }

  async #readWinningKey(): Promise<Buffer> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        return await this.#readKeyFile(true);
      } catch (error: unknown) {
        if (!(error instanceof KeyPublicationInProgressError) || attempt === 99) {
          throw error;
        }
        await waitForKeyPublisher();
      }
    }
    throw encryptionError();
  }

  async #readKeyFile(reportLinkCountRace = false): Promise<Buffer> {
    const encoded = (
      await readSecureTextFile(this.#keyFile, MAX_KEY_FILE_BYTES, { reportLinkCountRace })
    ).trim();
    const key = decodeBase64(encoded);
    if (key?.length !== KEY_BYTES) {
      throw encryptionError();
    }
    return key;
  }

  async #loadTokens(key: Buffer): Promise<StoredTokens | undefined> {
    let encryptedText: string;
    try {
      encryptedText = await readSecureTextFile(this.#tokenFile, MAX_TOKEN_FILE_BYTES);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }

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

  async #save(tokens: StoredTokens): Promise<void> {
    if (this.#key === undefined) {
      throw tokenWriteError();
    }

    let iv: Buffer;
    try {
      iv = this.#randomBytes(IV_BYTES);
    } catch {
      throw tokenWriteError();
    }
    if (iv.length !== IV_BYTES) {
      throw tokenWriteError();
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
    const serializedPayload = JSON.stringify(payload);
    if (Buffer.byteLength(serializedPayload, "utf8") > MAX_TOKEN_FILE_BYTES) {
      throw tokenWriteError();
    }

    const temporaryFile = this.#temporaryFilePath(this.#tokenFile, "token");
    try {
      try {
        await writePrivateTemporaryFile(temporaryFile, serializedPayload);
        await rename(temporaryFile, this.#tokenFile);
      } catch {
        throw tokenWriteError();
      }

      this.#tokens = tokens;
      await syncDirectory(this.#configDir);
    } finally {
      await rm(temporaryFile, { force: true }).catch(() => undefined);
    }
  }

  async #clearUnlocked(): Promise<void> {
    this.#validateSecretPaths();
    const directoryExists = await validateConfigDirectory(this.#configDir, {
      create: false,
      enforceMode: false,
    });
    if (!directoryExists) {
      this.#tokens = undefined;
      return;
    }

    try {
      await unlink(this.#tokenFile);
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) {
        throw tokenClearError();
      }
    }

    let synchronizationFailure: Error | undefined;
    try {
      await syncDirectory(this.#configDir);
    } catch (error: unknown) {
      synchronizationFailure = error instanceof Error ? error : directorySyncError();
    }
    this.#tokens = undefined;
    if (synchronizationFailure !== undefined) {
      throw synchronizationFailure;
    }
  }

  #temporaryFilePath(targetFile: string, kind: "key" | "token"): string {
    temporaryFileSequence += 1;
    return join(
      this.#configDir,
      `.${basename(targetFile)}.${kind}.${process.pid}.${process.hrtime.bigint()}.${temporaryFileSequence}.tmp`,
    );
  }
}
