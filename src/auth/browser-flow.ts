import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import open from "open";

import type { Settings } from "../config.js";
import { AuthenticationError } from "../errors.js";
import { parseTokenResponse, type TokenResponse } from "../token-store.js";

const PKCE_VERIFIER_BYTES = 32;
const STATE_BYTES = 32;
const DEFAULT_TIMEOUT_MS = 120_000;
const LOGIN_CANCELLED_MESSAGE = "Login timed out or was cancelled.";
const LISTENER_CLOSED_MESSAGE = "Loopback callback listener is closed.";
const LISTENER_FAILURE_MESSAGE = "Loopback callback listener failed.";
const BROWSER_OPEN_ERROR_MESSAGE = "Unable to open browser for authentication.";
const TOKEN_RESPONSE_ERROR_MESSAGE = "Token endpoint returned an invalid token response.";
const TOKEN_EXCHANGE_ERROR_MESSAGE = "Token exchange failed.";
const LOOPBACK_HEADERS_TIMEOUT_MS = 5_000;
const LOOPBACK_REQUEST_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SUCCESS_HTML =
  "<!doctype html><html><body><p>Authentication complete. You can close this window.</p></body></html>";
const FAILURE_HTML =
  "<!doctype html><html><body><p>Authentication failed. You can close this window.</p></body></html>";
const SAFE_OAUTH_ERROR_IDENTIFIERS: ReadonlySet<string> = new Set([
  "access_denied",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_grant_type",
  "unsupported_response_type",
]);

type BrowserFlowSettings = Pick<
  Settings,
  "azureClientId" | "graphRedirectUri" | "authorizeEndpoint" | "tokenEndpoint" | "scopes"
>;

export type BrowserLoginSettings = BrowserFlowSettings;

export interface PkceCodes {
  readonly verifier: string;
  readonly challenge: string;
}

export interface AuthorizationRequest {
  readonly state: string;
  readonly challenge: string;
}

export interface OAuthCallback {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

export interface CallbackListener {
  start(): Promise<void>;
  waitForCallback(): Promise<OAuthCallback>;
  close(): Promise<void>;
}

export interface LoopbackCallbackListener extends CallbackListener {
  readonly callbackUrl: string;
}

export type HttpServerFactory = (requestListener: RequestListener) => Server;

export interface LoopbackCallbackListenerDependencies {
  readonly createServer?: HttpServerFactory;
}

export interface CallbackListenerOptions {
  readonly redirectUri: string;
  readonly expectedState: string;
}

export type CallbackListenerFactory = (options: CallbackListenerOptions) => CallbackListener;

export type BrowserOpener = (url: string) => Promise<unknown>;

export interface TokenEndpointResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type TokenEndpointFetch = (
  input: string,
  init: RequestInit,
) => Promise<TokenEndpointResponse>;

export type TimeoutRunner = <Value>(operation: Promise<Value>, timeoutMs: number) => Promise<Value>;

export interface BrowserLoginDependencies {
  readonly randomBytes?: (size: number) => Buffer;
  readonly createCallbackListener?: CallbackListenerFactory;
  readonly openBrowser?: BrowserOpener;
  readonly fetch?: TokenEndpointFetch;
  readonly timeoutMs?: number;
  readonly timeout?: TimeoutRunner;
  readonly signal?: AbortSignal;
}

interface LoopbackRedirectUri {
  readonly url: URL;
  readonly host: string;
  readonly port: number;
}

function authenticationError(message: string): AuthenticationError {
  return new AuthenticationError(message);
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function parseLoopbackRedirectUri(value: string): LoopbackRedirectUri {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw authenticationError("graphRedirectUri must be a valid HTTP loopback URL.");
  }

  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
    throw authenticationError("graphRedirectUri must use HTTP and a loopback hostname.");
  }

  const port = url.port === "" ? 80 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw authenticationError("graphRedirectUri must use a valid loopback port.");
  }

  return {
    url,
    host: url.hostname === "[::1]" ? "::1" : url.hostname,
    port,
  };
}

function fixedHtml(
  response: import("node:http").ServerResponse,
  statusCode: number,
  html: string,
  onComplete?: () => void,
): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  response.end(html, onComplete);
}

function callbackFromUrl(url: URL): OAuthCallback {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  return {
    ...(code === null ? {} : { code }),
    ...(state === null ? {} : { state }),
    ...(error === null ? {} : { error }),
    ...(errorDescription === null ? {} : { errorDescription }),
  };
}

function callbackIsSuccessful(callback: OAuthCallback, expectedState: string): boolean {
  return (
    callback.error === undefined &&
    callback.code !== undefined &&
    callback.code.length > 0 &&
    callback.state !== undefined &&
    callback.state.length > 0 &&
    callback.state === expectedState
  );
}

function callbackUrlForAddress(redirectUri: URL, address: AddressInfo | string | null): string {
  if (address === null || typeof address === "string") {
    return redirectUri.toString();
  }

  const url = new URL(redirectUri);
  url.port = String(address.port);
  return url.toString();
}

export function createLoopbackCallbackListener(
  options: CallbackListenerOptions,
  dependencies: LoopbackCallbackListenerDependencies = {},
): LoopbackCallbackListener {
  const redirect = parseLoopbackRedirectUri(options.redirectUri);
  const sockets = new Set<Socket>();
  let callbackReceived = false;
  let callbackSettled = false;
  let resolveCallback: (callback: OAuthCallback) => void = () => undefined;
  let rejectCallback: (error: AuthenticationError) => void = () => undefined;
  const callback = new Promise<OAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  void callback.catch(() => undefined);
  const server = (dependencies.createServer ?? createServer)((request, response) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url ?? "/", redirect.url);
    } catch {
      fixedHtml(response, 400, FAILURE_HTML);
      return;
    }
    if (requestUrl.pathname !== redirect.url.pathname) {
      fixedHtml(response, 404, FAILURE_HTML);
      return;
    }

    if (callbackReceived) {
      fixedHtml(response, 409, FAILURE_HTML);
      return;
    }

    callbackReceived = true;
    const parsedCallback = callbackFromUrl(requestUrl);
    const html = callbackIsSuccessful(parsedCallback, options.expectedState)
      ? SUCCESS_HTML
      : FAILURE_HTML;
    fixedHtml(response, 200, html, () => {
      if (!callbackSettled) {
        callbackSettled = true;
        resolveCallback(parsedCallback);
      }
    });
  });
  server.headersTimeout = LOOPBACK_HEADERS_TIMEOUT_MS;
  server.requestTimeout = LOOPBACK_REQUEST_TIMEOUT_MS;
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let lifecycle: "idle" | "starting" | "listening" | "closed" = "idle";
  let startPromise: Promise<void> | undefined;
  let rejectStart: ((error: Error) => void) | undefined;
  let closePromise: Promise<void> | undefined;

  function listenerFailure(): AuthenticationError {
    return authenticationError(LISTENER_FAILURE_MESSAGE);
  }

  function rejectCallbackOnce(error: AuthenticationError): void {
    if (callbackSettled) {
      return;
    }
    callbackSettled = true;
    rejectCallback(error);
  }

  function destroyConnections(): void {
    server.closeAllConnections?.();
    for (const socket of sockets) {
      socket.destroy();
    }
  }

  function stopServer(): Promise<void> {
    destroyConnections();
    return new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  function stopLateServer(): void {
    destroyConnections();
    try {
      server.close(() => undefined);
    } catch {
      // The server was never listening or has already stopped.
    }
  }

  function closeListener(
    startError: Error = authenticationError(LISTENER_CLOSED_MESSAGE),
  ): Promise<void> {
    if (closePromise !== undefined) {
      return closePromise;
    }

    const previousLifecycle = lifecycle;
    lifecycle = "closed";
    rejectCallbackOnce(authenticationError(LISTENER_CLOSED_MESSAGE));
    if (previousLifecycle === "starting") {
      rejectStart?.(startError);
      rejectStart = undefined;
    }
    closePromise = previousLifecycle === "idle" ? Promise.resolve() : stopServer();
    return closePromise;
  }

  server.on("error", (error: Error) => {
    if (lifecycle === "starting") {
      rejectStart?.(error);
      rejectStart = undefined;
      void closeListener(error);
      return;
    }
    if (lifecycle === "listening") {
      rejectCallbackOnce(listenerFailure());
      void closeListener();
    }
  });

  return {
    get callbackUrl(): string {
      return callbackUrlForAddress(redirect.url, server.address());
    },
    start(): Promise<void> {
      if (lifecycle === "closed") {
        return Promise.reject(authenticationError(LISTENER_CLOSED_MESSAGE));
      }
      if (startPromise !== undefined) {
        return startPromise;
      }

      lifecycle = "starting";
      startPromise = new Promise<void>((resolve, reject) => {
        rejectStart = reject;
        const onListening = () => {
          if (lifecycle === "closed") {
            stopLateServer();
            return;
          }
          lifecycle = "listening";
          rejectStart = undefined;
          resolve();
        };

        server.once("listening", onListening);
        try {
          server.listen({ host: redirect.host, port: redirect.port });
        } catch (error: unknown) {
          const startError =
            error instanceof Error ? error : new Error("Unable to start callback listener.");
          rejectStart?.(startError);
          rejectStart = undefined;
          void closeListener(startError);
        }
      });
      return startPromise;
    },
    waitForCallback(): Promise<OAuthCallback> {
      return callback;
    },
    close(): Promise<void> {
      return closeListener();
    },
  };
}

export function generatePkce(
  options: { readonly randomBytes?: (size: number) => Buffer } = {},
): PkceCodes {
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const verifier = randomBytes(PKCE_VERIFIER_BYTES).toString("base64url");
  if (verifier.length < 43 || verifier.length > 128) {
    throw new Error("Unable to generate a valid PKCE verifier.");
  }

  return {
    verifier,
    challenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
  };
}

function generateState(randomBytes: (size: number) => Buffer): string {
  return randomBytes(STATE_BYTES).toString("base64url");
}

export function buildAuthorizationUrl(
  settings: BrowserLoginSettings,
  request: AuthorizationRequest,
): string {
  const url = new URL(settings.authorizeEndpoint);
  url.searchParams.set("client_id", settings.azureClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", settings.graphRedirectUri);
  url.searchParams.set("scope", settings.scopes.join(" "));
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function allowlistedOAuthErrorIdentifier(
  value: string | undefined,
  secrets: readonly string[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!SAFE_OAUTH_ERROR_IDENTIFIERS.has(normalized)) {
    return undefined;
  }
  for (const secret of secrets) {
    if (secret.length > 0 && normalized.includes(secret.toLowerCase())) {
      return undefined;
    }
  }
  return normalized;
}

function providerErrorMessage(callback: OAuthCallback, secrets: readonly string[]): string {
  const error = allowlistedOAuthErrorIdentifier(callback.error, secrets);
  return `OAuth error: ${error ?? "unknown"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenEndpointErrorIdentifier(
  responseText: string,
  secrets: readonly string[],
): string | undefined {
  try {
    const body: unknown = JSON.parse(responseText);
    if (isRecord(body) && typeof body.error === "string") {
      const bodySecrets = [
        body.access_token,
        body.refresh_token,
        body.code,
        body.code_verifier,
        body.state,
      ].filter((value): value is string => typeof value === "string");
      return allowlistedOAuthErrorIdentifier(body.error, [...secrets, ...bodySecrets]);
    }
  } catch {
    // Non-JSON provider bodies are never included in authentication errors.
  }
  return undefined;
}

async function exchangeAuthorizationCode(
  settings: BrowserLoginSettings,
  code: string,
  verifier: string,
  state: string,
  fetchToken: TokenEndpointFetch,
  signal: AbortSignal,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: settings.azureClientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: settings.graphRedirectUri,
    code_verifier: verifier,
  });
  let response: TokenEndpointResponse;
  try {
    response = await fetchToken(settings.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal,
    });
  } catch {
    if (signal.aborted) {
      throw authenticationError(LOGIN_CANCELLED_MESSAGE);
    }
    throw authenticationError(TOKEN_EXCHANGE_ERROR_MESSAGE);
  }

  if (signal.aborted) {
    throw authenticationError(LOGIN_CANCELLED_MESSAGE);
  }

  if (response.ok) {
    if (response.status === 204) {
      throw authenticationError(TOKEN_RESPONSE_ERROR_MESSAGE);
    }
    try {
      const payload: unknown = await response.json();
      if (signal.aborted) {
        throw authenticationError(LOGIN_CANCELLED_MESSAGE);
      }
      return parseTokenResponse(payload);
    } catch {
      if (signal.aborted) {
        throw authenticationError(LOGIN_CANCELLED_MESSAGE);
      }
      throw authenticationError(TOKEN_RESPONSE_ERROR_MESSAGE);
    }
  }

  const responseText = await response.text().catch(() => "");
  if (signal.aborted) {
    throw authenticationError(LOGIN_CANCELLED_MESSAGE);
  }
  const errorIdentifier = tokenEndpointErrorIdentifier(responseText, [code, verifier, state]);
  if (errorIdentifier !== undefined) {
    throw authenticationError(`Token exchange failed: ${errorIdentifier}`);
  }
  throw authenticationError(`Token exchange failed with status ${response.status}.`);
}

function defaultTimeout<Value>(
  operation: Promise<Value>,
  timeoutMs: number,
  cancel: () => void,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        cancel();
        reject(authenticationError(LOGIN_CANCELLED_MESSAGE));
      },
      Math.min(timeoutMs, MAX_TIMER_DELAY_MS),
    );
    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("Browser login operation failed."));
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw authenticationError(LOGIN_CANCELLED_MESSAGE);
  }
}

function rejectOnAbort<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const onAbort = () => {
      reject(authenticationError(LOGIN_CANCELLED_MESSAGE));
    };
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
        reject(error instanceof Error ? error : new Error("Browser login operation failed."));
      },
    );
  });
}

async function closeListener(listener: CallbackListener, terminalError: unknown): Promise<void> {
  try {
    await listener.close();
  } catch (closeError: unknown) {
    if (terminalError === undefined) {
      throw closeError;
    }
  }
}

export async function runBrowserLogin(
  settings: BrowserLoginSettings,
  dependencies: BrowserLoginDependencies = {},
): Promise<TokenResponse> {
  const flowSettings: BrowserLoginSettings = Object.freeze({
    ...settings,
    scopes: Object.freeze([...settings.scopes]),
  });
  const redirect = parseLoopbackRedirectUri(flowSettings.graphRedirectUri);
  if (redirect.port === 0) {
    throw authenticationError("graphRedirectUri must not use port 0.");
  }
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Browser login timeout must be a positive safe integer.");
  }

  const randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  const pkce = generatePkce({ randomBytes });
  const state = generateState(randomBytes);
  const listener = (dependencies.createCallbackListener ?? createLoopbackCallbackListener)({
    redirectUri: flowSettings.graphRedirectUri,
    expectedState: state,
  });
  const fetchToken: TokenEndpointFetch =
    dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const openBrowser: BrowserOpener = dependencies.openBrowser ?? open;
  const cancellation = new AbortController();
  const abortFromExternalSignal = () => cancellation.abort();
  if (dependencies.signal?.aborted) {
    cancellation.abort();
  } else {
    dependencies.signal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  }
  const operation = (async () => {
    throwIfAborted(cancellation.signal);
    await listener.start();
    throwIfAborted(cancellation.signal);
    try {
      await openBrowser(buildAuthorizationUrl(flowSettings, { state, challenge: pkce.challenge }));
    } catch {
      if (cancellation.signal.aborted) {
        throw authenticationError(LOGIN_CANCELLED_MESSAGE);
      }
      throw authenticationError(BROWSER_OPEN_ERROR_MESSAGE);
    }
    throwIfAborted(cancellation.signal);
    const callback = await listener.waitForCallback();
    throwIfAborted(cancellation.signal);

    if (callback.state === undefined || callback.state.length === 0) {
      throw authenticationError(LOGIN_CANCELLED_MESSAGE);
    }
    if (callback.state !== state) {
      throw authenticationError("Invalid state parameter — possible CSRF attack");
    }
    if (callback.error !== undefined) {
      throw authenticationError(
        providerErrorMessage(callback, [callback.code ?? "", pkce.verifier, state]),
      );
    }
    if (callback.code === undefined || callback.code.length === 0) {
      throw authenticationError(LOGIN_CANCELLED_MESSAGE);
    }

    return await exchangeAuthorizationCode(
      flowSettings,
      callback.code,
      pkce.verifier,
      state,
      fetchToken,
      cancellation.signal,
    );
  })();
  const abortableOperation = rejectOnAbort(operation, cancellation.signal);
  void abortableOperation.catch(() => undefined);
  const timeout =
    dependencies.timeout ??
    ((pendingOperation: Promise<TokenResponse>, timeoutMs: number) =>
      defaultTimeout(pendingOperation, timeoutMs, () => cancellation.abort()));
  let terminalError: unknown;

  try {
    return await timeout(abortableOperation, Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
  } catch (error: unknown) {
    terminalError = error;
    throw error;
  } finally {
    dependencies.signal?.removeEventListener("abort", abortFromExternalSignal);
    cancellation.abort();
    await closeListener(listener, terminalError);
  }
}
