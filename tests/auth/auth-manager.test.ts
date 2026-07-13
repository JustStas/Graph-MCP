import { describe, expect, test, vi } from "vitest";

import { AuthenticationError } from "../../src/errors.js";
import type { StoredTokens, TokenResponse } from "../../src/token-store.js";
import {
  AuthManager,
  type AuthManagerDependencies,
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

function withStorageTimeout(
  dependencies: AuthManagerDependencies,
  storageTimeoutMs: number,
): AuthManagerDependencies {
  return { ...dependencies, storageTimeoutMs };
}

class MemoryTokenStore {
  accessToken: string | undefined;
  refreshToken: string | undefined;
  expired = true;
  actuallyExpired = true;

  readonly store = vi.fn((tokens: TokenResponse, options?: { readonly signal?: AbortSignal }) => {
    void options;
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token ?? this.refreshToken;
    this.expired = false;
    this.actuallyExpired = false;
    return Promise.resolve();
  });

  readonly storeTokenSnapshot = vi.fn(
    (snapshot: Readonly<StoredTokens>, options?: { readonly signal?: AbortSignal }) => {
      void options;
      this.accessToken = snapshot.accessToken;
      this.refreshToken = snapshot.refreshToken;
      this.actuallyExpired = Date.now() >= snapshot.expiresAt;
      this.expired = this.actuallyExpired;
      return Promise.resolve();
    },
  );

  readonly clear = vi.fn((options?: { readonly signal?: AbortSignal }) => {
    void options;
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

  getTokenSnapshot(): Readonly<StoredTokens> | undefined {
    if (this.accessToken === undefined || this.accessToken.trim().length === 0) {
      return undefined;
    }
    return Object.freeze({
      accessToken: this.accessToken,
      refreshToken: this.refreshToken ?? "",
      expiresAt: this.actuallyExpired ? Date.now() - 1 : Date.now() + 3_600_000,
      scope: "",
    });
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
  test("snapshots and freezes caller-provided settings before login and refresh", async () => {
    const mutableSettings = {
      azureClientId: "client-id",
      authority: "https://login.microsoftonline.com/tenant",
      authorizeEndpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize",
      graphRedirectUri: "http://127.0.0.1:4567/auth/callback",
      tokenEndpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
      scopes: ["openid", "profile", "User.Read"],
    };
    const store = new MemoryTokenStore();
    let receivedSettings: Parameters<BrowserLoginRunner>[0] | undefined;
    let refreshEndpoint = "";
    let refreshRequest: RequestInit | undefined;
    const manager = new AuthManager(mutableSettings, store, {
      runBrowserLogin: (loginSettings) => {
        receivedSettings = loginSettings;
        return Promise.resolve({
          access_token: "browser-access",
          refresh_token: "browser-refresh",
        });
      },
      fetch: (endpoint, init) => {
        refreshEndpoint = endpoint;
        refreshRequest = init;
        return Promise.resolve(response(200, { access_token: "refreshed-access" }));
      },
    });

    mutableSettings.azureClientId = "mutated-client";
    mutableSettings.authority = "https://attacker.example/tenant";
    mutableSettings.authorizeEndpoint = "https://attacker.example/authorize";
    mutableSettings.graphRedirectUri = "http://127.0.0.1:9999/mutated";
    mutableSettings.tokenEndpoint = "https://attacker.example/token";
    mutableSettings.scopes.splice(0, mutableSettings.scopes.length, "Mutated.Scope");

    await manager.login();
    expect(receivedSettings).not.toBe(mutableSettings);
    expect(receivedSettings).toEqual(settings);
    expect(Object.isFrozen(receivedSettings)).toBe(true);
    expect(Object.isFrozen(receivedSettings?.scopes)).toBe(true);

    store.expired = true;
    store.actuallyExpired = true;
    await manager.refreshAccessToken();

    expect(refreshEndpoint).toBe(settings.tokenEndpoint);
    expect(refreshRequest?.body).toContain("client_id=client-id");
    expect(refreshRequest?.body).toContain("scope=openid+profile+User.Read");
  });

  test("clamps oversized storage and refresh timers to the Node timer limit", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const store = new MemoryTokenStore();
      const manager = new AuthManager(settings, store, {
        runBrowserLogin: () =>
          Promise.resolve({
            access_token: "browser-access",
            refresh_token: "browser-refresh",
          }),
        fetch: () =>
          Promise.resolve(
            response(200, {
              access_token: "refreshed-access",
              refresh_token: "refreshed-refresh",
            }),
          ),
        refreshTimeoutMs: Number.MAX_SAFE_INTEGER,
        storageTimeoutMs: Number.MAX_SAFE_INTEGER,
      });

      await manager.login();
      expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 2_147_483_647)).toHaveLength(1);

      timeoutSpy.mockClear();
      await manager.refreshAccessToken();
      expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 2_147_483_647)).toHaveLength(2);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  test("uses browser login by default, stores tokens, and becomes authenticated", async () => {
    const store = new MemoryTokenStore();
    const runBrowserLogin = vi.fn<BrowserLoginRunner>((_settings, dependencies) => {
      expect(_settings).not.toBe(settings);
      expect(_settings).toEqual(settings);
      expect(Object.isFrozen(_settings)).toBe(true);
      expect(Object.isFrozen(_settings.scopes)).toBe(true);
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
    expect(store.store).toHaveBeenCalledTimes(1);
    const [storedTokens, storeOptions] = store.store.mock.calls[0]!;
    expect(storedTokens).toEqual({
      access_token: "browser-access",
      refresh_token: "browser-refresh",
      expires_in: 3600,
    });
    expect(storeOptions?.signal).toBeInstanceOf(AbortSignal);
    expectStatus(manager, { state: "authenticated" });
  });

  test("bounds browser token storage, aborts its signal, and permits a later login", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      let storeSignal: AbortSignal | undefined;
      store.store.mockImplementationOnce((_tokens, options) => {
        storeSignal = options?.signal;
        return new Promise<void>(() => undefined);
      });
      const manager = new AuthManager(
        settings,
        store,
        withStorageTimeout(
          {
            runBrowserLogin: () =>
              Promise.resolve({
                access_token: "browser-access",
                refresh_token: "browser-refresh",
              }),
          },
          10,
        ),
      );

      const firstLogin = settlesPromptly(manager.login());
      const firstLoginAssertion = expect(firstLogin).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);

      await firstLoginAssertion;
      expect(storeSignal?.aborted).toBe(true);

      await expect(manager.login()).resolves.toEqual({ state: "authenticated" });
      expect(store.getAccessToken()).toBe("browser-access");
      expect(store.getRefreshToken()).toBe("browser-refresh");
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns device instructions immediately, reports pending, then becomes authenticated", async () => {
    const store = new MemoryTokenStore();
    const polling = deferred<void>();
    const startDeviceCodeLogin = vi.fn<DeviceCodeLoginStarter>(
      (_settings, receivedStore, dependencies) => {
        expect(_settings).not.toBe(settings);
        expect(_settings).toEqual(settings);
        expect(Object.isFrozen(_settings)).toBe(true);
        expect(Object.isFrozen(_settings.scopes)).toBe(true);
        expect(receivedStore).not.toBe(store);
        expect("clear" in receivedStore).toBe(false);
        expect(dependencies?.signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve({
          details: deviceDetails,
          poll: vi.fn(async () => {
            await polling.promise;
            await receivedStore.store({
              access_token: "device-access",
              refresh_token: "device-refresh",
              expires_in: 3600,
            });
          }),
        });
      },
    );
    const manager = new AuthManager(settings, store, { startDeviceCodeLogin });

    const result = await manager.login("device_code");

    expect(result).toEqual({ state: "pending", method: "device_code", ...deviceDetails });
    expectStatus(manager, { state: "pending", method: "device_code", ...deviceDetails });
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
    expect(omittedStore.store).toHaveBeenCalledTimes(1);
    const [storedTokens, storeOptions] = omittedStore.store.mock.calls[0]!;
    expect(storedTokens).toEqual({
      access_token: "new-access",
      refresh_token: "captured-refresh",
      expires_in: 3600,
    });
    expect(storeOptions?.signal).toBeInstanceOf(AbortSignal);
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

  test("clears refresh credentials only for HTTP 400 with a normalized invalid_grant identifier", async () => {
    const normalizedStore = new MemoryTokenStore();
    normalizedStore.accessToken = "expired-access";
    normalizedStore.refreshToken = "invalid-refresh";
    normalizedStore.expired = true;
    normalizedStore.actuallyExpired = true;
    const normalizedManager = new AuthManager(settings, normalizedStore, {
      fetch: () =>
        Promise.resolve(
          response(400, {
            error: " \tINVALID_GRANT\r\n",
            error_description: "private invalid-refresh access-secret",
          }),
        ),
    });

    await expect(normalizedManager.refreshAccessToken()).resolves.toBe(false);
    expect(normalizedStore.clear).toHaveBeenCalledTimes(1);
    expect(normalizedStore.getRefreshToken()).toBeUndefined();

    for (const status of [401, 403, 429, 500, 503]) {
      const store = new MemoryTokenStore();
      store.accessToken = "expired-access";
      store.refreshToken = `keep-refresh-${status}`;
      store.expired = true;
      store.actuallyExpired = true;
      const manager = new AuthManager(settings, store, {
        fetch: () =>
          Promise.resolve(
            response(status, {
              error: "invalid_grant",
              error_description: `private keep-refresh-${status}`,
            }),
          ),
      });

      await expect(manager.refreshAccessToken()).resolves.toBe(false);
      expect(store.clear).not.toHaveBeenCalled();
      expect(store.getRefreshToken()).toBe(`keep-refresh-${status}`);
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

  test("bounds refresh token storage and does not leave future authentication wedged", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      store.accessToken = "expired-access";
      store.refreshToken = "refresh-secret";
      store.expired = true;
      store.actuallyExpired = true;
      let storeSignal: AbortSignal | undefined;
      store.store.mockImplementationOnce((_tokens, options) => {
        storeSignal = options?.signal;
        return new Promise<void>(() => undefined);
      });
      const manager = new AuthManager(
        settings,
        store,
        withStorageTimeout(
          {
            fetch: () =>
              Promise.resolve(
                response(200, {
                  access_token: "refreshed-access",
                  refresh_token: "refreshed-refresh",
                }),
              ),
            runBrowserLogin: () =>
              Promise.resolve({
                access_token: "browser-access",
                refresh_token: "browser-refresh",
              }),
          },
          10,
        ),
      );

      const refresh = settlesPromptly(manager.refreshAccessToken());
      await vi.advanceTimersByTimeAsync(100);

      await expect(refresh).resolves.toBe(false);
      expect(storeSignal?.aborted).toBe(true);
      await expect(manager.login()).resolves.toEqual({ state: "authenticated" });
      expect(store.getAccessToken()).toBe("browser-access");
      expect(store.getRefreshToken()).toBe("browser-refresh");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AuthManager storage mutation fencing", () => {
  test("fences and clears a first timed-out store when it settles late", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      const lateStore = deferred<void>();
      store.store.mockImplementationOnce((tokens) =>
        lateStore.promise.then(() => {
          store.accessToken = tokens.access_token;
          store.refreshToken = tokens.refresh_token;
          store.expired = false;
          store.actuallyExpired = false;
        }),
      );
      const manager = new AuthManager(
        settings,
        store,
        withStorageTimeout(
          {
            runBrowserLogin: () =>
              Promise.resolve({
                access_token: "late-first-access",
                refresh_token: "late-first-refresh",
              }),
          },
          10,
        ),
      );

      const login = manager.login();
      const loginAssertion = expect(login).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await loginAssertion;

      lateStore.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.clear).toHaveBeenCalledTimes(1);
      expect(store.getAccessToken()).toBeUndefined();
      expect(store.getRefreshToken()).toBeUndefined();
      await expect(manager.getValidAccessToken()).rejects.toMatchObject({
        name: "AuthenticationError",
        message: loginRequiredMessage,
      });
      expectStatus(manager, { state: "unauthenticated" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not extend token lifetime when replaying a delayed correction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const store = Object.assign(new MemoryTokenStore(), {
        getTokenSnapshot: () => ({
          accessToken: "baseline-access",
          refreshToken: "baseline-refresh",
          expiresAt: 1_010_000,
          scope: "User.Read",
        }),
      });
      store.accessToken = "baseline-access";
      store.refreshToken = "baseline-refresh";
      store.expired = false;
      store.actuallyExpired = false;
      const lateStore = deferred<void>();
      store.store.mockImplementationOnce((tokens) =>
        lateStore.promise.then(() => {
          store.accessToken = tokens.access_token;
          store.refreshToken = tokens.refresh_token;
          store.expired = false;
          store.actuallyExpired = false;
        }),
      );
      const manager = new AuthManager(
        settings,
        store,
        withStorageTimeout(
          {
            runBrowserLogin: () =>
              Promise.resolve({
                access_token: "late-access",
                refresh_token: "late-refresh",
              }),
          },
          10,
        ),
      );

      const login = manager.login();
      const loginAssertion = expect(login).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await loginAssertion;

      vi.setSystemTime(1_005_500);
      lateStore.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.store).toHaveBeenCalledTimes(1);
      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(1);
      expect(store.storeTokenSnapshot.mock.calls[0]?.[0]).toEqual({
        accessToken: "baseline-access",
        refreshToken: "baseline-refresh",
        expiresAt: 1_010_000,
        scope: "User.Read",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("anchors accepted token expiry before storage latency", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const store = new MemoryTokenStore();
      const firstStoreStarted = deferred<void>();
      const firstStore = deferred<void>();
      store.store
        .mockImplementationOnce((tokens) => {
          firstStoreStarted.resolve();
          return firstStore.promise.then(() => {
            store.accessToken = tokens.access_token;
            store.refreshToken = tokens.refresh_token;
            store.expired = false;
            store.actuallyExpired = false;
          });
        })
        .mockImplementationOnce((tokens) => {
          store.accessToken = tokens.access_token;
          store.refreshToken = tokens.refresh_token;
          store.expired = false;
          store.actuallyExpired = false;
          return Promise.reject(new AuthenticationError("uncertain post-commit store failure"));
        });
      const runBrowserLogin = vi
        .fn<BrowserLoginRunner>()
        .mockResolvedValueOnce({
          access_token: "accepted-access",
          refresh_token: "accepted-refresh",
          expires_in: 10,
        })
        .mockResolvedValueOnce({
          access_token: "rejected-access",
          refresh_token: "rejected-refresh",
          expires_in: 10,
        });
      const manager = new AuthManager(
        settings,
        store,
        withStorageTimeout({ runBrowserLogin }, 20_000),
      );

      const firstLogin = manager.login();
      await firstStoreStarted.promise;
      vi.setSystemTime(1_005_000);
      firstStore.resolve();
      await firstLogin;

      vi.setSystemTime(1_006_000);
      await expect(manager.login()).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(store.store).toHaveBeenCalledTimes(2);
      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(1);
      expect(store.storeTokenSnapshot.mock.calls[0]?.[0]).toEqual({
        accessToken: "accepted-access",
        refreshToken: "accepted-refresh",
        expiresAt: 1_010_000,
        scope: "",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses accepted credentials while and after a relogin store mutates before never settling", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      const reloginStoreStarted = deferred<void>();
      store.store
        .mockImplementationOnce((tokens) => {
          store.accessToken = tokens.access_token;
          store.refreshToken = tokens.refresh_token;
          store.expired = false;
          store.actuallyExpired = false;
          return Promise.resolve();
        })
        .mockImplementationOnce((tokens) => {
          store.accessToken = tokens.access_token;
          store.refreshToken = tokens.refresh_token;
          store.expired = false;
          store.actuallyExpired = false;
          reloginStoreStarted.resolve();
          return new Promise<void>(() => undefined);
        });
      const runBrowserLogin = vi
        .fn<BrowserLoginRunner>()
        .mockResolvedValueOnce({
          access_token: "accepted-access",
          refresh_token: "accepted-refresh",
          expires_in: 3600,
        })
        .mockResolvedValueOnce({
          access_token: "mutated-access",
          refresh_token: "mutated-refresh",
          expires_in: 3600,
        })
        .mockResolvedValueOnce({
          access_token: "newer-access",
          refresh_token: "newer-refresh",
          expires_in: 3600,
        });
      const manager = new AuthManager(settings, store, withStorageTimeout({ runBrowserLogin }, 10));

      await manager.login();
      const relogin = manager.login();

      await reloginStoreStarted.promise;
      expect(store.getAccessToken()).toBe("mutated-access");
      await expect(manager.getValidAccessToken()).resolves.toBe("accepted-access");
      expectStatus(manager, { state: "authenticated" });

      const reloginAssertion = expect(relogin).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await reloginAssertion;

      expect(store.getAccessToken()).toBe("mutated-access");
      await expect(manager.getValidAccessToken()).resolves.toBe("accepted-access");
      expectStatus(manager, { state: "authenticated" });

      await expect(manager.login()).resolves.toEqual({ state: "authenticated" });
      await expect(manager.getValidAccessToken()).resolves.toBe("newer-access");
      expect(store.getRefreshToken()).toBe("newer-refresh");
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses accepted credentials while a refresh store is still in flight", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      store.accessToken = "accepted-access";
      store.refreshToken = "accepted-refresh";
      store.expired = false;
      store.actuallyExpired = false;
      const refreshStoreStarted = deferred<void>();
      store.store.mockImplementationOnce((tokens) => {
        store.accessToken = tokens.access_token;
        store.refreshToken = tokens.refresh_token;
        store.expired = false;
        store.actuallyExpired = false;
        refreshStoreStarted.resolve();
        return new Promise<void>(() => undefined);
      });
      const manager = new AuthManager(
        settings,
        store,
        withStorageTimeout(
          {
            fetch: () =>
              Promise.resolve(
                response(200, {
                  access_token: "unaccepted-refresh-access",
                  refresh_token: "unaccepted-refresh-token",
                }),
              ),
          },
          10,
        ),
      );

      const refresh = manager.refreshAccessToken();
      await refreshStoreStarted.promise;

      expect(store.getAccessToken()).toBe("unaccepted-refresh-access");
      await expect(manager.getValidAccessToken()).resolves.toBe("accepted-access");
      expectStatus(manager, { state: "authenticated" });

      await vi.advanceTimersByTimeAsync(100);
      await expect(refresh).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps device login pending and uses accepted credentials while its store is in flight", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      store.accessToken = "accepted-access";
      store.refreshToken = "accepted-refresh";
      store.expired = false;
      store.actuallyExpired = false;
      const deviceStoreStarted = deferred<void>();
      store.store.mockImplementationOnce((tokens) => {
        store.accessToken = tokens.access_token;
        store.refreshToken = tokens.refresh_token;
        store.expired = false;
        store.actuallyExpired = false;
        deviceStoreStarted.resolve();
        return new Promise<void>(() => undefined);
      });
      const startDeviceCodeLogin = vi.fn<DeviceCodeLoginStarter>((_settings, deviceStore) =>
        Promise.resolve({
          details: deviceDetails,
          poll: () =>
            deviceStore.store({
              access_token: "unaccepted-device-access",
              refresh_token: "unaccepted-device-refresh",
            }),
        }),
      );
      const manager = new AuthManager(
        settings,
        store,
        withStorageTimeout({ startDeviceCodeLogin }, 10),
      );

      await expect(manager.login("device_code")).resolves.toEqual({
        state: "pending",
        method: "device_code",
        ...deviceDetails,
      });
      await deviceStoreStarted.promise;

      expect(store.getAccessToken()).toBe("unaccepted-device-access");
      expectStatus(manager, { state: "pending", method: "device_code", ...deviceDetails });
      await expect(manager.getValidAccessToken()).resolves.toBe("accepted-access");

      await vi.advanceTimersByTimeAsync(100);
      expectStatus(manager, { state: "authenticated" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("clears a late stale browser store that settles after logout", async () => {
    const store = new MemoryTokenStore();
    const storeStarted = deferred<void>();
    const lateStore = deferred<void>();
    const correctionStarted = deferred<void>();
    const correction = deferred<void>();
    store.store.mockImplementationOnce((tokens) => {
      storeStarted.resolve();
      return lateStore.promise.then(() => {
        store.accessToken = tokens.access_token;
        store.refreshToken = tokens.refresh_token;
        store.expired = false;
        store.actuallyExpired = false;
      });
    });
    store.clear
      .mockImplementationOnce(() => {
        store.accessToken = undefined;
        store.refreshToken = undefined;
        store.expired = true;
        store.actuallyExpired = true;
        return Promise.resolve();
      })
      .mockImplementationOnce(() => {
        correctionStarted.resolve();
        return correction.promise.then(() => {
          store.accessToken = undefined;
          store.refreshToken = undefined;
          store.expired = true;
          store.actuallyExpired = true;
        });
      });
    const manager = new AuthManager(settings, store, {
      runBrowserLogin: () =>
        Promise.resolve({
          access_token: "stale-access",
          refresh_token: "stale-refresh",
        }),
    });

    const login = manager.login();
    const loginAssertion = expect(login).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "Login timed out or was cancelled.",
    });
    await storeStarted.promise;

    await expect(settlesPromptly(manager.logout())).resolves.toBeUndefined();
    await loginAssertion;
    expect(store.clear).toHaveBeenCalledTimes(1);
    expectStatus(manager, { state: "unauthenticated" });

    lateStore.resolve();
    await correctionStarted.promise;

    expect(store.getAccessToken()).toBe("stale-access");
    expectStatus(manager, { state: "unauthenticated" });
    await expect(settlesPromptly(manager.getValidAccessToken())).rejects.toMatchObject({
      name: "AuthenticationError",
      message: loginRequiredMessage,
    });

    correction.resolve();
    await flushAsync();

    expect(store.clear).toHaveBeenCalledTimes(2);
    expect(store.getAccessToken()).toBeUndefined();
    expect(store.getRefreshToken()).toBeUndefined();
    expectStatus(manager, { state: "unauthenticated" });
  });

  test("restores the latest accepted login after an older timed-out store settles", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      const lateStore = deferred<void>();
      store.store.mockImplementationOnce((tokens) =>
        lateStore.promise.then(() => {
          store.accessToken = tokens.access_token;
          store.refreshToken = tokens.refresh_token;
          store.expired = false;
          store.actuallyExpired = false;
        }),
      );
      const runBrowserLogin = vi
        .fn<BrowserLoginRunner>()
        .mockResolvedValueOnce({
          access_token: "stale-access",
          refresh_token: "stale-refresh",
        })
        .mockResolvedValueOnce({
          access_token: "latest-access",
          refresh_token: "latest-refresh",
        });
      const manager = new AuthManager(settings, store, withStorageTimeout({ runBrowserLogin }, 10));

      const staleLogin = manager.login();
      const staleAssertion = expect(staleLogin).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await staleAssertion;

      await expect(manager.login()).resolves.toEqual({ state: "authenticated" });
      expect(store.getAccessToken()).toBe("latest-access");
      expect(store.getRefreshToken()).toBe("latest-refresh");

      lateStore.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.getAccessToken()).toBe("latest-access");
      expect(store.getRefreshToken()).toBe("latest-refresh");
      expect(store.store).toHaveBeenCalledTimes(2);
      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.store).toHaveBeenCalledTimes(2);
      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("restores accepted credentials after a same-revision relogin store settles late", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      const lateRelogin = deferred<void>();
      store.store
        .mockImplementationOnce((tokens) => {
          store.accessToken = tokens.access_token;
          store.refreshToken = tokens.refresh_token;
          store.expired = false;
          store.actuallyExpired = false;
          return Promise.resolve();
        })
        .mockImplementationOnce((tokens) =>
          lateRelogin.promise.then(() => {
            store.accessToken = tokens.access_token;
            store.refreshToken = tokens.refresh_token;
            store.expired = false;
            store.actuallyExpired = false;
          }),
        );
      const runBrowserLogin = vi
        .fn<BrowserLoginRunner>()
        .mockResolvedValueOnce({
          access_token: "accepted-access",
          refresh_token: "accepted-refresh",
        })
        .mockResolvedValueOnce({
          access_token: "timed-out-access",
          refresh_token: "timed-out-refresh",
        });
      const manager = new AuthManager(settings, store, withStorageTimeout({ runBrowserLogin }, 10));

      await manager.login();
      const relogin = manager.login();
      const reloginAssertion = expect(relogin).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await reloginAssertion;

      lateRelogin.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.getAccessToken()).toBe("accepted-access");
      expect(store.getRefreshToken()).toBe("accepted-refresh");
      expect(store.store).toHaveBeenCalledTimes(2);
      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(1);
      await expect(manager.getValidAccessToken()).resolves.toBe("accepted-access");
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps stale credentials fenced after a failed correction and retries on a later read", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      const lateRelogin = deferred<void>();
      const retryStarted = deferred<void>();
      const retry = deferred<void>();
      store.store
        .mockImplementationOnce((tokens) => {
          store.accessToken = tokens.access_token;
          store.refreshToken = tokens.refresh_token;
          store.expired = false;
          store.actuallyExpired = false;
          return Promise.resolve();
        })
        .mockImplementationOnce((tokens) =>
          lateRelogin.promise.then(() => {
            store.accessToken = tokens.access_token;
            store.refreshToken = tokens.refresh_token;
            store.expired = false;
            store.actuallyExpired = false;
          }),
        );
      store.storeTokenSnapshot
        .mockRejectedValueOnce(new Error("corrective store failed"))
        .mockImplementationOnce((snapshot) => {
          retryStarted.resolve();
          return retry.promise.then(() => {
            store.accessToken = snapshot.accessToken;
            store.refreshToken = snapshot.refreshToken;
            store.actuallyExpired = Date.now() >= snapshot.expiresAt;
            store.expired = store.actuallyExpired;
          });
        });
      const runBrowserLogin = vi
        .fn<BrowserLoginRunner>()
        .mockResolvedValueOnce({
          access_token: "accepted-access",
          refresh_token: "accepted-refresh",
        })
        .mockResolvedValueOnce({
          access_token: "stale-access",
          refresh_token: "stale-refresh",
        });
      const manager = new AuthManager(settings, store, withStorageTimeout({ runBrowserLogin }, 10));

      await manager.login();
      const relogin = manager.login();
      const reloginAssertion = expect(relogin).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await reloginAssertion;

      lateRelogin.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(store.getAccessToken()).toBe("stale-access");
      expect(store.store).toHaveBeenCalledTimes(2);
      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(1);

      expectStatus(manager, { state: "authenticated" });
      await retryStarted.promise;
      await expect(manager.getValidAccessToken()).resolves.toBe("accepted-access");

      retry.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await expect(manager.getValidAccessToken()).resolves.toBe("accepted-access");
      expect(store.getRefreshToken()).toBe("accepted-refresh");
      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("tracks a timed-out correction until its late rejection is repaired", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      const lateRelogin = deferred<void>();
      const firstCorrectionStarted = deferred<void>();
      let rejectFirstCorrection: (() => void) | undefined;
      store.storeTokenSnapshot.mockImplementationOnce(
        (snapshot: Readonly<StoredTokens>) =>
          new Promise<void>((_resolve, reject) => {
            firstCorrectionStarted.resolve();
            rejectFirstCorrection = () => {
              store.accessToken = snapshot.accessToken;
              store.refreshToken = snapshot.refreshToken;
              store.actuallyExpired = Date.now() >= snapshot.expiresAt;
              store.expired = store.actuallyExpired;
              reject(new Error("late corrective durability failure"));
            };
          }),
      );
      const runBrowserLogin = vi
        .fn<BrowserLoginRunner>()
        .mockResolvedValueOnce({
          access_token: "accepted-access",
          refresh_token: "accepted-refresh",
        })
        .mockResolvedValueOnce({
          access_token: "stale-access",
          refresh_token: "stale-refresh",
        })
        .mockResolvedValueOnce({
          access_token: "newer-access",
          refresh_token: "newer-refresh",
        });
      const manager = new AuthManager(settings, store, withStorageTimeout({ runBrowserLogin }, 10));

      await manager.login();
      store.store.mockImplementationOnce((tokens) =>
        lateRelogin.promise.then(() => {
          store.accessToken = tokens.access_token;
          store.refreshToken = tokens.refresh_token;
          store.expired = false;
          store.actuallyExpired = false;
        }),
      );
      const relogin = manager.login();
      const reloginAssertion = expect(relogin).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await reloginAssertion;

      lateRelogin.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await firstCorrectionStarted.promise;
      await vi.advanceTimersByTimeAsync(100);
      await expect(manager.getValidAccessToken()).resolves.toBe("accepted-access");
      await vi.advanceTimersByTimeAsync(0);
      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(1);

      await manager.login();
      expect(store.getAccessToken()).toBe("newer-access");

      rejectFirstCorrection?.();
      await vi.advanceTimersByTimeAsync(0);
      await expect(manager.getValidAccessToken()).resolves.toBe("newer-access");
      await vi.advanceTimersByTimeAsync(0);

      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(2);
      expect(store.getAccessToken()).toBe("newer-access");
      expect(store.getRefreshToken()).toBe("newer-refresh");
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports unauthenticated when fenced desired credentials have expired without refresh", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      const runBrowserLogin = vi
        .fn<BrowserLoginRunner>()
        .mockResolvedValueOnce({
          access_token: "short-lived-access",
          expires_in: 1,
        })
        .mockResolvedValueOnce({
          access_token: "unaccepted-access",
          expires_in: 3600,
        });
      const manager = new AuthManager(settings, store, withStorageTimeout({ runBrowserLogin }, 10));

      await manager.login();
      store.store.mockImplementationOnce((tokens) => {
        store.accessToken = tokens.access_token;
        store.refreshToken = tokens.refresh_token;
        store.expired = false;
        store.actuallyExpired = false;
        return new Promise<void>(() => undefined);
      });
      const relogin = manager.login();
      const reloginAssertion = expect(relogin).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await reloginAssertion;
      await vi.advanceTimersByTimeAsync(1_000);

      expectStatus(manager, { state: "unauthenticated" });
      await expect(manager.getValidAccessToken()).rejects.toMatchObject({
        name: "AuthenticationError",
        message: loginRequiredMessage,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("restores the latest accepted login after a timed-out clear settles", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      store.accessToken = "old-access";
      store.refreshToken = "old-refresh";
      store.expired = false;
      store.actuallyExpired = false;
      const lateClear = deferred<void>();
      store.clear.mockImplementationOnce(() =>
        lateClear.promise.then(() => {
          store.accessToken = undefined;
          store.refreshToken = undefined;
          store.expired = true;
          store.actuallyExpired = true;
        }),
      );
      const manager = new AuthManager(
        settings,
        store,
        withStorageTimeout(
          {
            runBrowserLogin: () =>
              Promise.resolve({
                access_token: "latest-access",
                refresh_token: "latest-refresh",
              }),
          },
          10,
        ),
      );

      const logout = manager.logout();
      const logoutAssertion = expect(logout).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to clear authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await logoutAssertion;

      await expect(manager.login()).resolves.toEqual({ state: "authenticated" });
      expect(store.getAccessToken()).toBe("latest-access");
      expect(store.getRefreshToken()).toBe("latest-refresh");

      lateClear.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.getAccessToken()).toBe("latest-access");
      expect(store.getRefreshToken()).toBe("latest-refresh");
      expect(store.store).toHaveBeenCalledTimes(1);
      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(1);
      expect(store.clear).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.store).toHaveBeenCalledTimes(1);
      expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(1);
      expect(store.clear).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("accepts refreshed desired credentials when an older clear wins the raw-store race", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      store.accessToken = "old-access";
      store.refreshToken = "old-refresh";
      store.expired = false;
      store.actuallyExpired = false;
      const lateClear = deferred<void>();
      store.clear.mockImplementationOnce(() =>
        lateClear.promise.then(() => {
          store.accessToken = undefined;
          store.refreshToken = undefined;
          store.expired = true;
          store.actuallyExpired = true;
        }),
      );
      const manager = new AuthManager(
        settings,
        store,
        withStorageTimeout(
          {
            runBrowserLogin: () =>
              Promise.resolve({
                access_token: "accepted-access",
                refresh_token: "accepted-refresh",
              }),
            fetch: () =>
              Promise.resolve(
                response(200, {
                  access_token: "refreshed-access",
                  refresh_token: "refreshed-refresh",
                }),
              ),
          },
          10,
        ),
      );

      const logout = manager.logout();
      const logoutAssertion = expect(logout).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to clear authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await logoutAssertion;
      await manager.login();

      store.store.mockImplementationOnce((tokens) => {
        store.accessToken = tokens.access_token;
        store.refreshToken = tokens.refresh_token;
        store.expired = false;
        store.actuallyExpired = false;
        lateClear.resolve();
        return Promise.resolve();
      });

      await expect(manager.refreshAccessToken()).resolves.toBe(true);
      await expect(manager.getValidAccessToken()).resolves.toBe("refreshed-access");
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getAccessToken()).toBe("refreshed-access");
      expect(store.getRefreshToken()).toBe("refreshed-refresh");
    } finally {
      vi.useRealTimers();
    }
  });

  test("reconciles an older background clear that settles during a newer store", async () => {
    const store = new MemoryTokenStore();
    const staleStoreStarted = deferred<void>();
    const lateStaleStore = deferred<void>();
    const latestStoreStarted = deferred<void>();
    const latestStoreCompletion = deferred<void>();
    const reconciliationClearStarted = deferred<void>();
    const reconciliationClear = deferred<void>();
    store.store
      .mockImplementationOnce((tokens) => {
        staleStoreStarted.resolve();
        return lateStaleStore.promise.then(() => {
          store.accessToken = tokens.access_token;
          store.refreshToken = tokens.refresh_token;
          store.expired = false;
          store.actuallyExpired = false;
        });
      })
      .mockImplementationOnce((tokens) => {
        store.accessToken = tokens.access_token;
        store.refreshToken = tokens.refresh_token;
        store.expired = false;
        store.actuallyExpired = false;
        latestStoreStarted.resolve();
        return latestStoreCompletion.promise;
      });
    store.clear
      .mockImplementationOnce(() => {
        store.accessToken = undefined;
        store.refreshToken = undefined;
        store.expired = true;
        store.actuallyExpired = true;
        return Promise.resolve();
      })
      .mockImplementationOnce(() => {
        reconciliationClearStarted.resolve();
        return reconciliationClear.promise.then(() => {
          store.accessToken = undefined;
          store.refreshToken = undefined;
          store.expired = true;
          store.actuallyExpired = true;
        });
      });
    const runBrowserLogin = vi
      .fn<BrowserLoginRunner>()
      .mockResolvedValueOnce({
        access_token: "stale-access",
        refresh_token: "stale-refresh",
      })
      .mockResolvedValueOnce({
        access_token: "latest-access",
        refresh_token: "latest-refresh",
      });
    const manager = new AuthManager(settings, store, { runBrowserLogin });

    const staleLogin = manager.login();
    const staleAssertion = expect(staleLogin).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "Login timed out or was cancelled.",
    });
    await staleStoreStarted.promise;
    await manager.logout();
    await staleAssertion;

    lateStaleStore.resolve();
    await reconciliationClearStarted.promise;

    const latestLogin = manager.login();
    await latestStoreStarted.promise;
    reconciliationClear.resolve();
    await flushAsync();
    latestStoreCompletion.resolve();
    await latestLogin;
    await flushAsync();
    await flushAsync();

    expect(store.getAccessToken()).toBe("latest-access");
    expect(store.getRefreshToken()).toBe("latest-refresh");
    expect(store.store).toHaveBeenCalledTimes(2);
    expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(1);
    expect(store.clear).toHaveBeenCalledTimes(2);
  });

  test("logout remains bounded while an earlier reconciliation continues in the background", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      const lateStore = deferred<void>();
      const reconciliationStarted = deferred<void>();
      store.store
        .mockImplementationOnce((tokens) =>
          lateStore.promise.then(() => {
            store.accessToken = tokens.access_token;
            store.refreshToken = tokens.refresh_token;
            store.expired = false;
            store.actuallyExpired = false;
          }),
        )
        .mockImplementationOnce((tokens) => {
          store.accessToken = tokens.access_token;
          store.refreshToken = tokens.refresh_token;
          store.expired = false;
          store.actuallyExpired = false;
          return Promise.resolve();
        });
      store.storeTokenSnapshot.mockImplementationOnce(() => {
        reconciliationStarted.resolve();
        return new Promise<void>(() => undefined);
      });
      const runBrowserLogin = vi
        .fn<BrowserLoginRunner>()
        .mockResolvedValueOnce({
          access_token: "stale-access",
          refresh_token: "stale-refresh",
        })
        .mockResolvedValueOnce({
          access_token: "latest-access",
          refresh_token: "latest-refresh",
        });
      const manager = new AuthManager(settings, store, withStorageTimeout({ runBrowserLogin }, 10));

      const staleLogin = manager.login();
      const staleAssertion = expect(staleLogin).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await staleAssertion;
      await manager.login();

      lateStore.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await reconciliationStarted.promise;

      await expect(settlesPromptly(manager.logout())).resolves.toBeUndefined();
      expect(store.clear).toHaveBeenCalledTimes(1);
      expectStatus(manager, { state: "unauthenticated" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("observes a losing store rejection after its bounded caller has settled", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      const store = new MemoryTokenStore();
      const lateStore = deferred<void>();
      store.store.mockImplementationOnce(() => lateStore.promise);
      const manager = new AuthManager(
        settings,
        store,
        withStorageTimeout(
          {
            runBrowserLogin: () => Promise.resolve({ access_token: "stale-access" }),
          },
          10,
        ),
      );

      const login = manager.login();
      const assertion = expect(login).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to store authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      lateStore.reject(new Error("late private store rejection access-secret"));
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });
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

  test("bounds an ignored clear, aborts its signal, and releases the logout gate", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryTokenStore();
      store.accessToken = "old-access";
      store.refreshToken = "old-refresh";
      store.expired = false;
      store.actuallyExpired = false;
      let clearSignal: AbortSignal | undefined;
      store.clear.mockImplementationOnce((options) => {
        clearSignal = options?.signal;
        return new Promise<void>(() => undefined);
      });
      const manager = new AuthManager(
        settings,
        store,
        withStorageTimeout(
          {
            runBrowserLogin: () =>
              Promise.resolve({
                access_token: "new-access",
                refresh_token: "new-refresh",
              }),
          },
          10,
        ),
      );

      const logout = settlesPromptly(manager.logout());
      const logoutAssertion = expect(logout).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Unable to clear authentication tokens.",
      });
      await vi.advanceTimersByTimeAsync(100);

      await logoutAssertion;
      expect(clearSignal?.aborted).toBe(true);
      await expect(manager.login()).resolves.toEqual({ state: "authenticated" });
      expect(store.getAccessToken()).toBe("new-access");
      expect(store.getRefreshToken()).toBe("new-refresh");
    } finally {
      vi.useRealTimers();
    }
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

  test("does not wait for a non-cooperative device poll before clearing tokens", async () => {
    const store = new MemoryTokenStore();
    const polling = deferred<void>();
    const manager = new AuthManager(settings, store, {
      startDeviceCodeLogin: () =>
        Promise.resolve({ details: deviceDetails, poll: () => polling.promise }),
    });
    await manager.login("device_code");

    await expect(settlesPromptly(manager.logout())).resolves.toBeUndefined();

    expect(store.clear).toHaveBeenCalledTimes(1);
    expectStatus(manager, { state: "unauthenticated" });

    polling.reject(new Error("late poll rejection access-secret"));
    await flushAsync();
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

  test("fences and repairs a storage rejection that mutates before rejecting", async () => {
    const store = Object.assign(new MemoryTokenStore(), {
      getTokenSnapshot: () => ({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() + 60_000,
        scope: "User.Read",
      }),
    });
    store.accessToken = "old-access";
    store.refreshToken = "old-refresh";
    store.expired = false;
    store.actuallyExpired = false;
    store.store.mockImplementationOnce((tokens: TokenResponse) => {
      store.accessToken = tokens.access_token;
      store.refreshToken = tokens.refresh_token;
      store.expired = false;
      store.actuallyExpired = false;
      return Promise.reject(new AuthenticationError("post-commit directory sync failure"));
    });
    const manager = new AuthManager(settings, store, {
      runBrowserLogin: () =>
        Promise.resolve({
          access_token: "rejected-access",
          refresh_token: "rejected-refresh",
        }),
    });

    await expect(manager.login()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "Unable to store authentication tokens.",
    });

    await expect(manager.getValidAccessToken()).resolves.toBe("old-access");
    await flushAsync();
    expect(store.store).toHaveBeenCalledTimes(1);
    expect(store.storeTokenSnapshot).toHaveBeenCalledTimes(1);
    expect(store.getAccessToken()).toBe("old-access");
    expect(store.getRefreshToken()).toBe("old-refresh");
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

  test("retries a rejected clear because stale credentials may remain", async () => {
    const store = new MemoryTokenStore();
    store.accessToken = "old-access";
    store.refreshToken = "old-refresh";
    store.expired = false;
    store.actuallyExpired = false;
    store.clear.mockRejectedValueOnce(
      new AuthenticationError("pre-commit clear failure with uncertain storage state"),
    );
    const manager = new AuthManager(settings, store);

    await expect(manager.logout()).rejects.toMatchObject({
      name: "AuthenticationError",
      message: "Unable to clear authentication tokens.",
    });

    await flushAsync();
    expect(store.clear).toHaveBeenCalledTimes(2);
    expect(store.getAccessToken()).toBeUndefined();
    expect(store.getRefreshToken()).toBeUndefined();
    expectStatus(manager, { state: "unauthenticated" });
  });
});
