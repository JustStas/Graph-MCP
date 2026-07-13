import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";

import { describe, expect, test, vi, type Mock } from "vitest";

import { AuthenticationError } from "../../src/errors.js";
import {
  buildAuthorizationUrl,
  createLoopbackCallbackListener,
  generatePkce,
  runBrowserLogin,
  type BrowserLoginSettings,
  type CallbackListener,
  type OAuthCallback,
  type TokenEndpointResponse,
} from "../../src/auth/browser-flow.js";

const settings: BrowserLoginSettings = {
  azureClientId: "client-id",
  graphRedirectUri: "http://127.0.0.1:4567/auth/callback",
  authorizeEndpoint: "https://login.example.test/authorize",
  tokenEndpoint: "https://login.example.test/token",
  scopes: ["openid", "profile", "User.Read"],
};

interface ListenerFixture {
  readonly listener: CallbackListener;
  readonly start: Mock<() => Promise<void>>;
  readonly waitForCallback: Mock<() => Promise<OAuthCallback>>;
  readonly close: Mock<() => Promise<void>>;
}

function listenerFor(callback: OAuthCallback): ListenerFixture {
  const start = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const waitForCallback = vi.fn<() => Promise<OAuthCallback>>(() => Promise.resolve(callback));
  const close = vi.fn<() => Promise<void>>(() => Promise.resolve());

  return {
    listener: { start, waitForCallback, close },
    start,
    waitForCallback,
    close,
  };
}

function successResponse(
  payload = { access_token: "access-token", refresh_token: "refresh-token" },
) {
  const json = vi.fn<() => Promise<typeof payload>>(() => Promise.resolve(payload));
  const text = vi.fn<() => Promise<string>>(() => Promise.resolve(""));

  return {
    response: {
      ok: true,
      status: 200,
      json,
      text,
    } satisfies TokenEndpointResponse,
    json,
    text,
  };
}

function randomBytesFrom(buffers: readonly Buffer[]): (size: number) => Buffer {
  let index = 0;
  return (size: number) => {
    const buffer = buffers[index++];
    if (buffer === undefined) {
      throw new Error("Unexpected random byte request");
    }
    expect(size).toBe(buffer.length);
    return buffer;
  };
}

function never<Value>(): Promise<Value> {
  return new Promise<Value>(() => undefined);
}

function waitForSocket(socket: Socket, event: "connect" | "close"): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.once(event, () => resolve());
    socket.once("error", reject);
  });
}

function waitForSocketClose(socket: Socket): Promise<void> {
  return new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
}

function settlesPromptly<Value>(promise: Promise<Value>, timeoutMs = 500): Promise<Value> {
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

function sendRawHttpRequest(host: string, port: number, request: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(response));
    socket.once("connect", () => socket.end(request));
  });
}

async function expectAuthenticationError(
  operation: Promise<unknown>,
  message: string,
): Promise<AuthenticationError> {
  let rejected: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    rejected = error;
  }

  expect(rejected).toBeInstanceOf(AuthenticationError);
  const authenticationError = rejected as AuthenticationError;
  expect(authenticationError.message).toBe(message);
  return authenticationError;
}

describe("generatePkce", () => {
  test("creates an RFC 7636 verifier and exact SHA-256 base64url challenge", () => {
    const verifierSource = Buffer.from(Array.from({ length: 32 }, (_value, index) => index));
    const { verifier, challenge } = generatePkce({
      randomBytes: randomBytesFrom([verifierSource]),
    });
    const expectedChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

    expect(verifier).toBe(verifierSource.toString("base64url"));
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(expectedChallenge);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("buildAuthorizationUrl", () => {
  test("includes every OAuth authorization field with the configured ordered scopes", () => {
    const authorizationUrl = new URL(
      buildAuthorizationUrl(settings, {
        state: "csrf-state",
        challenge: "pkce-challenge",
      }),
    );

    expect(authorizationUrl.origin).toBe("https://login.example.test");
    expect(authorizationUrl.pathname).toBe("/authorize");
    expect(authorizationUrl.searchParams.get("client_id")).toBe(settings.azureClientId);
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(settings.graphRedirectUri);
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid profile User.Read");
    expect(authorizationUrl.searchParams.get("state")).toBe("csrf-state");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("runBrowserLogin", () => {
  test("clamps an oversized timeout before invoking the timeout runner", async () => {
    const verifierSource = Buffer.alloc(32);
    const stateSource = Buffer.alloc(32, 1);
    const listener = listenerFor({
      code: "authorization-code",
      state: stateSource.toString("base64url"),
    });
    const { response } = successResponse();
    let receivedTimeoutMs: number | undefined;

    await runBrowserLogin(settings, {
      randomBytes: randomBytesFrom([verifierSource, stateSource]),
      createCallbackListener: () => listener.listener,
      openBrowser: () => Promise.resolve(),
      fetch: () => Promise.resolve(response),
      timeoutMs: Number.MAX_SAFE_INTEGER,
      timeout: <Value>(operation: Promise<Value>, timeoutMs: number) => {
        receivedTimeoutMs = timeoutMs;
        return operation;
      },
    });

    expect(receivedTimeoutMs).toBe(2_147_483_647);
  });

  test("waits for listener readiness before opening the browser", async () => {
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const events: string[] = [];
    const stateSource = Buffer.alloc(32);
    const listener = listenerFor({
      code: "authorization-code",
      state: stateSource.toString("base64url"),
    });
    listener.start.mockImplementation(async () => {
      events.push("start");
      await ready;
      events.push("ready");
    });
    const { response } = successResponse();
    const openBrowser = vi.fn(() => {
      events.push("open");
      return Promise.resolve();
    });

    const login = runBrowserLogin(settings, {
      randomBytes: randomBytesFrom([Buffer.alloc(32), stateSource]),
      createCallbackListener: vi.fn(() => listener.listener),
      openBrowser,
      fetch: vi.fn(() => Promise.resolve(response)),
    });

    await Promise.resolve();
    expect(openBrowser).not.toHaveBeenCalled();
    markReady?.();

    await login;

    expect(events).toEqual(["start", "ready", "open"]);
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("exchanges a successful callback using exact URL-encoded PKCE token fields", async () => {
    const verifierSource = Buffer.alloc(32);
    const stateSource = Buffer.alloc(32, 1);
    const expectedState = stateSource.toString("base64url");
    const expectedVerifier = verifierSource.toString("base64url");
    const listener = listenerFor({ code: "authorization-code", state: expectedState });
    const { response } = successResponse();
    let requestedEndpoint = "";
    let tokenRequest: RequestInit | undefined;
    const fetchToken = vi.fn((endpoint: string, init: RequestInit) => {
      requestedEndpoint = endpoint;
      tokenRequest = init;
      return Promise.resolve(response);
    });
    let openedUrl = "";
    const openBrowser = vi.fn((url: string) => {
      openedUrl = url;
      return Promise.resolve();
    });

    const tokens = await runBrowserLogin(settings, {
      randomBytes: randomBytesFrom([verifierSource, stateSource]),
      createCallbackListener: vi.fn(() => listener.listener),
      openBrowser,
      fetch: fetchToken,
    });

    expect(tokens).toEqual({ access_token: "access-token", refresh_token: "refresh-token" });
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(requestedEndpoint).toBe(settings.tokenEndpoint);
    expect(tokenRequest?.method).toBe("POST");
    expect(tokenRequest?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(tokenRequest?.body).toBe(
      "client_id=client-id&grant_type=authorization_code&code=authorization-code&redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2Fauth%2Fcallback&code_verifier=" +
        expectedVerifier,
    );
    expect(tokenRequest?.signal).toBeDefined();
    expect(new URL(openedUrl).searchParams.get("state")).toBe(expectedState);
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("rejects a mismatched callback state with the exact CSRF error", async () => {
    const listener = listenerFor({ code: "authorization-code", state: "attacker-state" });
    const fetchToken = vi.fn();

    await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([Buffer.alloc(32), Buffer.alloc(32)]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: fetchToken,
      }),
      "Invalid state parameter — possible CSRF attack",
    );

    expect(fetchToken).not.toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("returns only an allowlisted provider OAuth error identifier", async () => {
    const verifierSource = Buffer.alloc(32);
    const stateSource = Buffer.alloc(32, 1);
    const listener = listenerFor({
      error: "access_denied",
      errorDescription: "The user cancelled sign-in.",
      state: stateSource.toString("base64url"),
    });
    const fetchToken = vi.fn();

    await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([verifierSource, stateSource]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: fetchToken,
      }),
      "OAuth error: access_denied",
    );

    expect(fetchToken).not.toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("rejects a provider error callback with a mismatched state as possible CSRF", async () => {
    const listener = listenerFor({
      error: "access_denied",
      errorDescription: "The user cancelled sign-in.",
      state: "attacker-state",
    });
    const fetchToken = vi.fn();

    await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([Buffer.alloc(32), Buffer.alloc(32)]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: fetchToken,
      }),
      "Invalid state parameter — possible CSRF attack",
    );

    expect(fetchToken).not.toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  for (const [stateName, callback] of [
    ["missing", { error: "access_denied", errorDescription: "The user cancelled sign-in." }],
    [
      "empty",
      { error: "access_denied", errorDescription: "The user cancelled sign-in.", state: "" },
    ],
  ] as const) {
    test(`treats a provider error callback with ${stateName} state as a cancelled login`, async () => {
      const listener = listenerFor(callback);
      const fetchToken = vi.fn();

      await expectAuthenticationError(
        runBrowserLogin(settings, {
          randomBytes: randomBytesFrom([Buffer.alloc(32), Buffer.alloc(32)]),
          createCallbackListener: vi.fn(() => listener.listener),
          openBrowser: vi.fn(() => Promise.resolve()),
          fetch: fetchToken,
        }),
        "Login timed out or was cancelled.",
      );

      expect(fetchToken).not.toHaveBeenCalled();
      expect(listener.close).toHaveBeenCalledTimes(1);
    });
  }

  test("omits callback secrets and provider descriptions from OAuth errors", async () => {
    const verifierSource = Buffer.alloc(32);
    const stateSource = Buffer.alloc(32, 1);
    const verifier = verifierSource.toString("base64url");
    const state = stateSource.toString("base64url");
    const code = "authorization-code-secret";
    const accessToken = "callback-access-token-secret";
    const refreshToken = "callback-refresh-token-secret";
    const listener = listenerFor({
      code,
      error: "access_denied",
      errorDescription: `Provider ${accessToken} ${refreshToken} ${code} ${verifier} ${state}`,
      state,
    });
    const fetchToken = vi.fn();

    const error = await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([verifierSource, stateSource]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: fetchToken,
      }),
      "OAuth error: access_denied",
    );

    for (const secret of [accessToken, refreshToken, code, verifier, state]) {
      expect(error.message).not.toContain(secret);
    }
    expect(fetchToken).not.toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("uses unknown when the provider error identifier is not allowlisted", async () => {
    const verifierSource = Buffer.alloc(32);
    const stateSource = Buffer.alloc(32, 1);
    const listener = listenerFor({
      error: "access denied with provider text",
      errorDescription: "The user cancelled sign-in.",
      state: stateSource.toString("base64url"),
    });
    const fetchToken = vi.fn();

    await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([verifierSource, stateSource]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: fetchToken,
      }),
      "OAuth error: unknown",
    );

    expect(fetchToken).not.toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("treats a missing callback code or state as a cancelled login and closes once", async () => {
    const listener = listenerFor({ code: "authorization-code" });
    const fetchToken = vi.fn();

    await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([Buffer.alloc(32), Buffer.alloc(32)]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: fetchToken,
      }),
      "Login timed out or was cancelled.",
    );

    expect(fetchToken).not.toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("treats an empty callback state as a cancelled login", async () => {
    const listener = listenerFor({ code: "authorization-code", state: "" });

    await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([Buffer.alloc(32), Buffer.alloc(32)]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: vi.fn(),
      }),
      "Login timed out or was cancelled.",
    );

    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("times out an absent callback through the injected timeout runner and closes once", async () => {
    const listener = listenerFor({ code: "authorization-code", state: "unused" });
    listener.waitForCallback.mockImplementation(() => new Promise<OAuthCallback>(() => undefined));
    const timeout = vi.fn(() =>
      Promise.reject(new AuthenticationError("Login timed out or was cancelled.")),
    );

    await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([Buffer.alloc(32), Buffer.alloc(32)]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: vi.fn(),
        timeout,
      }),
      "Login timed out or was cancelled.",
    );

    expect(timeout).toHaveBeenCalledWith(expect.any(Promise), 120_000);
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("sanitizes browser-open failures containing the authorization URL and credentials", async () => {
    const verifierSource = Buffer.alloc(32);
    const stateSource = Buffer.alloc(32, 1);
    const verifier = verifierSource.toString("base64url");
    const state = stateSource.toString("base64url");
    const code = "browser-open-code-secret";
    const accessToken = "browser-open-access-secret";
    const refreshToken = "browser-open-refresh-secret";
    const listener = listenerFor({ code: "unused", state: "unused" });
    let openedUrl = "";

    const error = await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([verifierSource, stateSource]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn((url: string) => {
          openedUrl = url;
          return Promise.reject(
            new Error(`${url} ${accessToken} ${refreshToken} ${code} ${verifier} ${state}`),
          );
        }),
        fetch: vi.fn(),
      }),
      "Unable to open browser for authentication.",
    );

    expect(openedUrl).toContain(state);
    for (const secret of [openedUrl, accessToken, refreshToken, code, verifier, state]) {
      expect(error.message).not.toContain(secret);
    }
    expect(listener.waitForCallback).not.toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("closes the listener after a token error while redacting PKCE secrets", async () => {
    const verifierSource = Buffer.alloc(32);
    const stateSource = Buffer.alloc(32, 1);
    const verifier = verifierSource.toString("base64url");
    const state = stateSource.toString("base64url");
    const code = "authorization-code-secret";
    const listener = listenerFor({ code, state });
    const tokenResponse = {
      ok: false,
      status: 400,
      json: vi.fn(),
      text: vi.fn(() =>
        Promise.resolve(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "The authorization code was rejected.",
            diagnostic: `${code} ${verifier} ${state}`,
          }),
        ),
      ),
    } satisfies TokenEndpointResponse;

    const error = await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([verifierSource, stateSource]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: vi.fn(() => Promise.resolve(tokenResponse)),
      }),
      "Token exchange failed: invalid_grant",
    );

    expect(error.message).not.toContain(code);
    expect(error.message).not.toContain(verifier);
    expect(error.message).not.toContain(state);
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("never includes a raw token-endpoint error body in an authentication error", async () => {
    const verifierSource = Buffer.alloc(32);
    const stateSource = Buffer.alloc(32, 1);
    const verifier = verifierSource.toString("base64url");
    const state = stateSource.toString("base64url");
    const code = "token-body-authorization-code";
    const accessToken = "token-body-access-secret";
    const refreshToken = "token-body-refresh-secret";
    const listener = listenerFor({ code, state });
    const tokenResponse = {
      ok: false,
      status: 400,
      json: vi.fn(),
      text: vi.fn(() =>
        Promise.resolve(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken,
            code,
            verifier,
            state,
          }),
        ),
      ),
    } satisfies TokenEndpointResponse;

    const error = await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([verifierSource, stateSource]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: vi.fn(() => Promise.resolve(tokenResponse)),
      }),
      "Token exchange failed with status 400.",
    );

    for (const secret of [accessToken, refreshToken, code, verifier, state]) {
      expect(error.message).not.toContain(secret);
    }
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test.each(["access_token", "refresh_token"] as const)(
    "never echoes a token-shaped %s value used as the OAuth error identifier",
    async (credentialField) => {
      const verifierSource = Buffer.alloc(32);
      const stateSource = Buffer.alloc(32, 1);
      const verifier = verifierSource.toString("base64url");
      const state = stateSource.toString("base64url");
      const code = "token-identifier-authorization-code";
      const accessToken = "tokenidentifieraccesssecret";
      const refreshToken = "tokenidentifierrefreshsecret";
      const tokenBody = {
        access_token: accessToken,
        refresh_token: refreshToken,
      };
      const listener = listenerFor({ code, state });
      const tokenResponse = {
        ok: false,
        status: 400,
        json: vi.fn(),
        text: vi.fn(() =>
          Promise.resolve(
            JSON.stringify({
              error: tokenBody[credentialField],
              ...tokenBody,
            }),
          ),
        ),
      } satisfies TokenEndpointResponse;

      const error = await expectAuthenticationError(
        runBrowserLogin(settings, {
          randomBytes: randomBytesFrom([verifierSource, stateSource]),
          createCallbackListener: vi.fn(() => listener.listener),
          openBrowser: vi.fn(() => Promise.resolve()),
          fetch: vi.fn(() => Promise.resolve(tokenResponse)),
        }),
        "Token exchange failed with status 400.",
      );

      for (const secret of [accessToken, refreshToken, code, verifier, state]) {
        expect(error.message).not.toContain(secret);
      }
      expect(listener.close).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["access_token", "refresh_token"] as const)(
    "does not echo an allowlisted identifier when it is also the %s value",
    async (credentialField) => {
      const verifierSource = Buffer.alloc(32);
      const stateSource = Buffer.alloc(32, 1);
      const state = stateSource.toString("base64url");
      const code = "allowlist-collision-authorization-code";
      const listener = listenerFor({ code, state });
      const tokenResponse = {
        ok: false,
        status: 400,
        json: vi.fn(),
        text: vi.fn(() =>
          Promise.resolve(
            JSON.stringify({
              error: "invalid_grant",
              access_token: "access-secret",
              refresh_token: "refresh-secret",
              [credentialField]: "invalid_grant",
            }),
          ),
        ),
      } satisfies TokenEndpointResponse;

      const error = await expectAuthenticationError(
        runBrowserLogin(settings, {
          randomBytes: randomBytesFrom([verifierSource, stateSource]),
          createCallbackListener: vi.fn(() => listener.listener),
          openBrowser: vi.fn(() => Promise.resolve()),
          fetch: vi.fn(() => Promise.resolve(tokenResponse)),
        }),
        "Token exchange failed with status 400.",
      );

      expect(error.message).not.toContain("invalid_grant");
      expect(listener.close).toHaveBeenCalledTimes(1);
    },
  );

  test("snapshots mutable settings before asynchronous browser-login work", async () => {
    const mutableSettings = { ...settings, scopes: [...settings.scopes] };
    const verifierSource = Buffer.alloc(32);
    const stateSource = Buffer.alloc(32, 1);
    const expectedState = stateSource.toString("base64url");
    const listener = listenerFor({ code: "authorization-code", state: expectedState });
    listener.start.mockImplementation(() => {
      mutableSettings.azureClientId = "mutated-client";
      mutableSettings.graphRedirectUri = "http://127.0.0.1:9876/mutated";
      mutableSettings.authorizeEndpoint = "https://attacker.example/authorize";
      mutableSettings.tokenEndpoint = "https://attacker.example/token";
      mutableSettings.scopes.splice(0, mutableSettings.scopes.length, "Mutated.Scope");
      return Promise.resolve();
    });
    const { response } = successResponse();
    let openedUrl = "";
    let tokenEndpoint = "";
    let tokenRequest: RequestInit | undefined;

    await runBrowserLogin(mutableSettings, {
      randomBytes: randomBytesFrom([verifierSource, stateSource]),
      createCallbackListener: vi.fn(() => listener.listener),
      openBrowser: vi.fn((url: string) => {
        openedUrl = url;
        return Promise.resolve();
      }),
      fetch: vi.fn((endpoint: string, init: RequestInit) => {
        tokenEndpoint = endpoint;
        tokenRequest = init;
        return Promise.resolve(response);
      }),
    });

    const authorizationUrl = new URL(openedUrl);
    expect(authorizationUrl.origin).toBe("https://login.example.test");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-id");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:4567/auth/callback",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid profile User.Read");
    expect(tokenEndpoint).toBe("https://login.example.test/token");
    expect(tokenRequest?.body).toContain("client_id=client-id");
    expect(tokenRequest?.body).toContain(
      "redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2Fauth%2Fcallback",
    );
  });

  test("rejects non-loopback and non-http redirect URIs before binding or opening", async () => {
    for (const graphRedirectUri of [
      "https://localhost:4567/auth/callback",
      "http://example.test/auth/callback",
    ]) {
      const createCallbackListener = vi.fn();
      const openBrowser = vi.fn();

      await expect(
        runBrowserLogin(
          { ...settings, graphRedirectUri },
          {
            createCallbackListener,
            openBrowser,
            fetch: vi.fn(),
          },
        ),
      ).rejects.toBeInstanceOf(AuthenticationError);

      expect(createCallbackListener).not.toHaveBeenCalled();
      expect(openBrowser).not.toHaveBeenCalled();
    }
  });

  test("rejects a port-zero redirect URI before creating the listener or opening the browser", async () => {
    const createCallbackListener = vi.fn();
    const openBrowser = vi.fn();

    await expectAuthenticationError(
      runBrowserLogin(
        { ...settings, graphRedirectUri: "http://127.0.0.1:0/auth/callback" },
        {
          createCallbackListener,
          openBrowser,
          fetch: vi.fn(),
        },
      ),
      "graphRedirectUri must not use port 0.",
    );

    expect(createCallbackListener).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  test("preserves a listener callback failure instead of rewriting it as a timeout", async () => {
    const listener = listenerFor({ code: "unused", state: "unused" });
    const callbackFailure = new AuthenticationError("Loopback callback listener failed.");
    listener.waitForCallback.mockImplementation(() => Promise.reject(callbackFailure));

    await expect(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([Buffer.alloc(32), Buffer.alloc(32)]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: vi.fn(),
      }),
    ).rejects.toBe(callbackFailure);

    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("times out a listener start that never resolves and closes once", async () => {
    const listener = listenerFor({ code: "unused", state: "unused" });
    listener.start.mockImplementation(() => never<void>());

    await expectAuthenticationError(
      settlesPromptly(
        runBrowserLogin(settings, {
          randomBytes: randomBytesFrom([Buffer.alloc(32), Buffer.alloc(32)]),
          createCallbackListener: vi.fn(() => listener.listener),
          openBrowser: vi.fn(),
          fetch: vi.fn(),
          timeoutMs: 25,
        }),
      ),
      "Login timed out or was cancelled.",
    );

    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("times out a browser opener that never resolves and closes once", async () => {
    const stateSource = Buffer.alloc(32, 1);
    const listener = listenerFor({
      code: "authorization-code",
      state: stateSource.toString("base64url"),
    });

    await expectAuthenticationError(
      settlesPromptly(
        runBrowserLogin(settings, {
          randomBytes: randomBytesFrom([Buffer.alloc(32), stateSource]),
          createCallbackListener: vi.fn(() => listener.listener),
          openBrowser: vi.fn(() => never<unknown>()),
          fetch: vi.fn(),
          timeoutMs: 25,
        }),
      ),
      "Login timed out or was cancelled.",
    );

    expect(listener.waitForCallback).not.toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("times out token fetches, aborts their signal, and closes once", async () => {
    const verifierSource = Buffer.alloc(32);
    const stateSource = Buffer.alloc(32, 1);
    const listener = listenerFor({
      code: "authorization-code",
      state: stateSource.toString("base64url"),
    });
    let fetchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    const fetchToken = vi.fn((_input: string, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      fetchStarted?.();
      return never<TokenEndpointResponse>();
    });

    const login = runBrowserLogin(settings, {
      randomBytes: randomBytesFrom([verifierSource, stateSource]),
      createCallbackListener: vi.fn(() => listener.listener),
      openBrowser: vi.fn(() => Promise.resolve()),
      fetch: fetchToken,
      timeoutMs: 25,
    });
    await started;

    await expectAuthenticationError(settlesPromptly(login), "Login timed out or was cancelled.");

    expect(requestSignal?.aborted).toBe(true);
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("cancels an in-progress callback wait through an external abort signal", async () => {
    const stateSource = Buffer.alloc(32, 1);
    const listener = listenerFor({
      code: "authorization-code",
      state: stateSource.toString("base64url"),
    });
    let callbackWaitStarted: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      callbackWaitStarted = resolve;
    });
    listener.waitForCallback.mockImplementation(() => {
      callbackWaitStarted?.();
      return never<OAuthCallback>();
    });
    const controller = new AbortController();

    const login = runBrowserLogin(settings, {
      randomBytes: randomBytesFrom([Buffer.alloc(32), stateSource]),
      createCallbackListener: vi.fn(() => listener.listener),
      openBrowser: vi.fn(() => Promise.resolve()),
      fetch: vi.fn(),
      signal: controller.signal,
    });
    await waiting;
    controller.abort();

    await expectAuthenticationError(settlesPromptly(login), "Login timed out or was cancelled.");

    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("rejects malformed token JSON without exposing response fragments", async () => {
    const stateSource = Buffer.alloc(32, 1);
    const listener = listenerFor({
      code: "authorization-code",
      state: stateSource.toString("base64url"),
    });
    const responseFragment = "malformed-token-response-secret";
    const tokenResponse = {
      ok: true,
      status: 200,
      json: vi.fn(() => Promise.reject(new SyntaxError(responseFragment))),
      text: vi.fn(() => Promise.resolve("")),
    } satisfies TokenEndpointResponse;

    const error = await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([Buffer.alloc(32), stateSource]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: vi.fn(() => Promise.resolve(tokenResponse)),
      }),
      "Token endpoint returned an invalid token response.",
    );

    expect(error.message).not.toContain(responseFragment);
    expect(listener.close).toHaveBeenCalledTimes(1);
  });

  test("rejects empty and structurally invalid token responses without exposing response values", async () => {
    const invalidResponses: readonly [string, number, unknown, string][] = [
      ["204 response", 204, { access_token: "valid-but-empty-response" }, "204-response-secret"],
      ["empty response", 200, undefined, "empty-token-response-secret"],
      ["null", 200, null, "null-token-response-secret"],
      ["array", 200, [], "array-token-response-secret"],
      ["missing access token", 200, {}, "missing-token-response-secret"],
      ["empty access token", 200, { access_token: "" }, "empty-token-response-secret"],
      ["wrong access token type", 200, { access_token: 123 }, "wrong-token-response-secret"],
      [
        "wrong refresh token type",
        200,
        { access_token: "valid-access", refresh_token: 123 },
        "refresh-token-response-secret",
      ],
      [
        "wrong scope type",
        200,
        { access_token: "valid-access", scope: 123 },
        "scope-token-response-secret",
      ],
      [
        "invalid expiry",
        200,
        { access_token: "valid-access", expires_in: 1.5 },
        "expiry-token-response-secret",
      ],
    ];

    for (const responseCase of invalidResponses) {
      const status = responseCase[1];
      const payload = responseCase[2];
      const responseFragment = responseCase[3];
      const stateSource = Buffer.alloc(32, 1);
      const listener = listenerFor({
        code: "authorization-code",
        state: stateSource.toString("base64url"),
      });
      const tokenResponse = {
        ok: true,
        status,
        json: vi.fn(() => Promise.resolve(payload)),
        text: vi.fn(() => Promise.resolve(responseFragment)),
      } satisfies TokenEndpointResponse;

      const error = await expectAuthenticationError(
        runBrowserLogin(settings, {
          randomBytes: randomBytesFrom([Buffer.alloc(32), stateSource]),
          createCallbackListener: vi.fn(() => listener.listener),
          openBrowser: vi.fn(() => Promise.resolve()),
          fetch: vi.fn(() => Promise.resolve(tokenResponse)),
        }),
        "Token endpoint returned an invalid token response.",
      );

      expect(error.message).not.toContain(responseFragment);
      expect(listener.close).toHaveBeenCalledTimes(1);
    }
  });

  test("wraps token fetch failures without exposing network error text", async () => {
    const stateSource = Buffer.alloc(32, 1);
    const listener = listenerFor({
      code: "authorization-code",
      state: stateSource.toString("base64url"),
    });
    const networkSecret = "network-token-response-secret";

    const error = await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([Buffer.alloc(32), stateSource]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: vi.fn(() => Promise.reject(new Error(networkSecret))),
      }),
      "Token exchange failed.",
    );

    expect(error.message).not.toContain(networkSecret);
    expect(listener.close).toHaveBeenCalledTimes(1);
  });
});

describe("createLoopbackCallbackListener", () => {
  test("destroys incomplete-header sockets so close settles promptly", async () => {
    const listener = createLoopbackCallbackListener({
      redirectUri: "http://127.0.0.1:0/auth/callback",
      expectedState: "expected-state",
    });
    await listener.start();
    const callbackUrl = new URL(listener.callbackUrl);
    const socket = connect({ host: callbackUrl.hostname, port: Number(callbackUrl.port) });
    socket.on("error", () => undefined);

    try {
      await waitForSocket(socket, "connect");
      const socketClosed = waitForSocketClose(socket);
      socket.write("GET /auth/callback HTTP/1.1\r\nHost: 127.0.0.1\r\n");

      await settlesPromptly(listener.close());
      await settlesPromptly(socketClosed);
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      await listener.close();
    }
  });

  test("permanently closes before start and rejects a later start", async () => {
    const listener = createLoopbackCallbackListener({
      redirectUri: "http://127.0.0.1:0/auth/callback",
      expectedState: "expected-state",
    });

    try {
      const firstClose = listener.close();
      const repeatedClose = listener.close();

      expect(repeatedClose).toBe(firstClose);
      await expect(firstClose).resolves.toBeUndefined();
      await expect(listener.start()).rejects.toMatchObject({
        message: "Loopback callback listener is closed.",
      });
    } finally {
      await listener.close();
    }
  });

  test("rejects a standalone callback waiter promptly when normally closed", async () => {
    const listener = createLoopbackCallbackListener({
      redirectUri: "http://127.0.0.1:0/auth/callback",
      expectedState: "expected-state",
    });
    await listener.start();
    const callback = listener.waitForCallback();

    try {
      await listener.close();
      await expect(settlesPromptly(callback)).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Loopback callback listener is closed.",
      });
    } finally {
      await listener.close();
    }
  });

  test("stops a server that reports listening after close during start", async () => {
    const pendingServer = new EventEmitter() as unknown as Server;
    const close = vi.fn((callback?: (error?: Error) => void) => {
      callback?.();
      return pendingServer;
    });
    Object.assign(pendingServer, {
      address: () => null,
      close,
      closeAllConnections: vi.fn(),
      listen: vi.fn(() => pendingServer),
    });
    const listener = createLoopbackCallbackListener(
      {
        redirectUri: "http://127.0.0.1:0/auth/callback",
        expectedState: "expected-state",
      },
      {
        createServer: () => pendingServer,
      },
    );

    const starting = listener.start();
    await listener.close();
    await expect(settlesPromptly(starting)).rejects.toMatchObject({
      message: "Loopback callback listener is closed.",
    });
    pendingServer.emit("listening");

    expect(close).toHaveBeenCalled();
  });

  test("closes safely after a bind failure", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const blockerAddress = blocker.address();
    if (blockerAddress === null || typeof blockerAddress === "string") {
      throw new Error("Unable to reserve a loopback port.");
    }
    const listener = createLoopbackCallbackListener({
      redirectUri: `http://127.0.0.1:${blockerAddress.port}/auth/callback`,
      expectedState: "expected-state",
    });

    try {
      await expect(listener.start()).rejects.toBeInstanceOf(Error);
      await settlesPromptly(listener.close());
      await expect(listener.close()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test("rejects callback waiting with a fixed error after a post-start server failure", async () => {
    let server: Server | undefined;
    const listener = createLoopbackCallbackListener(
      {
        redirectUri: "http://127.0.0.1:0/auth/callback",
        expectedState: "expected-state",
      },
      {
        createServer: (handler) => {
          server = createServer(handler);
          return server;
        },
      },
    );

    try {
      await listener.start();
      expect(server).toBeDefined();
      if (server === undefined) {
        return;
      }

      const callback = listener.waitForCallback();
      server.emit("error", new Error("post-start-listener-secret"));

      await expect(callback).rejects.toMatchObject({
        name: "AuthenticationError",
        message: "Loopback callback listener failed.",
      });
      await listener.close();
    } finally {
      await listener.close();
    }
  });

  test("returns the fixed failure page for a callback with an empty code", async () => {
    const listener = createLoopbackCallbackListener({
      redirectUri: "http://127.0.0.1:0/auth/callback",
      expectedState: "expected-state",
    });
    await listener.start();
    const callback = listener.waitForCallback();

    try {
      const emptyCode = new URL(listener.callbackUrl);
      emptyCode.searchParams.set("code", "");
      emptyCode.searchParams.set("state", "expected-state");
      const response = await fetch(emptyCode);

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("Authentication failed.");
      await expect(callback).resolves.toEqual({ code: "", state: "expected-state" });
    } finally {
      await listener.close();
    }
  });

  test("keeps callback credentials out of the fixed failure response body", async () => {
    const listener = createLoopbackCallbackListener({
      redirectUri: "http://127.0.0.1:0/auth/callback",
      expectedState: "callback-state-secret",
    });
    await listener.start();
    const callback = listener.waitForCallback();
    const accessToken = "callback-page-access-secret";
    const refreshToken = "callback-page-refresh-secret";
    const verifier = "callback-page-verifier-secret";
    const code = "callback-page-code-secret";
    const state = "callback-state-secret";

    try {
      const callbackUrl = new URL(listener.callbackUrl);
      callbackUrl.searchParams.set("error", "access_denied");
      callbackUrl.searchParams.set(
        "error_description",
        `${accessToken} ${refreshToken} ${verifier} ${code} ${state}`,
      );
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);
      const response = await fetch(callbackUrl);
      const responseBody = await response.text();

      expect(response.status).toBe(200);
      expect(responseBody).toContain("Authentication failed.");
      for (const secret of [accessToken, refreshToken, verifier, code, state]) {
        expect(responseBody).not.toContain(secret);
      }
      await expect(callback).resolves.toMatchObject({
        error: "access_denied",
        code,
        state,
      });
    } finally {
      await listener.close();
    }
  });

  test("returns 400 for a malformed absolute request target and still accepts a valid callback", async () => {
    const listener = createLoopbackCallbackListener({
      redirectUri: "http://127.0.0.1:0/auth/callback",
      expectedState: "expected-state",
    });
    await listener.start();
    const callback = listener.waitForCallback();
    const callbackUrl = new URL(listener.callbackUrl);

    try {
      const malformedResponse = await sendRawHttpRequest(
        callbackUrl.hostname,
        Number(callbackUrl.port),
        "GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
      );

      expect(malformedResponse).toContain(" 400 ");
      expect(malformedResponse).toContain("Authentication failed.");

      let settled = false;
      void callback.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      callbackUrl.searchParams.set("code", "authorization-code");
      callbackUrl.searchParams.set("state", "expected-state");
      const validResponse = await fetch(callbackUrl);

      expect(validResponse.status).toBe(200);
      await expect(callback).resolves.toEqual({
        code: "authorization-code",
        state: "expected-state",
      });
    } finally {
      await listener.close();
    }
  });

  test("returns 404 for a wrong path and continues waiting for the configured callback path", async () => {
    const listener = createLoopbackCallbackListener({
      redirectUri: "http://127.0.0.1:0/auth/callback",
      expectedState: "expected-state",
    });
    await listener.start();
    const callback = listener.waitForCallback();

    try {
      const wrongPath = new URL(listener.callbackUrl);
      wrongPath.pathname = "/not-the-callback";
      const wrongResponse = await fetch(wrongPath);
      expect(wrongResponse.status).toBe(404);

      let settled = false;
      void callback.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      const validCallback = new URL(listener.callbackUrl);
      validCallback.searchParams.set("code", "authorization-code");
      validCallback.searchParams.set("state", "expected-state");
      const validResponse = await fetch(validCallback);

      expect(validResponse.status).toBe(200);
      await expect(callback).resolves.toEqual({
        code: "authorization-code",
        state: "expected-state",
      });
    } finally {
      await listener.close();
    }
  });
});
