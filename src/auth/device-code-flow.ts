import type { Settings } from "../config.js";
import { AuthenticationError } from "../errors.js";
import { parseTokenResponse, type TokenResponse } from "../token-store.js";

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_SECONDS = 5;
const CANCELLED_MESSAGE = "Device-code login was cancelled.";
const DEVICE_RESPONSE_ERROR_MESSAGE = "Device-code endpoint returned an invalid response.";
const DEVICE_REQUEST_ERROR_MESSAGE = "Unable to request a device code.";
const POLLING_ERROR_MESSAGE = "Device-code token polling failed.";
const TOKEN_RESPONSE_ERROR_MESSAGE = "Token endpoint returned an invalid token response.";
const EXPIRED_MESSAGE = "Device code expired. Start login again.";
const DECLINED_MESSAGE = "Device-code login was declined.";
const STORE_ERROR_MESSAGE = "Unable to store authentication tokens.";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STORAGE_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type DeviceCodeSettings = Pick<
  Settings,
  "azureClientId" | "authority" | "tokenEndpoint" | "scopes"
>;

export interface DeviceCodeResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type DeviceCodeFetch = (input: string, init: RequestInit) => Promise<DeviceCodeResponse>;

export interface DeviceCodeTokenStore {
  store(tokens: TokenResponse, options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export interface DeviceCodeLoginDetails {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  readonly message: string;
}

export interface DeviceCodeLoginSession {
  readonly details: DeviceCodeLoginDetails;
  poll(): Promise<void>;
}

export type DeviceCodeSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface DeviceCodeLoginDependencies {
  readonly fetch?: DeviceCodeFetch;
  readonly now?: () => number;
  readonly sleep?: DeviceCodeSleep;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
  readonly storageTimeoutMs?: number;
}

interface ParsedDeviceCodeResponse {
  readonly deviceCode: string;
  readonly expiresAt: number;
  readonly details: DeviceCodeLoginDetails;
  readonly intervalMilliseconds: number;
}

interface ManagedAbort {
  readonly signal: AbortSignal;
  callerAborted(): boolean;
  deadlineExpired(): boolean;
  dispose(): void;
}

function authenticationError(message: string): AuthenticationError {
  return new AuthenticationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function freezeDetails(details: DeviceCodeLoginDetails): DeviceCodeLoginDetails {
  return Object.freeze({ ...details });
}

function rejectOnAbort<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => finish(() => reject(authenticationError(CANCELLED_MESSAGE)));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => {
        finish(() =>
          reject(error instanceof Error ? error : new Error("Device-code operation failed.")),
        );
      },
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

function createManagedAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMilliseconds: number,
): ManagedAbort {
  const controller = new AbortController();
  let wasCallerAborted = callerSignal?.aborted ?? false;
  let wasDeadlineExpired = false;
  const onCallerAbort = () => {
    wasCallerAborted = true;
    controller.abort();
  };
  if (wasCallerAborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timeout = setTimeout(
    () => {
      wasDeadlineExpired = true;
      controller.abort();
    },
    Math.min(timeoutMilliseconds, MAX_TIMER_DELAY_MS),
  );
  timeout.unref?.();

  return {
    signal: controller.signal,
    callerAborted: () => wasCallerAborted,
    deadlineExpired: () => wasDeadlineExpired,
    dispose() {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function managedFailure(
  managed: ManagedAbort,
  deadlineMessage: string,
  fallbackMessage: string,
): AuthenticationError {
  if (managed.callerAborted()) {
    return authenticationError(CANCELLED_MESSAGE);
  }
  if (managed.deadlineExpired()) {
    return authenticationError(deadlineMessage);
  }
  return authenticationError(fallbackMessage);
}

function parseDeviceCodeResponse(value: unknown, now: number): ParsedDeviceCodeResponse {
  if (!isRecord(value)) {
    throw authenticationError(DEVICE_RESPONSE_ERROR_MESSAGE);
  }

  const deviceCode = value.device_code;
  const userCode = value.user_code;
  const verificationUri = value.verification_uri;
  const message = value.message;
  const expiresIn = value.expires_in;
  const interval = value.interval;
  if (
    !isNonemptyString(deviceCode) ||
    !isNonemptyString(userCode) ||
    !isNonemptyString(verificationUri) ||
    !isNonemptyString(message) ||
    !positiveSafeInteger(expiresIn) ||
    (interval !== undefined && !positiveSafeInteger(interval)) ||
    !Number.isSafeInteger(now)
  ) {
    throw authenticationError(DEVICE_RESPONSE_ERROR_MESSAGE);
  }
  if (
    userCode.includes(deviceCode) ||
    verificationUri.includes(deviceCode) ||
    message.includes(deviceCode)
  ) {
    throw authenticationError(DEVICE_RESPONSE_ERROR_MESSAGE);
  }

  const expiryMilliseconds = expiresIn * 1000;
  const expiresAt = now + expiryMilliseconds;
  const intervalMilliseconds = (interval ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
  if (
    !Number.isSafeInteger(expiryMilliseconds) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    !Number.isSafeInteger(intervalMilliseconds)
  ) {
    throw authenticationError(DEVICE_RESPONSE_ERROR_MESSAGE);
  }

  return {
    deviceCode,
    expiresAt,
    intervalMilliseconds,
    details: freezeDetails({ userCode, verificationUri, expiresAt, message }),
  };
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(authenticationError(CANCELLED_MESSAGE));
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.min(milliseconds, MAX_TIMER_DELAY_MS),
    );

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function readJson(response: DeviceCodeResponse, signal: AbortSignal): Promise<unknown> {
  return rejectOnAbort(response.json(), signal);
}

async function requestDeviceCode(
  settings: DeviceCodeSettings,
  fetchDeviceCode: DeviceCodeFetch,
  now: () => number,
  callerSignal: AbortSignal | undefined,
  requestTimeoutMs: number,
): Promise<ParsedDeviceCodeResponse> {
  const managed = createManagedAbort(callerSignal, requestTimeoutMs);
  if (managed.callerAborted()) {
    managed.dispose();
    throw authenticationError(CANCELLED_MESSAGE);
  }
  let response: DeviceCodeResponse;
  try {
    response = await rejectOnAbort(
      fetchDeviceCode(`${settings.authority}/oauth2/v2.0/devicecode`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: settings.azureClientId,
          scope: settings.scopes.join(" "),
        }).toString(),
        signal: managed.signal,
      }),
      managed.signal,
    );
  } catch {
    managed.dispose();
    throw managedFailure(managed, DEVICE_REQUEST_ERROR_MESSAGE, DEVICE_REQUEST_ERROR_MESSAGE);
  }

  if (managed.callerAborted() || managed.deadlineExpired()) {
    managed.dispose();
    throw managedFailure(managed, DEVICE_REQUEST_ERROR_MESSAGE, DEVICE_REQUEST_ERROR_MESSAGE);
  }
  if (!response.ok) {
    managed.dispose();
    throw authenticationError(DEVICE_REQUEST_ERROR_MESSAGE);
  }

  let payload: unknown;
  try {
    payload = await readJson(response, managed.signal);
  } catch {
    managed.dispose();
    throw managedFailure(managed, DEVICE_REQUEST_ERROR_MESSAGE, DEVICE_RESPONSE_ERROR_MESSAGE);
  }
  managed.dispose();
  return parseDeviceCodeResponse(payload, now());
}

async function storeTokens(
  store: DeviceCodeTokenStore,
  payload: unknown,
  managed: ManagedAbort,
  storageTimeoutMs: number,
): Promise<void> {
  let tokens: TokenResponse;
  try {
    tokens = parseTokenResponse(payload);
  } catch {
    throw authenticationError(TOKEN_RESPONSE_ERROR_MESSAGE);
  }

  if (managed.signal.aborted) {
    throw managedFailure(managed, EXPIRED_MESSAGE, STORE_ERROR_MESSAGE);
  }
  const storageManaged = createManagedAbort(managed.signal, storageTimeoutMs);
  try {
    await rejectOnAbort(
      store.store(tokens, { signal: storageManaged.signal }),
      storageManaged.signal,
    );
  } catch {
    if (storageManaged.callerAborted()) {
      throw managedFailure(managed, EXPIRED_MESSAGE, STORE_ERROR_MESSAGE);
    }
    throw authenticationError(STORE_ERROR_MESSAGE);
  } finally {
    storageManaged.dispose();
  }
  if (managed.signal.aborted) {
    throw managedFailure(managed, EXPIRED_MESSAGE, STORE_ERROR_MESSAGE);
  }
}

async function pollForTokens(
  settings: DeviceCodeSettings,
  store: DeviceCodeTokenStore,
  parsed: ParsedDeviceCodeResponse,
  dependencies: Required<Pick<DeviceCodeLoginDependencies, "fetch" | "now" | "sleep">> & {
    managed: ManagedAbort;
    storageTimeoutMs: number;
  },
): Promise<void> {
  let delayMilliseconds = parsed.intervalMilliseconds;

  while (true) {
    if (dependencies.managed.signal.aborted) {
      throw managedFailure(dependencies.managed, EXPIRED_MESSAGE, POLLING_ERROR_MESSAGE);
    }
    const remainingLifetime = parsed.expiresAt - dependencies.now();
    if (!Number.isSafeInteger(remainingLifetime) || remainingLifetime <= 0) {
      throw authenticationError(EXPIRED_MESSAGE);
    }

    try {
      await rejectOnAbort(
        dependencies.sleep(
          Math.min(delayMilliseconds, remainingLifetime),
          dependencies.managed.signal,
        ),
        dependencies.managed.signal,
      );
    } catch {
      throw managedFailure(dependencies.managed, EXPIRED_MESSAGE, POLLING_ERROR_MESSAGE);
    }

    if (dependencies.managed.signal.aborted) {
      throw managedFailure(dependencies.managed, EXPIRED_MESSAGE, POLLING_ERROR_MESSAGE);
    }
    if (dependencies.now() >= parsed.expiresAt) {
      throw authenticationError(EXPIRED_MESSAGE);
    }

    let response: DeviceCodeResponse;
    try {
      response = await rejectOnAbort(
        dependencies.fetch(settings.tokenEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: settings.azureClientId,
            device_code: parsed.deviceCode,
          }).toString(),
          signal: dependencies.managed.signal,
        }),
        dependencies.managed.signal,
      );
    } catch {
      throw managedFailure(dependencies.managed, EXPIRED_MESSAGE, POLLING_ERROR_MESSAGE);
    }

    if (dependencies.managed.signal.aborted) {
      throw managedFailure(dependencies.managed, EXPIRED_MESSAGE, POLLING_ERROR_MESSAGE);
    }
    let payload: unknown;
    try {
      payload = await readJson(response, dependencies.managed.signal);
    } catch {
      throw managedFailure(dependencies.managed, EXPIRED_MESSAGE, POLLING_ERROR_MESSAGE);
    }
    if (response.ok) {
      await storeTokens(store, payload, dependencies.managed, dependencies.storageTimeoutMs);
      return;
    }
    if (!isRecord(payload) || typeof payload.error !== "string") {
      throw authenticationError(POLLING_ERROR_MESSAGE);
    }

    switch (payload.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        delayMilliseconds += SLOW_DOWN_SECONDS * 1000;
        if (!Number.isSafeInteger(delayMilliseconds)) {
          throw authenticationError(POLLING_ERROR_MESSAGE);
        }
        break;
      case "authorization_declined":
        throw authenticationError(DECLINED_MESSAGE);
      case "expired_token":
        throw authenticationError(EXPIRED_MESSAGE);
      default:
        throw authenticationError(POLLING_ERROR_MESSAGE);
    }
  }
}

export async function startDeviceCodeLogin(
  settings: DeviceCodeSettings,
  store: DeviceCodeTokenStore,
  dependencies: DeviceCodeLoginDependencies = {},
): Promise<DeviceCodeLoginSession> {
  const flowSettings: DeviceCodeSettings = Object.freeze({
    ...settings,
    scopes: Object.freeze([...settings.scopes]),
  });
  const fetchDeviceCode: DeviceCodeFetch =
    dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const storageTimeoutMs = dependencies.storageTimeoutMs ?? DEFAULT_STORAGE_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("Device-code request timeout must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(storageTimeoutMs) || storageTimeoutMs <= 0) {
    throw new Error("Device-code storage timeout must be a positive safe integer.");
  }
  const parsed = await requestDeviceCode(
    flowSettings,
    fetchDeviceCode,
    now,
    dependencies.signal,
    requestTimeoutMs,
  );
  let polling: Promise<void> | undefined;
  const publicDetails = freezeDetails(parsed.details);

  return {
    details: publicDetails,
    poll() {
      if (polling === undefined) {
        const remainingLifetime = parsed.expiresAt - now();
        if (!Number.isSafeInteger(remainingLifetime) || remainingLifetime <= 0) {
          polling = Promise.reject(authenticationError(EXPIRED_MESSAGE));
        } else {
          const managed = createManagedAbort(dependencies.signal, remainingLifetime);
          polling = pollForTokens(flowSettings, store, parsed, {
            fetch: fetchDeviceCode,
            now,
            sleep,
            managed,
            storageTimeoutMs,
          }).finally(() => managed.dispose());
        }
      }
      return polling;
    },
  };
}
