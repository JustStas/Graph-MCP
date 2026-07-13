import type { AuthManager } from "./auth/auth-manager.js";
import { AuthenticationError, GraphApiError, GraphMcpError } from "./errors.js";
import type { RateLimiter } from "./rate-limiter.js";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0/";
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

  put(path: string, data?: BodyInit, jsonBody?: unknown, headers?: HeadersInit): Promise<unknown> {
    return this.#request("PUT", path, undefined, jsonBody, headers, data);
  }

  delete(path: string, headers?: HeadersInit): Promise<unknown> {
    return this.#request("DELETE", path, undefined, undefined, headers);
  }

  async #request(
    method: string,
    path: string,
    params?: GraphQueryParameters,
    jsonBody?: unknown,
    callerHeaders?: HeadersInit,
    binaryBody?: BodyInit,
  ): Promise<unknown> {
    await this.#rateLimiter.acquire();

    const url = this.#buildUrl(path, params);
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

      const response = await this.#fetchAttempt(method, url, headers, body);

      if (response.status === 429) {
        if (retried429) {
          throw new GraphApiError("Rate limit exceeded after retry", 429);
        }
        retried429 = true;
        const delaySeconds = this.#rateLimiter.handle429(
          retryAfterSeconds(response.headers.get("Retry-After")),
        );
        await this.#sleep(delaySeconds * 1_000);
        accessToken = await this.#authManager.getValidAccessToken();
        continue;
      }

      if (response.status === 401) {
        if (retried401) {
          throw sessionExpiredError();
        }
        retried401 = true;
        const refreshed = await this.#authManager.refreshAccessToken();
        if (!refreshed) {
          throw sessionExpiredError();
        }
        accessToken = await this.#authManager.getValidAccessToken();
        continue;
      }

      if (!response.ok) {
        throw await this.#graphApiError(response);
      }

      const result = await this.#parseSuccessfulResponse(response);
      this.#rateLimiter.resetBackoff();
      return result;
    }
  }

  #buildUrl(path: string, params?: GraphQueryParameters): URL {
    const normalizedPath = path.replace(/^\/+/, "");
    const url = new URL(normalizedPath, GRAPH_BASE_URL);
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

  #requestBody(jsonBody: unknown, binaryBody?: BodyInit): BodyInit | undefined {
    if (binaryBody !== undefined) {
      return binaryBody;
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
  ): Promise<Response> {
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
      return await this.#fetch(url, init);
    } catch {
      if (signal.aborted) {
        throw new GraphMcpError(
          `Microsoft Graph request timed out after ${this.#timeoutMs} ms. Check your network connection and try again.`,
        );
      }
      throw new GraphMcpError(
        "Microsoft Graph request failed. Check your network connection and try again.",
      );
    }
  }

  async #graphApiError(response: Response): Promise<GraphApiError> {
    const text = await response.text();
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

  async #parseSuccessfulResponse(response: Response): Promise<unknown> {
    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    if (text.length === 0) {
      return null;
    }

    const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
    return contentType.includes("json") ? (JSON.parse(text) as unknown) : text;
  }
}
