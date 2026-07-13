import { AuthenticationError } from "../errors.js";
import { parseTokenResponse, type TokenResponse, type TokenStore } from "../token-store.js";
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
  store: AuthManagerTokenStore,
  dependencies?: DeviceCodeLoginDependencies,
) => Promise<DeviceCodeLoginSession>;

export interface AuthManagerDependencies {
  readonly runBrowserLogin?: BrowserLoginRunner;
  readonly startDeviceCodeLogin?: DeviceCodeLoginStarter;
  readonly fetch?: OAuthFetch;
  readonly refreshTimeoutMs?: number;
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

class InternalAuthenticationError extends AuthenticationError {}

function freezeStatus(status: LoginStatus): LoginStatus {
  return Object.freeze({ ...status });
}

function authenticationError(message: string): AuthenticationError {
  return new InternalAuthenticationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  #status: LoginStatus;
  #activeLogin: ActiveLogin | undefined;
  #activeRefresh: ActiveRefresh | undefined;
  #authGeneration = 0;
  #logoutInProgress = false;
  #logoutPromise: Promise<void> | undefined;

  constructor(
    settings: AuthManagerSettings,
    tokenStore: AuthManagerTokenStore,
    dependencies: AuthManagerDependencies = {},
  ) {
    this.#settings = settings;
    this.#tokenStore = tokenStore;
    this.#usesDefaultBrowserLogin = dependencies.runBrowserLogin === undefined;
    this.#usesDefaultDeviceCodeLogin = dependencies.startDeviceCodeLogin === undefined;
    this.#runBrowserLogin = dependencies.runBrowserLogin ?? runBrowserLogin;
    this.#startDeviceCodeLogin = dependencies.startDeviceCodeLogin ?? startDeviceCodeLogin;
    this.#fetch = dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#refreshTimeoutMs = dependencies.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#refreshTimeoutMs) || this.#refreshTimeoutMs <= 0) {
      throw new Error("Refresh timeout must be a positive safe integer.");
    }
    this.#status = freezeStatus(
      tokenStore.isAuthenticated() ? { state: "authenticated" } : { state: "unauthenticated" },
    );
  }

  getStatus(): LoginStatus {
    this.#setStatus(this.#reconcileStatus(this.#status));
    return this.#statusSnapshot();
  }

  async login(method: LoginMethod = "browser"): Promise<LoginStatus> {
    this.#requireClientId();
    if (this.#logoutInProgress) {
      throw authenticationError(LOGOUT_IN_PROGRESS_MESSAGE);
    }
    if (this.#activeLogin !== undefined) {
      throw authenticationError(LOGIN_COLLISION_MESSAGE);
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

    const refreshToken = this.#tokenStore.getRefreshToken();
    if (refreshToken === undefined || refreshToken.length === 0) {
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
    active.timeout = setTimeout(() => active.controller.abort(), this.#refreshTimeoutMs);
    active.timeout.unref?.();
    this.#activeRefresh = active;
    const refreshPromise = this.#performRefresh(active).finally(() => {
      this.#clearRefreshTimeout(active);
      if (this.#activeRefresh === active) {
        this.#activeRefresh = undefined;
      }
    });
    active.settlement = refreshPromise;
    return refreshPromise;
  }

  async getValidAccessToken(): Promise<string> {
    const accessToken = this.#tokenStore.getAccessToken();
    if (
      accessToken !== undefined &&
      accessToken.trim().length > 0 &&
      !this.#tokenStore.isAccessTokenExpired()
    ) {
      return accessToken;
    }

    const refreshed = await this.refreshAccessToken();
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
    const capturedLogin = this.#activeLogin;
    const capturedRefresh = this.#activeRefresh;
    capturedLogin?.controller.abort();
    capturedRefresh?.controller.abort();

    const logoutPromise = this.#completeLogout(capturedLogin, capturedRefresh).finally(() => {
      if (this.#logoutPromise === logoutPromise) {
        this.#logoutPromise = undefined;
        this.#logoutInProgress = false;
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
        await this.#tokenStore.store(tokens);
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
        this.#startDeviceCodeLogin(this.#settings, this.#tokenStore, {
          signal: active.controller.signal,
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
      await session.poll();
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
      if (response.status < 500 && isRecord(payload) && payload.error === "invalid_grant") {
        if (!this.#refreshIdentityIsCurrent(active)) {
          return false;
        }
        try {
          await this.#tokenStore.clear();
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
      await this.#tokenStore.store(tokens);
    } catch {
      return false;
    }
    if (!this.#refreshOperationIsCurrent(active)) {
      return false;
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
  ): Promise<void> {
    await Promise.all([
      capturedLogin?.settlement.catch(() => undefined),
      capturedRefresh?.settlement.catch(() => false),
    ]);

    try {
      await this.#tokenStore.clear();
    } catch {
      throw authenticationError(LOGOUT_FAILURE_MESSAGE);
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
      this.#refreshOperationIsCurrent(active) &&
      this.#tokenStore.getRefreshToken() === active.refreshToken
    );
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

  #throwIfLoginInactive(active: ActiveLogin, message: string): void {
    throwIfAborted(active.controller.signal, message);
    if (
      this.#activeLogin !== active ||
      this.#authGeneration !== active.generation ||
      this.#logoutInProgress
    ) {
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
    if (this.#hasUsableStoredCredentials()) {
      return { state: "authenticated" };
    }
    return status.state === "failed" ? status : { state: "unauthenticated" };
  }

  #hasUsableStoredCredentials(): boolean {
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
  }
}
