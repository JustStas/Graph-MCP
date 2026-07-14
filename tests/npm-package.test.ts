import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface NpmPackFile {
  readonly path: string;
}

interface NpmPackResult {
  readonly files: readonly NpmPackFile[];
}

async function npmPackDryRun(): Promise<readonly string[]> {
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--dry-run"], {
    cwd: repositoryRoot,
    maxBuffer: 2_000_000,
  });
  const result = JSON.parse(stdout) as readonly NpmPackResult[];
  return result.flatMap((pack) => pack.files.map((file) => file.path));
}

describe("npm package contents", () => {
  beforeAll(async () => {
    await execFileAsync(process.execPath, ["scripts/build.mjs"], { cwd: repositoryRoot });
  }, 30_000);

  test("contains the executable package files and excludes source/runtime artifacts", async () => {
    const files = await npmPackDryRun();

    expect(files).toEqual(
      expect.arrayContaining(["dist/cli.js", "README.md", "LICENSE", "package.json"]),
    );
    expect(files.some((file) => /^src\/graph_mcp(?:\/|$)/.test(file))).toBe(false);
    expect(files.some((file) => /(?:^|\/)test[^/]*\.py$|\.py$/.test(file))).toBe(false);
    expect(
      files.some((file) => /(?:token|secret|credential|private|\.key|config)/i.test(file)),
    ).toBe(false);
    expect(
      files.some((file) => /(?:^|\/)(?:plugins?|\.cache|cache|node_modules)(?:\/|$)/i.test(file)),
    ).toBe(false);
  });

  test("the package verifier accepts the current package contents", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/verify-package.mjs"], {
      cwd: repositoryRoot,
      maxBuffer: 2_000_000,
    });

    expect(stdout).toContain("npm package verification passed");
  });

  test("the bundled CLI executes through an npm-style symlink", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "graph-mcp-cli-link-"));
    const linkPath = join(temporaryDirectory, "graph-mcp");
    try {
      await symlink(join(repositoryRoot, "dist/cli.js"), linkPath, "file");
      const { stdout, stderr } = await execFileAsync(process.execPath, [linkPath, "--version"], {
        cwd: repositoryRoot,
      });

      expect(stdout).toBe("0.6.0\n");
      expect(stderr).toBe("");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
