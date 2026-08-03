import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, test } from "vitest";

interface PackageValidationResult {
  readonly violations: readonly string[];
}

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const bundlePath = join(repositoryRoot, "dist/cli.js");
const allowedPackagePaths = [
  "LICENSE",
  "README.md",
  "dist/cli.js",
  "dist/cli.js.map",
  "package.json",
];

interface NpmPackFile {
  readonly path: string;
  readonly mode: number;
}

interface NpmPackResult {
  readonly name: string;
  readonly version: string;
  readonly files: readonly NpmPackFile[];
}

async function npmPackDryRun(): Promise<NpmPackResult> {
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--dry-run"], {
    cwd: repositoryRoot,
    maxBuffer: 2_000_000,
  });
  const result = JSON.parse(stdout) as readonly NpmPackResult[];
  expect(result).toHaveLength(1);
  return result[0]!;
}

async function validatePackageResult(input: unknown): Promise<PackageValidationResult> {
  const verifier = await import("../scripts/verify-package.mjs");
  if (typeof verifier.validatePackageResult !== "function") {
    throw new Error("The package verifier must export validatePackageResult.");
  }
  return verifier.validatePackageResult(input) as PackageValidationResult;
}

describe("npm package contents", () => {
  beforeAll(async () => {
    await execFileAsync(process.execPath, ["scripts/clean.mjs"], { cwd: repositoryRoot });
    await execFileAsync(process.execPath, ["scripts/build.mjs"], {
      cwd: repositoryRoot,
      env: { ...process.env, GRAPH_MCP_SKIP_PLUGIN_SYNC: "1" },
    });
  }, 30_000);

  test("contains the executable package files and excludes source/runtime artifacts", async () => {
    const packResult = await npmPackDryRun();
    const files = packResult.files;
    const paths = files.map((file) => file.path.replaceAll("\\", "/")).sort();

    expect(packResult.name).toBe("@juststas/graph-mcp");
    expect(packResult.version).toBe("0.6.1");
    expect(paths).toEqual([...allowedPackagePaths].sort());
    expect(files.find((file) => file.path === "dist/cli.js")?.mode).toBe(0o755);
  }, 30_000);

  test("the package verifier accepts the current package contents", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/verify-package.mjs"], {
      cwd: repositoryRoot,
      maxBuffer: 2_000_000,
    });

    expect(stdout).toContain("npm package verification passed");
  }, 30_000);

  test("the bundled CLI executes through an npm-style symlink", async () => {
    if (process.platform === "win32") {
      return;
    }
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "graph-mcp-cli-link-"));
    const linkPath = join(temporaryDirectory, "graph-mcp");
    try {
      await symlink(bundlePath, linkPath, "file");
      const { stdout, stderr } = await execFileAsync(process.execPath, [linkPath, "--version"], {
        cwd: repositoryRoot,
      });

      expect(stdout).toBe("0.6.1\n");
      expect(stderr).toBe("");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("direct node launch of the current bundle prints the version", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bundlePath, "--version"], {
      cwd: repositoryRoot,
    });

    expect(stdout).toBe("0.6.1\n");
    expect(stderr).toBe("");
  });

  test("runs a copied bundle from a path with spaces without repository node_modules", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "Graph MCP copied bundle "));
    const copiedBundle = join(temporaryDirectory, "path with spaces", "graph-mcp.js");
    try {
      await mkdir(dirname(copiedBundle), { recursive: true });
      await copyFile(bundlePath, copiedBundle);
      await chmod(copiedBundle, 0o755);
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [copiedBundle, "--version"],
        {
          cwd: temporaryDirectory,
        },
      );

      expect(stdout).toBe("0.6.1\n");
      expect(stderr).toBe("");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("launches the executable directly on POSIX or through the node shim on Windows", async () => {
    const command = process.platform === "win32" ? process.execPath : bundlePath;
    const args = process.platform === "win32" ? [bundlePath, "--version"] : ["--version"];
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: repositoryRoot });

    expect(stdout).toBe("0.6.1\n");
    expect(stderr).toBe("");
  });

  test("accepts canonical backslash and leading-dot package paths", async () => {
    const report = await validatePackageResult([
      {
        files: [
          { path: "LICENSE", mode: 0o644 },
          { path: "./README.md", mode: 0o644 },
          { path: "dist\\cli.js", mode: 0o755 },
          { path: "./dist/cli.js.map", mode: 0o644 },
          { path: "package.json", mode: 0o644 },
        ],
      },
    ]);

    expect(report.violations).toEqual([]);
  });

  test.each([
    "",
    "\0bad",
    "/absolute/path",
    "C:\\absolute\\path",
    "../traversal",
    "a/../traversal",
  ])("rejects unsafe package path %j", async (path) => {
    const report = await validatePackageResult([{ files: [{ path, mode: 0o644 }] }]);

    expect(report.violations.some((violation) => violation.includes("invalid path"))).toBe(true);
  });

  test("aggregates structural, duplicate, missing, unexpected, and forbidden violations", async () => {
    const report = await validatePackageResult([
      {
        files: [
          null,
          { path: 42, mode: "not-a-mode" },
          { path: "README.md", mode: 0o644 },
          { path: "./README.md", mode: 0o644 },
          { path: "token.json", mode: 0o644 },
          { path: "extra.txt", mode: 0o644 },
        ],
      },
      { files: "not-a-file-list" },
    ]);

    expect(report.violations.some((violation) => violation.includes("exactly one"))).toBe(true);
    expect(report.violations.some((violation) => violation.includes("must be an object"))).toBe(
      true,
    );
    expect(report.violations.some((violation) => violation.includes("path must be a string"))).toBe(
      true,
    );
    expect(
      report.violations.some((violation) => violation.includes("files must be an array")),
    ).toBe(true);
    expect(report.violations.some((violation) => violation.includes("duplicate"))).toBe(true);
    expect(report.violations.some((violation) => violation.includes("missing required path"))).toBe(
      true,
    );
    expect(report.violations.some((violation) => violation.includes("unexpected path"))).toBe(true);
    expect(report.violations.some((violation) => violation.includes("forbidden"))).toBe(true);
  });

  test("rejects non-array pack results without throwing", async () => {
    const report = await validatePackageResult({ files: [] });

    expect(report.violations.some((violation) => violation.includes("must be an array"))).toBe(
      true,
    );
    expect(
      report.violations.filter((violation) => violation.includes("missing required path")),
    ).toHaveLength(5);
  });

  const forbiddenPaths = [
    "script.py",
    "compiled.pyc",
    "src/graph_mcp/server.py",
    "__pycache__/cache.pyc",
    ".pytest_cache/result",
    ".env",
    ".env.production",
    "access-token.txt",
    "access_token.json",
    "refresh-token.txt",
    "refresh_token.json",
    "authorization-code.txt",
    "code-verifier.txt",
    "code_verifier.json",
    "pkce-verifier.txt",
    "pkce_verifier.json",
    "encryption-key.txt",
    "encryption_key.json",
    "private.pem",
    "credential.json",
    "secret.json",
    "config.json",
    "private.key",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".codex/config",
    ".claude/config",
    "plugin/file",
    "plugins/file",
    "cache/file",
    ".cache/file",
    "node_modules/file",
    "coverage/file",
  ];

  test.each(forbiddenPaths)("rejects forbidden published path %s", async (path) => {
    const report = await validatePackageResult([
      {
        files: [
          { path: "LICENSE", mode: 0o644 },
          { path: "README.md", mode: 0o644 },
          { path: "dist/cli.js", mode: 0o755 },
          { path: "dist/cli.js.map", mode: 0o644 },
          { path: "package.json", mode: 0o644 },
          { path, mode: 0o644 },
        ],
      },
    ]);

    expect(report.violations.some((violation) => violation.includes("forbidden"))).toBe(true);
  });
});
