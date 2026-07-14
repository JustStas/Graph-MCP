import { AuthenticationError } from "../errors.js";
import {
  parseTokenResponse,
  type StoredTokens,
  type TokenResponse,
  type TokenStore,
} from "../token-store.js";
import {
  runBrowserLogin,
  type BrowserLoginDependencies,
  type BrowserLoginSettings,
} from "./browser-flow.js";
import {
  startDeviceCodeLogin,
  type DeviceCodeLoginDependencies,
  type DeviceCodeLoginSession,
  type DeviceCodeSettings,
  type DeviceCodeTokenStore,
} from "./device-code-flow.js";

const SETUP_MESSAGE = "AZURE_CLIENT_ID is not configured. Run 'graph-mcp setup' first.";
const LOGIN_REQUIRED_MESSAGE = "Not authenticated. Please log in first.";
const LOGIN_COLLISION_MESSAGE = "An authentication login is already in progress.";
const BROWSER_FAILURE_MESSAGE = "Browser login failed.";
const DEVICE_START_FAILURE_MESSAGE = "Unable to start device-code login.";
const DEVICE_FAILURE_MESSAGE = "Device-code login failed.";
const STORE_FAILURE_MESSAGE = "Unable to store authentication tokens.";
const LOGOUT_FAILURE_MESSAGE = "Unable to clear authentication tokens.";
const BROWSER_CANCELLED_MESSAGE = "Login timed out or was cancelled.";
const DEVICE_CANCELLED_MESSAGE = "Device-code login was cancelled.";
const LOGOUT_IN_PROGRESS_MESSAGE = "Authentication logout is in progress.";
const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;
const DEFAULT_STORAGE_TIMEOUT_MS = 30_000;
const STORAGE_MUTATION_CANCELLED_MESSAGE = "Authentication storage operation was cancelled.";
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type LoginStatus =
  | { readonly state: "unauthenticated" }
  | {
      readonly state: "pending";
      readonly method: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresAt: number;
      readonly message: string;
    }
  | { readonly state: "authenticated" }
  | { readonly state: "failed"; readonly message: string };

export type LoginMethod = "browser" | "device_code";

export type AuthManagerSettings = BrowserLoginSettings & DeviceCodeSettings;

export type AuthManagerTokenStore = Pick<
  TokenStore,
  | "store"
  | "getAccessToken"
  | "getRefreshToken"
  | "getTokenSnapshot"
  | "storeTokenSnapshot"
  | "isAccessTokenExpired"
  | "isAuthenticated"
  | "clear"
>;

export interface OAuthResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type OAuthFetch = (input: string, init: RequestInit) => Promise<OAuthResponse>;

export type BrowserLoginRunner = (
  settings: BrowserLoginSettings,
  dependencies?: BrowserLoginDependencies,
) => Promise<TokenResponse>;

export type DeviceCodeLoginStarter = (
  settings: DeviceCodeSettings,
  store: DeviceCodeTokenStore,
  dependencies?: DeviceCodeLoginDependencies,
) => Promise<DeviceCodeLoginSession>;

export interface AuthManagerDependencies {
  readonly runBrowserLogin?: BrowserLoginRunner;
  readonly startDeviceCodeLogin?: DeviceCodeLoginStarter;
  readonly fetch?: OAuthFetch;
  readonly refreshTimeoutMs?: number;
  readonly storageTimeoutMs?: number;
}

interface ActiveLogin {
  readonly controller: AbortController;
  readonly generation: number;
  settlement: Promise<void>;
}

interface ActiveRefresh {
  readonly controller: AbortController;
  readonly generation: number;
  readonly refreshToken: string;
  settlement: Promise<boolean>;
  timeout: ReturnType<typeof setTimeout> | undefined;
}

type DesiredAuthState =
  | {
      readonly revision: number;
      readonly generation: number;
      readonly kind: "clear";
    }
  | {
      readonly revision: number;
      readonly generation: number;
      readonly kind: "tokens";
      readonly accessToken?: string;
      readonly refreshToken?: string;
      readonly expiresAt?: number;
      readonly storageSnapshot: Readonly<StoredTokens>;
    };

interface PrimaryStorageMutation {
  readonly id: number;
  readonly startRevision: number;
  readonly kind: "tokens" | "clear";
  accepted: boolean;
  awaitingFinished: boolean;
  losing: boolean;
  rawSettled: boolean;
  rawRejected: boolean;
}

interface PendingLosingMutation {
  readonly startRevision: number;
  readonly kind: "tokens" | "clear";
  rawSettled: boolean;
  rawRejected: boolean;
}

interface PhysicalStorageSlot {
  readonly occupied: true;
}

class InternalAuthenticationError extends AuthenticationError {}

class StorageMutationCancelledError extends Error {
  constructor() {
    super(STORAGE_MUTATION_CANCELLED_MESSAGE);
  }
}

function freezeStatus(status: LoginStatus): LoginStatus {
  return Object.freeze({ ...status });
}

function authenticationError(message: string): AuthenticationError {
  return new InternalAuthenticationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedOAuthErrorIdentifier(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function tokenSnapshot(tokens: Readonly<TokenResponse>): Readonly<StoredTokens> {
  const now = Date.now();
  const expiresIn = tokens.expires_in ?? 3600;
  const expiresAt = now + expiresIn * 1000;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error("Token response expiry is outside the supported time range.");
  }
  return Object.freeze({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
    expiresAt,
    scope: tokens.scope ?? "",
  });
}

function throwIfAborted(signal: AbortSignal, message: string): void {
  if (signal.aborted) {
    throw authenticationError(message);
  }
}

function rejectOnAbort<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
  message: string,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => finish(() => reject(authenticationError(message)));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => {
        finish(() =>
          reject(error instanceof Error ? error : new Error("Authentication operation failed.")),
        );
      },
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

interface ManagedStorageAbort {
  readonly signal: AbortSignal;
  dispose(): void;
}

function createManagedStorageAbort(
  callerSignals: readonly (AbortSignal | undefined)[],
  timeoutMs: number,
): ManagedStorageAbort {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abort = () => controller.abort();
  for (const signal of callerSignals) {
    if (signal === undefined) {
      continue;
    }
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    listeners.push({ signal, listener: abort });
  }
  const timeout = setTimeout(abort, Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
  timeout.unref?.();

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

function rejectStorageOnAbort(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(new StorageMutationCancelledError()));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      () => finish(resolve),
      (error: unknown) =>
        finish(() =>
          reject(error instanceof Error ? error : new Error("Authentication storage failed.")),
        ),
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

function browserFailure(
  error: unknown,
  signal: AbortSignal,
  trusted: boolean,
): AuthenticationError {
  if (signal.aborted) {
    return authenticationError(BROWSER_CANCELLED_MESSAGE);
  }
  if (
    error instanceof InternalAuthenticationError ||
    (trusted && error instanceof AuthenticationError)
  ) {
    return error;
  }
  return authenticationError(BROWSER_FAILURE_MESSAGE);
}

function deviceStartFailure(
  error: unknown,
  signal: AbortSignal,
  trusted: boolean,
): AuthenticationError {
  if (signal.aborted) {
    return authenticationError(DEVICE_CANCELLED_MESSAGE);
  }
  if (
    error instanceof InternalAuthenticationError ||
    (trusted && error instanceof AuthenticationError)
  ) {
    return error;
  }
  return authenticationError(DEVICE_START_FAILURE_MESSAGE);
}

function devicePollingFailure(
  error: unknown,
  signal: AbortSignal,
  trusted: boolean,
): AuthenticationError {
  if (signal.aborted) {
    return authenticationError(DEVICE_CANCELLED_MESSAGE);
  }
  if (
    error instanceof InternalAuthenticationError ||
    (trusted && error instanceof AuthenticationError)
  ) {
    return error;
  }
  return authenticationError(DEVICE_FAILURE_MESSAGE);
}

export class AuthManager {
  readonly #settings: AuthManagerSettings;
  readonly #tokenStore: AuthManagerTokenStore;
  readonly #runBrowserLogin: BrowserLoginRunner;
  readonly #startDeviceCodeLogin: DeviceCodeLoginStarter;
  readonly #usesDefaultBrowserLogin: boolean;
  readonly #usesDefaultDeviceCodeLogin: boolean;
  readonly #fetch: OAuthFetch;
  readonly #refreshTimeoutMs: number;
  readonly #storageTimeoutMs: number;
  #status: LoginStatus;
  #activeLogin: ActiveLogin | undefined;
  #activeRefresh: ActiveRefresh | undefined;
  #disposePromise: Promise<void> | undefined;
  #authGeneration = 0;
  #logoutInProgress = false;
  #logoutPromise: Promise<void> | undefined;
  #desiredAuthState: DesiredAuthState | undefined;
  #desiredRevision = 0;
  #storageMutationSequence = 0;
  #activePrimaryStorageMutations = 0;
  #physicalStorageSlot: PhysicalStorageSlot | undefined;
  readonly #pendingLosingMutations = new Map<number, PendingLosingMutation>();
  #reconciliationRequested = false;
  #reconciliationRunning = false;

  constructor(
    settings: AuthManagerSettings,
    tokenStore: AuthManagerTokenStore,
    dependencies: AuthManagerDependencies = {},
  ) {
    this.#settings = Object.freeze({
      ...settings,
      scopes: Object.freeze([...settings.scopes]),
    });
    this.#tokenStore = tokenStore;
    this.#usesDefaultBrowserLogin = dependencies.runBrowserLogin === undefined;
    this.#usesDefaultDeviceCodeLogin = dependencies.startDeviceCodeLogin === undefined;
    this.#runBrowserLogin = dependencies.runBrowserLogin ?? runBrowserLogin;
    this.#startDeviceCodeLogin = dependencies.startDeviceCodeLogin ?? startDeviceCodeLogin;
    this.#fetch = dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#refreshTimeoutMs = dependencies.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
    this.#storageTimeoutMs = dependencies.storageTimeoutMs ?? DEFAULT_STORAGE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#refreshTimeoutMs) || this.#refreshTimeoutMs <= 0) {
      throw new Error("Refresh timeout must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.#storageTimeoutMs) || this.#storageTimeoutMs <= 0) {
      throw new Error("Storage timeout must be a positive safe integer.");
    }
    const initiallyAuthenticated = tokenStore.isAuthenticated();
    this.#status = freezeStatus(
      initiallyAuthenticated ? { state: "authenticated" } : { state: "unauthenticated" },
    );
  }

  getStatus(): LoginStatus {
    this.#requestReconciliation();
    this.#setStatus(this.#reconcileStatus(this.#status));
    return this.#statusSnapshot();
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) {
      return this.#disposePromise;
    }

    this.#authGeneration += 1;
    const activeLogin = this.#activeLogin;
    const activeRefresh = this.#activeRefresh;
    activeLogin?.controller.abort();
    activeRefresh?.controller.abort();

    const disposePromise = Promise.all([
      activeLogin?.settlement.catch(() => undefined),
      activeRefresh?.settlement.catch(() => false),
    ]).then(() => undefined);
    this.#disposePromise = disposePromise;
    return disposePromise;
  }

  async login(method: LoginMethod = "browser"): Promise<LoginStatus> {
    this.#requireClientId();
    if (this.#logoutInProgress) {
      throw authenticationError(LOGOUT_IN_PROGRESS_MESSAGE);
    }
    if (this.#activeLogin !== undefined) {
      throw authenticationError(LOGIN_COLLISION_MESSAGE);
    }
    if (this.#physicalStorageSlot !== undefined) {
      throw authenticationError(STORE_FAILURE_MESSAGE);
    }

    const previousRefresh = this.#activeRefresh;
    this.#authGeneration += 1;
    previousRefresh?.controller.abort();
    const active: ActiveLogin = {
      controller: new AbortController(),
      generation: this.#authGeneration,
      settlement: Promise.resolve(),
    };
    this.#activeLogin = active;

    if (method === "device_code") {
      const startup = this.#startDeviceLogin(active, previousRefresh?.settlement);
      active.settlement = startup.then(
        () => undefined,
        () => undefined,
      );
      return await startup;
    }

    const browser = this.#completeBrowserLogin(active, previousRefresh?.settlement);
    active.settlement = browser.then(
      () => undefined,
      () => undefined,
    );
    return await browser;
  }

  refreshAccessToken(): Promise<boolean> {
    if (this.#logoutInProgress) {
      return Promise.reject(authenticationError(LOGOUT_IN_PROGRESS_MESSAGE));
    }
    if (this.#activeLogin !== undefined) {
      return Promise.reject(authenticationError(LOGIN_COLLISION_MESSAGE));
    }
    if (this.#activeRefresh !== undefined) {
      return this.#activeRefresh.settlement;
    }
    if (this.#physicalStorageSlot !== undefined) {
      return Promise.resolve(false);
    }

    const storageIsFenced = this.#storageReadIsFenced();
    if (storageIsFenced) {
      this.#requestReconciliation();
    }
    const refreshToken =
      storageIsFenced && this.#desiredAuthState?.kind === "tokens"
        ? this.#desiredAuthState.refreshToken
        : this.#tokenStore.getRefreshToken();
    if (refreshToken === undefined || refreshToken.trim().length === 0) {
      return Promise.resolve(false);
    }
    try {
      this.#requireClientId();
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : authenticationError(SETUP_MESSAGE));
    }

    const active: ActiveRefresh = {
      controller: new AbortController(),
      generation: this.#authGeneration,
      refreshToken,
      settlement: Promise.resolve(false),
      timeout: undefined,
    };
    active.timeout = setTimeout(
      () => active.controller.abort(),
      Math.min(this.#refreshTimeoutMs, MAX_TIMER_DELAY_MS),
    );
    active.timeout.unref?.();
    this.#activeRefresh = active;
    const refreshPromise = this.#performRefresh(active).finally(() => {
      this.#clearRefreshTimeout(active);
      if (this.#activeRefresh === active) {
        this.#activeRefresh = undefined;
      }
      this.#maybeStartReconciliation();
    });
    active.settlement = refreshPromise;
    return refreshPromise;
  }

  async getValidAccessToken(): Promise<string> {
    if (this.#storageReadIsFenced()) {
      this.#requestReconciliation();
      if (this.#desiredAuthState?.kind === "clear") {
        this.#setStatus({ state: "unauthenticated" });
        throw authenticationError(LOGIN_REQUIRED_MESSAGE);
      }
      const desiredAccessToken = this.#desiredAccessToken();
      if (desiredAccessToken !== undefined) {
        this.#setStatus({ state: "authenticated" });
        return desiredAccessToken;
      }
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        const refreshedDesiredAccessToken = this.#desiredAccessToken();
        if (refreshedDesiredAccessToken !== undefined) {
          this.#setStatus({ state: "authenticated" });
          return refreshedDesiredAccessToken;
        }
      }
      throw authenticationError(LOGIN_REQUIRED_MESSAGE);
    }
    const accessToken = this.#tokenStore.getAccessToken();
    if (
      accessToken !== undefined &&
      accessToken.trim().length > 0 &&
      !this.#tokenStore.isAccessTokenExpired()
    ) {
      return accessToken;
    }

    const refreshed = await this.refreshAccessToken();
    if (this.#storageReadIsFenced()) {
      this.#requestReconciliation();
      const refreshedDesiredAccessToken = this.#desiredAccessToken();
      if (refreshedDesiredAccessToken !== undefined) {
        this.#setStatus({ state: "authenticated" });
        return refreshedDesiredAccessToken;
      }
      throw authenticationError(LOGIN_REQUIRED_MESSAGE);
    }
    const refreshedAccessToken = this.#tokenStore.getAccessToken();
    if (
      refreshed &&
      refreshedAccessToken !== undefined &&
      refreshedAccessToken.trim().length > 0 &&
      !this.#tokenStore.isAccessTokenExpired(0)
    ) {
      this.#setStatus({ state: "authenticated" });
      return refreshedAccessToken;
    }
    if (
      refreshedAccessToken !== undefined &&
      refreshedAccessToken.trim().length > 0 &&
      !this.#tokenStore.isAccessTokenExpired(0)
    ) {
      this.#setStatus({ state: "authenticated" });
      return refreshedAccessToken;
    }
    if (!this.#hasUsableStoredCredentials()) {
      this.#setStatus({ state: "unauthenticated" });
    }
    throw authenticationError(LOGIN_REQUIRED_MESSAGE);
  }

  logout(): Promise<void> {
    if (this.#logoutPromise !== undefined) {
      return this.#logoutPromise;
    }

    this.#logoutInProgress = true;
    this.#authGeneration += 1;
    const logoutGeneration = this.#authGeneration;
    this.#setDesiredClear(logoutGeneration);
    const capturedLogin = this.#activeLogin;
    const capturedRefresh = this.#activeRefresh;
    capturedLogin?.controller.abort();
    capturedRefresh?.controller.abort();

    const logoutPromise = this.#completeLogout(
      capturedLogin,
      capturedRefresh,
      logoutGeneration,
    ).finally(() => {
      if (this.#logoutPromise === logoutPromise) {
        this.#logoutPromise = undefined;
        this.#logoutInProgress = false;
        this.#maybeStartReconciliation();
      }
    });
    this.#logoutPromise = logoutPromise;
    return logoutPromise;
  }

  async #completeBrowserLogin(
    active: ActiveLogin,
    previousRefresh: Promise<boolean> | undefined,
  ): Promise<LoginStatus> {
    try {
      if (previousRefresh !== undefined) {
        await previousRefresh.catch(() => false);
      }
      this.#throwIfLoginInactive(active, BROWSER_CANCELLED_MESSAGE);
      const tokens = await rejectOnAbort(
        this.#runBrowserLogin(this.#settings, { signal: active.controller.signal }),
        active.controller.signal,
        BROWSER_CANCELLED_MESSAGE,
      );
      this.#throwIfLoginInactive(active, BROWSER_CANCELLED_MESSAGE);
      try {
        await this.#storeTokens(tokens, [active.controller.signal], active.generation, () =>
          this.#loginOperationIsCurrent(active),
        );
      } catch {
        if (active.controller.signal.aborted) {
          throw authenticationError(BROWSER_CANCELLED_MESSAGE);
        }
        throw authenticationError(STORE_FAILURE_MESSAGE);
      }
      this.#throwIfLoginInactive(active, BROWSER_CANCELLED_MESSAGE);
      this.#setStatus({ state: "authenticated" });
      return this.#statusSnapshot();
    } catch (error: unknown) {
      const failure = browserFailure(
        error,
        active.controller.signal,
        this.#usesDefaultBrowserLogin,
      );
      this.#setStatus(this.#failureStatus(failure.message));
      throw failure;
    } finally {
      this.#clearActive(active);
    }
  }

  async #startDeviceLogin(
    active: ActiveLogin,
    previousRefresh: Promise<boolean> | undefined,
  ): Promise<LoginStatus> {
    let session: DeviceCodeLoginSession;
    try {
      if (previousRefresh !== undefined) {
        await previousRefresh.catch(() => false);
      }
      this.#throwIfLoginInactive(active, DEVICE_CANCELLED_MESSAGE);
      session = await rejectOnAbort(
        this.#startDeviceCodeLogin(this.#settings, this.#deviceStore(active), {
          signal: active.controller.signal,
          storageTimeoutMs: this.#storageTimeoutMs,
        }),
        active.controller.signal,
        DEVICE_CANCELLED_MESSAGE,
      );
      this.#throwIfLoginInactive(active, DEVICE_CANCELLED_MESSAGE);
    } catch (error: unknown) {
      const failure = deviceStartFailure(
        error,
        active.controller.signal,
        this.#usesDefaultDeviceCodeLogin,
      );
      this.#setStatus(this.#failureStatus(failure.message));
      this.#clearActive(active);
      throw failure;
    }

    this.#setStatus({
      state: "pending",
      method: "device_code",
      ...session.details,
    });
    const background = this.#completeDeviceLogin(active, session);
    active.settlement = background;
    void background.catch(() => undefined);
    return this.#statusSnapshot();
  }

  async #completeDeviceLogin(active: ActiveLogin, session: DeviceCodeLoginSession): Promise<void> {
    try {
      await rejectOnAbort(session.poll(), active.controller.signal, DEVICE_CANCELLED_MESSAGE);
      this.#throwIfLoginInactive(active, DEVICE_CANCELLED_MESSAGE);
      this.#setStatus({ state: "authenticated" });
    } catch (error: unknown) {
      const failure = devicePollingFailure(
        error,
        active.controller.signal,
        this.#usesDefaultDeviceCodeLogin,
      );
      this.#setStatus(this.#failureStatus(failure.message));
    } finally {
      this.#clearActive(active);
    }
  }

  async #performRefresh(active: ActiveRefresh): Promise<boolean> {
    let response: OAuthResponse;
    try {
      response = await rejectOnAbort(
        this.#fetch(this.#settings.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: this.#settings.azureClientId,
            grant_type: "refresh_token",
            refresh_token: active.refreshToken,
            scope: this.#settings.scopes.join(" "),
          }).toString(),
          signal: active.controller.signal,
        }),
        active.controller.signal,
        "Token refresh was cancelled.",
      );
    } catch {
      return false;
    }

    let payload: unknown;
    try {
      payload = await rejectOnAbort(
        response.json(),
        active.controller.signal,
        "Token refresh was cancelled.",
      );
    } catch {
      return false;
    }
    this.#clearRefreshTimeout(active);

    if (!response.ok) {
      if (
        response.status === 400 &&
        isRecord(payload) &&
        normalizedOAuthErrorIdentifier(payload.error) === "invalid_grant"
      ) {
        if (!this.#refreshIdentityIsCurrent(active)) {
          return false;
        }
        this.#setDesiredClear(active.generation);
        try {
          await this.#clearTokens([active.controller.signal], active.generation, () =>
            this.#refreshOperationIsCurrent(active),
          );
        } catch {
          return false;
        }
        if (!this.#refreshOperationIsCurrent(active)) {
          return false;
        }
        this.#setStatus({ state: "unauthenticated" });
      }
      return false;
    }

    let tokens: TokenResponse;
    try {
      const parsed = parseTokenResponse(payload);
      tokens =
        parsed.refresh_token === undefined
          ? { ...parsed, refresh_token: active.refreshToken }
          : parsed;
      if (!this.#refreshIdentityIsCurrent(active)) {
        return false;
      }
      await this.#storeTokens(tokens, [active.controller.signal], active.generation, () =>
        this.#refreshOperationIsCurrent(active),
      );
    } catch {
      return false;
    }
    if (!this.#refreshOperationIsCurrent(active)) {
      return false;
    }
    if (this.#storageReadIsFenced()) {
      if (this.#desiredAccessToken() === undefined) {
        this.#setStatus(this.#reconcileStatus({ state: "unauthenticated" }));
        return false;
      }
      this.#setStatus({ state: "authenticated" });
      return true;
    }
    const accessToken = this.#tokenStore.getAccessToken();
    if (
      accessToken === undefined ||
      accessToken.trim().length === 0 ||
      this.#tokenStore.isAccessTokenExpired(0)
    ) {
      this.#setStatus(this.#reconcileStatus({ state: "unauthenticated" }));
      return false;
    }
    this.#setStatus({ state: "authenticated" });
    return true;
  }

  async #completeLogout(
    capturedLogin: ActiveLogin | undefined,
    capturedRefresh: ActiveRefresh | undefined,
    logoutGeneration: number,
  ): Promise<void> {
    await Promise.all([
      capturedLogin?.settlement.catch(() => undefined),
      capturedRefresh?.settlement.catch(() => false),
    ]);

    if (this.#physicalStorageSlot === undefined) {
      try {
        await this.#clearTokens(
          [],
          logoutGeneration,
          () => this.#logoutInProgress && this.#authGeneration === logoutGeneration,
        );
      } catch {
        throw authenticationError(LOGOUT_FAILURE_MESSAGE);
      }
    }
    if (this.#activeLogin === capturedLogin) {
      this.#activeLogin = undefined;
    }
    if (this.#activeRefresh === capturedRefresh) {
      this.#activeRefresh = undefined;
    }
    this.#setStatus({ state: "unauthenticated" });
  }

  #refreshIdentityIsCurrent(active: ActiveRefresh): boolean {
    return (
      this.#refreshOperationIsCurrent(active) && this.#currentRefreshToken() === active.refreshToken
    );
  }

  #acquirePhysicalStorageSlot(): PhysicalStorageSlot | undefined {
    if (this.#physicalStorageSlot !== undefined) {
      return undefined;
    }
    const slot: PhysicalStorageSlot = { occupied: true };
    this.#physicalStorageSlot = slot;
    return slot;
  }

  #releasePhysicalStorageSlot(slot: PhysicalStorageSlot): void {
    if (this.#physicalStorageSlot !== slot) {
      return;
    }
    this.#physicalStorageSlot = undefined;
    this.#maybeStartReconciliation();
  }

  async #storeTokens(
    tokens: TokenResponse,
    callerSignals: readonly (AbortSignal | undefined)[],
    generation: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    const parsed = Object.freeze({ ...parseTokenResponse(tokens) });
    const snapshot = tokenSnapshot(parsed);
    await this.#runPrimaryStorageMutation(
      "tokens",
      parsed,
      snapshot,
      callerSignals,
      generation,
      isCurrent,
    );
  }

  async #clearTokens(
    callerSignals: readonly (AbortSignal | undefined)[],
    generation: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    await this.#runPrimaryStorageMutation(
      "clear",
      undefined,
      undefined,
      callerSignals,
      generation,
      isCurrent,
    );
  }

  async #runPrimaryStorageMutation(
    kind: "tokens" | "clear",
    tokens: Readonly<TokenResponse> | undefined,
    acceptedSnapshot: Readonly<StoredTokens> | undefined,
    callerSignals: readonly (AbortSignal | undefined)[],
    generation: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    const physicalSlot = this.#acquirePhysicalStorageSlot();
    if (physicalSlot === undefined) {
      throw new StorageMutationCancelledError();
    }
    try {
      this.#materializeDesiredBaseline();
    } catch (error: unknown) {
      this.#releasePhysicalStorageSlot(physicalSlot);
      throw error;
    }
    const record: PrimaryStorageMutation = {
      id: (this.#storageMutationSequence += 1),
      startRevision: this.#desiredAuthState?.revision ?? 0,
      kind,
      accepted: false,
      awaitingFinished: false,
      losing: false,
      rawSettled: false,
      rawRejected: false,
    };
    this.#activePrimaryStorageMutations += 1;
    const managed = createManagedStorageAbort(callerSignals, this.#storageTimeoutMs);
    let operation: Promise<void>;
    try {
      operation =
        kind === "tokens" && tokens !== undefined
          ? this.#tokenStore.store(tokens, { signal: managed.signal })
          : this.#tokenStore.clear({ signal: managed.signal });
    } catch (error: unknown) {
      this.#releasePhysicalStorageSlot(physicalSlot);
      operation = Promise.reject(
        error instanceof Error ? error : new Error("Authentication storage failed."),
      );
    }
    const markRawFulfilled = () => {
      record.rawSettled = true;
      this.#releasePhysicalStorageSlot(physicalSlot);
      this.#reportLosingMutation(record);
    };
    const markRawRejected = () => {
      record.rawSettled = true;
      record.rawRejected = true;
      this.#releasePhysicalStorageSlot(physicalSlot);
      this.#reportLosingMutation(record);
    };
    void operation.then(markRawFulfilled, markRawRejected);

    try {
      await rejectStorageOnAbort(operation, managed.signal);
      if (!isCurrent()) {
        throw new StorageMutationCancelledError();
      }
      record.accepted = true;
      if (kind === "tokens" && acceptedSnapshot !== undefined) {
        this.#setDesiredTokens(generation, acceptedSnapshot);
      }
    } catch (error: unknown) {
      record.losing = true;
      throw error;
    } finally {
      managed.dispose();
      record.awaitingFinished = true;
      this.#activePrimaryStorageMutations -= 1;
      this.#reportLosingMutation(record);
      this.#maybeStartReconciliation();
    }
  }

  #deviceStore(active: ActiveLogin): DeviceCodeTokenStore {
    return {
      store: (tokens, options) =>
        this.#storeTokens(
          tokens,
          [active.controller.signal, options?.signal],
          active.generation,
          () => this.#loginOperationIsCurrent(active),
        ),
    };
  }

  #setDesiredTokens(generation: number, snapshot: Readonly<StoredTokens>): void {
    this.#desiredRevision += 1;
    this.#desiredAuthState = {
      revision: this.#desiredRevision,
      generation,
      kind: "tokens",
      accessToken: snapshot.accessToken,
      ...(snapshot.refreshToken.length === 0 ? {} : { refreshToken: snapshot.refreshToken }),
      expiresAt: snapshot.expiresAt,
      storageSnapshot: Object.freeze({ ...snapshot }),
    };
    this.#requestReconciliation();
  }

  #setDesiredClear(generation: number): void {
    this.#desiredRevision += 1;
    this.#desiredAuthState = {
      revision: this.#desiredRevision,
      generation,
      kind: "clear",
    };
    this.#requestReconciliation();
  }

  #materializeDesiredBaseline(): void {
    if (this.#desiredAuthState !== undefined) {
      return;
    }

    const storedSnapshot = this.#tokenStore.getTokenSnapshot();
    if (
      storedSnapshot !== undefined &&
      storedSnapshot.accessToken.trim().length > 0 &&
      Number.isSafeInteger(storedSnapshot.expiresAt)
    ) {
      this.#desiredRevision += 1;
      this.#desiredAuthState = {
        revision: this.#desiredRevision,
        generation: this.#authGeneration,
        kind: "tokens",
        accessToken: storedSnapshot.accessToken,
        ...(storedSnapshot.refreshToken.trim().length === 0
          ? {}
          : { refreshToken: storedSnapshot.refreshToken }),
        expiresAt: storedSnapshot.expiresAt,
        storageSnapshot: Object.freeze({ ...storedSnapshot }),
      };
      return;
    }

    this.#setDesiredClear(this.#authGeneration);
  }

  #reportLosingMutation(record: PrimaryStorageMutation): void {
    if (record.accepted || !record.awaitingFinished || !record.losing) {
      return;
    }
    const pending = this.#pendingLosingMutations.get(record.id);
    if (pending === undefined) {
      this.#pendingLosingMutations.set(record.id, {
        startRevision: record.startRevision,
        kind: record.kind,
        rawSettled: record.rawSettled,
        rawRejected: record.rawRejected,
      });
    } else if (record.rawSettled) {
      pending.rawSettled = true;
      pending.rawRejected = record.rawRejected;
    }
    if (record.rawSettled) {
      this.#requestReconciliation();
    }
  }

  #requestReconciliation(): void {
    const target = this.#desiredAuthState;
    if (
      target === undefined ||
      ![...this.#pendingLosingMutations.values()].some(
        (mutation) => mutation.rawSettled && this.#mutationConflictsWithTarget(mutation, target),
      )
    ) {
      return;
    }
    this.#reconciliationRequested = true;
    this.#maybeStartReconciliation();
  }

  #maybeStartReconciliation(): void {
    if (
      this.#reconciliationRunning ||
      !this.#reconciliationRequested ||
      this.#physicalStorageSlot !== undefined ||
      this.#activePrimaryStorageMutations > 0 ||
      this.#activeLogin !== undefined ||
      this.#activeRefresh !== undefined ||
      this.#logoutInProgress
    ) {
      return;
    }

    this.#reconciliationRunning = true;
    const reconciliation = this.#runReconciliationLoop();
    void reconciliation.then(
      () => {
        this.#reconciliationRunning = false;
        this.#maybeStartReconciliation();
      },
      () => {
        this.#reconciliationRunning = false;
        this.#maybeStartReconciliation();
      },
    );
  }

  async #runReconciliationLoop(): Promise<void> {
    while (
      this.#reconciliationRequested &&
      this.#physicalStorageSlot === undefined &&
      this.#activePrimaryStorageMutations === 0 &&
      this.#activeLogin === undefined &&
      this.#activeRefresh === undefined &&
      !this.#logoutInProgress
    ) {
      this.#reconciliationRequested = false;
      const target = this.#desiredAuthState;
      if (target === undefined) {
        return;
      }
      const eligibleIds = [...this.#pendingLosingMutations.entries()]
        .filter(
          ([, mutation]) =>
            mutation.rawSettled && this.#mutationConflictsWithTarget(mutation, target),
        )
        .map(([id]) => id);
      if (eligibleIds.length === 0) {
        continue;
      }
      await this.#runReconciliationMutation(target, eligibleIds);
    }
  }

  async #runReconciliationMutation(
    target: DesiredAuthState,
    eligibleIds: readonly number[],
  ): Promise<void> {
    const physicalSlot = this.#acquirePhysicalStorageSlot();
    if (physicalSlot === undefined) {
      this.#reconciliationRequested = true;
      return;
    }
    const managed = createManagedStorageAbort([], this.#storageTimeoutMs);
    const correctionId = (this.#storageMutationSequence += 1);
    let correctionMarkerRegistered = false;
    let rawSettled = false;
    let operation: Promise<void>;
    try {
      if (target.kind === "tokens") {
        operation = this.#tokenStore.storeTokenSnapshot(
          { ...target.storageSnapshot },
          { signal: managed.signal },
        );
      } else {
        operation = this.#tokenStore.clear({ signal: managed.signal });
      }
    } catch (error: unknown) {
      this.#releasePhysicalStorageSlot(physicalSlot);
      operation = Promise.reject(
        error instanceof Error ? error : new Error("Authentication storage failed."),
      );
    }
    const observeFulfillment = () => {
      rawSettled = true;
      const currentTarget = this.#desiredAuthState;
      const newerOperationIsActive =
        this.#activePrimaryStorageMutations > 0 ||
        this.#activeLogin !== undefined ||
        this.#activeRefresh !== undefined ||
        this.#logoutInProgress;
      if (
        currentTarget !== undefined &&
        (currentTarget.revision > target.revision || newerOperationIsActive)
      ) {
        for (const id of eligibleIds) {
          this.#pendingLosingMutations.delete(id);
        }
        this.#pendingLosingMutations.set(correctionId, {
          startRevision: target.revision,
          kind: target.kind,
          rawSettled: true,
          rawRejected: false,
        });
        correctionMarkerRegistered = true;
        this.#requestReconciliation();
        this.#releasePhysicalStorageSlot(physicalSlot);
        return;
      }
      for (const id of eligibleIds) {
        this.#pendingLosingMutations.delete(id);
      }
      if (correctionMarkerRegistered) {
        this.#pendingLosingMutations.delete(correctionId);
      }
      this.#requestReconciliation();
      this.#releasePhysicalStorageSlot(physicalSlot);
    };
    const observeRejection = () => {
      rawSettled = true;
      if (correctionMarkerRegistered) {
        const marker = this.#pendingLosingMutations.get(correctionId);
        if (marker !== undefined) {
          marker.rawSettled = true;
          marker.rawRejected = true;
        }
      }
      this.#releasePhysicalStorageSlot(physicalSlot);
    };
    void operation.then(observeFulfillment, observeRejection);
    try {
      await rejectStorageOnAbort(operation, managed.signal).catch(() => undefined);
    } finally {
      if (!rawSettled) {
        for (const id of eligibleIds) {
          this.#pendingLosingMutations.delete(id);
        }
        this.#pendingLosingMutations.set(correctionId, {
          startRevision: target.revision,
          kind: target.kind,
          rawSettled: false,
          rawRejected: false,
        });
        correctionMarkerRegistered = true;
      }
      managed.dispose();
    }
  }

  #mutationConflictsWithTarget(mutation: PendingLosingMutation, target: DesiredAuthState): boolean {
    if (mutation.startRevision < target.revision) {
      return true;
    }
    if (mutation.startRevision > target.revision) {
      return false;
    }
    return mutation.rawRejected || target.kind === "tokens" || mutation.kind === "tokens";
  }

  #storageReadIsFenced(): boolean {
    const target = this.#desiredAuthState;
    if (target?.kind === "clear") {
      return true;
    }
    return (
      target !== undefined &&
      (this.#physicalStorageSlot !== undefined ||
        this.#activePrimaryStorageMutations > 0 ||
        [...this.#pendingLosingMutations.values()].some((mutation) =>
          this.#mutationConflictsWithTarget(mutation, target),
        ))
    );
  }

  #desiredAccessToken(): string | undefined {
    const target = this.#desiredAuthState;
    if (
      target?.kind !== "tokens" ||
      target.accessToken === undefined ||
      target.expiresAt === undefined ||
      Date.now() >= target.expiresAt
    ) {
      return undefined;
    }
    return target.accessToken;
  }

  #desiredCredentialsAreUsable(): boolean {
    const target = this.#desiredAuthState;
    if (target?.kind !== "tokens") {
      return false;
    }
    return (
      this.#desiredAccessToken() !== undefined ||
      (target.refreshToken !== undefined && target.refreshToken.trim().length > 0)
    );
  }

  #currentRefreshToken(): string | undefined {
    if (this.#storageReadIsFenced()) {
      return this.#desiredAuthState?.kind === "tokens"
        ? this.#desiredAuthState.refreshToken
        : undefined;
    }
    return this.#tokenStore.getRefreshToken();
  }

  #refreshOperationIsCurrent(active: ActiveRefresh): boolean {
    return (
      this.#activeRefresh === active &&
      this.#authGeneration === active.generation &&
      !this.#logoutInProgress &&
      this.#activeLogin === undefined &&
      !active.controller.signal.aborted
    );
  }

  #clearRefreshTimeout(active: ActiveRefresh): void {
    if (active.timeout !== undefined) {
      clearTimeout(active.timeout);
      active.timeout = undefined;
    }
  }

  #loginOperationIsCurrent(active: ActiveLogin): boolean {
    return (
      this.#activeLogin === active &&
      this.#authGeneration === active.generation &&
      !this.#logoutInProgress &&
      !active.controller.signal.aborted
    );
  }

  #throwIfLoginInactive(active: ActiveLogin, message: string): void {
    throwIfAborted(active.controller.signal, message);
    if (!this.#loginOperationIsCurrent(active)) {
      throw authenticationError(message);
    }
  }

  #failureStatus(message: string): LoginStatus {
    return this.#hasUsableStoredCredentials()
      ? { state: "authenticated" }
      : { state: "failed", message };
  }

  #setStatus(status: LoginStatus): void {
    this.#status = freezeStatus(status);
  }

  #statusSnapshot(): LoginStatus {
    return freezeStatus(this.#status);
  }

  #reconcileStatus(status: LoginStatus): LoginStatus {
    if (status.state === "pending") {
      return status;
    }
    if (this.#desiredAuthState?.kind === "clear") {
      return status.state === "failed" ? status : { state: "unauthenticated" };
    }
    if (this.#storageReadIsFenced()) {
      return this.#desiredCredentialsAreUsable()
        ? { state: "authenticated" }
        : status.state === "failed"
          ? status
          : { state: "unauthenticated" };
    }
    if (this.#hasUsableStoredCredentials()) {
      return { state: "authenticated" };
    }
    return status.state === "failed" ? status : { state: "unauthenticated" };
  }

  #hasUsableStoredCredentials(): boolean {
    if (this.#desiredAuthState?.kind === "clear") {
      return false;
    }
    if (this.#storageReadIsFenced()) {
      return this.#desiredCredentialsAreUsable();
    }
    try {
      if (this.#tokenStore.isAuthenticated()) {
        return true;
      }
      const accessToken = this.#tokenStore.getAccessToken();
      return (
        accessToken !== undefined &&
        accessToken.trim().length > 0 &&
        !this.#tokenStore.isAccessTokenExpired(0)
      );
    } catch {
      return false;
    }
  }

  #requireClientId(): void {
    if (this.#settings.azureClientId.trim().length === 0) {
      throw authenticationError(SETUP_MESSAGE);
    }
  }

  #clearActive(active: ActiveLogin): void {
    if (this.#activeLogin === active) {
      this.#activeLogin = undefined;
    }
    this.#maybeStartReconciliation();
  }
}
