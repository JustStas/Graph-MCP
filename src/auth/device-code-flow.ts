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
  store(tokens: TokenResponse): Promise<void>;
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
}

interface ParsedDeviceCodeResponse {
  readonly deviceCode: string;
  readonly details: DeviceCodeLoginDetails;
  readonly intervalMilliseconds: number;
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw authenticationError(CANCELLED_MESSAGE);
  }
}

function rejectOnAbort<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const onAbort = () => reject(authenticationError(CANCELLED_MESSAGE));
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
        reject(error instanceof Error ? error : new Error("Device-code operation failed."));
      },
    );
  });
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
    intervalMilliseconds,
    details: {
      userCode,
      verificationUri,
      expiresAt,
      message,
    },
  };
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(authenticationError(CANCELLED_MESSAGE));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readJson(
  response: DeviceCodeResponse,
  signal: AbortSignal,
  errorMessage: string,
): Promise<unknown> {
  try {
    const payload = await rejectOnAbort(response.json(), signal);
    throwIfAborted(signal);
    return payload;
  } catch (error: unknown) {
    if (signal.aborted) {
      throw authenticationError(CANCELLED_MESSAGE);
    }
    if (error instanceof AuthenticationError) {
      throw error;
    }
    throw authenticationError(errorMessage);
  }
}

async function requestDeviceCode(
  settings: DeviceCodeSettings,
  fetchDeviceCode: DeviceCodeFetch,
  now: () => number,
  signal: AbortSignal,
): Promise<ParsedDeviceCodeResponse> {
  throwIfAborted(signal);
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
        signal,
      }),
      signal,
    );
  } catch {
    if (signal.aborted) {
      throw authenticationError(CANCELLED_MESSAGE);
    }
    throw authenticationError(DEVICE_REQUEST_ERROR_MESSAGE);
  }

  throwIfAborted(signal);
  if (!response.ok) {
    throw authenticationError(DEVICE_REQUEST_ERROR_MESSAGE);
  }

  const payload = await readJson(response, signal, DEVICE_RESPONSE_ERROR_MESSAGE);
  return parseDeviceCodeResponse(payload, now());
}

async function storeTokens(
  store: DeviceCodeTokenStore,
  payload: unknown,
  signal: AbortSignal,
): Promise<void> {
  let tokens: TokenResponse;
  try {
    tokens = parseTokenResponse(payload);
  } catch {
    throw authenticationError(TOKEN_RESPONSE_ERROR_MESSAGE);
  }

  throwIfAborted(signal);
  try {
    await rejectOnAbort(store.store(tokens), signal);
  } catch {
    if (signal.aborted) {
      throw authenticationError(CANCELLED_MESSAGE);
    }
    throw authenticationError(STORE_ERROR_MESSAGE);
  }
  throwIfAborted(signal);
}

async function pollForTokens(
  settings: DeviceCodeSettings,
  store: DeviceCodeTokenStore,
  parsed: ParsedDeviceCodeResponse,
  dependencies: Required<Pick<DeviceCodeLoginDependencies, "fetch" | "now" | "sleep">> & {
    signal: AbortSignal;
  },
): Promise<void> {
  let delayMilliseconds = parsed.intervalMilliseconds;

  while (true) {
    throwIfAborted(dependencies.signal);
    if (dependencies.now() >= parsed.details.expiresAt) {
      throw authenticationError(EXPIRED_MESSAGE);
    }

    try {
      await rejectOnAbort(
        dependencies.sleep(delayMilliseconds, dependencies.signal),
        dependencies.signal,
      );
    } catch (error: unknown) {
      if (dependencies.signal.aborted) {
        throw authenticationError(CANCELLED_MESSAGE);
      }
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw authenticationError(POLLING_ERROR_MESSAGE);
    }

    throwIfAborted(dependencies.signal);
    if (dependencies.now() >= parsed.details.expiresAt) {
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
          signal: dependencies.signal,
        }),
        dependencies.signal,
      );
    } catch {
      if (dependencies.signal.aborted) {
        throw authenticationError(CANCELLED_MESSAGE);
      }
      throw authenticationError(POLLING_ERROR_MESSAGE);
    }

    throwIfAborted(dependencies.signal);
    const payload = await readJson(response, dependencies.signal, POLLING_ERROR_MESSAGE);
    if (response.ok) {
      await storeTokens(store, payload, dependencies.signal);
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
  const fetchDeviceCode: DeviceCodeFetch =
    dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const signal = dependencies.signal ?? new AbortController().signal;
  const parsed = await requestDeviceCode(settings, fetchDeviceCode, now, signal);
  let polling: Promise<void> | undefined;

  return {
    details: parsed.details,
    poll() {
      polling ??= pollForTokens(settings, store, parsed, {
        fetch: fetchDeviceCode,
        now,
        sleep,
        signal,
      });
      return polling;
    },
  };
}
