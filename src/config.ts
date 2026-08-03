import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULTS = {
  azureClientId: "",
  azureTenantId: "common",
  graphRedirectUri: "http://localhost:3000/auth/callback",
  graphTokenEncryptionKey: "",
  graphTokenRefreshBuffer: 300,
  graphRateLimitMaxRequests: 10000,
  graphRateLimitWindow: 600,
  graphDebug: false,
} as const;

const SCOPES: readonly string[] = Object.freeze([
  "offline_access",
  "openid",
  "profile",
  "User.Read",
  "User.ReadBasic.All",
  "Chat.Read",
  "Chat.ReadWrite",
  "ChatMessage.Send",
  "ChannelMessage.Read.All",
  "ChannelMessage.Send",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "ChannelMember.Read.All",
  "Calendars.ReadWrite",
  "Mail.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "MailboxSettings.ReadWrite",
  "Presence.Read",
  "Presence.Read.All",
  "Presence.ReadWrite",
  "OnlineMeetings.Read",
  "OnlineMeetingTranscript.Read.All",
  "OnlineMeetingRecording.Read.All",
  "Files.ReadWrite.All",
]);

interface PersistedConfig {
  azureClientId?: string;
  azureTenantId?: string;
}

export interface Settings {
  readonly azureClientId: string;
  readonly azureTenantId: string;
  readonly graphRedirectUri: string;
  readonly graphTokenEncryptionKey: string;
  readonly graphTokenRefreshBuffer: number;
  readonly graphRateLimitMaxRequests: number;
  readonly graphRateLimitWindow: number;
  readonly graphDebug: boolean;
  readonly configDir: string;
  readonly configFile: string;
  readonly tokenFile: string;
  readonly keyFile: string;
  readonly authority: string;
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  readonly scopes: readonly string[];
}

export interface LoadSettingsOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

function configPaths(homeDir: string) {
  const configDir = join(homeDir, ".graph-mcp");
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    tokenFile: join(configDir, "tokens-v2.enc"),
    keyFile: join(configDir, ".key-v2"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePersistedConfig(value: unknown, configFile: string): PersistedConfig {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid config file ${configFile}: expected a JSON object with string client and tenant IDs.`,
    );
  }

  if (
    (value.azureClientId !== undefined && typeof value.azureClientId !== "string") ||
    (value.azureTenantId !== undefined && typeof value.azureTenantId !== "string")
  ) {
    throw new Error(
      `Invalid config file ${configFile}: azureClientId and azureTenantId must be strings.`,
    );
  }

  return {
    ...(typeof value.azureClientId === "string" ? { azureClientId: value.azureClientId } : {}),
    ...(typeof value.azureTenantId === "string" ? { azureTenantId: value.azureTenantId } : {}),
  };
}

async function readPersistedConfig(configFile: string): Promise<PersistedConfig> {
  let text: string;
  try {
    text = await readFile(configFile, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read config file ${configFile}.`, { cause: error });
  }

  try {
    return validatePersistedConfig(JSON.parse(text) as unknown, configFile);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid config file ${configFile}: fix or remove the malformed JSON.`, {
        cause: error,
      });
    }
    throw error;
  }
}

function parsePositiveInteger(variable: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${variable} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${variable} must be a positive integer.`);
  }
  return parsed;
}

function parseBoolean(variable: string, value: string): boolean {
  switch (value.toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${variable} must be one of true, false, 1, 0, yes, no, on, or off.`);
  }
}

function tenantOrDefault(value: string): string {
  return value.trim() || DEFAULTS.azureTenantId;
}

export async function loadSettings(options: LoadSettingsOptions = {}): Promise<Settings> {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const paths = configPaths(homeDir);
  const persisted = await readPersistedConfig(paths.configFile);

  const azureClientId =
    env.AZURE_CLIENT_ID !== undefined
      ? env.AZURE_CLIENT_ID
      : (persisted.azureClientId ?? DEFAULTS.azureClientId);
  const azureTenantId = tenantOrDefault(
    env.AZURE_TENANT_ID !== undefined
      ? env.AZURE_TENANT_ID
      : (persisted.azureTenantId ?? DEFAULTS.azureTenantId),
  );
  const graphRedirectUri =
    env.GRAPH_REDIRECT_URI !== undefined ? env.GRAPH_REDIRECT_URI : DEFAULTS.graphRedirectUri;
  const graphTokenEncryptionKey =
    env.GRAPH_TOKEN_ENCRYPTION_KEY !== undefined
      ? env.GRAPH_TOKEN_ENCRYPTION_KEY
      : DEFAULTS.graphTokenEncryptionKey;
  const graphTokenRefreshBuffer =
    env.GRAPH_TOKEN_REFRESH_BUFFER !== undefined
      ? parsePositiveInteger("GRAPH_TOKEN_REFRESH_BUFFER", env.GRAPH_TOKEN_REFRESH_BUFFER)
      : DEFAULTS.graphTokenRefreshBuffer;
  const graphRateLimitMaxRequests =
    env.GRAPH_RATE_LIMIT_MAX_REQUESTS !== undefined
      ? parsePositiveInteger("GRAPH_RATE_LIMIT_MAX_REQUESTS", env.GRAPH_RATE_LIMIT_MAX_REQUESTS)
      : DEFAULTS.graphRateLimitMaxRequests;
  const graphRateLimitWindow =
    env.GRAPH_RATE_LIMIT_WINDOW !== undefined
      ? parsePositiveInteger("GRAPH_RATE_LIMIT_WINDOW", env.GRAPH_RATE_LIMIT_WINDOW)
      : DEFAULTS.graphRateLimitWindow;
  const graphDebug =
    env.GRAPH_DEBUG !== undefined
      ? parseBoolean("GRAPH_DEBUG", env.GRAPH_DEBUG)
      : DEFAULTS.graphDebug;
  const authority = `https://login.microsoftonline.com/${azureTenantId}`;

  const settings: Settings = {
    azureClientId,
    azureTenantId,
    graphRedirectUri,
    graphTokenEncryptionKey,
    graphTokenRefreshBuffer,
    graphRateLimitMaxRequests,
    graphRateLimitWindow,
    graphDebug,
    ...paths,
    authority,
    authorizeEndpoint: `${authority}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${authority}/oauth2/v2.0/token`,
    scopes: SCOPES,
  };
  return Object.freeze(settings);
}

export async function persistSetupConfig(
  input: { azureClientId: string; azureTenantId: string },
  options: { homeDir?: string } = {},
): Promise<void> {
  const paths = configPaths(options.homeDir ?? homedir());
  const config = {
    azureClientId: input.azureClientId.trim(),
    azureTenantId: tenantOrDefault(input.azureTenantId),
  };

  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await chmod(paths.configDir, 0o700);
  await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(paths.configFile, 0o600);
}
