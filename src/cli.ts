import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { persistSetupConfig } from "./config.js";
import { createServer } from "./server.js";

const VERSION = "0.8.0";
const PROTOCOL_ERROR_MESSAGE = "Graph MCP protocol error.";
const HELP = `Graph MCP ${VERSION}

Usage:
  graph-mcp             Start the MCP server over stdio
  graph-mcp setup       Configure Azure Client ID and Tenant ID
  graph-mcp --help      Show this help
  graph-mcp --version   Show the version
`;
const SETUP_OUTPUT = `Graph MCP configuration saved.

Manual MCP examples:

Claude Code:
  claude mcp add graph-mcp -- node /path/to/graph-mcp/dist/cli.js

Codex:
  codex mcp add graph-mcp -- node /path/to/graph-mcp/dist/cli.js
`;
const UNKNOWN_ARGUMENTS_MESSAGE = "Unknown arguments. Run graph-mcp --help for usage.\n";
const EMPTY_CLIENT_ID_MESSAGE = "Azure Client ID is required.";
const SETUP_INPUT_MESSAGE = "Unable to read setup input.";
const SETUP_SAVE_MESSAGE = "Unable to save configuration.";
const SETUP_CLOSE_MESSAGE = "Unable to close setup input.";
const SETUP_SAVED_CLEANUP_MESSAGE = "Configuration saved but cleanup failed.";
const SERVER_FAILURE_MESSAGE = "Graph MCP server failed.";

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliPrompt {
  readonly question: (message: string) => Promise<string>;
  readonly close: () => void | Promise<void>;
}

export interface CliDependencies {
  readonly output?: CliOutput;
  readonly prompt?: CliPrompt;
  readonly persistSetupConfig?: typeof persistSetupConfig;
  readonly stdio?: () => Promise<void>;
}

class CliFailure extends Error {
  readonly publicMessage: string;

  constructor(publicMessage: string) {
    super(publicMessage);
    this.name = "CliFailure";
    this.publicMessage = publicMessage;
  }
}

const defaultOutput: CliOutput = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

function setupMessageFor(error: unknown): string {
  return error instanceof CliFailure ? error.publicMessage : "Unexpected setup failure.";
}

function serverMessageFor(error: unknown): string {
  return error instanceof Error && error.message === PROTOCOL_ERROR_MESSAGE
    ? PROTOCOL_ERROR_MESSAGE
    : SERVER_FAILURE_MESSAGE;
}

function combineShutdownErrors(first: unknown, second: unknown): unknown {
  if (first === undefined) {
    return second;
  }
  if (second === undefined) {
    return first;
  }
  return new AggregateError([first, second], "Graph MCP shutdown failed.");
}

function createDefaultPrompt(): CliPrompt {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  return {
    question: (message) => prompt.question(message),
    close: () => {
      prompt.close();
    },
  };
}

async function runSetup(dependencies: CliDependencies, output: CliOutput): Promise<void> {
  let prompt: CliPrompt;
  try {
    prompt = dependencies.prompt ?? createDefaultPrompt();
  } catch {
    throw new CliFailure(SETUP_INPUT_MESSAGE);
  }
  const persist = dependencies.persistSetupConfig ?? persistSetupConfig;
  let primaryFailure: CliFailure | undefined;
  let azureClientId = "";
  let azureTenantId = "common";
  let saved = false;

  try {
    azureClientId = (await prompt.question("Azure Client ID: ")).trim();
  } catch {
    primaryFailure = new CliFailure(SETUP_INPUT_MESSAGE);
  }

  if (primaryFailure === undefined && azureClientId === "") {
    primaryFailure = new CliFailure(EMPTY_CLIENT_ID_MESSAGE);
  }

  if (primaryFailure === undefined) {
    try {
      azureTenantId = (await prompt.question("Azure Tenant ID [common]: ")).trim() || "common";
    } catch {
      primaryFailure = new CliFailure(SETUP_INPUT_MESSAGE);
    }
  }

  if (primaryFailure === undefined) {
    try {
      await persist({ azureClientId, azureTenantId });
      saved = true;
    } catch {
      primaryFailure = new CliFailure(SETUP_SAVE_MESSAGE);
    }
  }

  let cleanupFailed = false;
  try {
    await prompt.close();
  } catch {
    cleanupFailed = true;
  }

  if (primaryFailure !== undefined) {
    throw primaryFailure;
  }
  if (cleanupFailed) {
    throw new CliFailure(saved ? SETUP_SAVED_CLEANUP_MESSAGE : SETUP_CLOSE_MESSAGE);
  }

  output.stdout(SETUP_OUTPUT);
}

async function runStdio(output: CliOutput): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  let closePromise: Promise<void> | undefined;
  let resolveShutdown: () => void = () => undefined;
  let rejectShutdown: (error: unknown) => void = () => undefined;
  const shutdownRequested = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  let fatalError: Error | undefined;

  const onEnd = (): void => {
    void close().catch(() => undefined);
  };
  const onSignal = (): void => {
    void close().catch(() => undefined);
  };
  const removeListeners = (): void => {
    process.stdin.off("end", onEnd);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  function close(): Promise<void> {
    if (closePromise !== undefined) {
      return closePromise;
    }
    closePromise = (async () => {
      try {
        await server.close();
      } finally {
        removeListeners();
        if (fatalError !== undefined) {
          process.stdin.destroy();
        }
      }
    })();
    void closePromise.then(
      () => {
        if (fatalError === undefined) {
          resolveShutdown();
        } else {
          rejectShutdown(fatalError);
        }
      },
      (error: unknown) => {
        rejectShutdown(combineShutdownErrors(fatalError, error));
      },
    );
    return closePromise;
  }

  server.server.onerror = (): void => {
    if (fatalError !== undefined) {
      return;
    }
    fatalError = new Error(PROTOCOL_ERROR_MESSAGE);
    output.stderr(`${PROTOCOL_ERROR_MESSAGE}\n`);
    void close().catch(() => undefined);
  };

  process.stdin.once("end", onEnd);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await server.connect(transport);
    if (process.stdin.readableEnded) {
      await close();
    } else {
      await shutdownRequested;
    }
  } catch (error: unknown) {
    if (closePromise === undefined) {
      try {
        await close();
      } catch (closeError: unknown) {
        throw combineShutdownErrors(error, closeError);
      }
    }
    throw error;
  }
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? defaultOutput;
  const command = args[0];
  if (command === undefined) {
    try {
      await (dependencies.stdio ?? (() => runStdio(output)))();
      return 0;
    } catch (error: unknown) {
      output.stderr(`Graph MCP failed: ${serverMessageFor(error)}\n`);
      return 1;
    }
  }
  if (args.length === 1 && command === "setup") {
    try {
      await runSetup(dependencies, output);
      return 0;
    } catch (error: unknown) {
      output.stderr(`Graph MCP setup failed: ${setupMessageFor(error)}\n`);
      return 1;
    }
  }
  if (args.length === 1 && (command === "--help" || command === "-h")) {
    output.stdout(HELP);
    return 0;
  }
  if (args.length === 1 && (command === "--version" || command === "-v")) {
    output.stdout(`${VERSION}\n`);
    return 0;
  }

  output.stderr(UNKNOWN_ARGUMENTS_MESSAGE);
  return 1;
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }

  let candidatePath: string;
  try {
    candidatePath = resolve(entry);
  } catch {
    return false;
  }

  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  const entryPath = realPathOrUndefined(candidatePath);
  return entryPath !== undefined && modulePath === entryPath;
}

function realPathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error: unknown) {
    if (
      error instanceof TypeError ||
      (error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" ||
          error.code === "EACCES" ||
          error.code === "ENOTDIR" ||
          error.code === "ERR_INVALID_ARG_TYPE"))
    ) {
      return undefined;
    }
    throw error;
  }
}

if (isDirectEntry()) {
  void main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      defaultOutput.stderr(`Graph MCP failed: ${serverMessageFor(error)}\n`);
      process.exitCode = 1;
    },
  );
}
