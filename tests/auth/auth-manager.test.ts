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

function settlesPromptly<Value>(promise: Promise<Value>, timeoutMs = 250): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Operation did not settle promptly.")),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("Operation failed."));
      },
    );
  });
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
  actuallyExpired = true;

  readonly store = vi.fn((tokens: TokenResponse) => {
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token ?? this.refreshToken;
    this.expired = false;
    this.actuallyExpired = false;
    return Promise.resolve();
  });

  readonly clear = vi.fn(() => {
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.expired = true;
    this.actuallyExpired = true;
    return Promise.resolve();
  });

  getAccessToken(): string | undefined {
    return this.accessToken;
  }

  getRefreshToken(): string | undefined {
    return this.refreshToken;
  }

  readonly isAccessTokenExpired = vi.fn((bufferSeconds?: number) =>
    bufferSeconds === 0 ? this.actuallyExpired : this.expired,
  );

  isAuthenticated(): boolean {
    return Boolean((this.accessToken !== undefined && !this.actuallyExpired) || this.refreshToken);
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

  test("sanitizes AuthenticationError values from injected login dependencies", async () => {
    const browserManager = new AuthManager(settings, new MemoryTokenStore(), {
      runBrowserLogin: () =>
        Promise.reject(new AuthenticationError("browser private authorization-code access-secret")),
    });
    await expect(browserManager.login()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "Browser login failed.",
    });

    const store = new MemoryTokenStore();
    store.store.mockRejectedValueOnce(
      new AuthenticationError("store private refresh-secret access-secret"),
    );
    const storeManager = new AuthManager(settings, store, {
      runBrowserLogin: () => Promise.resolve({ access_token: "access-secret" }),
    });
    await expect(storeManager.login()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "Unable to store authentication tokens.",
    });

    const starterManager = new AuthManager(settings, new MemoryTokenStore(), {
      startDeviceCodeLogin: () =>
        Promise.reject(new AuthenticationError("starter private-device-code access-secret")),
    });
    await expect(starterManager.login("device_code")).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "Unable to start device-code login.",
    });

    const pollingManager = new AuthManager(settings, new MemoryTokenStore(), {
      startDeviceCodeLogin: () =>
        Promise.resolve({
          details: deviceDetails,
          poll: () =>
            Promise.reject(new AuthenticationError("poll private-device-code access-secret")),
        }),
    });
    await pollingManager.login("device_code");
    await flushAsync();
    expectStatus(pollingManager, {
      state: "failed",
      message: "Device-code login failed.",
    });
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
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=client-id&grant_type=refresh_token&refresh_token=refresh-secret&scope=openid+profile+User.Read",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);

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

  test("preserves an omitted refresh token and rejects an explicitly blank one", async () => {
    const omittedStore = new MemoryTokenStore();
    omittedStore.accessToken = "expired-access";
    omittedStore.refreshToken = "captured-refresh";
    omittedStore.expired = true;
    omittedStore.actuallyExpired = true;
    const omittedManager = new AuthManager(settings, omittedStore, {
      fetch: () =>
        Promise.resolve(
          response(200, {
            access_token: "new-access",
            expires_in: 3600,
          }),
        ),
    });

    await expect(omittedManager.refreshAccessToken()).resolves.toBe(true);
    expect(omittedStore.store).toHaveBeenCalledWith({
      access_token: "new-access",
      refresh_token: "captured-refresh",
      expires_in: 3600,
    });
    expect(omittedStore.getRefreshToken()).toBe("captured-refresh");

    const blankStore = new MemoryTokenStore();
    blankStore.accessToken = "expired-access";
    blankStore.refreshToken = "keep-refresh";
    blankStore.expired = true;
    blankStore.actuallyExpired = true;
    const blankManager = new AuthManager(settings, blankStore, {
      fetch: () =>
        Promise.resolve(
          response(200, {
            access_token: "must-not-store",
            refresh_token: "   ",
            expires_in: 3600,
          }),
        ),
    });

    await expect(blankManager.refreshAccessToken()).resolves.toBe(false);
    expect(blankStore.store).not.toHaveBeenCalled();
    expect(blankStore.getAccessToken()).toBe("expired-access");
    expect(blankStore.getRefreshToken()).toBe("keep-refresh");
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
    expectStatus(missingManager, { state: "unauthenticated" });
  });

  test("accepts a freshly stored short-lived token using an actual-expiry check", async () => {
    const store = new MemoryTokenStore();
    store.accessToken = "expired-access";
    store.refreshToken = "refresh-secret";
    store.expired = true;
    store.actuallyExpired = true;
    store.store.mockImplementationOnce((tokens) => {
      store.accessToken = tokens.access_token;
      store.refreshToken = tokens.refresh_token ?? store.refreshToken;
      store.expired = true;
      store.actuallyExpired = false;
      return Promise.resolve();
    });
    const manager = new AuthManager(settings, store, {
      fetch: () =>
        Promise.resolve(
          response(200, {
            access_token: "short-lived-access",
            expires_in: 30,
          }),
        ),
    });

    await expect(manager.refreshAccessToken()).resolves.toBe(true);
    await expect(manager.getValidAccessToken()).resolves.toBe("short-lived-access");
    expect(store.isAccessTokenExpired).toHaveBeenCalledWith(0);
    expectStatus(manager, { state: "authenticated" });
  });

  test.each(["missing", "expired"] as const)(
    "rejects refresh success when the stored access token is %s",
    async (condition) => {
      const store = new MemoryTokenStore();
      store.refreshToken = "refresh-secret";
      store.store.mockImplementation((tokens) => {
        store.accessToken = condition === "missing" ? undefined : tokens.access_token;
        store.refreshToken = tokens.refresh_token ?? store.refreshToken;
        store.expired = true;
        store.actuallyExpired = true;
        return Promise.resolve();
      });
      const manager = new AuthManager(settings, store, {
        fetch: () =>
          Promise.resolve(
            response(200, {
              access_token: "unusable-access",
              expires_in: 1,
            }),
          ),
      });

      await expect(manager.refreshAccessToken()).resolves.toBe(false);
      await expect(manager.getValidAccessToken()).rejects.toMatchObject({
        name: "AuthenticationError",
        message: loginRequiredMessage,
      });
      if (condition === "expired") {
        expect(store.isAccessTokenExpired).toHaveBeenCalledWith(0);
      }
    },
  );

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

  test("starting browser login aborts and fences an older invalid_grant refresh", async () => {
    const store = new MemoryTokenStore();
    store.accessToken = "old-expired-access";
    store.refreshToken = "old-refresh";
    store.expired = true;
    const oldRefreshResponse = deferred<ReturnType<typeof response>>();
    let refreshSignal: AbortSignal | undefined;
    const fetch = vi.fn<OAuthFetch>((_input, init) => {
      refreshSignal = init.signal ?? undefined;
      return oldRefreshResponse.promise;
    });
    const runBrowserLogin = vi.fn<BrowserLoginRunner>(() =>
      Promise.resolve({
        access_token: "new-browser-access",
        refresh_token: "new-browser-refresh",
        expires_in: 3600,
      }),
    );
    const manager = new AuthManager(settings, store, { fetch, runBrowserLogin });

    const oldRefresh = manager.refreshAccessToken();
    await manager.login();

    expect(refreshSignal?.aborted).toBe(true);
    expect(store.getAccessToken()).toBe("new-browser-access");
    expect(store.getRefreshToken()).toBe("new-browser-refresh");

    oldRefreshResponse.resolve(
      response(400, {
        error: "invalid_grant",
        error_description: "old-refresh private access-secret",
      }),
    );
    await expect(oldRefresh).resolves.toBe(false);
    await flushAsync();

    expect(store.clear).not.toHaveBeenCalled();
    expect(store.getAccessToken()).toBe("new-browser-access");
    expect(store.getRefreshToken()).toBe("new-browser-refresh");
  });

  test("rejects refresh while a login is active", async () => {
    const store = new MemoryTokenStore();
    store.refreshToken = "refresh-secret";
    const browser = deferred<TokenResponse>();
    const manager = new AuthManager(settings, store, {
      runBrowserLogin: () => browser.promise,
    });
    const login = manager.login();

    await expect(manager.refreshAccessToken()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "An authentication login is already in progress.",
    });

    const logout = manager.logout();
    browser.reject(new AuthenticationError("private browser error access-secret"));
    await expect(login).rejects.toBeInstanceOf(AuthenticationError);
    await logout;
  });

  test.each(["fetch", "json"] as const)(
    "bounds refresh when injected %s ignores cancellation",
    async (stage) => {
      const store = new MemoryTokenStore();
      store.accessToken = "expired-access";
      store.refreshToken = "refresh-secret";
      store.expired = true;
      let refreshSignal: AbortSignal | undefined;
      const fetch = vi.fn<OAuthFetch>((_input, init) => {
        refreshSignal = init.signal ?? undefined;
        if (stage === "fetch") {
          return new Promise<ReturnType<typeof response>>(() => undefined);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => new Promise<unknown>(() => undefined),
        });
      });
      const manager = new AuthManager(settings, store, {
        fetch,
        refreshTimeoutMs: 10,
      });

      await expect(settlesPromptly(manager.refreshAccessToken())).resolves.toBe(false);

      expect(refreshSignal?.aborted).toBe(true);
      expect(store.store).not.toHaveBeenCalled();
      expect(store.clear).not.toHaveBeenCalled();
    },
  );
});

describe("AuthManager logout", () => {
  test("aborts an ignored refresh and prevents it from restoring credentials after logout", async () => {
    const store = new MemoryTokenStore();
    store.accessToken = "expired-access";
    store.refreshToken = "refresh-secret";
    store.expired = true;
    const refreshResponse = deferred<ReturnType<typeof response>>();
    let refreshSignal: AbortSignal | undefined;
    const manager = new AuthManager(settings, store, {
      fetch: (_input, init) => {
        refreshSignal = init.signal ?? undefined;
        return refreshResponse.promise;
      },
      refreshTimeoutMs: 10_000,
    });
    const refresh = manager.refreshAccessToken();

    await settlesPromptly(manager.logout());

    expect(refreshSignal?.aborted).toBe(true);
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store.getAccessToken()).toBeUndefined();
    expect(store.getRefreshToken()).toBeUndefined();

    refreshResponse.resolve(
      response(200, {
        access_token: "must-not-return-after-logout",
        refresh_token: "must-not-return-refresh",
        expires_in: 3600,
      }),
    );
    await expect(refresh).resolves.toBe(false);
    await flushAsync();

    expect(store.store).not.toHaveBeenCalled();
    expect(store.getAccessToken()).toBeUndefined();
    expect(store.getRefreshToken()).toBeUndefined();
  });

  test("is single-flight, blocks login and refresh, and preserves the next active login record", async () => {
    const store = new MemoryTokenStore();
    store.refreshToken = "refresh-secret";
    const clearing = deferred<void>();
    store.clear.mockImplementationOnce(() => clearing.promise);
    const browser = deferred<TokenResponse>();
    const runBrowserLogin = vi.fn<BrowserLoginRunner>(() => browser.promise);
    const fetch = vi.fn<OAuthFetch>(() =>
      Promise.resolve(response(200, { access_token: "unexpected-refresh" })),
    );
    const manager = new AuthManager(settings, store, { fetch, runBrowserLogin });

    const firstLogout = manager.logout();
    const secondLogout = manager.logout();

    expect(secondLogout).toBe(firstLogout);
    await expect(manager.login()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "Authentication logout is in progress.",
    });
    await expect(manager.refreshAccessToken()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "Authentication logout is in progress.",
    });
    expect(runBrowserLogin).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    clearing.resolve();
    await Promise.all([firstLogout, secondLogout]);
    expect(store.clear).toHaveBeenCalledTimes(1);

    const nextLogin = manager.login();
    await expect(manager.login("device_code")).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "An authentication login is already in progress.",
    });

    const finalLogout = manager.logout();
    browser.reject(new AuthenticationError("private browser error access-secret"));
    await expect(nextLogin).rejects.toBeInstanceOf(AuthenticationError);
    await finalLogout;
  });

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

  test("waits for the contained device poll settlement before clearing tokens", async () => {
    const store = new MemoryTokenStore();
    const polling = deferred<void>();
    const manager = new AuthManager(settings, store, {
      startDeviceCodeLogin: () =>
        Promise.resolve({ details: deviceDetails, poll: () => polling.promise }),
    });
    await manager.login("device_code");

    const logout = manager.logout();
    await flushAsync();

    expect(store.clear).not.toHaveBeenCalled();

    polling.resolve();
    await logout;

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

describe("AuthManager status reconciliation", () => {
  test("returns detached frozen status and login snapshots", async () => {
    const store = new MemoryTokenStore();
    const manager = new AuthManager(settings, store, {
      runBrowserLogin: () =>
        Promise.resolve({
          access_token: "browser-access",
          refresh_token: "browser-refresh",
        }),
    });

    const first = manager.getStatus();
    const second = manager.getStatus();
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(() => {
      (first as { state: string }).state = "authenticated";
    }).toThrow(TypeError);
    expectStatus(manager, { state: "unauthenticated" });

    const loginResult = await manager.login();
    expect(Object.isFrozen(loginResult)).toBe(true);
    expect(loginResult).not.toBe(manager.getStatus());
    expect(() => {
      (loginResult as { state: string }).state = "failed";
    }).toThrow(TypeError);
    expectStatus(manager, { state: "authenticated" });
  });

  test("returns an immutable pending snapshot without exposing internal status", async () => {
    const polling = deferred<void>();
    const manager = new AuthManager(settings, new MemoryTokenStore(), {
      startDeviceCodeLogin: () =>
        Promise.resolve({ details: deviceDetails, poll: () => polling.promise }),
    });

    const pending = await manager.login("device_code");

    expect(Object.isFrozen(pending)).toBe(true);
    expect(() => {
      (pending as { userCode: string }).userCode = "MUTATED";
    }).toThrow(TypeError);
    expectStatus(manager, { state: "pending", method: "device_code", ...deviceDetails });

    const logout = manager.logout();
    polling.reject(new AuthenticationError("private poll failure access-secret"));
    await logout;
  });

  test("reflects external clear and access-only expiry", () => {
    const store = new MemoryTokenStore();
    store.accessToken = "current-access";
    store.expired = false;
    store.actuallyExpired = false;
    const manager = new AuthManager(settings, store);

    expectStatus(manager, { state: "authenticated" });

    store.accessToken = undefined;
    store.expired = true;
    store.actuallyExpired = true;
    expectStatus(manager, { state: "unauthenticated" });

    store.accessToken = "expired-access-only";
    expectStatus(manager, { state: "unauthenticated" });
  });

  test("keeps pending status even when older credentials remain usable", async () => {
    const store = new MemoryTokenStore();
    store.accessToken = "old-access";
    store.refreshToken = "old-refresh";
    store.expired = false;
    store.actuallyExpired = false;
    const polling = deferred<void>();
    const manager = new AuthManager(settings, store, {
      startDeviceCodeLogin: () =>
        Promise.resolve({ details: deviceDetails, poll: () => polling.promise }),
    });

    await manager.login("device_code");

    expectStatus(manager, { state: "pending", method: "device_code", ...deviceDetails });

    const logout = manager.logout();
    polling.reject(new AuthenticationError("private poll failure access-secret"));
    await logout;
  });

  test("reports authenticated after failed relogin or partial store failure with old credentials", async () => {
    for (const failure of ["runner", "store"] as const) {
      const store = new MemoryTokenStore();
      store.accessToken = "old-access";
      store.refreshToken = "old-refresh";
      store.expired = false;
      store.actuallyExpired = false;
      if (failure === "store") {
        store.store.mockRejectedValueOnce(
          new AuthenticationError("partial store private access-secret"),
        );
      }
      const manager = new AuthManager(settings, store, {
        runBrowserLogin: () =>
          failure === "runner"
            ? Promise.reject(new AuthenticationError("relogin private authorization-code"))
            : Promise.resolve({
                access_token: "new-access",
                refresh_token: "new-refresh",
              }),
      });

      await expect(manager.login()).rejects.toBeInstanceOf(AuthenticationError);

      expectStatus(manager, { state: "authenticated" });
      expect(store.getAccessToken()).toBe("old-access");
      expect(store.getRefreshToken()).toBe("old-refresh");
    }
  });

  test("failed status remains only without credentials and getValidAccessToken resets it", async () => {
    const store = new MemoryTokenStore();
    const manager = new AuthManager(settings, store, {
      runBrowserLogin: () =>
        Promise.reject(new AuthenticationError("private browser access-secret")),
    });
    await expect(manager.login()).rejects.toBeInstanceOf(AuthenticationError);
    expectStatus(manager, { state: "failed", message: "Browser login failed." });

    store.accessToken = "externally-restored";
    store.expired = false;
    store.actuallyExpired = false;
    expectStatus(manager, { state: "authenticated" });

    store.accessToken = undefined;
    store.expired = true;
    store.actuallyExpired = true;
    await expect(manager.getValidAccessToken()).rejects.toBeInstanceOf(AuthenticationError);
    expectStatus(manager, { state: "unauthenticated" });
  });

  test("reconciles status after a partially failing clear", async () => {
    const store = new MemoryTokenStore();
    store.accessToken = "old-access";
    store.refreshToken = "old-refresh";
    store.expired = false;
    store.actuallyExpired = false;
    store.clear.mockImplementationOnce(() => {
      store.accessToken = undefined;
      store.refreshToken = undefined;
      store.expired = true;
      store.actuallyExpired = true;
      return Promise.reject(new AuthenticationError("partial clear private refresh-secret"));
    });
    const manager = new AuthManager(settings, store);

    await expect(manager.logout()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "Unable to clear authentication tokens.",
    });

    expectStatus(manager, { state: "unauthenticated" });
  });
});
