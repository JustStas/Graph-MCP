import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { persistSetupConfig } from "./config.js";
import { createServer } from "./server.js";

const VERSION = "0.6.0";
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

const defaultOutput: CliOutput = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

function messageFor(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "Unknown error.";
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
  const prompt = dependencies.prompt ?? createDefaultPrompt();
  const persist = dependencies.persistSetupConfig ?? persistSetupConfig;
  try {
    const azureClientId = (await prompt.question("Azure Client ID: ")).trim();
    if (azureClientId === "") {
      throw new Error("Azure Client ID is required.");
    }
    const azureTenantId = (await prompt.question("Azure Tenant ID [common]: ")).trim() || "common";
    await persist({ azureClientId, azureTenantId });
    output.stdout(SETUP_OUTPUT);
  } finally {
    await prompt.close();
  }
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
    await (dependencies.stdio ?? (() => runStdio(output)))();
    return 0;
  }
  if (args.length === 1 && command === "setup") {
    try {
      await runSetup(dependencies, output);
      return 0;
    } catch (error: unknown) {
      output.stderr(`Graph MCP setup failed: ${messageFor(error)}\n`);
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

  output.stderr(`Unknown arguments: ${args.join(" ")}\n${HELP}`);
  return 1;
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }

  const modulePath = realPathOrUndefined(fileURLToPath(import.meta.url));
  const entryPath = realPathOrUndefined(resolve(entry));
  return modulePath !== undefined && entryPath !== undefined && modulePath === entryPath;
}

function realPathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
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
      defaultOutput.stderr(`Graph MCP failed: ${messageFor(error)}\n`);
      process.exitCode = 1;
    },
  );
}
