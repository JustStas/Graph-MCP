import { describe, expect, test, vi } from "vitest";

import { GraphMcpError } from "../src/errors.js";
import { GraphClient } from "../src/graph-client.js";
import { RateLimiter } from "../src/rate-limiter.js";

function createHarness(timeoutMs = 1_000) {
  const authManager = {
    getValidAccessToken: vi.fn<() => Promise<string>>().mockResolvedValue("access-token"),
    refreshAccessToken: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
  const rateLimiter = new RateLimiter({
    maxRequests: 100,
    windowMs: 1_000,
  });
  const acquire = vi.spyOn(rateLimiter, "acquire").mockResolvedValue();
  const handle429 = vi.spyOn(rateLimiter, "handle429").mockReturnValue(2);
  const resetBackoff = vi.spyOn(rateLimiter, "resetBackoff").mockImplementation(() => undefined);
  const fetch = vi.fn<typeof globalThis.fetch>();
  const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue();
  const client = new GraphClient({
    authManager,
    rateLimiter,
    fetch,
    sleep,
    timeoutMs,
  });

  return {
    client,
    authManager,
    acquire,
    handle429,
    resetBackoff,
    fetch,
    sleep,
  };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function textResponse(
  value: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
  headers: Record<string, string> = {},
) {
  return new Response(value, {
    status,
    headers: {
      "Content-Type": contentType,
      ...headers,
    },
  });
}

function cancellableResponse(status: number, label: string, events: string[], cancelError?: Error) {
  const cancel = vi.fn(() => {
    events.push(`cancel:${label}`);
    if (cancelError !== undefined) {
      throw cancelError;
    }
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel,
  });

  return {
    response: new Response(body, { status }),
    cancel,
  };
}

function authorizationFor(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, call: number) {
  return new Headers(fetch.mock.calls[call]?.[1]?.headers).get("Authorization");
}

function requestUrl(input: RequestInfo | URL | undefined): URL {
  if (input === undefined) {
    throw new Error("Expected a fetch request URL");
  }
  if (typeof input === "string") {
    return new URL(input);
  }
  return input instanceof URL ? input : new URL(input.url);
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("Expected an Error rejection");
  }
  throw new Error("Expected operation to reject");
}

describe("GraphClient", () => {
  test("acquires the limiter before auth and sends an authorized encoded query", async () => {
    const harness = createHarness();
    harness.fetch.mockResolvedValue(jsonResponse({ value: [] }));

    await expect(
      harness.client.get("users", {
        $select: "displayName,mail",
        search: "Ada & Bob / London",
      }),
    ).resolves.toEqual({ value: [] });

    expect(harness.acquire).toHaveBeenCalledOnce();
    expect(harness.authManager.getValidAccessToken).toHaveBeenCalledOnce();
    expect(harness.fetch).toHaveBeenCalledOnce();

    const url = requestUrl(harness.fetch.mock.calls[0]?.[0]);
    expect(url.origin).toBe("https://graph.microsoft.com");
    expect(url.pathname).toBe("/v1.0/users");
    expect(url.searchParams.get("$select")).toBe("displayName,mail");
    expect(url.searchParams.get("search")).toBe("Ada & Bob / London");
    expect(url.href).not.toContain("Ada & Bob / London");

    const init = harness.fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(harness.acquire.mock.invocationCallOrder[0]).toBeLessThan(
      harness.authManager.getValidAccessToken.mock.invocationCallOrder[0] ?? 0,
    );
    expect(harness.authManager.getValidAccessToken.mock.invocationCallOrder[0]).toBeLessThan(
      harness.fetch.mock.invocationCallOrder[0] ?? 0,
    );
    expect(harness.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      harness.resetBackoff.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test.each([
    "https://attacker.example/collect",
    "/https://attacker.example/collect",
    "../beta/users",
    "%2e%2e/beta/users",
  ])("rejects unsafe Graph path %s before auth or fetch", async (path) => {
    const harness = createHarness();
    harness.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    const error = await rejectedError(harness.client.get(path));

    expect(error).toEqual(
      expect.objectContaining({
        name: "GraphMcpError",
        message: "Microsoft Graph request path must stay under /v1.0/.",
      }),
    );
    expect(harness.authManager.getValidAccessToken).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  test("keeps query-only paths on the Graph v1.0 base", async () => {
    const harness = createHarness();
    harness.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(harness.client.get("?$select=id")).resolves.toBeNull();

    const url = requestUrl(harness.fetch.mock.calls[0]?.[0]);
    expect(url.origin).toBe("https://graph.microsoft.com");
    expect(url.pathname).toBe("/v1.0/");
    expect(url.searchParams.get("$select")).toBe("id");
  });

  test("normalizes paths and routes every public verb through the request pipeline", async () => {
    const harness = createHarness();
    harness.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    await harness.client.get("/get");
    await harness.client.post("post");
    await harness.client.patch("/patch");
    await harness.client.put("put");
    await harness.client.delete("/delete");

    expect(
      harness.fetch.mock.calls.map(([input, init]) => ({
        method: init?.method,
        pathname: requestUrl(input).pathname,
      })),
    ).toEqual([
      { method: "GET", pathname: "/v1.0/get" },
      { method: "POST", pathname: "/v1.0/post" },
      { method: "PATCH", pathname: "/v1.0/patch" },
      { method: "PUT", pathname: "/v1.0/put" },
      { method: "DELETE", pathname: "/v1.0/delete" },
    ]);
    expect(harness.acquire).toHaveBeenCalledTimes(5);
    expect(harness.resetBackoff).toHaveBeenCalledTimes(5);
  });

  test("merges caller headers without allowing Authorization to be removed or replaced", async () => {
    const harness = createHarness();
    harness.fetch.mockResolvedValue(jsonResponse({ id: "me" }));

    await harness.client.get("/me", undefined, [
      ["authorization", "Bearer caller-token"],
      ["x-correlation-id", "correlation-123"],
    ]);

    const headers = new Headers(harness.fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer access-token");
    expect(headers.get("X-Correlation-Id")).toBe("correlation-123");
  });

  test("stringifies JSON bodies and forces the JSON content type", async () => {
    const harness = createHarness();
    harness.fetch.mockResolvedValue(jsonResponse({ id: "created" }));

    await harness.client.post("/items", { displayName: "Ada" }, undefined, {
      "Content-Type": "text/plain",
      "X-Test": "present",
    });

    const init = harness.fetch.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.body).toBe('{"displayName":"Ada"}');
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Test")).toBe("present");
  });

  test("passes binary bodies through and ignores a simultaneous JSON body", async () => {
    const harness = createHarness();
    const bytes = new Uint8Array([0, 1, 2, 255]);
    harness.fetch.mockResolvedValue(jsonResponse({ uploaded: true }));

    await harness.client.put("/drive/root/content", bytes, { ignored: true });

    const init = harness.fetch.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.body).toBeInstanceOf(Uint8Array);
    if (!(init?.body instanceof Uint8Array)) {
      throw new Error("Expected a Uint8Array request body");
    }
    expect(Array.from(init.body)).toEqual([0, 1, 2, 255]);
    expect(init?.body).not.toBe('{"ignored":true}');
    expect(headers.has("Content-Type")).toBe(false);
  });

  test("presents SharedArrayBuffer upload bytes to native Request as raw bytes", async () => {
    const harness = createHarness();
    const sharedBuffer = new SharedArrayBuffer(4);
    const source = new Uint8Array(sharedBuffer);
    source.set([1, 2, 3, 4]);
    let bodyUsesArrayBuffer = false;
    let nativeRequestBytes: number[] = [];
    harness.fetch.mockImplementation(async (input, init) => {
      const body = init?.body;
      if (!(body instanceof Uint8Array)) {
        throw new Error("Expected a Uint8Array request body");
      }
      bodyUsesArrayBuffer = body.buffer instanceof ArrayBuffer;
      const request = new Request(input, init);
      nativeRequestBytes = Array.from(new Uint8Array(await request.arrayBuffer()));
      return jsonResponse({ uploaded: true });
    });

    await expect(harness.client.put("/drive/root/content", source)).resolves.toEqual({
      uploaded: true,
    });

    expect(source.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(bodyUsesArrayBuffer).toBe(true);
    expect(nativeRequestBytes).toEqual([1, 2, 3, 4]);
  });

  test("reuses one upload byte snapshot across a 429 retry", async () => {
    const harness = createHarness();
    const source = new Uint8Array([1, 2, 3, 4]);
    const nativeRequestBodies: number[][] = [];
    let fetchAttempt = 0;
    harness.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      nativeRequestBodies.push(Array.from(new Uint8Array(await request.arrayBuffer())));
      fetchAttempt += 1;
      return fetchAttempt === 1
        ? textResponse("slow down", 429, "text/plain", { "Retry-After": "1" })
        : jsonResponse({ uploaded: true });
    });
    harness.sleep.mockImplementation(() => {
      source.set([9, 9, 9, 9]);
      return Promise.resolve();
    });

    await expect(harness.client.put("/drive/root/content", source)).resolves.toEqual({
      uploaded: true,
    });

    expect(Array.from(source)).toEqual([9, 9, 9, 9]);
    expect(nativeRequestBodies).toEqual([
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ]);
  });

  test("restricts PUT binary input to replayable bytes", () => {
    type PutBody = Parameters<GraphClient["put"]>[1];

    const bytes: PutBody = new Uint8Array([1, 2, 3]);
    const buffer: PutBody = Buffer.from([4, 5, 6]);
    // @ts-expect-error Blob bodies are not replayable across Graph retries.
    const blob: PutBody = new Blob(["not replayable"]);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(blob).toBeInstanceOf(Blob);
  });

  test("returns null for 204 and empty successful responses", async () => {
    const harness = createHarness();
    harness.fetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    await expect(harness.client.delete("/items/1")).resolves.toBeNull();
    await expect(harness.client.get("/items/empty")).resolves.toBeNull();
  });

  test("parses JSON content and preserves plain text and VTT content", async () => {
    const harness = createHarness();
    harness.fetch
      .mockResolvedValueOnce(jsonResponse({ value: [1, 2] }))
      .mockResolvedValueOnce(textResponse("plain response"))
      .mockResolvedValueOnce(
        textResponse("WEBVTT\n\n00:00.000 --> 00:01.000\nHello", 200, "text/vtt"),
      );

    await expect(harness.client.get("/json")).resolves.toEqual({ value: [1, 2] });
    await expect(harness.client.get("/text")).resolves.toBe("plain response");
    await expect(harness.client.get("/transcript")).resolves.toContain("WEBVTT");
  });

  test("returns malformed successful JSON as text and resets backoff", async () => {
    const harness = createHarness();
    const malformedJson = '{"value":';
    harness.fetch.mockResolvedValue(textResponse(malformedJson, 200, "application/json"));

    await expect(harness.client.get("/malformed-json")).resolves.toBe(malformedJson);

    expect(harness.resetBackoff).toHaveBeenCalledOnce();
  });

  test("converts a nested Graph error message into GraphApiError", async () => {
    const harness = createHarness();
    harness.fetch.mockResolvedValue(
      jsonResponse({ error: { code: "BadRequest", message: "Invalid request" } }, 400),
    );

    await expect(harness.client.get("/bad")).rejects.toMatchObject({
      name: "GraphApiError",
      message: "400: Invalid request",
      statusCode: 400,
    });
    expect(harness.resetBackoff).not.toHaveBeenCalled();
  });

  test("falls back to response text when a Graph error has no nested message", async () => {
    const harness = createHarness();
    const body = '{"error":{"code":"BadRequest"}}';
    harness.fetch.mockResolvedValue(textResponse(body, 400, "application/json"));

    await expect(harness.client.get("/bad")).rejects.toEqual(
      expect.objectContaining({
        name: "GraphApiError",
        message: `400: ${body}`,
        statusCode: 400,
      }),
    );
  });

  test("honors Retry-After, sleeps, reacquires a token, and retries one 429", async () => {
    const harness = createHarness();
    harness.authManager.getValidAccessToken
      .mockResolvedValueOnce("first-token")
      .mockResolvedValueOnce("retry-token");
    harness.handle429.mockReturnValue(2.5);
    harness.fetch
      .mockResolvedValueOnce(textResponse("slow down", 429, "text/plain", { "Retry-After": "1.5" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(harness.client.get("/throttled")).resolves.toEqual({ ok: true });

    expect(harness.acquire).toHaveBeenCalledOnce();
    expect(harness.handle429).toHaveBeenCalledOnce();
    expect(harness.handle429).toHaveBeenCalledWith(1.5);
    expect(harness.sleep).toHaveBeenCalledOnce();
    expect(harness.sleep).toHaveBeenCalledWith(2_500);
    expect(harness.authManager.getValidAccessToken).toHaveBeenCalledTimes(2);
    expect(harness.authManager.refreshAccessToken).not.toHaveBeenCalled();
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(authorizationFor(harness.fetch, 0)).toBe("Bearer first-token");
    expect(authorizationFor(harness.fetch, 1)).toBe("Bearer retry-token");
    expect(harness.fetch.mock.calls[0]?.[1]?.signal).not.toBe(
      harness.fetch.mock.calls[1]?.[1]?.signal,
    );
    expect(harness.resetBackoff).toHaveBeenCalledOnce();
  });

  test("uses rate limiter fallback backoff for an invalid Retry-After value", async () => {
    const harness = createHarness();
    harness.handle429.mockReturnValue(3);
    harness.fetch
      .mockResolvedValueOnce(
        textResponse("slow down", 429, "text/plain", { "Retry-After": "not-a-number" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(harness.client.get("/throttled")).resolves.toBeNull();

    expect(harness.handle429).toHaveBeenCalledWith(undefined);
    expect(harness.sleep).toHaveBeenCalledWith(3_000);
  });

  test("records a second 429 before throwing the exact terminal GraphApiError", async () => {
    const harness = createHarness();
    harness.handle429.mockReturnValueOnce(2).mockReturnValueOnce(9);
    harness.fetch
      .mockResolvedValueOnce(textResponse("slow down", 429, "text/plain", { "Retry-After": "1.5" }))
      .mockResolvedValueOnce(textResponse("still slow", 429, "text/plain", { "Retry-After": "7" }));

    await expect(harness.client.get("/throttled")).rejects.toEqual(
      expect.objectContaining({
        name: "GraphApiError",
        message: "Rate limit exceeded after retry",
        statusCode: 429,
      }),
    );
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.handle429.mock.calls).toEqual([[1.5], [7]]);
    expect(harness.sleep).toHaveBeenCalledOnce();
    expect(harness.sleep).toHaveBeenCalledWith(2_000);
    expect(harness.authManager.getValidAccessToken).toHaveBeenCalledTimes(2);
    expect(harness.resetBackoff).not.toHaveBeenCalled();
  });

  test("cancels 429 bodies before retry and terminal rate-limit handling", async () => {
    const cancellationSecret = "rate-cancel-secret";
    const events: string[] = [];
    const harness = createHarness();
    const first = cancellableResponse(429, "first-429", events);
    const second = cancellableResponse(
      429,
      "second-429",
      events,
      new Error(`cancel failed with ${cancellationSecret}`),
    );
    let fetchAttempt = 0;
    harness.authManager.getValidAccessToken
      .mockImplementationOnce(() => {
        events.push("token:initial");
        return Promise.resolve("initial-token");
      })
      .mockImplementationOnce(() => {
        events.push("token:retry");
        return Promise.resolve("retry-token");
      });
    harness.sleep.mockImplementation(() => {
      events.push("sleep");
      return Promise.resolve();
    });
    harness.fetch.mockImplementation(() => {
      fetchAttempt += 1;
      events.push(`fetch:${fetchAttempt}`);
      return Promise.resolve(fetchAttempt === 1 ? first.response : second.response);
    });

    const error = await rejectedError(harness.client.get("/throttled"));

    expect(error).toEqual(
      expect.objectContaining({
        name: "GraphApiError",
        message: "Rate limit exceeded after retry",
        statusCode: 429,
      }),
    );
    expect(error.message).not.toContain(cancellationSecret);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.cancel).toHaveBeenCalledOnce();
    expect(events.indexOf("cancel:first-429")).toBeLessThan(events.indexOf("sleep"));
    expect(events.indexOf("cancel:first-429")).toBeLessThan(events.indexOf("token:retry"));
    expect(events.indexOf("cancel:second-429")).toBeGreaterThan(events.indexOf("fetch:2"));
  });

  test("refreshes once after 401, gets the current token, and retries", async () => {
    const harness = createHarness();
    harness.authManager.getValidAccessToken
      .mockResolvedValueOnce("expired-token")
      .mockResolvedValueOnce("refreshed-token");
    harness.fetch
      .mockResolvedValueOnce(textResponse("unauthorized", 401))
      .mockResolvedValueOnce(jsonResponse({ id: "me" }));

    await expect(harness.client.get("/me")).resolves.toEqual({ id: "me" });

    expect(harness.authManager.refreshAccessToken).toHaveBeenCalledOnce();
    expect(harness.authManager.getValidAccessToken).toHaveBeenCalledTimes(2);
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(authorizationFor(harness.fetch, 0)).toBe("Bearer expired-token");
    expect(authorizationFor(harness.fetch, 1)).toBe("Bearer refreshed-token");
    expect(harness.resetBackoff).toHaveBeenCalledOnce();
  });

  test("throws AuthenticationError when refresh after 401 returns false", async () => {
    const harness = createHarness();
    harness.authManager.refreshAccessToken.mockResolvedValue(false);
    harness.fetch.mockResolvedValue(textResponse("unauthorized", 401));

    await expect(harness.client.get("/me")).rejects.toEqual(
      expect.objectContaining({
        name: "AuthenticationError",
        message: "Session expired. Please log in again.",
      }),
    );
    expect(harness.fetch).toHaveBeenCalledOnce();
    expect(harness.authManager.getValidAccessToken).toHaveBeenCalledOnce();
    expect(harness.resetBackoff).not.toHaveBeenCalled();
  });

  test("normalizes a rejected refresh without leaking its internal error", async () => {
    const secret = "refresh-internal-secret";
    const harness = createHarness();
    harness.authManager.refreshAccessToken.mockRejectedValue(
      new Error(`refresh provider failed with ${secret}`),
    );
    harness.fetch.mockResolvedValue(textResponse("unauthorized", 401));

    const error = await rejectedError(harness.client.get("/me"));

    expect(error).toEqual(
      expect.objectContaining({
        name: "AuthenticationError",
        message: "Session expired. Please log in again.",
      }),
    );
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("refresh provider failed");
    expect(harness.authManager.refreshAccessToken).toHaveBeenCalledOnce();
    expect(harness.authManager.getValidAccessToken).toHaveBeenCalledOnce();
    expect(harness.fetch).toHaveBeenCalledOnce();
    expect(harness.resetBackoff).not.toHaveBeenCalled();
  });

  test("throws AuthenticationError after a second 401 without refreshing twice", async () => {
    const harness = createHarness();
    harness.fetch
      .mockResolvedValueOnce(textResponse("unauthorized", 401))
      .mockResolvedValueOnce(textResponse("still unauthorized", 401));

    await expect(harness.client.get("/me")).rejects.toEqual(
      expect.objectContaining({
        name: "AuthenticationError",
        message: "Session expired. Please log in again.",
      }),
    );
    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.authManager.refreshAccessToken).toHaveBeenCalledOnce();
    expect(harness.resetBackoff).not.toHaveBeenCalled();
  });

  test("cancels 401 bodies before refresh and terminal authentication handling", async () => {
    const cancellationSecret = "auth-cancel-secret";
    const events: string[] = [];
    const harness = createHarness();
    const first = cancellableResponse(401, "first-401", events);
    const second = cancellableResponse(
      401,
      "second-401",
      events,
      new Error(`cancel failed with ${cancellationSecret}`),
    );
    let fetchAttempt = 0;
    harness.authManager.getValidAccessToken
      .mockImplementationOnce(() => {
        events.push("token:initial");
        return Promise.resolve("initial-token");
      })
      .mockImplementationOnce(() => {
        events.push("token:retry");
        return Promise.resolve("retry-token");
      });
    harness.authManager.refreshAccessToken.mockImplementation(() => {
      events.push("refresh");
      return Promise.resolve(true);
    });
    harness.fetch.mockImplementation(() => {
      fetchAttempt += 1;
      events.push(`fetch:${fetchAttempt}`);
      return Promise.resolve(fetchAttempt === 1 ? first.response : second.response);
    });

    const error = await rejectedError(harness.client.get("/me"));

    expect(error).toEqual(
      expect.objectContaining({
        name: "AuthenticationError",
        message: "Session expired. Please log in again.",
      }),
    );
    expect(error.message).not.toContain(cancellationSecret);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.cancel).toHaveBeenCalledOnce();
    expect(events.indexOf("cancel:first-401")).toBeLessThan(events.indexOf("refresh"));
    expect(events.indexOf("cancel:first-401")).toBeLessThan(events.indexOf("token:retry"));
    expect(events.indexOf("cancel:second-401")).toBeGreaterThan(events.indexOf("fetch:2"));
  });

  test("handles a 429 to 401 transition with each retry policy used once", async () => {
    const harness = createHarness();
    harness.authManager.getValidAccessToken
      .mockResolvedValueOnce("initial-token")
      .mockResolvedValueOnce("after-429-token")
      .mockResolvedValueOnce("after-401-token");
    harness.fetch
      .mockResolvedValueOnce(textResponse("slow down", 429))
      .mockResolvedValueOnce(textResponse("unauthorized", 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(harness.client.get("/transition")).resolves.toEqual({ ok: true });

    expect(harness.fetch).toHaveBeenCalledTimes(3);
    expect(harness.handle429).toHaveBeenCalledOnce();
    expect(harness.authManager.refreshAccessToken).toHaveBeenCalledOnce();
    expect(harness.authManager.getValidAccessToken).toHaveBeenCalledTimes(3);
    expect(authorizationFor(harness.fetch, 2)).toBe("Bearer after-401-token");
  });

  test("stops on a repeated 401 after a 401 to 429 transition", async () => {
    const harness = createHarness();
    harness.fetch
      .mockResolvedValueOnce(textResponse("unauthorized", 401))
      .mockResolvedValueOnce(textResponse("slow down", 429))
      .mockResolvedValueOnce(textResponse("unauthorized again", 401));

    await expect(harness.client.get("/transition")).rejects.toEqual(
      expect.objectContaining({
        name: "AuthenticationError",
        message: "Session expired. Please log in again.",
      }),
    );

    expect(harness.fetch).toHaveBeenCalledTimes(3);
    expect(harness.authManager.refreshAccessToken).toHaveBeenCalledOnce();
    expect(harness.handle429).toHaveBeenCalledOnce();
    expect(harness.resetBackoff).not.toHaveBeenCalled();
  });

  test("stops on a repeated 429 after a 429 to 401 transition", async () => {
    const harness = createHarness();
    harness.fetch
      .mockResolvedValueOnce(textResponse("slow down", 429, "text/plain", { "Retry-After": "1" }))
      .mockResolvedValueOnce(textResponse("unauthorized", 401))
      .mockResolvedValueOnce(
        textResponse("slow down again", 429, "text/plain", { "Retry-After": "8" }),
      );

    await expect(harness.client.get("/transition")).rejects.toEqual(
      expect.objectContaining({
        name: "GraphApiError",
        message: "Rate limit exceeded after retry",
        statusCode: 429,
      }),
    );

    expect(harness.fetch).toHaveBeenCalledTimes(3);
    expect(harness.handle429.mock.calls).toEqual([[1], [8]]);
    expect(harness.sleep).toHaveBeenCalledOnce();
    expect(harness.authManager.refreshAccessToken).toHaveBeenCalledOnce();
    expect(harness.resetBackoff).not.toHaveBeenCalled();
  });

  test("converts timeout aborts into an actionable GraphMcpError without leaking tokens", async () => {
    const secretToken = "timeout-secret-token";
    const harness = createHarness(5);
    harness.authManager.getValidAccessToken.mockResolvedValue(secretToken);
    harness.fetch.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            reject(new Error("Missing abort signal"));
            return;
          }
          const rejectOnAbort = () =>
            reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted"));
          if (signal.aborted) {
            rejectOnAbort();
            return;
          }
          signal.addEventListener("abort", rejectOnAbort, { once: true });
        }),
    );

    const error = await rejectedError(harness.client.get("/slow"));

    expect(error).toBeInstanceOf(GraphMcpError);
    expect(error.message).toMatch(/timed out after 5 ms/i);
    expect(error.message).toMatch(/try again/i);
    expect(error.message).not.toContain(secretToken);
    expect(error.message).not.toMatch(/authorization|bearer/i);
    expect(harness.resetBackoff).not.toHaveBeenCalled();
  });

  test("normalizes a response body timeout without leaking the stream error", async () => {
    const secretToken = "body-timeout-secret-token";
    const harness = createHarness(5);
    harness.authManager.getValidAccessToken.mockResolvedValue(secretToken);
    harness.fetch.mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        return Promise.reject(new Error("Missing abort signal"));
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const failBody = () =>
            controller.error(new Error(`body stream failed with Bearer ${secretToken}`));
          if (signal.aborted) {
            failBody();
            return;
          }
          signal.addEventListener("abort", failBody, { once: true });
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const error = await rejectedError(harness.client.get("/slow-body"));

    expect(error).toBeInstanceOf(GraphMcpError);
    expect(error.message).toBe(
      "Microsoft Graph request timed out after 5 ms. Check your network connection and try again.",
    );
    expect(error.message).not.toContain(secretToken);
    expect(error.message).not.toMatch(/authorization|bearer|body stream failed/i);
    expect(harness.resetBackoff).not.toHaveBeenCalled();
  });

  test("normalizes a response body network failure without leaking the stream error", async () => {
    const secretToken = "body-network-secret-token";
    const harness = createHarness();
    harness.authManager.getValidAccessToken.mockResolvedValue(secretToken);
    harness.fetch.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error(`body read failed with Bearer ${secretToken}`));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/plain" } },
      ),
    );

    const error = await rejectedError(harness.client.get("/broken-body"));

    expect(error).toBeInstanceOf(GraphMcpError);
    expect(error.message).toBe(
      "Microsoft Graph request failed. Check your network connection and try again.",
    );
    expect(error.message).not.toContain(secretToken);
    expect(error.message).not.toMatch(/authorization|bearer|body read failed/i);
    expect(harness.resetBackoff).not.toHaveBeenCalled();
  });

  test("converts ordinary fetch failures consistently without exposing request secrets", async () => {
    const secretToken = "network-secret-token";
    const harness = createHarness();
    harness.authManager.getValidAccessToken.mockResolvedValue(secretToken);
    harness.fetch.mockRejectedValue(
      new TypeError(`socket disconnected while sending Bearer ${secretToken}`),
    );

    const error = await rejectedError(harness.client.get("/network-failure"));

    expect(error).toBeInstanceOf(GraphMcpError);
    expect(error.message).toMatch(/microsoft graph request failed/i);
    expect(error.message).toMatch(/network connection/i);
    expect(error.message).not.toContain(secretToken);
    expect(error.message).not.toMatch(/authorization|bearer/i);
    expect(harness.resetBackoff).not.toHaveBeenCalled();
  });
});
