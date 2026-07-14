import { beforeAll, describe, expect, test, vi } from "vitest";

import type { CliDependencies } from "../src/cli.js";

interface CapturedOutput {
  readonly output: NonNullable<CliDependencies["output"]>;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function capturedOutput(): CapturedOutput {
  let stdout = "";
  let stderr = "";
  return {
    output: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function promptAnswers(...answers: string[]): NonNullable<CliDependencies["prompt"]> {
  return {
    question: vi.fn(() => Promise.resolve(answers.shift() ?? "")),
    close: vi.fn(),
  };
}

let cli: typeof import("../src/cli.js");
let importStdoutCalls = 0;
let importStderrCalls = 0;
let importExitCode: number | string | null | undefined;

beforeAll(async () => {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const previousArgs = process.argv;
  const previousExitCode = process.exitCode;
  process.argv = [process.execPath, "graph-mcp", "--help"];
  process.exitCode = undefined;

  try {
    cli = await import("../src/cli.js");
    importStdoutCalls = stdout.mock.calls.length;
    importStderrCalls = stderr.mock.calls.length;
    importExitCode = process.exitCode;
  } finally {
    process.argv = previousArgs;
    process.exitCode = previousExitCode;
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

describe("CLI", () => {
  test("returns code 1 with a precise sanitized error when Client ID is empty", async () => {
    const output = capturedOutput();
    const persistSetupConfig = vi.fn(() => Promise.resolve());
    const exitCode = await cli.main(["setup"], {
      output: output.output,
      prompt: promptAnswers("  "),
      persistSetupConfig,
    });

    expect(exitCode).toBe(1);
    expect(output.stderr()).toBe("Graph MCP setup failed: Azure Client ID is required.\n");
    expect(output.stderr()).not.toContain("client-secret");
    expect(persistSetupConfig).not.toHaveBeenCalled();
  });

  test("persists the Client ID and normalizes a blank tenant to common", async () => {
    const output = capturedOutput();
    const persistSetupConfig = vi.fn(() => Promise.resolve());
    const exitCode = await cli.main(["setup"], {
      output: output.output,
      prompt: promptAnswers(" client-id ", "   "),
      persistSetupConfig,
    });

    expect(exitCode).toBe(0);
    expect(persistSetupConfig).toHaveBeenCalledWith({
      azureClientId: "client-id",
      azureTenantId: "common",
    });
  });

  test("prints Claude and Codex manual MCP examples without secrets", async () => {
    const output = capturedOutput();
    const exitCode = await cli.main(["setup"], {
      output: output.output,
      prompt: promptAnswers("client-id", "tenant-id"),
      persistSetupConfig: vi.fn(() => Promise.resolve()),
    });

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain("Claude Code:");
    expect(output.stdout()).toContain("Codex:");
    expect(output.stdout()).toContain("claude mcp add graph-mcp");
    expect(output.stdout()).toContain("codex mcp add graph-mcp");
    expect(output.stdout()).not.toContain("AZURE_CLIENT_SECRET");
    expect(output.stdout()).not.toContain("client-secret");
  });

  test.each([
    ["--help", "Graph MCP 0.6.0"],
    ["--version", "0.6.0"],
  ])("%s returns code 0 without starting stdio", async (argument, expectedOutput) => {
    const output = capturedOutput();
    const stdio = vi.fn(() => Promise.reject(new Error("stdio must not start")));
    const exitCode = await cli.main([argument], { output: output.output, stdio });

    expect(exitCode).toBe(0);
    expect(output.stdout()).toContain(expectedOutput);
    expect(output.stderr()).toBe("");
    expect(stdio).not.toHaveBeenCalled();
  });

  test("importing the CLI module has no process side effects", () => {
    expect(importStdoutCalls).toBe(0);
    expect(importStderrCalls).toBe(0);
    expect(importExitCode).toBeUndefined();
  });
});
