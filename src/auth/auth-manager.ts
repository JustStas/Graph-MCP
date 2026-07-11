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

export type LoginStatus =
  | { state: "unauthenticated" }
  | {
      state: "pending";
      method: "device_code";
      userCode: string;
      verificationUri: string;
      expiresAt: number;
      message: string;
    }
  | { state: "authenticated" }
  | { state: "failed"; message: string };

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
}

interface ActiveLogin {
  readonly controller: AbortController;
  settlement: Promise<void>;
}

function authenticationError(message: string): AuthenticationError {
  return new AuthenticationError(message);
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
    const onAbort = () => reject(authenticationError(message));
    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("Authentication operation failed."));
      },
    );
  });
}

function browserFailure(error: unknown, signal: AbortSignal): AuthenticationError {
  if (signal.aborted) {
    return authenticationError(BROWSER_CANCELLED_MESSAGE);
  }
  if (error instanceof AuthenticationError) {
    return error;
  }
  return authenticationError(BROWSER_FAILURE_MESSAGE);
}

function deviceStartFailure(error: unknown, signal: AbortSignal): AuthenticationError {
  if (signal.aborted) {
    return authenticationError(DEVICE_CANCELLED_MESSAGE);
  }
  if (error instanceof AuthenticationError) {
    return error;
  }
  return authenticationError(DEVICE_START_FAILURE_MESSAGE);
}

function devicePollingFailure(error: unknown, signal: AbortSignal): AuthenticationError {
  if (signal.aborted) {
    return authenticationError(DEVICE_CANCELLED_MESSAGE);
  }
  if (error instanceof AuthenticationError) {
    return error;
  }
  return authenticationError(DEVICE_FAILURE_MESSAGE);
}

export class AuthManager {
  readonly #settings: AuthManagerSettings;
  readonly #tokenStore: AuthManagerTokenStore;
  readonly #runBrowserLogin: BrowserLoginRunner;
  readonly #startDeviceCodeLogin: DeviceCodeLoginStarter;
  readonly #fetch: OAuthFetch;
  #status: LoginStatus;
  #activeLogin: ActiveLogin | undefined;
  #refreshPromise: Promise<boolean> | undefined;

  constructor(
    settings: AuthManagerSettings,
    tokenStore: AuthManagerTokenStore,
    dependencies: AuthManagerDependencies = {},
  ) {
    this.#settings = settings;
    this.#tokenStore = tokenStore;
    this.#runBrowserLogin = dependencies.runBrowserLogin ?? runBrowserLogin;
    this.#startDeviceCodeLogin = dependencies.startDeviceCodeLogin ?? startDeviceCodeLogin;
    this.#fetch = dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#status = tokenStore.isAuthenticated()
      ? { state: "authenticated" }
      : { state: "unauthenticated" };
  }

  getStatus(): LoginStatus {
    return this.#status;
  }

  async login(method: LoginMethod = "browser"): Promise<LoginStatus> {
    this.#requireClientId();
    if (this.#activeLogin !== undefined) {
      throw authenticationError(LOGIN_COLLISION_MESSAGE);
    }

    const active: ActiveLogin = {
      controller: new AbortController(),
      settlement: Promise.resolve(),
    };
    this.#activeLogin = active;

    if (method === "device_code") {
      const startup = this.#startDeviceLogin(active);
      active.settlement = startup.then(
        () => undefined,
        () => undefined,
      );
      return await startup;
    }

    const browser = this.#completeBrowserLogin(active);
    active.settlement = browser.then(
      () => undefined,
      () => undefined,
    );
    return await browser;
  }

  refreshAccessToken(): Promise<boolean> {
    if (this.#refreshPromise !== undefined) {
      return this.#refreshPromise;
    }

    const refreshPromise = this.#performRefresh().finally(() => {
      if (this.#refreshPromise === refreshPromise) {
        this.#refreshPromise = undefined;
      }
    });
    this.#refreshPromise = refreshPromise;
    return refreshPromise;
  }

  async getValidAccessToken(): Promise<string> {
    const accessToken = this.#tokenStore.getAccessToken();
    if (accessToken !== undefined && !this.#tokenStore.isAccessTokenExpired()) {
      return accessToken;
    }

    const refreshed = await this.refreshAccessToken();
    const refreshedAccessToken = this.#tokenStore.getAccessToken();
    if (refreshed && refreshedAccessToken !== undefined) {
      return refreshedAccessToken;
    }
    throw authenticationError(LOGIN_REQUIRED_MESSAGE);
  }

  async logout(): Promise<void> {
    const active = this.#activeLogin;
    active?.controller.abort();
    await active?.settlement.catch(() => undefined);
    await this.#refreshPromise?.catch(() => undefined);

    try {
      await this.#tokenStore.clear();
    } catch {
      throw authenticationError(LOGOUT_FAILURE_MESSAGE);
    }
    this.#activeLogin = undefined;
    this.#status = { state: "unauthenticated" };
  }

  async #completeBrowserLogin(active: ActiveLogin): Promise<LoginStatus> {
    try {
      const tokens = await rejectOnAbort(
        this.#runBrowserLogin(this.#settings, { signal: active.controller.signal }),
        active.controller.signal,
        BROWSER_CANCELLED_MESSAGE,
      );
      throwIfAborted(active.controller.signal, BROWSER_CANCELLED_MESSAGE);
      try {
        await rejectOnAbort(
          this.#tokenStore.store(tokens),
          active.controller.signal,
          BROWSER_CANCELLED_MESSAGE,
        );
      } catch (error: unknown) {
        if (active.controller.signal.aborted) {
          throw authenticationError(BROWSER_CANCELLED_MESSAGE);
        }
        if (error instanceof AuthenticationError) {
          throw error;
        }
        throw authenticationError(STORE_FAILURE_MESSAGE);
      }
      throwIfAborted(active.controller.signal, BROWSER_CANCELLED_MESSAGE);
      this.#status = { state: "authenticated" };
      return this.#status;
    } catch (error: unknown) {
      const failure = browserFailure(error, active.controller.signal);
      this.#status = { state: "failed", message: failure.message };
      throw failure;
    } finally {
      this.#clearActive(active);
    }
  }

  async #startDeviceLogin(active: ActiveLogin): Promise<LoginStatus> {
    let session: DeviceCodeLoginSession;
    try {
      session = await rejectOnAbort(
        this.#startDeviceCodeLogin(this.#settings, this.#tokenStore, {
          signal: active.controller.signal,
        }),
        active.controller.signal,
        DEVICE_CANCELLED_MESSAGE,
      );
      throwIfAborted(active.controller.signal, DEVICE_CANCELLED_MESSAGE);
    } catch (error: unknown) {
      const failure = deviceStartFailure(error, active.controller.signal);
      this.#status = { state: "failed", message: failure.message };
      this.#clearActive(active);
      throw failure;
    }

    this.#status = {
      state: "pending",
      method: "device_code",
      ...session.details,
    };
    const background = this.#completeDeviceLogin(active, session);
    active.settlement = background;
    void background.catch(() => undefined);
    return this.#status;
  }

  async #completeDeviceLogin(active: ActiveLogin, session: DeviceCodeLoginSession): Promise<void> {
    try {
      await rejectOnAbort(session.poll(), active.controller.signal, DEVICE_CANCELLED_MESSAGE);
      throwIfAborted(active.controller.signal, DEVICE_CANCELLED_MESSAGE);
      this.#status = { state: "authenticated" };
    } catch (error: unknown) {
      const failure = devicePollingFailure(error, active.controller.signal);
      this.#status = { state: "failed", message: failure.message };
    } finally {
      this.#clearActive(active);
    }
  }

  async #performRefresh(): Promise<boolean> {
    const refreshToken = this.#tokenStore.getRefreshToken();
    if (refreshToken === undefined || refreshToken.length === 0) {
      return false;
    }
    this.#requireClientId();

    let response: OAuthResponse;
    try {
      response = await this.#fetch(this.#settings.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.#settings.azureClientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: this.#settings.scopes.join(" "),
        }).toString(),
      });
    } catch {
      return false;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return false;
    }

    if (!response.ok) {
      if (response.status < 500 && isRecord(payload) && payload.error === "invalid_grant") {
        try {
          await this.#tokenStore.clear();
        } catch {
          return false;
        }
        this.#status = { state: "unauthenticated" };
      }
      return false;
    }

    let tokens: TokenResponse;
    try {
      const parsed = parseTokenResponse(payload);
      tokens =
        parsed.refresh_token === undefined ? { ...parsed, refresh_token: refreshToken } : parsed;
      await this.#tokenStore.store(tokens);
    } catch {
      return false;
    }
    this.#status = { state: "authenticated" };
    return true;
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
