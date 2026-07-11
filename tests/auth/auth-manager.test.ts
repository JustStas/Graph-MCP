import { describe, expect, test, vi } from "vitest";

import { AuthenticationError } from "../../src/errors.js";
import type { TokenResponse } from "../../src/token-store.js";
import {
  AuthManager,
  type AuthManagerSettings,
  type BrowserLoginRunner,
  type DeviceCodeLoginStarter,
  type LoginStatus,
  type OAuthFetch,
} from "../../src/auth/auth-manager.js";

const settings: AuthManagerSettings = {
  azureClientId: "client-id",
  authority: "https://login.microsoftonline.com/tenant",
  authorizeEndpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize",
  graphRedirectUri: "http://127.0.0.1:4567/auth/callback",
  tokenEndpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
  scopes: ["openid", "profile", "User.Read"],
};

const deviceDetails = {
  userCode: "ABCD-EFGH",
  verificationUri: "https://microsoft.com/devicelogin",
  expiresAt: 910_000,
  message: "Open the verification page and enter the code.",
} as const;

const setupMessage = "AZURE_CLIENT_ID is not configured. Run 'graph-mcp setup' first.";
const loginRequiredMessage = "Not authenticated. Please log in first.";

function deferred<Value>() {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(() => Promise.resolve(body)),
  };
}

class MemoryTokenStore {
  accessToken: string | undefined;
  refreshToken: string | undefined;
  expired = true;

  readonly store = vi.fn((tokens: TokenResponse) => {
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token ?? this.refreshToken;
    this.expired = false;
    return Promise.resolve();
  });

  readonly clear = vi.fn(() => {
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.expired = true;
    return Promise.resolve();
  });

  getAccessToken(): string | undefined {
    return this.accessToken;
  }

  getRefreshToken(): string | undefined {
    return this.refreshToken;
  }

  isAccessTokenExpired(): boolean {
    return this.expired;
  }

  isAuthenticated(): boolean {
    return Boolean((this.accessToken !== undefined && !this.expired) || this.refreshToken);
  }
}

function expectStatus(manager: AuthManager, expected: LoginStatus): void {
  expect(manager.getStatus()).toEqual(expected);
}

describe("AuthManager login", () => {
  test("uses browser login by default, stores tokens, and becomes authenticated", async () => {
    const store = new MemoryTokenStore();
    const runBrowserLogin = vi.fn<BrowserLoginRunner>((_settings, dependencies) => {
      expect(_settings).toBe(settings);
      expect(dependencies?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve({
        access_token: "browser-access",
        refresh_token: "browser-refresh",
        expires_in: 3600,
      });
    });
    const manager = new AuthManager(settings, store, { runBrowserLogin });

    const result = await manager.login();

    expect(result).toEqual({ state: "authenticated" });
    expect(runBrowserLogin).toHaveBeenCalledTimes(1);
    expect(store.store).toHaveBeenCalledWith({
      access_token: "browser-access",
      refresh_token: "browser-refresh",
      expires_in: 3600,
    });
    expectStatus(manager, { state: "authenticated" });
  });

  test("returns device instructions immediately, reports pending, then becomes authenticated", async () => {
    const store = new MemoryTokenStore();
    const polling = deferred<void>();
    const poll = vi.fn(async () => {
      await polling.promise;
      await store.store({
        access_token: "device-access",
        refresh_token: "device-refresh",
        expires_in: 3600,
      });
    });
    const startDeviceCodeLogin = vi.fn<DeviceCodeLoginStarter>(
      (_settings, receivedStore, dependencies) => {
        expect(_settings).toBe(settings);
        expect(receivedStore).toBe(store);
        expect(dependencies?.signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve({ details: deviceDetails, poll });
      },
    );
    const manager = new AuthManager(settings, store, { startDeviceCodeLogin });

    const result = await manager.login("device_code");

    expect(result).toEqual({ state: "pending", method: "device_code", ...deviceDetails });
    expectStatus(manager, { state: "pending", method: "device_code", ...deviceDetails });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(store.store).not.toHaveBeenCalled();

    polling.resolve();
    await flushAsync();

    expectStatus(manager, { state: "authenticated" });
    expect(store.store).toHaveBeenCalledTimes(1);
  });

  test("contains background device failures and exposes a sanitized failed status", async () => {
    const store = new MemoryTokenStore();
    const startDeviceCodeLogin = vi.fn<DeviceCodeLoginStarter>(() =>
      Promise.resolve({
        details: deviceDetails,
        poll: () => Promise.reject(new Error("network private-device-code access-secret")),
      }),
    );
    const manager = new AuthManager(settings, store, { startDeviceCodeLogin });

    await manager.login("device_code");
    await flushAsync();

    expectStatus(manager, { state: "failed", message: "Device-code login failed." });
  });

  test("rejects browser and device collisions while either login is active", async () => {
    const store = new MemoryTokenStore();
    const browser = deferred<TokenResponse>();
    const runBrowserLogin = vi.fn<BrowserLoginRunner>((_settings, dependencies) => {
      dependencies?.signal?.addEventListener(
        "abort",
        () => browser.reject(new AuthenticationError("Login timed out or was cancelled.")),
        { once: true },
      );
      return browser.promise;
    });
    const manager = new AuthManager(settings, store, { runBrowserLogin });
    const browserLogin = manager.login();

    await expect(manager.login("device_code")).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "An authentication login is already in progress.",
    });

    const logout = manager.logout();
    await expect(browserLogin).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "Login timed out or was cancelled.",
    });
    await logout;

    const devicePolling = deferred<void>();
    const deviceManager = new AuthManager(settings, store, {
      startDeviceCodeLogin: () =>
        Promise.resolve({ details: deviceDetails, poll: () => devicePolling.promise }),
    });
    await deviceManager.login("device_code");

    await expect(deviceManager.login()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "An authentication login is already in progress.",
    });
    devicePolling.resolve();
    await flushAsync();
  });

  test("uses the actionable setup message when the client ID is missing", async () => {
    const runBrowserLogin = vi.fn();
    const manager = new AuthManager({ ...settings, azureClientId: "" }, new MemoryTokenStore(), {
      runBrowserLogin,
    });

    await expect(manager.login()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: setupMessage,
    });
    expect(runBrowserLogin).not.toHaveBeenCalled();
  });
});

describe("AuthManager refresh and access tokens", () => {
  test("single-flights refresh and posts the exact form before storing valid tokens", async () => {
    const store = new MemoryTokenStore();
    store.accessToken = "expired-access";
    store.refreshToken = "refresh-secret";
    store.expired = true;
    const tokenResponse = deferred<ReturnType<typeof response>>();
    const fetch = vi.fn<OAuthFetch>(() => tokenResponse.promise);
    const manager = new AuthManager(settings, store, { fetch });

    const first = manager.refreshAccessToken();
    const second = manager.refreshAccessToken();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetch.mock.calls[0]!;
    expect(endpoint).toBe(settings.tokenEndpoint);
    expect(init).toEqual({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=client-id&grant_type=refresh_token&refresh_token=refresh-secret&scope=openid+profile+User.Read",
    });

    tokenResponse.resolve(
      response(200, {
        access_token: "refreshed-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(store.store).toHaveBeenCalledTimes(1);
    expectStatus(manager, { state: "authenticated" });
  });

  test("invalid_grant clears tokens while malformed, network, and server failures leave them", async () => {
    const invalidStore = new MemoryTokenStore();
    invalidStore.accessToken = "expired-access";
    invalidStore.refreshToken = "invalid-refresh";
    invalidStore.expired = true;
    const invalidManager = new AuthManager(settings, invalidStore, {
      fetch: vi.fn(() =>
        Promise.resolve(
          response(400, {
            error: "invalid_grant",
            error_description: "private invalid-refresh access-secret",
          }),
        ),
      ),
    });

    await expect(invalidManager.refreshAccessToken()).resolves.toBe(false);
    expect(invalidStore.clear).toHaveBeenCalledTimes(1);
    expect(invalidStore.getRefreshToken()).toBeUndefined();
    expectStatus(invalidManager, { state: "unauthenticated" });

    const transientCases = [
      vi.fn(() => Promise.reject(new Error("network invalid-refresh access-secret"))),
      vi.fn(() =>
        Promise.resolve(
          response(503, {
            error: "invalid_grant",
            error_description: "server private invalid-refresh",
          }),
        ),
      ),
      vi.fn(() => Promise.resolve(response(200, { access_token: "" }))),
    ];

    for (const fetch of transientCases) {
      const store = new MemoryTokenStore();
      store.accessToken = "expired-access";
      store.refreshToken = "keep-refresh";
      store.expired = true;
      const manager = new AuthManager(settings, store, { fetch });

      await expect(manager.refreshAccessToken()).resolves.toBe(false);
      expect(store.clear).not.toHaveBeenCalled();
      expect(store.getRefreshToken()).toBe("keep-refresh");
    }
  });

  test("returns a current token, refreshes an expired token, and otherwise requires login", async () => {
    const currentStore = new MemoryTokenStore();
    currentStore.accessToken = "current-access";
    currentStore.expired = false;
    const currentFetch = vi.fn();
    const currentManager = new AuthManager(settings, currentStore, { fetch: currentFetch });

    await expect(currentManager.getValidAccessToken()).resolves.toBe("current-access");
    expect(currentFetch).not.toHaveBeenCalled();

    const expiredStore = new MemoryTokenStore();
    expiredStore.accessToken = "expired-access";
    expiredStore.refreshToken = "refresh-secret";
    expiredStore.expired = true;
    const expiredManager = new AuthManager(settings, expiredStore, {
      fetch: vi.fn(() =>
        Promise.resolve(
          response(200, {
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
        ),
      ),
    });

    await expect(expiredManager.getValidAccessToken()).resolves.toBe("new-access");

    const missingManager = new AuthManager(settings, new MemoryTokenStore());
    await expect(missingManager.getValidAccessToken()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: loginRequiredMessage,
    });
  });

  test("uses the actionable setup message when refresh needs a missing client ID", async () => {
    const store = new MemoryTokenStore();
    store.refreshToken = "refresh-secret";
    const fetch = vi.fn();
    const manager = new AuthManager({ ...settings, azureClientId: "" }, store, { fetch });

    await expect(manager.refreshAccessToken()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: setupMessage,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("AuthManager logout", () => {
  test("aborts device polling, contains its settlement, clears storage, and becomes unauthenticated", async () => {
    const store = new MemoryTokenStore();
    let pollingSignal: AbortSignal | undefined;
    const poll = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          pollingSignal?.addEventListener(
            "abort",
            () => reject(new Error("private-device-code access-secret")),
            { once: true },
          );
        }),
    );
    const manager = new AuthManager(settings, store, {
      startDeviceCodeLogin: (_settings, _store, dependencies) => {
        pollingSignal = dependencies?.signal;
        return Promise.resolve({ details: deviceDetails, poll });
      },
    });
    await manager.login("device_code");

    await manager.logout();

    expect(pollingSignal?.aborted).toBe(true);
    expect(store.clear).toHaveBeenCalledTimes(1);
    expectStatus(manager, { state: "unauthenticated" });
  });

  test("aborts an active browser login before clearing storage", async () => {
    const store = new MemoryTokenStore();
    let browserSignal: AbortSignal | undefined;
    const runBrowserLogin = vi.fn<BrowserLoginRunner>((_settings, dependencies) => {
      browserSignal = dependencies?.signal;
      return new Promise<TokenResponse>((_resolve, reject) => {
        browserSignal?.addEventListener(
          "abort",
          () => reject(new AuthenticationError("Login timed out or was cancelled.")),
          { once: true },
        );
      });
    });
    const manager = new AuthManager(settings, store, { runBrowserLogin });
    const login = manager.login();

    const logout = manager.logout();
    await expect(login).rejects.toBeInstanceOf(AuthenticationError);
    await logout;

    expect(browserSignal?.aborted).toBe(true);
    expect(store.clear).toHaveBeenCalledTimes(1);
    expectStatus(manager, { state: "unauthenticated" });
  });
});
