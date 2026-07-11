import { createHash } from "node:crypto";

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
    const fetchToken = vi.fn(() => Promise.resolve(response));
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
    expect(fetchToken).toHaveBeenCalledWith(settings.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:
        "client_id=client-id&grant_type=authorization_code&code=authorization-code&redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2Fauth%2Fcallback&code_verifier=" +
        expectedVerifier,
    });
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

  test("returns the provider OAuth error description without exchanging a token", async () => {
    const listener = listenerFor({
      error: "access_denied",
      errorDescription: "The user cancelled sign-in.",
    });
    const fetchToken = vi.fn();

    await expectAuthenticationError(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([Buffer.alloc(32), Buffer.alloc(32)]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.resolve()),
        fetch: fetchToken,
      }),
      "OAuth error: access_denied — The user cancelled sign-in.",
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

  test("closes the listener when opening the browser fails", async () => {
    const listener = listenerFor({ code: "authorization-code", state: "unused" });
    const browserFailure = new Error("Browser unavailable");

    await expect(
      runBrowserLogin(settings, {
        randomBytes: randomBytesFrom([Buffer.alloc(32), Buffer.alloc(32)]),
        createCallbackListener: vi.fn(() => listener.listener),
        openBrowser: vi.fn(() => Promise.reject(browserFailure)),
        fetch: vi.fn(),
      }),
    ).rejects.toBe(browserFailure);

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
      "Token exchange failed: The authorization code was rejected.",
    );

    expect(error.message).not.toContain(code);
    expect(error.message).not.toContain(verifier);
    expect(error.message).not.toContain(state);
    expect(listener.close).toHaveBeenCalledTimes(1);
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
});

describe("createLoopbackCallbackListener", () => {
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
