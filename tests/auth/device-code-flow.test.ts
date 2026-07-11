import { describe, expect, test, vi } from "vitest";

import { AuthenticationError } from "../../src/errors.js";
import {
  startDeviceCodeLogin,
  type DeviceCodeFetch,
  type DeviceCodeSettings,
} from "../../src/auth/device-code-flow.js";
import type { TokenResponse } from "../../src/token-store.js";

const settings: DeviceCodeSettings = {
  azureClientId: "client-id",
  authority: "https://login.microsoftonline.com/tenant",
  tokenEndpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
  scopes: ["openid", "profile", "User.Read"],
};

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(() => Promise.resolve(body)),
  };
}

function deviceResponse(overrides: Record<string, unknown> = {}) {
  return {
    device_code: "private-device-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://microsoft.com/devicelogin",
    expires_in: 900,
    interval: 2,
    message: "Open the verification page and enter the code.",
    ...overrides,
  };
}

function sequenceFetch(responses: ReturnType<typeof response>[]): DeviceCodeFetch {
  let index = 0;
  return vi.fn(() => {
    const next = responses[index++];
    if (next === undefined) {
      throw new Error("Unexpected fetch");
    }
    return Promise.resolve(next);
  });
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

async function expectAuthenticationError(
  operation: Promise<unknown>,
  expectedMessage: string,
): Promise<AuthenticationError> {
  let rejection: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(AuthenticationError);
  expect((rejection as AuthenticationError).message).toBe(expectedMessage);
  return rejection as AuthenticationError;
}

describe("startDeviceCodeLogin", () => {
  test("posts the exact device request and returns public details before polling", async () => {
    const fetch = sequenceFetch([response(200, deviceResponse())]);
    const store = vi.fn<(tokens: TokenResponse) => Promise<void>>(() => Promise.resolve());

    const session = await startDeviceCodeLogin(settings, { store }, { fetch, now: () => 10_000 });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(endpoint).toBe("https://login.microsoftonline.com/tenant/oauth2/v2.0/devicecode");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=client-id&scope=openid+profile+User.Read",
    });
    expect(init.signal).toBeDefined();
    expect(session.details).toEqual({
      userCode: "ABCD-EFGH",
      verificationUri: "https://microsoft.com/devicelogin",
      expiresAt: 910_000,
      message: "Open the verification page and enter the code.",
    });
    expect(JSON.stringify(session)).not.toContain("private-device-code");
    expect(store).not.toHaveBeenCalled();
  });

  test("uses the five-second protocol default when interval is absent", async () => {
    const fetch = sequenceFetch([
      response(200, deviceResponse({ interval: undefined })),
      response(200, { access_token: "access-secret" }),
    ]);
    const sleep = vi.fn(() => Promise.resolve());
    const session = await startDeviceCodeLogin(
      settings,
      { store: vi.fn(() => Promise.resolve()) },
      { fetch, sleep, now: () => 10_000 },
    );

    await session.poll();

    expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
  });

  test("polls pending then slow_down then success with exact delay progression and stores tokens", async () => {
    const fetch = sequenceFetch([
      response(200, deviceResponse()),
      response(400, { error: "authorization_pending" }),
      response(400, { error: "slow_down" }),
      response(200, {
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 3600,
      }),
    ]);
    const delays: number[] = [];
    const sleep = vi.fn((milliseconds: number) => {
      delays.push(milliseconds);
      return Promise.resolve();
    });
    const store = vi.fn<(tokens: TokenResponse) => Promise<void>>(() => Promise.resolve());

    const session = await startDeviceCodeLogin(
      settings,
      { store },
      { fetch, sleep, now: () => 10_000 },
    );
    await session.poll();

    expect(delays).toEqual([2_000, 2_000, 7_000]);
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(fetch).mock.calls.slice(1)) {
      const [endpoint, init] = call;
      expect(endpoint).toBe(settings.tokenEndpoint);
      expect(init.body).toBe(
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=client-id&device_code=private-device-code",
      );
      expect(init.signal).toBeDefined();
    }
    expect(store).toHaveBeenCalledWith({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      expires_in: 3600,
    });
  });

  test.each([
    ["authorization_declined", "Device-code login was declined."],
    ["expired_token", "Device code expired. Start login again."],
  ])("fails deterministically for %s", async (providerError, expectedMessage) => {
    const fetch = sequenceFetch([
      response(200, deviceResponse()),
      response(400, { error: providerError, error_description: "private fragment" }),
    ]);
    const session = await startDeviceCodeLogin(
      settings,
      { store: vi.fn() },
      { fetch, sleep: () => Promise.resolve(), now: () => 10_000 },
    );

    const error = await expectAuthenticationError(session.poll(), expectedMessage);

    expect(error.message).not.toContain("private");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("stops at local expiry without another token request", async () => {
    let now = 10_000;
    const fetch = sequenceFetch([response(200, deviceResponse({ expires_in: 1 }))]);
    const session = await startDeviceCodeLogin(
      settings,
      { store: vi.fn() },
      {
        fetch,
        now: () => now,
        sleep: () => {
          now = 11_000;
          return Promise.resolve();
        },
      },
    );

    await expectAuthenticationError(session.poll(), "Device code expired. Start login again.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["not an object", null],
    ["missing device code", deviceResponse({ device_code: undefined })],
    ["empty user code", deviceResponse({ user_code: "" })],
    ["empty verification URI", deviceResponse({ verification_uri: "" })],
    ["empty message", deviceResponse({ message: "" })],
    ["noninteger expiry", deviceResponse({ expires_in: 1.5 })],
    ["unsafe expiry", deviceResponse({ expires_in: Number.MAX_SAFE_INTEGER + 1 })],
    ["nonpositive interval", deviceResponse({ interval: 0 })],
    ["unsafe interval", deviceResponse({ interval: Number.MAX_SAFE_INTEGER + 1 })],
  ])("rejects malformed device responses: %s", async (_name, body) => {
    const fetch = sequenceFetch([response(200, body)]);

    const error = await expectAuthenticationError(
      startDeviceCodeLogin(settings, { store: vi.fn() }, { fetch }),
      "Device-code endpoint returned an invalid response.",
    );

    expect(error.message).not.toContain("private-device-code");
  });

  test("rejects malformed successful token responses without leaking values", async () => {
    const fetch = sequenceFetch([
      response(200, deviceResponse()),
      response(200, { access_token: "", refresh_token: "refresh-secret" }),
    ]);
    const session = await startDeviceCodeLogin(
      settings,
      { store: vi.fn() },
      { fetch, sleep: () => Promise.resolve(), now: () => 10_000 },
    );

    const error = await expectAuthenticationError(
      session.poll(),
      "Token endpoint returned an invalid token response.",
    );
    expect(error.message).not.toContain("refresh-secret");
  });

  test("sanitizes request and polling network failures", async () => {
    const requestFetch: DeviceCodeFetch = vi.fn(() =>
      Promise.reject(new Error("network private-device-code fragment")),
    );
    const requestError = await expectAuthenticationError(
      startDeviceCodeLogin(settings, { store: vi.fn() }, { fetch: requestFetch }),
      "Unable to request a device code.",
    );
    expect(requestError.message).not.toContain("private");

    const pollFetch: DeviceCodeFetch = vi
      .fn()
      .mockResolvedValueOnce(response(200, deviceResponse()))
      .mockRejectedValueOnce(new Error("network private-device-code fragment"));
    const session = await startDeviceCodeLogin(
      settings,
      { store: vi.fn() },
      { fetch: pollFetch, sleep: () => Promise.resolve(), now: () => 10_000 },
    );
    const pollError = await expectAuthenticationError(
      session.poll(),
      "Device-code token polling failed.",
    );
    expect(pollError.message).not.toContain("private-device-code");
  });

  test("sanitizes unknown provider polling errors", async () => {
    const fetch = sequenceFetch([
      response(200, deviceResponse()),
      response(400, {
        error: "provider_private_failure",
        error_description: "private-device-code access-secret",
      }),
    ]);
    const session = await startDeviceCodeLogin(
      settings,
      { store: vi.fn() },
      { fetch, sleep: () => Promise.resolve(), now: () => 10_000 },
    );

    const error = await expectAuthenticationError(
      session.poll(),
      "Device-code token polling failed.",
    );

    expect(error.message).not.toContain("private");
    expect(error.message).not.toContain("access-secret");
  });

  test("cancellation aborts prompt sleep and prevents token requests", async () => {
    const controller = new AbortController();
    const fetch = sequenceFetch([response(200, deviceResponse())]);
    const sleep = vi.fn((_milliseconds: number, signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const session = await startDeviceCodeLogin(
      settings,
      { store: vi.fn() },
      { fetch, sleep, signal: controller.signal, now: () => 10_000 },
    );

    const polling = session.poll();
    controller.abort();

    await expectAuthenticationError(polling, "Device-code login was cancelled.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("cancellation settles even when injected sleep ignores the signal", async () => {
    const controller = new AbortController();
    const fetch = sequenceFetch([response(200, deviceResponse())]);
    const session = await startDeviceCodeLogin(
      settings,
      { store: vi.fn() },
      {
        fetch,
        sleep: () => new Promise<void>(() => undefined),
        signal: controller.signal,
        now: () => 10_000,
      },
    );

    const polling = session.poll();
    controller.abort();

    await expectAuthenticationError(settlesPromptly(polling), "Device-code login was cancelled.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
