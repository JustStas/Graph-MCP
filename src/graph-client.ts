import type { AuthManager } from "./auth/auth-manager.js";
import { AuthenticationError, GraphApiError, GraphMcpError } from "./errors.js";
import type { RateLimiter } from "./rate-limiter.js";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0/";
const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_BASE_PATH = "/v1.0/";
const INVALID_GRAPH_PATH_MESSAGE = "Microsoft Graph request path must stay under /v1.0/.";
const SESSION_EXPIRED_MESSAGE = "Session expired. Please log in again.";

export type GraphQueryParameters =
  URLSearchParams | Readonly<Record<string, string | number | boolean>>;

export interface GraphClientDependencies {
  authManager: Pick<AuthManager, "getValidAccessToken" | "refreshAccessToken">;
  rateLimiter: RateLimiter;
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}

interface GraphAttempt {
  response: Response;
  signal: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function sessionExpiredError(): AuthenticationError {
  return new AuthenticationError(SESSION_EXPIRED_MESSAGE);
}

export class GraphClient {
  readonly #authManager: GraphClientDependencies["authManager"];
  readonly #rateLimiter: RateLimiter;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: GraphClientDependencies["sleep"];
  readonly #timeoutMs: number;

  constructor(dependencies: GraphClientDependencies) {
    this.#authManager = dependencies.authManager;
    this.#rateLimiter = dependencies.rateLimiter;
    this.#fetch = dependencies.fetch;
    this.#sleep = dependencies.sleep;
    this.#timeoutMs = dependencies.timeoutMs;
  }

  get(path: string, params?: GraphQueryParameters, headers?: HeadersInit): Promise<unknown> {
    return this.#request("GET", path, params, undefined, headers);
  }

  /** Reads a response as raw bytes, so binary downloads survive without UTF-8 decoding. */
  getBytes(
    path: string,
    params?: GraphQueryParameters,
    headers?: HeadersInit,
  ): Promise<Uint8Array> {
    return this.#send("GET", path, params, undefined, headers, undefined, (response, signal) =>
      this.#readResponseBytes(response, signal),
    );
  }

  post(
    path: string,
    jsonBody?: unknown,
    params?: GraphQueryParameters,
    headers?: HeadersInit,
  ): Promise<unknown> {
    return this.#request("POST", path, params, jsonBody, headers);
  }

  patch(path: string, jsonBody?: unknown, headers?: HeadersInit): Promise<unknown> {
    return this.#request("PATCH", path, undefined, jsonBody, headers);
  }

  put(
    path: string,
    data?: Uint8Array,
    jsonBody?: unknown,
    headers?: HeadersInit,
  ): Promise<unknown> {
    return this.#request("PUT", path, undefined, jsonBody, headers, data);
  }

  delete(path: string, headers?: HeadersInit): Promise<unknown> {
    return this.#request("DELETE", path, undefined, undefined, headers);
  }

  #request(
    method: string,
    path: string,
    params?: GraphQueryParameters,
    jsonBody?: unknown,
    callerHeaders?: HeadersInit,
    binaryBody?: Uint8Array,
  ): Promise<unknown> {
    return this.#send(
      method,
      path,
      params,
      jsonBody,
      callerHeaders,
      binaryBody,
      (response, signal) => this.#parseSuccessfulResponse(response, signal),
    );
  }

  async #send<Result>(
    method: string,
    path: string,
    params: GraphQueryParameters | undefined,
    jsonBody: unknown,
    callerHeaders: HeadersInit | undefined,
    binaryBody: Uint8Array | undefined,
    readResponse: (response: Response, signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const url = this.#buildUrl(path, params);
    await this.#rateLimiter.acquire();

    const body = this.#requestBody(jsonBody, binaryBody);
    let accessToken = await this.#authManager.getValidAccessToken();
    let retried401 = false;
    let retried429 = false;

    while (true) {
      const headers = new Headers(callerHeaders);
      headers.set("Authorization", `Bearer ${accessToken}`);
      if (binaryBody === undefined && jsonBody !== undefined) {
        headers.set("Content-Type", "application/json");
      }

      const { response, signal } = await this.#fetchAttempt(method, url, headers, body);

      if (response.status === 429) {
        const delaySeconds = this.#rateLimiter.handle429(
          retryAfterSeconds(response.headers.get("Retry-After")),
        );
        await this.#disposeResponseBody(response);
        if (retried429) {
          throw new GraphApiError("Rate limit exceeded after retry", 429);
        }
        retried429 = true;
        await this.#sleep(delaySeconds * 1_000);
        accessToken = await this.#authManager.getValidAccessToken();
        continue;
      }

      if (response.status === 401) {
        await this.#disposeResponseBody(response);
        if (retried401) {
          throw sessionExpiredError();
        }
        retried401 = true;
        let refreshed: boolean;
        try {
          refreshed = await this.#authManager.refreshAccessToken();
        } catch {
          throw sessionExpiredError();
        }
        if (!refreshed) {
          throw sessionExpiredError();
        }
        accessToken = await this.#authManager.getValidAccessToken();
        continue;
      }

      if (!response.ok) {
        throw await this.#graphApiError(response, signal);
      }

      const result = await readResponse(response, signal);
      this.#rateLimiter.resetBackoff();
      return result;
    }
  }

  async #disposeResponseBody(response: Response): Promise<void> {
    if (response.body === null) {
      return;
    }
    try {
      await response.body.cancel();
    } catch {
      // Body disposal must not replace stable authentication or rate-limit errors.
    }
  }

  #buildUrl(path: string, params?: GraphQueryParameters): URL {
    const normalizedPath = path.replace(/^\/+/, "");
    const url = new URL(normalizedPath, GRAPH_BASE_URL);
    if (url.origin !== GRAPH_ORIGIN || !url.pathname.startsWith(GRAPH_BASE_PATH)) {
      throw new GraphMcpError(INVALID_GRAPH_PATH_MESSAGE);
    }
    if (params === undefined) {
      return url;
    }

    const entries =
      params instanceof URLSearchParams
        ? params.entries()
        : Object.entries(params).map(([key, value]) => [key, String(value)] as const);
    for (const [key, value] of entries) {
      url.searchParams.append(key, value);
    }
    return url;
  }

  #requestBody(jsonBody: unknown, binaryBody?: Uint8Array): BodyInit | undefined {
    if (binaryBody !== undefined) {
      const snapshot = new Uint8Array(binaryBody.byteLength);
      snapshot.set(binaryBody);
      return snapshot;
    }
    if (jsonBody === undefined) {
      return undefined;
    }

    const serialized = JSON.stringify(jsonBody);
    if (serialized === undefined) {
      throw new GraphMcpError("Microsoft Graph request body could not be serialized as JSON.");
    }
    return serialized;
  }

  async #fetchAttempt(
    method: string,
    url: URL,
    headers: Headers,
    body?: BodyInit,
  ): Promise<GraphAttempt> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const init: RequestInit = {
      method,
      headers,
      signal,
    };
    if (body !== undefined) {
      init.body = body;
    }

    try {
      const response = await this.#fetch(url, init);
      return { response, signal };
    } catch {
      throw this.#requestFailure(signal);
    }
  }

  #requestFailure(signal: AbortSignal): GraphMcpError {
    return signal.aborted
      ? new GraphMcpError(
          `Microsoft Graph request timed out after ${this.#timeoutMs} ms. Check your network connection and try again.`,
        )
      : new GraphMcpError(
          "Microsoft Graph request failed. Check your network connection and try again.",
        );
  }

  async #readResponseText(response: Response, signal: AbortSignal): Promise<string> {
    try {
      return await response.text();
    } catch {
      throw this.#requestFailure(signal);
    }
  }

  async #readResponseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    if (response.status === 204) {
      return new Uint8Array();
    }
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw this.#requestFailure(signal);
    }
  }

  async #graphApiError(response: Response, signal: AbortSignal): Promise<GraphApiError> {
    const text = await this.#readResponseText(response, signal);
    let message = text;

    try {
      const payload: unknown = JSON.parse(text);
      if (
        isRecord(payload) &&
        isRecord(payload.error) &&
        typeof payload.error.message === "string"
      ) {
        message = payload.error.message;
      }
    } catch {
      // The response text is the fallback error message.
    }

    return new GraphApiError(`${response.status}: ${message}`, response.status);
  }

  async #parseSuccessfulResponse(response: Response, signal: AbortSignal): Promise<unknown> {
    if (response.status === 204) {
      return null;
    }

    const text = await this.#readResponseText(response, signal);
    if (text.length === 0) {
      return null;
    }

    const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
    if (!contentType.includes("json")) {
      return text;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}
