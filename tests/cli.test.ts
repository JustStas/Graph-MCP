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

function promptAnswers(...answers: string[]) {
  return {
    question: vi.fn(() => Promise.resolve(answers.shift() ?? "")),
    close: vi.fn(),
  };
}

function promptFailure(error: unknown, close: () => void | Promise<void> = vi.fn()) {
  const rejection = error instanceof Error ? error : new Error("prompt failed");
  return {
    question: vi.fn(() => Promise.reject(rejection)),
    close,
  };
}

function stableOutput(): NonNullable<CliDependencies["output"]> {
  return {
    stdout: vi.fn(),
    stderr: vi.fn(),
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

  test("uses a stable usage diagnostic without echoing unknown arguments", async () => {
    const output = capturedOutput();
    const sentinel = "access_token=unknown-argument-secret";

    const exitCode = await cli.main(["--not-a-command", sentinel], { output: output.output });

    expect(exitCode).toBe(1);
    expect(output.stderr()).toBe("Unknown arguments. Run graph-mcp --help for usage.\n");
    expect(output.stderr()).not.toContain(sentinel);
  });

  test.each([
    ["access token", "access_token=access-token-secret"],
    ["refresh token", "refresh_token=refresh-token-secret"],
    ["authorization code", "authorization-code=authorization-code-secret"],
    ["PKCE verifier", "code_verifier=pkce-verifier-secret"],
    ["encryption key", "encryption_key=encryption-key-secret"],
    ["assignment sentinel", "assignment-sentinel=do-not-leak"],
    ["JSON sentinel", '{"error":"json-sentinel"}'],
  ])("redacts arbitrary %s prompt failures", async (_category, sentinel) => {
    const output = capturedOutput();
    const prompt = promptFailure(new Error(sentinel));

    const exitCode = await cli.main(["setup"], { output: output.output, prompt });

    expect(exitCode).toBe(1);
    expect(output.stderr()).toBe("Graph MCP setup failed: Unable to read setup input.\n");
    expect(output.stderr()).not.toContain(sentinel);
    expect(prompt.close).toHaveBeenCalledTimes(1);
  });

  test("closes setup input exactly once and prints success only after cleanup", async () => {
    const events: string[] = [];
    const output = {
      stdout: vi.fn(() => events.push("output")),
      stderr: vi.fn(),
    };
    const prompt = {
      question: vi.fn((message: string) => {
        events.push(message);
        return Promise.resolve(message.startsWith("Azure Client ID") ? "client-id" : "tenant-id");
      }),
      close: vi.fn(() => {
        events.push("close");
      }),
    };
    const persistSetupConfig = vi.fn(() => {
      events.push("persist");
      return Promise.resolve();
    });

    const exitCode = await cli.main(["setup"], { output, prompt, persistSetupConfig });

    expect(exitCode).toBe(0);
    expect(prompt.close).toHaveBeenCalledTimes(1);
    expect(events.slice(-3)).toEqual(["persist", "close", "output"]);
  });

  test("preserves the exact empty Client ID error when cleanup also fails", async () => {
    const output = stableOutput();
    const close = vi.fn(() => Promise.reject(new Error("close-secret")));
    const prompt = promptAnswers("   ");
    prompt.close = close;

    const exitCode = await cli.main(["setup"], { output, prompt });

    expect(exitCode).toBe(1);
    expect(output.stderr).toHaveBeenCalledWith(
      "Graph MCP setup failed: Azure Client ID is required.\n",
    );
    expect(output.stderr).not.toHaveBeenCalledWith(expect.stringContaining("close-secret"));
    expect(close).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "question",
      promptFailure(new Error("question access_token=secret")),
      "Unable to read setup input.",
    ],
    ["persistence", promptAnswers("client-id", "tenant-id"), "Unable to save configuration."],
  ])("does not mask %s failures with cleanup failures", async (_kind, prompt, publicMessage) => {
    const output = stableOutput();
    const close = vi.fn(() => Promise.reject(new Error("cleanup refresh_token=secret")));
    prompt.close = close;
    const persistSetupConfig =
      _kind === "persistence"
        ? vi.fn(() => Promise.reject(new Error("persist authorization-code=secret")))
        : vi.fn(() => Promise.resolve());

    const exitCode = await cli.main(["setup"], {
      output,
      prompt,
      persistSetupConfig,
    });

    expect(exitCode).toBe(1);
    expect(output.stderr).toHaveBeenCalledWith(`Graph MCP setup failed: ${publicMessage}\n`);
    expect(output.stderr).not.toHaveBeenCalledWith(expect.stringContaining("secret"));
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("reports saved configuration cleanup failure without contradictory success", async () => {
    const output = stableOutput();
    const prompt = promptAnswers("client-id", "tenant-id");
    const close = vi.fn(() => Promise.reject(new Error("encryption-key=secret")));
    prompt.close = close;
    const persistSetupConfig = vi.fn(() => Promise.resolve());

    const exitCode = await cli.main(["setup"], {
      output,
      prompt,
      persistSetupConfig,
    });

    expect(exitCode).toBe(1);
    expect(output.stdout).not.toHaveBeenCalled();
    expect(output.stderr).toHaveBeenCalledWith(
      "Graph MCP setup failed: Configuration saved but cleanup failed.\n",
    );
    expect(output.stderr).not.toHaveBeenCalledWith(expect.stringContaining("encryption-key"));
    expect(close).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["stdio", () => Promise.reject(new Error("access_token=stdio-secret"))],
    ["top-level", () => Promise.reject(new Error('{"error":"top-level-secret"}'))],
  ])("redacts arbitrary %s failures", async (_kind, stdio) => {
    const output = stableOutput();

    const exitCode = await cli.main([], { output, stdio });

    expect(exitCode).toBe(1);
    expect(output.stderr).toHaveBeenCalledWith("Graph MCP failed: Graph MCP server failed.\n");
    expect(output.stderr).not.toHaveBeenCalledWith(expect.stringContaining("secret"));
  });
});
