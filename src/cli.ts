import { createInterface } from "node:readline/promises";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { persistSetupConfig } from "./config.js";
import { createServer } from "./server.js";

const VERSION = "0.6.0";
const HELP = `Graph MCP ${VERSION}

Usage:
  graph-mcp             Start the MCP server over stdio
  graph-mcp setup       Configure Azure Client ID and Tenant ID
  graph-mcp --help      Show this help
  graph-mcp --version   Show the version
`;

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

async function runSetup(): Promise<void> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const azureClientId = (await prompt.question("Azure Client ID: ")).trim();
    if (azureClientId === "") {
      throw new Error("Azure Client ID is required.");
    }
    const azureTenantId = (await prompt.question("Azure Tenant ID [common]: ")).trim() || "common";
    await persistSetupConfig({ azureClientId, azureTenantId });
    process.stdout.write("Graph MCP configuration saved.\n");
  } finally {
    prompt.close();
  }
}

async function runStdio(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  let closePromise: Promise<void> | undefined;
  let resolveShutdown: () => void = () => undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const onEnd = (): void => {
    void close();
  };
  const onSignal = (): void => {
    void close();
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
      } catch (error: unknown) {
        process.stderr.write(`Graph MCP shutdown failed: ${messageFor(error)}\n`);
        process.exitCode = 1;
      } finally {
        removeListeners();
        resolveShutdown();
      }
    })();
    return closePromise;
  }

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
    await close();
    throw error;
  }
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  if (command === undefined) {
    await runStdio();
    return 0;
  }
  if (args.length === 1 && command === "setup") {
    await runSetup();
    return 0;
  }
  if (args.length === 1 && (command === "--help" || command === "-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.length === 1 && (command === "--version" || command === "-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  process.stderr.write(`Unknown arguments: ${args.join(" ")}\n${HELP}`);
  return 1;
}

void main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(`Graph MCP failed: ${messageFor(error)}\n`);
    process.exitCode = 1;
  },
);
