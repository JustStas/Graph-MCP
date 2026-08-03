# Graph MCP npm Trusted Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Publish Graph MCP as @juststas/graph-mcp@0.6.1 and establish a least-privilege GitHub Release workflow that publishes later versions through npm Trusted Publishing.

**Architecture:** Keep package construction and verification in an unprivileged GitHub Actions job, bind checkout to fully qualified stable tags, and run a trusted inline commit/ancestry preflight before repository code. Transfer only the prepared tarball plus release metadata, then grant OIDC permission only to a separate publish job that derives the expected tag directly from the event/input, checks out its helper at `github.workflow_sha`, and validates npm's JSON dry-run manifest for the same private snapshot. Immediately after merged `main` is verified, activate an administrator-authority `v*` ruleset; audit the exact historical tag inventory, ancestry, known PyPI workflow blob, and release-helper absence; activate separate no-bypass immutability; and only then create `v0.6.1`. Reverify both rulesets before adding separately typed `main` branch and `v*` tag policies to the `npm` environment or configuring trust. The first scoped version is published interactively with 2FA because npm requires the package to exist before trust can be configured; automated OIDC publishing and provenance begin with 0.6.2.

**Tech Stack:** Node.js 24 in GitHub Actions, TypeScript, Vitest, npm 11.15+ for trust management, GitHub Actions, npm Trusted Publishing (OIDC), GitHub CLI.

---

## File Map

**Create**

- .github/workflows/publish.yml — trusted-ref release and recovery workflow, event/input-derived expected tag, data-only artifact transfer, workflow-SHA publish helper, job permissions, and OIDC publication.
- scripts/release-package.mjs — deterministic package metadata validation, explicit expected-tag binding, private-snapshot npm dry-run manifest validation, registry-integrity comparison, and idempotent publication.
- tests/release-package.test.ts — unit/CLI contract for release metadata, expected tag, dry-run manifest, snapshot, and registry decisions.
- tests/release-workflow.test.ts — semantic YAML security and behavior contract for publish.yml, including executable tag/npm gates and event truth tables.

**Modify**

- package.json — scoped package name, 0.6.1, normalized bin/repository fields, public publish configuration, and exact direct js-yaml test dependency.
- package-lock.json — synchronized root package identity/version and direct js-yaml development dependency without a transitive package upgrade.
- src/cli.ts — CLI version 0.6.1.
- src/server.ts — MCP server version 0.6.1.
- plugins/graph-mcp/.claude-plugin/plugin.json — plugin version 0.6.1.
- plugins/graph-mcp/.codex-plugin/plugin.json — plugin version 0.6.1.
- plugins/graph-mcp/dist/graph-mcp.js — generated 0.6.1 runtime.
- plugins/graph-mcp/dist/cli.js.map — generated 0.6.1 source map.
- tests/project-metadata.test.ts — scoped package and normalized metadata contract.
- tests/cli.test.ts — 0.6.1 CLI assertions.
- tests/mcp-stdio.test.ts — 0.6.1 stdio metadata assertion.
- tests/npm-package.test.ts — 0.6.1 executable assertions and scoped pack identity.
- tests/plugin-install-smoke.test.ts — 0.6.1 cache/version fixtures.
- tests/plugin-packaging.test.ts — 0.6.1 plugin/package synchronization.
- tests/tool-contract.test.ts — 0.6.1 server metadata assertion.
- scripts/test-plugin-install.mjs — 0.6.1 installed-plugin assertion.
- README.md — scoped installation, first-release exception, Trusted Publishing, and recovery procedures.
- CHANGELOG.md — 0.6.1 release entry.

## Task 1: Move package and runtime metadata to 0.6.1

**Files:**

- Modify: tests/project-metadata.test.ts
- Modify: tests/cli.test.ts
- Modify: tests/mcp-stdio.test.ts
- Modify: tests/npm-package.test.ts
- Modify: tests/plugin-install-smoke.test.ts
- Modify: tests/plugin-packaging.test.ts
- Modify: tests/tool-contract.test.ts
- Modify: package.json
- Modify: package-lock.json
- Modify: src/cli.ts
- Modify: src/server.ts
- Modify: plugins/graph-mcp/.claude-plugin/plugin.json
- Modify: plugins/graph-mcp/.codex-plugin/plugin.json
- Modify: scripts/test-plugin-install.mjs
- Regenerate: plugins/graph-mcp/dist/graph-mcp.js
- Regenerate: plugins/graph-mcp/dist/cli.js.map

- [ ] **Step 1: Change metadata tests first**

Replace the package metadata assertion in tests/project-metadata.test.ts with:

```typescript
test("publishes a scoped ESM Node 22 CLI as graph-mcp", async () => {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const pkg: unknown = JSON.parse(await readFile(packageJsonUrl, "utf8"));
  expect(pkg).toMatchObject({
    name: "@juststas/graph-mcp",
    version: "0.6.1",
    type: "module",
    bin: { "graph-mcp": "dist/cli.js" },
    repository: {
      type: "git",
      url: "git+https://github.com/JustStas/Graph-MCP.git",
    },
    publishConfig: { access: "public" },
    engines: { node: ">=22" },
  });
});
```

Change every active 0.6.0 runtime expectation in the listed test files to 0.6.1. Do not edit the historical 0.6.0 design or plan documents.

In tests/npm-package.test.ts, add pack identity fields and assert them:

```typescript
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
  const pack = result[0];
  if (pack === undefined) {
    throw new Error("npm pack returned no package.");
  }
  return pack;
}
```

Update the package-content test to use pack.files and assert:

```typescript
const pack = await npmPackDryRun();
expect(pack.name).toBe("@juststas/graph-mcp");
expect(pack.version).toBe("0.6.1");
const paths = pack.files.map((file) => file.path.replaceAll("\\", "/")).sort();
```

- [ ] **Step 2: Run focused tests and confirm the red state**

Run:

```bash
npx vitest run tests/project-metadata.test.ts tests/cli.test.ts tests/mcp-stdio.test.ts tests/npm-package.test.ts tests/plugin-install-smoke.test.ts tests/plugin-packaging.test.ts tests/tool-contract.test.ts
```

Expected: FAIL on the old graph-mcp package name, old bin path, missing repository/publishConfig object, and 0.6.0 runtime versions.

- [ ] **Step 3: Update package.json and package-lock.json**

Set the relevant package.json fields exactly:

```json
{
  "name": "@juststas/graph-mcp",
  "version": "0.6.1",
  "bin": {
    "graph-mcp": "dist/cli.js"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/JustStas/Graph-MCP.git"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

Preserve every unrelated field and dependency. Then regenerate only lock metadata:

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: the package-lock root name and version are @juststas/graph-mcp and 0.6.1, with no dependency version changes.

- [ ] **Step 4: Synchronize source and plugin versions**

Apply these exact active values:

```typescript
// src/cli.ts
const VERSION = "0.6.1";

// src/server.ts
{ name: "Graph MCP", version: "0.6.1" }
```

Set version to 0.6.1 in both plugin manifests. Change the active version checks in scripts/test-plugin-install.mjs from 0.6.0 to 0.6.1, including its error message.

- [ ] **Step 5: Rebuild committed plugin artifacts**

Run:

```bash
npm run build
```

Expected:

```text
Plugin versions synchronized at 0.6.1
```

The build must refresh plugins/graph-mcp/dist/graph-mcp.js and plugins/graph-mcp/dist/cli.js.map.

- [ ] **Step 6: Run focused tests and confirm green**

Run:

```bash
npx vitest run tests/project-metadata.test.ts tests/cli.test.ts tests/mcp-stdio.test.ts tests/npm-package.test.ts tests/plugin-install-smoke.test.ts tests/plugin-packaging.test.ts tests/tool-contract.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 7: Confirm no active release code still says 0.6.0**

Run:

```bash
rg -n '"version": "0\.6\.0"|const VERSION = "0\.6\.0"|version: "0\.6\.0"|Graph MCP 0\.6\.0|/0\.6\.0' package.json package-lock.json src scripts tests plugins/graph-mcp/.claude-plugin plugins/graph-mcp/.codex-plugin plugins/graph-mcp/dist/graph-mcp.js
```

Expected: no matches. Historical docs and the 0.6.0 changelog entry are intentionally excluded.

- [ ] **Step 8: Commit the identity/version change**

```bash
git add package.json package-lock.json src/cli.ts src/server.ts scripts/test-plugin-install.mjs tests/project-metadata.test.ts tests/cli.test.ts tests/mcp-stdio.test.ts tests/npm-package.test.ts tests/plugin-install-smoke.test.ts tests/plugin-packaging.test.ts tests/tool-contract.test.ts plugins/graph-mcp/.claude-plugin/plugin.json plugins/graph-mcp/.codex-plugin/plugin.json plugins/graph-mcp/dist/graph-mcp.js plugins/graph-mcp/dist/cli.js.map
git commit -m "build: prepare scoped npm package 0.6.1"
```

## Task 2: Add deterministic release package logic

**Files:**

- Create: tests/release-package.test.ts
- Create: scripts/release-package.mjs

- [ ] **Step 1: Write the failing release-helper contract tests**

Create tests/release-package.test.ts:

```typescript
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  classifyRegistryState,
  prepareRelease,
  publishRelease,
  readRegistryMetadata,
  validatePackResult,
  validateReleaseIdentity,
} from "../scripts/release-package.mjs";

interface ExecFileCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: unknown;
}

type ExecFileFunction = (
  file: string,
  args: readonly string[],
  options: unknown,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const packageJson = {
  name: "@juststas/graph-mcp",
  version: "0.6.1",
  repository: {
    type: "git",
    url: "git+https://github.com/JustStas/Graph-MCP.git",
  },
  publishConfig: { access: "public" },
};

const execFileAsync = promisify(execFile);
const releaseScriptPath = fileURLToPath(new URL("../scripts/release-package.mjs", import.meta.url));

const validIntegrity = "sha512-" + Buffer.alloc(64).toString("base64");

const localMetadata = {
  name: "@juststas/graph-mcp",
  version: "0.6.1",
  tag: "v0.6.1",
  filename: "juststas-graph-mcp-0.6.1.tgz",
  integrity: validIntegrity,
  shasum: "0123456789012345678901234567890123456789",
};
const temporaryDirectories = new Set<string>();
const releaseBytes = Buffer.from("deterministic release tarball bytes\n", "utf8");

interface ReleaseArtifact {
  readonly directory: string;
  readonly metadataPath: string;
  readonly tarballPath: string;
  readonly metadata: typeof localMetadata;
  readonly bytes: Buffer;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "graph-mcp-release-test-"));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

function npmViewFailure(stdout: string, stderr = "npm error code E404"): Error {
  return Object.assign(new Error("npm view failed"), { stdout, stderr });
}

function missingVersionFailure(version: string): Error {
  return npmViewFailure(
    JSON.stringify({
      error: {
        code: "E404",
        summary: "No match found for version " + version,
        detail: "",
      },
    }),
  );
}

function registryMetadataJson(metadata: typeof localMetadata): string {
  return JSON.stringify({ version: metadata.version, "dist.integrity": metadata.integrity });
}

function dryRunManifestJson(
  metadata: typeof localMetadata,
  overrides: Partial<typeof localMetadata & { id: string }> = {},
): string {
  const manifest = { ...metadata, ...overrides };
  return JSON.stringify({
    id: overrides.id ?? manifest.name + "@" + manifest.version,
    name: manifest.name,
    version: manifest.version,
    filename: manifest.filename,
    shasum: manifest.shasum,
    integrity: manifest.integrity,
    files: [],
  });
}

function isDryRunPublish(args: readonly string[]): boolean {
  return args[0] === "publish" && args.includes("--dry-run");
}

function isActualPublish(args: readonly string[]): boolean {
  return args[0] === "publish" && !args.includes("--dry-run");
}

async function createReleaseArtifact(
  metadataOverrides: Partial<typeof localMetadata> = {},
  bytes = releaseBytes,
): Promise<ReleaseArtifact> {
  const root = await createTemporaryDirectory();
  const directory = join(root, "artifact");
  await mkdir(directory);
  const metadata = {
    ...localMetadata,
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    shasum: createHash("sha1").update(bytes).digest("hex"),
    ...metadataOverrides,
  };
  const metadataPath = join(directory, "package-metadata.json");
  const tarballPath = join(directory, metadata.filename);
  await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
  await writeFile(tarballPath, bytes);
  return { directory, metadataPath, tarballPath, metadata, bytes };
}

async function runReleaseCli(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [releaseScriptPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...environment },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error !== "object" || error === null) {
      throw error;
    }
    return {
      exitCode: "code" in error && typeof error.code === "number" ? error.code : 1,
      stdout: "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
      stderr: "stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
    };
  }
}

async function createFailIfCalledNpm(): Promise<{
  readonly environment: Readonly<Record<string, string>>;
  readonly markerPath: string;
}> {
  const root = await createTemporaryDirectory();
  const bin = join(root, "bin");
  const markerPath = join(root, "npm-called");
  await mkdir(bin);
  const npmPath = join(bin, "npm");
  await writeFile(npmPath, '#!/bin/sh\n: > "$NPM_MARKER"\nexit 97\n', "utf8");
  await chmod(npmPath, 0o755);
  return {
    environment: {
      NPM_MARKER: markerPath,
      PATH: bin + ":" + process.env.PATH,
    },
    markerPath,
  };
}

describe("release package validation", () => {
  test("accepts the scoped package and exact version tag", () => {
    expect(validateReleaseIdentity(packageJson, "v0.6.1")).toEqual({
      name: "@juststas/graph-mcp",
      version: "0.6.1",
      tag: "v0.6.1",
    });
  });

  test.each([
    [{ ...packageJson, name: "graph-mcp" }, "v0.6.1", "package name"],
    [{ ...packageJson, version: "next" }, "vnext", "semantic version"],
    [{ ...packageJson, version: "01.2.3" }, "v01.2.3", "semantic version"],
    [{ ...packageJson, version: "1.2.3-alpha.1" }, "v1.2.3-alpha.1", "semantic version"],
    [{ ...packageJson, version: "1.2.3+build.1" }, "v1.2.3+build.1", "semantic version"],
    [packageJson, "0.6.1", "release tag"],
    [{ ...packageJson, publishConfig: {} }, "v0.6.1", "public"],
    [
      {
        ...packageJson,
        publishConfig: { access: "public", registry: "https://example.invalid/" },
      },
      "v0.6.1",
      "registry",
    ],
    [{ ...packageJson, publishConfig: { access: "public", tag: "next" } }, "v0.6.1", "tag"],
  ])("rejects invalid release identity", (pkg, tag, message) => {
    expect(() => validateReleaseIdentity(pkg, tag)).toThrow(message);
  });

  test("normalizes npm pack metadata", () => {
    expect(
      validatePackResult(
        [
          {
            name: localMetadata.name,
            version: localMetadata.version,
            filename: localMetadata.filename,
            integrity: localMetadata.integrity,
            shasum: localMetadata.shasum,
          },
        ],
        { name: localMetadata.name, version: localMetadata.version, tag: localMetadata.tag },
      ),
    ).toEqual(localMetadata);
  });

  test.each([
    "sha512-local",
    "sha512-" + Buffer.alloc(63).toString("base64"),
    "sha512-" + Buffer.alloc(64).toString("base64").replace(/=+$/, ""),
    "sha256-" + Buffer.alloc(64).toString("base64"),
  ])("rejects non-canonical sha512 integrity %s", (integrity) => {
    expect(() =>
      validatePackResult([{ ...localMetadata, integrity }], {
        name: localMetadata.name,
        version: localMetadata.version,
        tag: localMetadata.tag,
      }),
    ).toThrow("sha512");
  });

  test("publishes only when the version is absent", () => {
    expect(classifyRegistryState(undefined, localMetadata)).toBe("publish");
  });

  test("treats matching immutable bytes as an idempotent success", () => {
    expect(
      classifyRegistryState({ version: "0.6.1", integrity: validIntegrity }, localMetadata),
    ).toBe("already-published");
  });

  test("rejects an existing version with different bytes", () => {
    expect(() =>
      classifyRegistryState({ version: "0.6.1", integrity: "sha512-other" }, localMetadata),
    ).toThrow("different integrity");
  });
});

describe("release package CLI", () => {
  test("requires an explicit expected tag in exact publish usage", async () => {
    const result = await runReleaseCli(["publish", "package-metadata.json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "npm release failed: Usage: release-package.mjs prepare <tag> <output-directory> | publish <metadata-json> <expected-tag>\n",
    );
  });

  test("rejects an expected event tag mismatch before any npm command", async () => {
    const artifact = await createReleaseArtifact();
    const fakeNpm = await createFailIfCalledNpm();

    const result = await runReleaseCli(
      ["publish", artifact.metadataPath, "v0.6.2"],
      fakeNpm.environment,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "npm release failed: expected release tag does not match package metadata.\n",
    );
    await expect(lstat(fakeNpm.markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["0.6.1", "v01.6.1", "v0.6.1-beta.1"])(
    "rejects malformed expected tag %s before any npm command",
    async (expectedTag) => {
      const artifact = await createReleaseArtifact();
      const fakeNpm = await createFailIfCalledNpm();

      const result = await runReleaseCli(
        ["publish", artifact.metadataPath, expectedTag],
        fakeNpm.environment,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "npm release failed: expected release tag must match stable vMAJOR.MINOR.PATCH.\n",
      );
      await expect(lstat(fakeNpm.markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe("npm registry reads", () => {
  test("pins the public npm registry and parses exact version metadata", async () => {
    const calls: ExecFileCall[] = [];
    const execFile: ExecFileFunction = (file, args, options) => {
      calls.push({ file, args, options });
      return Promise.resolve({
        stdout: JSON.stringify({ version: "0.6.1", "dist.integrity": validIntegrity }),
        stderr: "",
      });
    };

    await expect(
      readRegistryMetadata(localMetadata.name, localMetadata.version, execFile),
    ).resolves.toEqual({ version: "0.6.1", integrity: validIntegrity });
    expect(calls).toEqual([
      {
        file: "npm",
        args: [
          "view",
          "@juststas/graph-mcp@0.6.1",
          "version",
          "dist.integrity",
          "--json",
          "--registry",
          "https://registry.npmjs.org/",
        ],
        options: { encoding: "utf8", maxBuffer: 2_000_000 },
      },
    ]);
  });

  test("treats only the structured missing-version response as absent", async () => {
    let calls = 0;
    const execFile: ExecFileFunction = () => {
      calls += 1;
      return Promise.reject(
        npmViewFailure(
          JSON.stringify({
            error: {
              code: "E404",
              summary: "No match found for version 0.6.1",
              detail: "",
            },
          }),
        ),
      );
    };

    await expect(
      readRegistryMetadata(localMetadata.name, localMetadata.version, execFile),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  test.each([
    {
      label: "missing package",
      stdout: JSON.stringify({
        error: {
          code: "E404",
          summary: "Not Found - GET https://registry.npmjs.org/@juststas%2fgraph-mcp - Not found",
          detail: "",
        },
      }),
      stderr: "npm error code E404",
    },
    {
      label: "wrong missing version",
      stdout: JSON.stringify({
        error: {
          code: "E404",
          summary: "No match found for version 0.6.0",
          detail: "",
        },
      }),
      stderr: "npm error code E404",
    },
    {
      label: "authorization failure",
      stdout: JSON.stringify({
        error: { code: "E401", summary: "Authentication required", detail: "" },
      }),
      stderr: "npm error code E401",
    },
    {
      label: "generic stderr E404",
      stdout: "",
      stderr: "npm error code E404 404 Not Found",
    },
    {
      label: "malformed structured error",
      stdout: "{not-json",
      stderr: "npm error code E404",
    },
  ])("fails closed for $label", async ({ stdout, stderr }) => {
    const failure = npmViewFailure(stdout, stderr);
    const execFile: ExecFileFunction = () => Promise.reject(failure);

    await expect(
      readRegistryMetadata(localMetadata.name, localMetadata.version, execFile),
    ).rejects.toBe(failure);
  });

  test("rejects malformed successful npm JSON", async () => {
    const execFile: ExecFileFunction = () => Promise.resolve({ stdout: "{not-json", stderr: "" });

    await expect(
      readRegistryMetadata(localMetadata.name, localMetadata.version, execFile),
    ).rejects.toThrow(SyntaxError);
  });
});

describe("release preparation", () => {
  test("rejects a release tag whose commit does not equal HEAD", async () => {
    const cwd = await createTemporaryDirectory();
    await writeFile(join(cwd, "package.json"), JSON.stringify(packageJson), "utf8");
    const tagCommit = "a".repeat(40);
    const headCommit = "b".repeat(40);
    const calls: ExecFileCall[] = [];
    const execFile: ExecFileFunction = (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === "rev-parse" && args[1] === "refs/tags/v0.6.1^{commit}") {
        return Promise.resolve({ stdout: tagCommit + "\n", stderr: "" });
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return Promise.resolve({ stdout: headCommit + "\n", stderr: "" });
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(prepareRelease("v0.6.1", join(cwd, "output"), { cwd, execFile })).rejects.toThrow(
      "release tag commit must match HEAD",
    );
    expect(calls.map(({ file, args }) => ({ file, args }))).toEqual([
      { file: "git", args: ["rev-parse", "refs/tags/v0.6.1^{commit}"] },
      { file: "git", args: ["rev-parse", "HEAD"] },
    ]);
  });

  test("checks origin/main ancestry against the resolved tag commit", async () => {
    const cwd = await createTemporaryDirectory();
    const outputDirectory = join(cwd, "output");
    await writeFile(join(cwd, "package.json"), JSON.stringify(packageJson), "utf8");
    const commit = "c".repeat(40);
    const calls: ExecFileCall[] = [];
    const execFile: ExecFileFunction = (file, args, options) => {
      calls.push({ file, args, options });
      if (file === "git" && args[0] === "rev-parse") {
        return Promise.resolve({ stdout: commit + "\n", stderr: "" });
      }
      if (file === "git" && args[0] === "merge-base") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (file === "npm" && args[0] === "pack") {
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              name: localMetadata.name,
              version: localMetadata.version,
              filename: localMetadata.filename,
              integrity: localMetadata.integrity,
              shasum: localMetadata.shasum,
            },
          ]),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(prepareRelease("v0.6.1", outputDirectory, { cwd, execFile })).resolves.toEqual(
      localMetadata,
    );
    expect(calls.map(({ file, args }) => ({ file, args }))).toEqual([
      { file: "git", args: ["rev-parse", "refs/tags/v0.6.1^{commit}"] },
      { file: "git", args: ["rev-parse", "HEAD"] },
      { file: "git", args: ["merge-base", "--is-ancestor", commit, "origin/main"] },
      {
        file: "npm",
        args: ["pack", "--json", "--pack-destination", outputDirectory],
      },
    ]);
  });
});

describe("release publication", () => {
  test("rejects a symlink tarball before querying or publishing", async () => {
    const artifact = await createReleaseArtifact();
    const outsideTarball = join(dirname(artifact.directory), "outside.tgz");
    await writeFile(outsideTarball, artifact.bytes);
    await rm(artifact.tarballPath);
    await symlink(outsideTarball, artifact.tarballPath);
    let subprocessCalls = 0;
    const execFile: ExecFileFunction = () => {
      subprocessCalls += 1;
      return Promise.reject(new Error("subprocess must not run"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
    ).rejects.toThrow("regular non-symlink");
    expect(subprocessCalls).toBe(0);
  });

  test("rejects a directory tarball before querying or publishing", async () => {
    const artifact = await createReleaseArtifact();
    await rm(artifact.tarballPath);
    await mkdir(artifact.tarballPath);
    let subprocessCalls = 0;
    const execFile: ExecFileFunction = () => {
      subprocessCalls += 1;
      return Promise.reject(new Error("subprocess must not run"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
    ).rejects.toThrow("regular non-symlink");
    expect(subprocessCalls).toBe(0);
  });

  test("rejects a sha512 byte mismatch before querying or publishing", async () => {
    const artifact = await createReleaseArtifact();
    await writeFile(artifact.tarballPath, "tampered tarball bytes", "utf8");
    let subprocessCalls = 0;
    const execFile: ExecFileFunction = () => {
      subprocessCalls += 1;
      return Promise.reject(new Error("subprocess must not run"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
    ).rejects.toThrow("sha512 integrity");
    expect(subprocessCalls).toBe(0);
  });

  test("rejects a sha1 byte mismatch before querying or publishing", async () => {
    const artifact = await createReleaseArtifact({ shasum: "0".repeat(40) });
    let subprocessCalls = 0;
    const execFile: ExecFileFunction = () => {
      subprocessCalls += 1;
      return Promise.reject(new Error("subprocess must not run"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
    ).rejects.toThrow("sha1 shasum");
    expect(subprocessCalls).toBe(0);
  });

  test("rejects malformed npm publish dry-run JSON before registry access", async () => {
    const artifact = await createReleaseArtifact();
    let registryCalls = 0;
    let actualPublishCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        return Promise.resolve({ stdout: "{not-json", stderr: "" });
      }
      if (args[0] === "view") {
        registryCalls += 1;
        return Promise.resolve({ stdout: registryMetadataJson(artifact.metadata), stderr: "" });
      }
      if (isActualPublish(args)) {
        actualPublishCalls += 1;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
    ).rejects.toThrow("malformed JSON");
    expect(registryCalls).toBe(0);
    expect(actualPublishCalls).toBe(0);
  });

  test("rejects a non-object npm publish dry-run result before registry access", async () => {
    const artifact = await createReleaseArtifact();
    let registryCalls = 0;
    let actualPublishCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        return Promise.resolve({ stdout: "[]", stderr: "" });
      }
      if (args[0] === "view") {
        registryCalls += 1;
        return Promise.resolve({ stdout: registryMetadataJson(artifact.metadata), stderr: "" });
      }
      if (isActualPublish(args)) {
        actualPublishCalls += 1;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
    ).rejects.toThrow("must be an object");
    expect(registryCalls).toBe(0);
    expect(actualPublishCalls).toBe(0);
  });

  test.each([
    ["name", { name: "@juststas/not-graph-mcp" }],
    ["version", { version: "0.6.2" }],
    ["filename", { filename: "unexpected-package.tgz" }],
    ["shasum", { shasum: "f".repeat(40) }],
    ["integrity", { integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") }],
    ["id", { id: "@juststas/graph-mcp@0.6.2" }],
  ] as const)(
    "rejects npm publish dry-run %s mismatch before registry access",
    async (field, overrides) => {
      const artifact = await createReleaseArtifact();
      let registryCalls = 0;
      let actualPublishCalls = 0;
      const execFile: ExecFileFunction = (file, args) => {
        if (isDryRunPublish(args)) {
          return Promise.resolve({
            stdout: dryRunManifestJson(artifact.metadata, overrides),
            stderr: "",
          });
        }
        if (args[0] === "view") {
          registryCalls += 1;
          return Promise.resolve({ stdout: registryMetadataJson(artifact.metadata), stderr: "" });
        }
        if (isActualPublish(args)) {
          actualPublishCalls += 1;
          return Promise.resolve({ stdout: "", stderr: "" });
        }
        return Promise.reject(new Error("unexpected subprocess call"));
      };

      await expect(
        publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
      ).rejects.toThrow(field);
      expect(registryCalls).toBe(0);
      expect(actualPublishCalls).toBe(0);
    },
  );

  test("publishes a private verified snapshot with deterministic npm arguments", async () => {
    const artifact = await createReleaseArtifact();
    const calls: ExecFileCall[] = [];
    let viewCalls = 0;
    let snapshotPath: string | undefined;
    let snapshotBytes: Buffer | undefined;
    let snapshotMode: number | undefined;
    let snapshotDirectoryMode: number | undefined;
    const execFile: ExecFileFunction = async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === "view") {
        viewCalls += 1;
        if (viewCalls === 1) {
          throw missingVersionFailure(artifact.metadata.version);
        }
        return { stdout: registryMetadataJson(artifact.metadata), stderr: "" };
      }
      if (args[0] === "publish") {
        const candidate = args[1];
        if (candidate === undefined) {
          throw new Error("publish snapshot path is missing");
        }
        snapshotPath = candidate;
        snapshotBytes = await readFile(candidate);
        snapshotMode = (await lstat(candidate)).mode & 0o777;
        snapshotDirectoryMode = (await lstat(dirname(candidate))).mode & 0o777;
        return {
          stdout: isDryRunPublish(args) ? dryRunManifestJson(artifact.metadata) : "",
          stderr: "",
        };
      }
      throw new Error("unexpected subprocess call");
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, {
        execFile,
        delay: () => Promise.resolve(),
      }),
    ).resolves.toEqual({
      state: "publish",
      version: artifact.metadata.version,
      integrity: artifact.metadata.integrity,
    });
    expect(snapshotPath).toBeDefined();
    expect(snapshotPath).not.toBe(artifact.tarballPath);
    expect(snapshotPath?.endsWith(".tgz")).toBe(true);
    expect(snapshotBytes).toEqual(artifact.bytes);
    expect(snapshotMode).toBe(0o600);
    expect(snapshotDirectoryMode).toBe(0o700);
    const dryRunCall = calls.find(({ args }) => isDryRunPublish(args));
    const actualPublishCall = calls.find(({ args }) => isActualPublish(args));
    expect(dryRunCall?.args).toEqual([
      "publish",
      snapshotPath,
      "--dry-run",
      "--json",
      "--access",
      "public",
      "--tag",
      "latest",
      "--ignore-scripts",
      "--registry",
      "https://registry.npmjs.org/",
    ]);
    expect(actualPublishCall?.args).toEqual([
      "publish",
      snapshotPath,
      "--access",
      "public",
      "--tag",
      "latest",
      "--ignore-scripts",
      "--registry",
      "https://registry.npmjs.org/",
    ]);
    if (snapshotPath === undefined) {
      throw new Error("publish did not receive a snapshot path");
    }
    await expect(lstat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("treats an initial exact registry match as a no-op", async () => {
    const artifact = await createReleaseArtifact();
    let dryRunCalls = 0;
    let viewCalls = 0;
    let publishCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        dryRunCalls += 1;
        return Promise.resolve({ stdout: dryRunManifestJson(artifact.metadata), stderr: "" });
      }
      if (args[0] === "view") {
        viewCalls += 1;
        return Promise.resolve({ stdout: registryMetadataJson(artifact.metadata), stderr: "" });
      }
      if (isActualPublish(args)) {
        publishCalls += 1;
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
    ).resolves.toEqual({
      state: "already-published",
      version: artifact.metadata.version,
      integrity: artifact.metadata.integrity,
    });
    expect(viewCalls).toBe(2);
    expect(publishCalls).toBe(0);
    expect(dryRunCalls).toBe(1);
  });

  test("fails closed when an initially matching version changes before final readback", async () => {
    const artifact = await createReleaseArtifact();
    const otherIntegrity =
      "sha512-" + createHash("sha512").update("different bytes").digest("base64");
    let viewCalls = 0;
    let publishCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        return Promise.resolve({ stdout: dryRunManifestJson(artifact.metadata), stderr: "" });
      }
      if (args[0] === "view") {
        viewCalls += 1;
        return Promise.resolve({
          stdout:
            viewCalls === 1
              ? registryMetadataJson(artifact.metadata)
              : JSON.stringify({
                  version: artifact.metadata.version,
                  "dist.integrity": otherIntegrity,
                }),
          stderr: "",
        });
      }
      if (isActualPublish(args)) {
        publishCalls += 1;
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
    ).rejects.toThrow("different integrity");
    expect(viewCalls).toBe(2);
    expect(publishCalls).toBe(0);
  });

  test("accepts a matching readback after an ambiguous publish failure", async () => {
    const artifact = await createReleaseArtifact();
    const publishFailure = new Error("connection reset after upload");
    let dryRunCalls = 0;
    let viewCalls = 0;
    let publishCalls = 0;
    let delayCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        dryRunCalls += 1;
        return Promise.resolve({ stdout: dryRunManifestJson(artifact.metadata), stderr: "" });
      }
      if (args[0] === "view") {
        viewCalls += 1;
        if (viewCalls < 3) {
          return Promise.reject(missingVersionFailure(artifact.metadata.version));
        }
        return Promise.resolve({ stdout: registryMetadataJson(artifact.metadata), stderr: "" });
      }
      if (isActualPublish(args)) {
        publishCalls += 1;
        return Promise.reject(publishFailure);
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, {
        execFile,
        delay: () => {
          delayCalls += 1;
          return Promise.resolve();
        },
      }),
    ).resolves.toEqual({
      state: "publish",
      version: artifact.metadata.version,
      integrity: artifact.metadata.integrity,
    });
    expect(viewCalls).toBe(3);
    expect(publishCalls).toBe(1);
    expect(delayCalls).toBe(1);
    expect(dryRunCalls).toBe(1);
  });

  test("fails immediately when readback has different integrity", async () => {
    const artifact = await createReleaseArtifact();
    const otherIntegrity =
      "sha512-" + createHash("sha512").update("different bytes").digest("base64");
    let viewCalls = 0;
    let publishCalls = 0;
    let delayCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        return Promise.resolve({ stdout: dryRunManifestJson(artifact.metadata), stderr: "" });
      }
      if (args[0] === "view") {
        viewCalls += 1;
        if (viewCalls === 1) {
          return Promise.reject(missingVersionFailure(artifact.metadata.version));
        }
        return Promise.resolve({
          stdout: JSON.stringify({
            version: artifact.metadata.version,
            "dist.integrity": otherIntegrity,
          }),
          stderr: "",
        });
      }
      if (isActualPublish(args)) {
        publishCalls += 1;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, {
        execFile,
        delay: () => {
          delayCalls += 1;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("different integrity");
    expect(viewCalls).toBe(2);
    expect(publishCalls).toBe(1);
    expect(delayCalls).toBe(0);
  });

  test("fails after bounded readback attempts following a successful publish", async () => {
    const artifact = await createReleaseArtifact();
    let viewCalls = 0;
    let publishCalls = 0;
    let delayCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        return Promise.resolve({ stdout: dryRunManifestJson(artifact.metadata), stderr: "" });
      }
      if (args[0] === "view") {
        viewCalls += 1;
        return Promise.reject(missingVersionFailure(artifact.metadata.version));
      }
      if (isActualPublish(args)) {
        publishCalls += 1;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, {
        execFile,
        delay: () => {
          delayCalls += 1;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("could not be read back from npm after 3 attempts");
    expect(viewCalls).toBe(4);
    expect(publishCalls).toBe(1);
    expect(delayCalls).toBe(2);
  });

  test("rethrows the original publish error after exhausted absent readback", async () => {
    const artifact = await createReleaseArtifact();
    const publishFailure = new Error("npm publish failed");
    let viewCalls = 0;
    let publishCalls = 0;
    let delayCalls = 0;
    let snapshotPath: string | undefined;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        return Promise.resolve({ stdout: dryRunManifestJson(artifact.metadata), stderr: "" });
      }
      if (args[0] === "view") {
        viewCalls += 1;
        return Promise.reject(missingVersionFailure(artifact.metadata.version));
      }
      if (isActualPublish(args)) {
        publishCalls += 1;
        snapshotPath = args[1];
        return Promise.reject(publishFailure);
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, {
        execFile,
        delay: () => {
          delayCalls += 1;
          return Promise.resolve();
        },
      }),
    ).rejects.toBe(publishFailure);
    expect(viewCalls).toBe(4);
    expect(publishCalls).toBe(1);
    expect(delayCalls).toBe(2);
    if (snapshotPath === undefined) {
      throw new Error("publish did not receive a snapshot path");
    }
    await expect(lstat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
```

- [ ] **Step 2: Run the helper tests and confirm they fail**

Run:

```bash
npx vitest run tests/release-package.test.ts
```

Expected: FAIL because scripts/release-package.mjs is missing or does not yet enforce deterministic metadata, explicit expected-tag binding, private-snapshot digest checks, exact npm dry-run manifest validation, registry idempotency, and bounded race recovery.

- [ ] **Step 3: Implement the hardened release helper**

Create scripts/release-package.mjs:

```javascript
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXPECTED_NAME = "@juststas/graph-mcp";
const EXPECTED_REPOSITORY = "git+https://github.com/JustStas/Graph-MCP.git";
const EXPECTED_REGISTRY = "https://registry.npmjs.org/";
const READBACK_ATTEMPTS = 3;
const READBACK_DELAY_MS = 1_000;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** @typedef {{ name: string, version: string, tag: string }} ReleaseIdentity */
/** @typedef {ReleaseIdentity & { filename: string, integrity: string, shasum: string }} PackageMetadata */
/** @typedef {{ version: string, integrity: string }} RegistryMetadata */
/** @typedef {{ encoding: "utf8", maxBuffer: number, cwd?: string }} CommandOptions */
/** @typedef {(file: string, args: readonly string[], options: CommandOptions) => Promise<{ stdout: string, stderr: string }>} ExecFileFunction */
/** @typedef {(milliseconds: number) => Promise<void>} DelayFunction */
/** @typedef {{ cwd?: string, execFile?: ExecFileFunction, scriptPath?: string }} PrepareOptions */
/** @typedef {{ execFile?: ExecFileFunction, delay?: DelayFunction }} PublishOptions */
/** @typedef {{ state: "publish" | "already-published", version: string, integrity: string }} PublishResult */

class RegistryReadbackExhaustedError extends Error {}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function requireRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(label + " must be an object.");
  }
  return value;
}

/** @param {Record<string, unknown>} record @param {string} key @param {string} label */
function requireString(record, key, label) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(label + " must be a non-empty string.");
  }
  return value;
}

/** @param {string} value */
function isCanonicalSha512Integrity(value) {
  if (!/^sha512-[A-Za-z0-9+/]+={2}$/.test(value)) {
    return false;
  }
  const encodedDigest = value.slice("sha512-".length);
  const digest = Buffer.from(encodedDigest, "base64");
  return digest.length === 64 && digest.toString("base64") === encodedDigest;
}

/** @param {unknown} packageJson @param {string} tag @returns {ReleaseIdentity} */
export function validateReleaseIdentity(packageJson, tag) {
  const pkg = requireRecord(packageJson, "package.json");
  const name = requireString(pkg, "name", "package name");
  const version = requireString(pkg, "version", "package version");
  if (name !== EXPECTED_NAME) {
    throw new Error("package name must be " + EXPECTED_NAME + ".");
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("package version must be a semantic version.");
  }
  if (tag !== "v" + version) {
    throw new Error("release tag must be v" + version + ".");
  }

  const repository = requireRecord(pkg.repository, "repository");
  if (repository.type !== "git" || repository.url !== EXPECTED_REPOSITORY) {
    throw new Error("repository must be the canonical JustStas/Graph-MCP git URL.");
  }
  const publishConfig = requireRecord(pkg.publishConfig, "publishConfig");
  if (publishConfig.access !== "public") {
    throw new Error("publishConfig.access must make the scoped package public.");
  }
  if ("registry" in publishConfig) {
    throw new Error("publishConfig.registry overrides are not allowed.");
  }
  if ("tag" in publishConfig) {
    throw new Error("publishConfig.tag overrides are not allowed.");
  }
  return { name, version, tag };
}

/** @param {unknown} packResult @param {ReleaseIdentity} identity @returns {PackageMetadata} */
export function validatePackResult(packResult, identity) {
  if (!Array.isArray(packResult) || packResult.length !== 1) {
    throw new Error("npm pack must return exactly one result.");
  }
  const pack = requireRecord(packResult[0], "npm pack result");
  const name = requireString(pack, "name", "packed name");
  const version = requireString(pack, "version", "packed version");
  const filename = requireString(pack, "filename", "packed filename");
  const integrity = requireString(pack, "integrity", "packed integrity");
  const shasum = requireString(pack, "shasum", "packed shasum");

  if (name !== identity.name || version !== identity.version) {
    throw new Error("npm pack identity does not match the release identity.");
  }
  if (filename !== basename(filename) || !filename.endsWith(".tgz")) {
    throw new Error("packed filename must be a basename-only .tgz path.");
  }
  if (!isCanonicalSha512Integrity(integrity)) {
    throw new Error("packed integrity must be a canonical sha512 value.");
  }
  if (!/^[a-f0-9]{40}$/.test(shasum)) {
    throw new Error("packed shasum must be 40 lowercase hexadecimal characters.");
  }
  return { ...identity, filename, integrity, shasum };
}

/**
 * @param {RegistryMetadata | undefined} remote
 * @param {PackageMetadata} local
 * @returns {"publish" | "already-published"}
 */
export function classifyRegistryState(remote, local) {
  if (remote === undefined) {
    return "publish";
  }
  if (remote.version !== local.version) {
    throw new Error("registry returned a different version.");
  }
  if (remote.integrity !== local.integrity) {
    throw new Error("existing package version has different integrity.");
  }
  return "already-published";
}

/** @param {unknown} value @returns {PackageMetadata} */
function validateArtifactMetadata(value) {
  const metadata = requireRecord(value, "package metadata");
  const name = requireString(metadata, "name", "metadata name");
  const version = requireString(metadata, "version", "metadata version");
  const tag = requireString(metadata, "tag", "metadata tag");
  const filename = requireString(metadata, "filename", "metadata filename");
  const integrity = requireString(metadata, "integrity", "metadata integrity");
  const shasum = requireString(metadata, "shasum", "metadata shasum");
  if (name !== EXPECTED_NAME || !VERSION_PATTERN.test(version) || tag !== "v" + version) {
    throw new Error("package metadata identity is invalid.");
  }
  return validatePackResult([{ name, version, filename, integrity, shasum }], {
    name,
    version,
    tag,
  });
}

/** @param {string} stdout @returns {RegistryMetadata} */
function parseRegistryMetadata(stdout) {
  /** @type {unknown} */
  const parsed = JSON.parse(stdout);
  const value = requireRecord(parsed, "npm view result");
  return {
    version: requireString(value, "version", "registry version"),
    integrity: requireString(value, "dist.integrity", "registry integrity"),
  };
}

/** @param {unknown} error @param {string} version */
function isMissingVersionError(error, version) {
  if (!isRecord(error) || typeof error.stdout !== "string") {
    return false;
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(error.stdout);
  } catch {
    return false;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) {
    return false;
  }
  return (
    parsed.error.code === "E404" && parsed.error.summary === "No match found for version " + version
  );
}

/**
 * @param {string} name
 * @param {string} version
 * @param {ExecFileFunction} [runFile]
 * @returns {Promise<RegistryMetadata | undefined>}
 */
export async function readRegistryMetadata(name, version, runFile = execFileAsync) {
  try {
    const { stdout } = await runFile(
      "npm",
      [
        "view",
        name + "@" + version,
        "version",
        "dist.integrity",
        "--json",
        "--registry",
        EXPECTED_REGISTRY,
      ],
      { encoding: "utf8", maxBuffer: 2_000_000 },
    );
    return parseRegistryMetadata(stdout);
  } catch (error) {
    if (isMissingVersionError(error, version)) {
      return undefined;
    }
    throw error;
  }
}

/** @param {string} stdout @param {string} label */
function parseResolvedCommit(stdout, label) {
  const commit = stdout.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) {
    throw new Error(label + " did not resolve to a commit.");
  }
  return commit;
}

/**
 * @param {string} tag
 * @param {string} outputDirectory
 * @param {PrepareOptions} [options]
 * @returns {Promise<PackageMetadata>}
 */
export async function prepareRelease(tag, outputDirectory, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const runFile = options.execFile ?? execFileAsync;
  const scriptPath = options.scriptPath ?? fileURLToPath(import.meta.url);
  /** @type {unknown} */
  const packageJson = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8"));
  const identity = validateReleaseIdentity(packageJson, tag);
  /** @type {CommandOptions} */
  const commandOptions = { cwd, encoding: "utf8", maxBuffer: 2_000_000 };
  const tagReference = "refs/tags/" + identity.tag + "^{commit}";
  const tagCommit = parseResolvedCommit(
    (await runFile("git", ["rev-parse", tagReference], commandOptions)).stdout,
    "release tag",
  );
  const headCommit = parseResolvedCommit(
    (await runFile("git", ["rev-parse", "HEAD"], commandOptions)).stdout,
    "HEAD",
  );
  if (tagCommit !== headCommit) {
    throw new Error("release tag commit must match HEAD.");
  }
  await runFile("git", ["merge-base", "--is-ancestor", tagCommit, "origin/main"], commandOptions);
  const output = resolve(cwd, outputDirectory);
  await mkdir(output, { recursive: true });
  const { stdout } = await runFile(
    "npm",
    ["pack", "--json", "--pack-destination", output],
    commandOptions,
  );
  /** @type {unknown} */
  const packResult = JSON.parse(stdout);
  const metadata = validatePackResult(packResult, identity);
  await writeFile(
    join(output, "package-metadata.json"),
    JSON.stringify(metadata, null, 2) + "\n",
    "utf8",
  );
  await copyFile(scriptPath, join(output, "release-package.mjs"));
  return metadata;
}

/**
 * @param {PackageMetadata} metadata
 * @param {"publish" | "already-published"} state
 * @returns {PublishResult}
 */
function publishedResult(metadata, state) {
  return { state, version: metadata.version, integrity: metadata.integrity };
}

/** @param {PackageMetadata} metadata @param {Buffer} bytes */
function verifyTarballDigests(metadata, bytes) {
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  if (integrity !== metadata.integrity) {
    throw new Error("tarball sha512 integrity does not match package metadata.");
  }
  const shasum = createHash("sha1").update(bytes).digest("hex");
  if (shasum !== metadata.shasum) {
    throw new Error("tarball sha1 shasum does not match package metadata.");
  }
}

/** @param {string} snapshotPath @param {boolean} dryRun */
function publishArguments(snapshotPath, dryRun) {
  return [
    "publish",
    snapshotPath,
    ...(dryRun ? ["--dry-run", "--json"] : []),
    "--access",
    "public",
    "--tag",
    "latest",
    "--ignore-scripts",
    "--registry",
    EXPECTED_REGISTRY,
  ];
}

/** @param {string} stdout @param {PackageMetadata} metadata */
function validateDryRunManifest(stdout, metadata) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm publish dry-run returned malformed JSON.");
  }
  const manifest = requireRecord(parsed, "npm publish dry-run result");
  /** @type {readonly (readonly [string, string])[]} */
  const fields = [
    ["name", metadata.name],
    ["version", metadata.version],
    ["filename", metadata.filename],
    ["shasum", metadata.shasum],
    ["integrity", metadata.integrity],
  ];
  for (const [field, expected] of fields) {
    const actual = requireString(manifest, field, "npm publish dry-run " + field);
    if (actual !== expected) {
      throw new Error("npm publish dry-run " + field + " does not match package metadata.");
    }
  }
  const id = requireString(manifest, "id", "npm publish dry-run id");
  if (id !== metadata.name + "@" + metadata.version) {
    throw new Error("npm publish dry-run id does not match package metadata.");
  }
}

/** @param {Buffer} bytes */
async function createPrivateSnapshot(bytes) {
  const directory = await mkdtemp(join(tmpdir(), "graph-mcp-release-"));
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "release-package.tgz");
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);
    return { directory, path };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * @param {PackageMetadata} metadata
 * @param {ExecFileFunction} runFile
 * @param {DelayFunction} wait
 */
async function pollForPublishedMetadata(metadata, runFile, wait) {
  for (let attempt = 1; attempt <= READBACK_ATTEMPTS; attempt += 1) {
    const remote = await readRegistryMetadata(metadata.name, metadata.version, runFile);
    if (remote !== undefined) {
      classifyRegistryState(remote, metadata);
      return;
    }
    if (attempt < READBACK_ATTEMPTS) {
      await wait(READBACK_DELAY_MS);
    }
  }
  throw new RegistryReadbackExhaustedError(
    "published package could not be read back from npm after " + READBACK_ATTEMPTS + " attempts.",
  );
}

/**
 * @param {string} metadataPath
 * @param {string} expectedTag
 * @param {PublishOptions} [options]
 * @returns {Promise<PublishResult>}
 */
export async function publishRelease(metadataPath, expectedTag, options = {}) {
  if (typeof expectedTag !== "string" || !TAG_PATTERN.test(expectedTag)) {
    throw new Error("expected release tag must match stable vMAJOR.MINOR.PATCH.");
  }
  const runFile = options.execFile ?? execFileAsync;
  const wait = options.delay ?? delay;
  const resolvedMetadata = resolve(metadataPath);
  /** @type {unknown} */
  const parsedMetadata = JSON.parse(await readFile(resolvedMetadata, "utf8"));
  const metadata = validateArtifactMetadata(parsedMetadata);
  if (metadata.tag !== expectedTag) {
    throw new Error("expected release tag does not match package metadata.");
  }
  const metadataDirectory = dirname(resolvedMetadata);
  const tarball = resolve(metadataDirectory, metadata.filename);
  if (dirname(tarball) !== metadataDirectory) {
    throw new Error("tarball escaped the metadata directory.");
  }
  const tarballStat = await lstat(tarball);
  if (tarballStat.isSymbolicLink() || !tarballStat.isFile()) {
    throw new Error("tarball must be a regular non-symlink file.");
  }
  const realMetadataDirectory = await realpath(metadataDirectory);
  const realTarball = await realpath(tarball);
  if (dirname(realTarball) !== realMetadataDirectory) {
    throw new Error("tarball escaped the real metadata directory.");
  }
  const tarballBytes = await readFile(realTarball);
  verifyTarballDigests(metadata, tarballBytes);
  const snapshot = await createPrivateSnapshot(tarballBytes);
  try {
    const { stdout: dryRunStdout } = await runFile("npm", publishArguments(snapshot.path, true), {
      encoding: "utf8",
      maxBuffer: 2_000_000,
    });
    validateDryRunManifest(dryRunStdout, metadata);
    const remote = await readRegistryMetadata(metadata.name, metadata.version, runFile);
    const state = classifyRegistryState(remote, metadata);
    /** @type {Error | undefined} */
    let publishError;
    if (state === "publish") {
      try {
        await runFile("npm", publishArguments(snapshot.path, false), {
          encoding: "utf8",
          maxBuffer: 2_000_000,
        });
      } catch (error) {
        publishError = error instanceof Error ? error : new Error(String(error));
      }
    }

    try {
      await pollForPublishedMetadata(metadata, runFile, wait);
    } catch (error) {
      if (publishError !== undefined && error instanceof RegistryReadbackExhaustedError) {
        throw publishError;
      }
      throw error;
    }
    return publishedResult(metadata, state);
  } finally {
    await rm(snapshot.directory, { recursive: true, force: true });
  }
}

/** @param {readonly string[]} args */
async function main(args) {
  const [command, first, second, third] = args;
  if (command === "prepare" && first !== undefined && second !== undefined && third === undefined) {
    const metadata = await prepareRelease(first, second);
    process.stdout.write(JSON.stringify(metadata, null, 2) + "\n");
    return;
  }
  if (command === "publish" && first !== undefined && second !== undefined && third === undefined) {
    const result = await publishRelease(first, second);
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  throw new Error(
    "Usage: release-package.mjs prepare <tag> <output-directory> | publish <metadata-json> <expected-tag>",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      "npm release failed: " + (error instanceof Error ? error.message : String(error)) + "\n",
    );
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run the helper tests**

Run:

```bash
npx vitest run tests/release-package.test.ts
```

Expected: all release-helper tests PASS. The publish CLI requires `publish <metadata-json> <expected-tag>`; the explicit tag and npm dry-run manifest are validated before registry access; and real publication uses the same private snapshot.

- [ ] **Step 5: Run scoped formatting, lint, and type checks**

Run:

```bash
npx prettier --check scripts/release-package.mjs tests/release-package.test.ts
npm run lint
npm run typecheck
```

Expected: all checks pass.

- [ ] **Step 6: Commit the release helper**

```bash
git add scripts/release-package.mjs tests/release-package.test.ts
git commit -m "feat: add deterministic npm release packaging"
```

## Task 3: Add the least-privilege GitHub Actions workflow

**Files:**

- Modify: package.json
- Modify: package-lock.json
- Create: tests/release-workflow.test.ts
- Create: .github/workflows/publish.yml

- [ ] **Step 1: Promote the semantic YAML parser to an exact direct dependency**

Add the already-locked version to devDependencies in both package.json and the root package entry in package-lock.json:

```json
"js-yaml": "4.3.0"
```

Keep the existing node_modules/js-yaml resolution at 4.3.0. Do not upgrade or rewrite unrelated dependencies.

- [ ] **Step 2: Write the failing semantic workflow contract test**

Create tests/release-workflow.test.ts:

```typescript
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

type WorkflowStep = {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly shell?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
};

type WorkflowJob = {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly "runs-on"?: string;
  readonly "timeout-minutes"?: number;
  readonly environment?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly steps?: readonly WorkflowStep[];
};

type Workflow = {
  readonly name?: string;
  readonly on?: unknown;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly concurrency?: Readonly<Record<string, unknown>>;
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
};

type ConditionContext = {
  readonly eventName: string;
  readonly ref: string;
  readonly prepareOnly: boolean;
};

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(source: string): unknown };
const execFileAsync = promisify(execFile);
const workflowUrl = new URL("../.github/workflows/publish.yml", import.meta.url);
const packageJsonUrl = new URL("../package.json", import.meta.url);
const workflow = yaml.load(readFileSync(workflowUrl, "utf8")) as Workflow;
const checkoutAction = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const setupNodeAction = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const uploadAction = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const downloadAction = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const packageCondition =
  "${{ github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') }}";
const publishCondition =
  "${{ github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.prepare_only != true) }}";
const temporaryDirectories = new Set<string>();

function getJob(name: "package" | "publish"): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (!job) {
    throw new Error("Missing workflow job: " + name);
  }
  return job;
}

function getSteps(job: WorkflowJob): readonly WorkflowStep[] {
  if (!job.steps) {
    throw new Error("Workflow job is missing steps.");
  }
  return job.steps;
}

function getStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = getSteps(job).find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error("Missing workflow step: " + name);
  }
  return step;
}

function getRun(step: WorkflowStep): string {
  if (!step.run) {
    throw new Error("Workflow step is missing a run script: " + step.name);
  }
  return step.run;
}

function evaluateCondition(condition: string | undefined, context: ConditionContext): boolean {
  if (condition === packageCondition) {
    return (
      context.eventName === "release" ||
      (context.eventName === "workflow_dispatch" && context.ref === "refs/heads/main")
    );
  }
  if (condition === publishCondition) {
    return (
      context.eventName === "release" ||
      (context.eventName === "workflow_dispatch" &&
        context.ref === "refs/heads/main" &&
        context.prepareOnly !== true)
    );
  }
  throw new Error("Unexpected workflow condition: " + condition);
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "graph-mcp-workflow-"));
  temporaryDirectories.add(directory);
  return directory;
}

async function executeShellScript(
  script: string,
  environment: Readonly<Record<string, string>>,
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const directory = await createTemporaryDirectory();
  const outputPath = join(directory, "github-output");
  try {
    await execFileAsync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: directory,
      env: { ...process.env, ...environment, GITHUB_OUTPUT: outputPath },
    });
    return { exitCode: 0, output: await readFile(outputPath, "utf8").catch(() => "") };
  } catch (error) {
    const exitCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number"
        ? error.code
        : 1;
    return { exitCode, output: await readFile(outputPath, "utf8").catch(() => "") };
  }
}

async function executeNpmGate(script: string, npmVersion: string): Promise<number> {
  const directory = await createTemporaryDirectory();
  const npmPath = join(directory, "npm");
  await writeFile(npmPath, '#!/bin/sh\nprintf "%s\\n" "$FAKE_NPM_VERSION"\n', "utf8");
  await chmod(npmPath, 0o755);
  try {
    await execFileAsync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: directory,
      env: {
        ...process.env,
        FAKE_NPM_VERSION: npmVersion,
        PATH: directory + ":" + process.env.PATH,
      },
    });
    return 0;
  } catch (error) {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number"
      ? error.code
      : 1;
  }
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
      temporaryDirectories.delete(directory);
    }),
  );
});

describe("npm publish workflow", () => {
  const packageJob = getJob("package");
  const publishJob = getJob("publish");

  test("declares the semantic YAML parser as an exact direct dependency", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      readonly devDependencies?: Readonly<Record<string, string>>;
    };
    expect(packageJson.devDependencies?.["js-yaml"]).toBe("4.3.0");
  });

  test("uses only the exact release and controlled manual triggers", () => {
    expect(workflow.on).toEqual({
      release: { types: ["published"] },
      workflow_dispatch: {
        inputs: {
          tag: {
            description: "Existing release tag to package",
            required: true,
            type: "string",
          },
          prepare_only: {
            description: "Build and upload the tarball without publishing",
            required: true,
            default: false,
            type: "boolean",
          },
        },
      },
    });
    expect(workflow.concurrency).toEqual({
      group: "npm-publish-${{ github.repository }}",
      "cancel-in-progress": false,
    });
  });

  test("uses exact job conditions for release and main-only manual execution", () => {
    expect(packageJob.if).toBe(packageCondition);
    expect(publishJob.if).toBe(publishCondition);
  });

  test.each([
    {
      label: "release tag",
      context: { eventName: "release", ref: "refs/tags/v1.2.3", prepareOnly: true },
      packageRuns: true,
      publishRuns: true,
    },
    {
      label: "manual main publication",
      context: { eventName: "workflow_dispatch", ref: "refs/heads/main", prepareOnly: false },
      packageRuns: true,
      publishRuns: true,
    },
    {
      label: "manual main preparation",
      context: { eventName: "workflow_dispatch", ref: "refs/heads/main", prepareOnly: true },
      packageRuns: true,
      publishRuns: false,
    },
    {
      label: "manual non-main publication",
      context: { eventName: "workflow_dispatch", ref: "refs/heads/topic", prepareOnly: false },
      packageRuns: false,
      publishRuns: false,
    },
  ])("enforces the $label truth-table row", ({ context, packageRuns, publishRuns }) => {
    expect(evaluateCondition(packageJob.if, context)).toBe(packageRuns);
    expect(evaluateCondition(publishJob.if, context)).toBe(publishRuns);
  });

  test("uses exact runners, timeouts, outputs, environment, and effective permissions", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.permissions).not.toHaveProperty("id-token");
    expect(packageJob["runs-on"]).toBe("ubuntu-latest");
    expect(packageJob["timeout-minutes"]).toBe(25);
    expect(packageJob.outputs).toEqual({
      artifact_name: "${{ steps.metadata.outputs.artifact_name }}",
    });
    expect(packageJob.env).toEqual({
      RELEASE_TAG: "${{ github.event.release.tag_name || inputs.tag }}",
    });
    expect(packageJob.permissions).toBeUndefined();
    expect(publishJob.needs).toBe("package");
    expect(publishJob["runs-on"]).toBe("ubuntu-latest");
    expect(publishJob["timeout-minutes"]).toBe(10);
    expect(publishJob.environment).toBe("npm");
    expect(publishJob.env).toEqual({
      EXPECTED_RELEASE_TAG: "${{ github.event.release.tag_name || inputs.tag }}",
    });
    expect(publishJob.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
    });
    expect(JSON.stringify(packageJob)).not.toContain("id-token");
  });

  test("uses the exact pinned action multiset and no other action", () => {
    const uses = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      getSteps(job)
        .map((step) => step.uses)
        .filter((value): value is string => value !== undefined),
    );
    const expectedUses = [
      checkoutAction,
      checkoutAction,
      setupNodeAction,
      setupNodeAction,
      uploadAction,
      downloadAction,
    ];
    expect([...uses].sort()).toEqual([...expectedUses].sort());
    expect(uses.every((value) => /@[a-f0-9]{40}$/.test(value))).toBe(true);
  });

  test("checks out only the qualified tag without persisted credentials", () => {
    const checkout = getStep(packageJob, "Check out release tag");
    expect(checkout.uses).toBe(checkoutAction);
    expect(checkout.with).toEqual({
      ref: "refs/tags/${{ steps.release.outputs.tag }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
  });

  test("checks out the trusted publish helper at the workflow SHA", () => {
    const checkout = getStep(publishJob, "Check out trusted publish helper");
    expect(checkout.uses).toBe(checkoutAction);
    expect(checkout.with).toEqual({
      ref: "${{ github.workflow_sha }}",
      path: "trusted-source",
      "persist-credentials": false,
    });
  });

  test.each([
    ["v0.0.0", true],
    ["v10.20.30", true],
    ["v01.2.3", false],
    ["v1.2.3-beta.1", false],
    ["v1.2.3\ninjected=value", false],
    ["1.2.3", false],
  ])("validates release tag %j before writing workflow output", async (tag, accepted) => {
    const result = await executeShellScript(getRun(getStep(packageJob, "Resolve release tag")), {
      RELEASE_TAG: tag,
    });
    expect(result.exitCode === 0).toBe(accepted);
    expect(result.output).toBe(accepted ? "tag=" + tag + "\n" : "");
  });

  test("runs a trusted commit and ancestry preflight before dependencies or repository code", () => {
    const names = getSteps(packageJob).map((step) => step.name);
    expect(names).toEqual([
      "Resolve release tag",
      "Check out release tag",
      "Fetch main ancestry",
      "Verify trusted release commit",
      "Set up Node.js",
      "Require OIDC-capable npm",
      "Install locked dependencies",
      "Verify source and package",
      "Prepare release tarball",
      "Validate release metadata",
      "Upload release tarball",
    ]);
    const preflight = getRun(getStep(packageJob, "Verify trusted release commit"));
    expect(preflight).toContain('git rev-parse --verify "refs/tags/$RELEASE_TAG^{commit}"');
    expect(preflight).toContain("git rev-parse --verify HEAD");
    expect(preflight).toContain('[[ "$tag_commit" != "$head_commit" ]]');
    expect(preflight).toContain('git merge-base --is-ancestor "$tag_commit" origin/main');
  });

  test("validates strict package metadata and exposes only strict outputs", () => {
    const metadataStep = getStep(packageJob, "Validate release metadata");
    const run = getRun(metadataStep);
    expect(metadataStep.id).toBe("metadata");
    expect(run).toContain('const expectedName = "@juststas/graph-mcp"');
    expect(run).toContain("metadata.tag !== process.env.RELEASE_TAG");
    expect(run).toContain('metadata.tag !== "v" + metadata.version');
    expect(run).toContain("const expectedFilename = `juststas-graph-mcp-${metadata.version}.tgz`");
    expect(run).toContain('await access(join("release", expectedFilename))');
    expect(run).toContain("printf 'artifact_name=npm-package-%s\\n'");
    expect(run).not.toContain("release_tag=");
  });

  test("uploads only the tarball and metadata data files", () => {
    const upload = getStep(packageJob, "Upload release tarball");
    const paths = String(upload.with?.path)
      .trim()
      .split("\n")
      .map((value) => value.trim());
    expect(upload.uses).toBe(uploadAction);
    expect(upload.with).toEqual({
      name: "${{ steps.metadata.outputs.artifact_name }}",
      path: "release/*.tgz\nrelease/package-metadata.json\n",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    expect(paths).toEqual(["release/*.tgz", "release/package-metadata.json"]);
    expect(paths.every((value) => !value.endsWith(".mjs"))).toBe(true);
  });

  test("downloads the named data artifact and validates its release identity", () => {
    const names = getSteps(publishJob).map((step) => step.name);
    expect(names).toEqual([
      "Check out trusted publish helper",
      "Set up Node.js",
      "Require OIDC-capable npm",
      "Download release tarball",
      "Validate downloaded release metadata",
      "Publish or verify immutable version",
    ]);
    const download = getStep(publishJob, "Download release tarball");
    expect(download.uses).toBe(downloadAction);
    expect(download.with).toEqual({
      name: "${{ needs.package.outputs.artifact_name }}",
      path: "release",
    });
    const validation = getStep(publishJob, "Validate downloaded release metadata");
    expect(validation.env).toBeUndefined();
    const run = getRun(validation);
    expect(run).toContain('metadata.name !== "@juststas/graph-mcp"');
    expect(run).toContain("metadata.tag !== process.env.EXPECTED_RELEASE_TAG");
    expect(run).toContain('metadata.tag !== "v" + metadata.version');
    expect(JSON.stringify(workflow)).not.toContain("needs.package.outputs.release_tag");
  });

  test("publishes through the workflow-SHA helper and never downloaded executable code", () => {
    const publishRun = getRun(getStep(publishJob, "Publish or verify immutable version"));
    expect(publishRun).toBe(
      'node trusted-source/scripts/release-package.mjs publish release/package-metadata.json "$EXPECTED_RELEASE_TAG"',
    );
    expect(JSON.stringify(publishJob)).not.toContain("node release/release-package.mjs");
    expect(JSON.stringify(publishJob)).not.toContain("npm ci");
    expect(JSON.stringify(publishJob)).not.toContain("npm run verify");
  });

  test.each([
    ["11.5.0", false],
    ["11.5.1", true],
    ["11.5.1-beta.0", false],
    ["malformed", false],
    ["12.0.0", true],
  ])("requires exact stable npm boundary for %s", async (version, accepted) => {
    const results = await Promise.all(
      [packageJob, publishJob].map(async (job) => {
        const gate = getRun(getStep(job, "Require OIDC-capable npm"));
        return (await executeNpmGate(gate, version)) === 0;
      }),
    );
    expect(results).toEqual([accepted, accepted]);
  });

  test("contains no long-lived credential reference in semantic workflow values", () => {
    expect(JSON.stringify(workflow)).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
  });
});
```

- [ ] **Step 3: Run the workflow test and confirm it fails**

Run:

```bash
npx vitest run tests/release-workflow.test.ts
```

Expected: FAIL because publish.yml is missing or violates the trusted-ref, event/input-derived expected-tag, data-only artifact, workflow-SHA helper, job-condition, exact npm-version, or two-argument publish-helper contracts. A parser, import, or TypeScript error is not an acceptable RED.

- [ ] **Step 4: Create the least-privilege trusted workflow**

Create .github/workflows/publish.yml:

```yaml
name: Publish npm package

on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      tag:
        description: Existing release tag to package
        required: true
        type: string
      prepare_only:
        description: Build and upload the tarball without publishing
        required: true
        default: false
        type: boolean

permissions:
  contents: read

concurrency:
  group: npm-publish-${{ github.repository }}
  cancel-in-progress: false

jobs:
  package:
    if: ${{ github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') }}
    runs-on: ubuntu-latest
    timeout-minutes: 25
    outputs:
      artifact_name: ${{ steps.metadata.outputs.artifact_name }}
    env:
      RELEASE_TAG: ${{ github.event.release.tag_name || inputs.tag }}
    steps:
      - name: Resolve release tag
        id: release
        shell: bash
        run: |
          if [[ ! "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
            echo "Release tag must match vMAJOR.MINOR.PATCH without leading zeros." >&2
            exit 1
          fi
          printf 'tag=%s\n' "$RELEASE_TAG" >> "$GITHUB_OUTPUT"

      - name: Check out release tag
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          ref: refs/tags/${{ steps.release.outputs.tag }}
          fetch-depth: 0
          persist-credentials: false

      - name: Fetch main ancestry
        run: git fetch --no-tags origin main:refs/remotes/origin/main

      - name: Verify trusted release commit
        shell: bash
        run: |
          tag_commit="$(git rev-parse --verify "refs/tags/$RELEASE_TAG^{commit}")"
          head_commit="$(git rev-parse --verify HEAD)"
          if [[ "$tag_commit" != "$head_commit" ]]; then
            echo "Release tag commit must match HEAD." >&2
            exit 1
          fi
          git merge-base --is-ancestor "$tag_commit" origin/main

      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          package-manager-cache: false

      - name: Require OIDC-capable npm
        shell: bash
        run: |
          npm_version="$(npm --version)"
          node -e '
          const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(process.argv[1]);
          if (!match) process.exit(1);
          const [major, minor, patch] = match.slice(1).map(Number);
          if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) process.exit(1);
          ' "$npm_version"

      - name: Install locked dependencies
        run: npm ci

      - name: Verify source and package
        run: npm run verify

      - name: Prepare release tarball
        run: node scripts/release-package.mjs prepare "$RELEASE_TAG" release

      - name: Validate release metadata
        id: metadata
        shell: bash
        run: |
          version="$(node --input-type=module <<'NODE'
          import { access, readFile } from "node:fs/promises";
          import { join } from "node:path";
          const expectedName = "@juststas/graph-mcp";
          const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
          const metadata = JSON.parse(await readFile("release/package-metadata.json", "utf8"));
          if (metadata.name !== expectedName) throw new Error("Unexpected package name.");
          if (!versionPattern.test(metadata.version)) throw new Error("Invalid package version.");
          if (metadata.tag !== process.env.RELEASE_TAG) throw new Error("Metadata tag does not match release tag.");
          if (metadata.tag !== "v" + metadata.version) throw new Error("Metadata tag does not match package version.");
          const expectedFilename = `juststas-graph-mcp-${metadata.version}.tgz`;
          if (metadata.filename !== expectedFilename) throw new Error("Unexpected tarball filename.");
          await access(join("release", expectedFilename));
          process.stdout.write(metadata.version);
          NODE
          )"
          printf 'artifact_name=npm-package-%s\n' "$version" >> "$GITHUB_OUTPUT"

      - name: Upload release tarball
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: ${{ steps.metadata.outputs.artifact_name }}
          path: |
            release/*.tgz
            release/package-metadata.json
          if-no-files-found: error
          retention-days: 1

  publish:
    if: ${{ github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.prepare_only != true) }}
    needs: package
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: npm
    permissions:
      actions: read
      contents: read
      id-token: write
    env:
      EXPECTED_RELEASE_TAG: ${{ github.event.release.tag_name || inputs.tag }}
    steps:
      - name: Check out trusted publish helper
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          ref: ${{ github.workflow_sha }}
          path: trusted-source
          persist-credentials: false

      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          package-manager-cache: false

      - name: Require OIDC-capable npm
        shell: bash
        run: |
          npm_version="$(npm --version)"
          node -e '
          const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(process.argv[1]);
          if (!match) process.exit(1);
          const [major, minor, patch] = match.slice(1).map(Number);
          if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) process.exit(1);
          ' "$npm_version"

      - name: Download release tarball
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: ${{ needs.package.outputs.artifact_name }}
          path: release

      - name: Validate downloaded release metadata
        run: |
          node --input-type=module <<'NODE'
          import { access, readFile } from "node:fs/promises";
          import { join } from "node:path";
          const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
          const tagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
          const metadata = JSON.parse(await readFile("release/package-metadata.json", "utf8"));
          if (!tagPattern.test(process.env.EXPECTED_RELEASE_TAG ?? "")) throw new Error("Invalid expected release tag.");
          if (metadata.name !== "@juststas/graph-mcp") throw new Error("Unexpected package name.");
          if (!versionPattern.test(metadata.version)) throw new Error("Invalid package version.");
          if (metadata.tag !== process.env.EXPECTED_RELEASE_TAG) throw new Error("Metadata tag does not match expected release tag.");
          if (metadata.tag !== "v" + metadata.version) throw new Error("Metadata tag does not match package version.");
          const expectedFilename = `juststas-graph-mcp-${metadata.version}.tgz`;
          if (metadata.filename !== expectedFilename) throw new Error("Unexpected tarball filename.");
          await access(join("release", expectedFilename));
          NODE

      - name: Publish or verify immutable version
        run: node trusted-source/scripts/release-package.mjs publish release/package-metadata.json "$EXPECTED_RELEASE_TAG"
```

- [ ] **Step 5: Run semantic workflow, formatting, and actionlint checks**

Run:

```bash
npx vitest run tests/release-workflow.test.ts
npx prettier --check .github/workflows/publish.yml tests/release-workflow.test.ts package.json package-lock.json
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 .github/workflows/publish.yml
```

Expected: all semantic workflow tests PASS, Prettier reports every scoped file formatted, and actionlint exits 0.

- [ ] **Step 6: Verify every action pin against GitHub**

Run:

```bash
gh api repos/actions/checkout/git/ref/tags/v7.0.0 --jq .object.sha
gh api repos/actions/setup-node/git/ref/tags/v7.0.0 --jq .object.sha
gh api repos/actions/upload-artifact/git/ref/tags/v7.0.1 --jq .object.sha
gh api repos/actions/download-artifact/git/ref/tags/v8.0.1 --jq .object.sha
```

Expected, in order:

```text
9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
820762786026740c76f36085b0efc47a31fe5020
043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
```

- [ ] **Step 7: Verify the lockfile delta and complete workflow gates**

Run:

```bash
npm ci
npm run verify
git diff --check
git diff -- package.json package-lock.json
```

Expected: npm ci and the full verification suite pass; the lockfile changes only promote exact js-yaml@4.3.0 into the root devDependencies without changing its resolved version, integrity, or transitive dependencies.

- [ ] **Step 8: Commit the workflow**

```bash
git add .github/workflows/publish.yml tests/release-workflow.test.ts package.json package-lock.json
git commit -m "ci: add npm trusted publishing workflow"
```

## Task 4: Document scoped installation and release operations

**Files:**

- Modify: tests/project-metadata.test.ts
- Modify: README.md
- Modify: CHANGELOG.md

- [ ] **Step 1: Add a failing README contract**

Add `sectionBetween` and whitespace-normalizing `expectMarkersInOrder` helpers, then add a
README/changelog contract that parses the release subsections instead of checking disconnected
substrings:

```typescript
test("documents the scoped package while preserving the graph-mcp command", async () => {
  const [readme, changelog] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
  ]);
  const releaseProcedure = sectionBetween(
    readme,
    "### Release procedure",
    "## Architecture and runtime behavior",
  );
  const normalRelease = sectionBetween(
    releaseProcedure,
    "#### Normal releases",
    "#### First scoped-package bootstrap",
  );
  const bootstrap = sectionBetween(
    releaseProcedure,
    "#### First scoped-package bootstrap",
    "#### Recovery",
  );
  const normalizedBootstrap = bootstrap.replace(/\s+/g, " ");

  expect(readme).toContain("npm install --global @juststas/graph-mcp");
  expect(readme).toContain("graph-mcp setup");
  expectMarkersInOrder(normalRelease, [
    "Merge the reviewed pull request",
    "release-tag authority",
    "no-bypass immutability",
    "Publish the matching GitHub Release",
    "The package job",
    "without OIDC permission",
    "The publish job",
    "only job that receives OIDC permission",
    "data-only artifact containing the tarball and metadata",
    "npm Trusted Publishing",
  ]);
  expectMarkersInOrder(bootstrap, [
    "activate the administrator-authority `v*` ruleset",
    "Audit the exact historical tag inventory",
    "Activate the separate no-bypass immutability ruleset",
    "Create the annotated `v0.6.1` tag",
    "with `prepare_only` enabled",
    "Validate the exact filename",
    "Publish that same private snapshot",
    "interactive 2FA",
    "Reverify both release-tag rulesets",
    "Create the `npm` GitHub environment",
    "Add separate typed environment policies",
    "Verify both rulesets and both typed environment policies",
    "Configure npm Trusted Publishing",
  ]);
  expect(normalizedBootstrap).toContain("manual 0.6.1 bootstrap uses neither OIDC nor provenance");
  expect(normalizedBootstrap).toContain("Version 0.6.2 is the first real OIDC publish");
  expect(changelog).not.toContain("- Published the npm distribution");
  expect(readme).not.toMatch(/^npm install --global graph-mcp(?:\s|$)/m);
  expect(readme).not.toMatch(/^npm (?:publish|view) graph-mcp(?:@|\s|$)/m);
  expect(readme).not.toMatch(/^npm publish(?:\s+--access public|\s+\.)/m);
  expect(readme).not.toMatch(
    /^(?:python(?:3)? -m build|twine upload|poetry publish|pip install graph-mcp)\b/m,
  );
});
```

- [ ] **Step 2: Run the README contract and confirm it fails**

Run:

```bash
npx vitest run tests/project-metadata.test.ts
```

Expected: FAIL because README still installs the unscoped package and lacks the workflow/provenance text.

- [ ] **Step 3: Update the npm installation section**

Use exactly:

````markdown
### npm

Install the public scoped package globally:

```bash
npm install --global @juststas/graph-mcp
graph-mcp setup
```

The npm package is scoped to JustStas, but the installed executable remains graph-mcp.
Invoking graph-mcp without arguments starts the MCP server over stdio.
````

- [ ] **Step 4: Replace the release procedure**

Replace the existing README release procedure with:

````markdown
### Release procedure

Graph MCP releases use the public npm package `@juststas/graph-mcp`; there is no Python/PyPI
release step. Version 0.6.0 completed the Node migration but was not published to npm because
npm rejected the unscoped `graph-mcp@0.6.0` name as too similar to the existing `graphmcp`
package. Version 0.6.1 is the first scoped npm release.

#### Normal releases

1. Update `package.json`, `package-lock.json`, both plugin manifests, runtime metadata,
   `CHANGELOG.md`, and the committed plugin bundle to one version.
2. Run `npm ci`, `npm run verify`, `node scripts/test-plugin-install.mjs`, and
   `npm pack --json --dry-run` from a clean worktree.
3. Merge the reviewed pull request to `main`. A repository administrator then creates the
   annotated `v<version>` tag on the merged commit through the mandatory release-tag authority
   ruleset; the separate no-bypass immutability ruleset blocks later update or deletion.
4. Publish the matching GitHub Release. The workflow trigger is `release: types: [published]`.
5. The package job installs locked dependencies, runs `npm run verify`, and prepares the exact
   tarball without OIDC permission.
6. The publish job runs in the `npm` GitHub environment and is the only job that receives OIDC
   permission. It downloads a data-only artifact containing the tarball and metadata, checks
   out its trusted helper at `github.workflow_sha`, binds the expected tag directly to the
   release event, validates npm's JSON dry-run manifest for the exact private snapshot, and
   uses npm Trusted Publishing. It has no `NODE_AUTH_TOKEN` or npm secret.
7. Verify the workflow, npm version, `dist.integrity`, installed CLI version, and 44-tool MCP
   inventory.

Workflow reruns are idempotent. If the version already exists, the workflow succeeds only
when npm's dist.integrity equals the prepared tarball. A different integrity fails and
requires a new patch version.

#### First scoped-package bootstrap

npm requires a package to exist before Trusted Publishing can be configured. Bootstrap the first
scoped release in this order:

1. Verify merged `main`, then activate the administrator-authority `v*` ruleset.
2. Audit the exact historical tag inventory and ancestry, require the exact allowlisted
   historical PyPI workflow blob where expected, and require the new release helper to be absent
   everywhere.
3. Activate the separate no-bypass immutability ruleset.
4. Create the annotated `v0.6.1` tag only after those gates pass.
5. Run `publish.yml` from `main` with `prepare_only` enabled and inspect its prepared artifact.
6. Validate the exact filename, regular-file status, SHA-512 and SHA-1 digests, and npm's JSON
   dry-run manifest. Publish that same private snapshot once with the maintainer's interactive
   2FA, explicit npmjs registry, `latest` tag, disabled lifecycle scripts, and public access;
   then verify its registry version and integrity.
7. Reverify both release-tag rulesets.
8. Create the `npm` GitHub environment.
9. Add separate typed environment policies for branch `main` and tag `v*`.
10. Verify both rulesets and both typed environment policies.
11. Configure npm Trusted Publishing:

```bash
npx --yes npm@11.15.0 trust github @juststas/graph-mcp \
  --file publish.yml \
  --repo JustStas/Graph-MCP \
  --env npm \
  --allow-publish
```

Verify the saved repository, workflow filename, environment, and publish permission, then
set npm publishing access to require 2FA and disallow traditional tokens.

The manual 0.6.1 bootstrap uses neither OIDC nor provenance, and its integrity-matched release
workflow is a no-op that does not test the OIDC exchange. Version 0.6.2 is the first real OIDC
publish and provenance check.

#### Recovery

Use `workflow_dispatch` from `main` with an existing protected tag to rerun publication. Use
`prepare_only` when only the verified tarball is needed. The release-tag rulesets prohibit
moving or deleting published `v*` tags. Never overwrite an npm version; recover from a bad
publication with a new patch release.
````

- [ ] **Step 5: Add the 0.6.1 changelog entry**

Insert above 0.6.0:

```markdown
## 0.6.1 - 2026-07-17

### Changed

- Changed the npm package identity to @juststas/graph-mcp while preserving the graph-mcp
  executable and Claude/Codex plugin names. npm rejected the unscoped graph-mcp@0.6.0 name as
  too similar to the existing graphmcp package, so 0.6.1 is the first scoped npm release.
- Normalized npm bin and repository metadata and synchronized all runtime and plugin versions.
- Updated installation and release documentation for the scoped package.

### Added

- A GitHub Release workflow with separate package and OIDC publish jobs, immutable action pins,
  disabled release caching, integrity-safe reruns, and a non-publishing bootstrap mode.
- A documented npm Trusted Publishing bootstrap and verification procedure for tokenless
  releases after the manual 0.6.1 bootstrap. Version 0.6.2 is the first planned OIDC publish
  with npm provenance.
```

- [ ] **Step 6: Run documentation tests and formatting**

Run:

```bash
npx vitest run tests/project-metadata.test.ts
npx prettier --check README.md CHANGELOG.md tests/project-metadata.test.ts
```

Expected: the metadata tests PASS and formatting is clean.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md CHANGELOG.md tests/project-metadata.test.ts
git commit -m "docs: document scoped npm publishing"
```

## Task 5: Run complete pre-merge verification

**Files:**

- Verify all changed files.
- Regenerate plugin artifacts only if the build proves they differ.

- [ ] **Step 1: Install from the lockfile**

Run:

```bash
npm ci
```

Expected: exit 0 and zero reported vulnerabilities.

- [ ] **Step 2: Run the complete repository verification**

Run:

```bash
npm run verify
```

Expected: formatting, lint, typecheck, all Vitest files, build, version synchronization, and five-file package validation all PASS.

- [ ] **Step 3: Run real plugin installation smoke**

Run:

```bash
node scripts/test-plugin-install.mjs
```

Expected output contains both:

```text
CLAUDE_PLUGIN_INSTALL_OK 44
CODEX_PLUGIN_INSTALL_OK 44
```

- [ ] **Step 4: Inspect the exact npm payload**

Run:

```bash
npm pack --json --dry-run
```

Expected: one @juststas/graph-mcp@0.6.1 result containing only LICENSE, README.md, dist/cli.js, dist/cli.js.map, and package.json.

- [ ] **Step 5: Verify repository cleanliness**

Run:

```bash
git diff --check
git status --short --branch
```

Expected: no unstaged or staged files. If npm run verify refreshed tracked plugin artifacts, inspect them, rerun the focused plugin tests, and commit only those generated files:

```bash
git add plugins/graph-mcp/dist/graph-mcp.js plugins/graph-mcp/dist/cli.js.map
git commit -m "build: refresh 0.6.1 plugin artifacts"
```

## Task 6: Review, push, open the PR, and merge

**Files:**

- Review the complete branch diff.
- No new implementation files.

- [ ] **Step 1: Review the branch against the approved spec**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: only the approved package identity, workflow, tests, docs, design, plan, and generated artifacts are present.

- [ ] **Step 2: Request code review**

Use superpowers:requesting-code-review. Resolve every verified blocking finding with test-first changes and rerun Task 5.

- [ ] **Step 3: Push the branch**

```bash
git push --set-upstream origin sn/npm-trusted-publishing
```

- [ ] **Step 4: Create the GitHub pull request**

```bash
gh pr create --repo JustStas/Graph-MCP --base main --head sn/npm-trusted-publishing --title "Publish scoped npm package with trusted publishing" --body "## Summary
- publish Graph MCP as @juststas/graph-mcp@0.6.1
- add least-privilege GitHub OIDC publishing
- document and test the one-time bootstrap flow

## Verification
- npm run verify
- node scripts/test-plugin-install.mjs
- npm pack --json --dry-run"
```

- [ ] **Step 5: Wait for GitHub checks**

```bash
gh pr checks --repo JustStas/Graph-MCP --watch
```

Expected: every required check passes.

- [ ] **Step 6: Merge without rewriting the existing v0.6.0 tag**

```bash
gh pr merge --repo JustStas/Graph-MCP --merge --delete-branch=false
```

Expected: the PR reports merged and origin/main advances to a merge commit containing the branch.

## Task 7: Protect release tags, audit history, and prepare the exact bootstrap tarball

**Files:**

- Operate from: /Users/juststas/Documents/Graph MCP
- No source edits.

- [ ] **Step 1: Fast-forward merged main and verify it**

```bash
git switch main
git pull --ff-only origin main
npm ci
npm run verify
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git status --short
```

Expected: verification passes, local `main` is the exact current `origin/main`, and the checkout
is clean. Do not create `v0.6.1`, an npm environment, or npm trust yet.

- [ ] **Step 2: Create or verify the active release-tag administrator-authority ruleset**

Use the repository rulesets API. Create the ruleset only when no ruleset with its exact name
exists; reuse and verify one existing match, and stop on duplicate same-name rulesets:

```bash
bash <<'BASH'
set -euo pipefail

repository="repos/JustStas/Graph-MCP"
authority_name="Release tag administrator authority"
rulesets="$(gh api --paginate "$repository/rulesets" | jq -s 'add')"
authority_count="$(jq -r --arg name "$authority_name" \
  '[.[] | select(.name == $name)] | length' <<<"$rulesets")"

case "$authority_count" in
  0)
    authority_ruleset_id="$(
      gh api --method POST "$repository/rulesets" --input - --jq .id <<'JSON'
{
  "name": "Release tag administrator authority",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "always"
    }
  ],
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/v*"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "creation" },
    { "type": "update" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
JSON
    )"
    ;;
  1)
    authority_ruleset_id="$(jq -r --arg name "$authority_name" \
      '.[] | select(.name == $name) | .id' <<<"$rulesets")"
    ;;
  *)
    echo "Expected zero or one ruleset named: $authority_name" >&2
    exit 1
    ;;
esac

gh api "$repository/rulesets/$authority_ruleset_id" | jq -e '
  .name == "Release tag administrator authority" and
  .target == "tag" and
  .enforcement == "active" and
  .conditions.ref_name.include == ["refs/tags/v*"] and
  .conditions.ref_name.exclude == [] and
  ([.bypass_actors[] | {actor_id, actor_type, bypass_mode}] == [
    {actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always"}
  ]) and
  (([.rules[].type] | sort) == ["creation", "deletion", "non_fast_forward", "update"])
'
BASH
```

Expected: exactly one active tag ruleset with the exact `refs/tags/v*` condition, four rule
types, and sole administrator-role `always` bypass. A same-name ruleset with different content
fails verification; duplicate same-name rulesets stop the rollout. This closes non-admin tag
creation and mutation races before the audit and uses no deprecated tag-protection endpoint.

- [ ] **Step 3: Audit the exact historical `v*` tag inventory and contents**

Run the audit while only repository administrators can create or mutate matching tags:

```bash
bash <<'BASH'
set -euo pipefail

expected_tags="$(cat <<'TAGS'
v0.1.0
v0.2.0
v0.4.0
v0.4.1
v0.4.2
v0.4.3
v0.5.0
v0.5.1
v0.6.0
TAGS
)"
historical_workflow_blob="d34e5a9a4691ab487629b8f25387fa0456331491"

read_remote_tags() {
  git ls-remote --refs --tags origin 'refs/tags/v*' |
    awk '{sub(/^refs\/tags\//, "", $2); print $2}' |
    LC_ALL=C sort
}

actual_tags="$(read_remote_tags)"
if [[ "$actual_tags" != "$expected_tags" ]]; then
  diff -u <(printf '%s\n' "$expected_tags") <(printf '%s\n' "$actual_tags") || true
  echo "Remote v* tag inventory differs from the approved baseline; stop for investigation." >&2
  exit 1
fi

git fetch --no-tags origin main:refs/remotes/origin/main
git fetch --tags origin

while IFS= read -r tag; do
  tag_commit="$(git rev-parse --verify "refs/tags/$tag^{commit}")"
  if ! git merge-base --is-ancestor "$tag_commit" origin/main; then
    echo "$tag does not peel to an ancestor of origin/main." >&2
    exit 1
  fi
  if [[ "$tag" == "v0.6.0" ]]; then
    if git cat-file -e "refs/tags/$tag:.github/workflows/publish.yml" 2>/dev/null; then
      echo "$tag unexpectedly contains .github/workflows/publish.yml." >&2
      exit 1
    fi
  else
    if ! workflow_blob="$(
      git rev-parse --verify "refs/tags/$tag:.github/workflows/publish.yml" 2>/dev/null
    )"; then
      echo "$tag is missing its allowlisted historical PyPI workflow." >&2
      exit 1
    fi
    if [[ "$workflow_blob" != "$historical_workflow_blob" ]]; then
      echo "$tag has an unexpected historical publish.yml blob: $workflow_blob" >&2
      exit 1
    fi
  fi
  if git cat-file -e "refs/tags/$tag:scripts/release-package.mjs" 2>/dev/null; then
    echo "$tag unexpectedly contains scripts/release-package.mjs." >&2
    exit 1
  fi
done <<<"$expected_tags"

post_audit_tags="$(read_remote_tags)"
if [[ "$post_audit_tags" != "$expected_tags" ]]; then
  diff -u <(printf '%s\n' "$expected_tags") <(printf '%s\n' "$post_audit_tags") || true
  echo "Remote v* tag inventory changed during the audit; stop for investigation." >&2
  exit 1
fi
BASH
```

Expected: `--refs` suppresses annotated peel lines, the sorted inventory equals the approved
nine tags exactly, and every tag peels to a commit reachable from current `origin/main`.
`v0.1.0` through `v0.5.1` must contain `.github/workflows/publish.yml` at exact blob
`d34e5a9a4691ab487629b8f25387fa0456331491`; `v0.6.0` must not contain that path; and none of
the nine tags may contain `scripts/release-package.mjs`. The allowlisted blob is different,
unrelated historical PyPI workflow content and declares environment `pypi`, so it cannot satisfy
the npm trust relationship that requires environment `npm`. Any unexpected historical npm
workflow/helper is a hard stop. Do not delete, move, recreate, or force-push a tag automatically;
investigate and obtain explicit user direction while the administrator bypass still permits an
intentional repair.

- [ ] **Step 4: Create or verify no-bypass immutability and reverify both rulesets**

Create the second ruleset only when absent, stop on duplicate same-name rulesets, and verify both
complete ruleset definitions:

```bash
bash <<'BASH'
set -euo pipefail

repository="repos/JustStas/Graph-MCP"
authority_name="Release tag administrator authority"
immutability_name="Release tag immutability"
rulesets="$(gh api --paginate "$repository/rulesets" | jq -s 'add')"
immutability_count="$(jq -r --arg name "$immutability_name" \
  '[.[] | select(.name == $name)] | length' <<<"$rulesets")"

case "$immutability_count" in
  0)
    immutability_ruleset_id="$(
      gh api --method POST "$repository/rulesets" --input - --jq .id <<'JSON'
{
  "name": "Release tag immutability",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/v*"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "update" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
JSON
    )"
    ;;
  1)
    immutability_ruleset_id="$(jq -r --arg name "$immutability_name" \
      '.[] | select(.name == $name) | .id' <<<"$rulesets")"
    ;;
  *)
    echo "Expected zero or one ruleset named: $immutability_name" >&2
    exit 1
    ;;
esac

rulesets="$(gh api --paginate "$repository/rulesets" | jq -s 'add')"
authority_ruleset_id="$(jq -er --arg name "$authority_name" '
  [.[] | select(.name == $name)] |
  if length == 1 then .[0].id else error("expected exactly one authority ruleset") end
' <<<"$rulesets")"
immutability_ruleset_id="$(jq -er --arg name "$immutability_name" '
  [.[] | select(.name == $name)] |
  if length == 1 then .[0].id else error("expected exactly one immutability ruleset") end
' <<<"$rulesets")"

gh api "$repository/rulesets/$authority_ruleset_id" | jq -e '
  .name == "Release tag administrator authority" and
  .target == "tag" and
  .enforcement == "active" and
  .conditions.ref_name.include == ["refs/tags/v*"] and
  .conditions.ref_name.exclude == [] and
  ([.bypass_actors[] | {actor_id, actor_type, bypass_mode}] == [
    {actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always"}
  ]) and
  (([.rules[].type] | sort) == ["creation", "deletion", "non_fast_forward", "update"])
'

gh api "$repository/rulesets/$immutability_ruleset_id" | jq -e '
  .name == "Release tag immutability" and
  .target == "tag" and
  .enforcement == "active" and
  .conditions.ref_name.include == ["refs/tags/v*"] and
  .conditions.ref_name.exclude == [] and
  .bypass_actors == [] and
  (([.rules[].type] | sort) == ["deletion", "non_fast_forward", "update"])
'
BASH
```

Expected: both exact API checks exit 0. The no-bypass ruleset has no `creation` rule, so an
administrator can still create a new release tag through the authority bypass, but nobody can
later update, delete, or force-move any matching tag.

- [ ] **Step 5: Create and push v0.6.1**

First prove the tag is unused:

```bash
git ls-remote --exit-code --refs --tags origin refs/tags/v0.6.1
```

Expected: exit 2 with no matching tag.

Then create it:

```bash
git tag -a v0.6.1 -m "Graph MCP v0.6.1"
git push origin refs/tags/v0.6.1
```

Expected: the administrator bypass permits creation through the authority ruleset. The
no-bypass immutability ruleset permits creation because it has no `creation` rule, then prevents
all later update or deletion.

- [ ] **Step 6: Verify v0.6.1 and both rulesets after creation**

```bash
bash <<'BASH'
set -euo pipefail

git fetch --no-tags origin main:refs/remotes/origin/main
git fetch origin refs/tags/v0.6.1:refs/tags/v0.6.1
merged_main_head="$(git rev-parse HEAD)"
test "$merged_main_head" = "$(git rev-parse origin/main)"
test "$(git rev-parse --verify 'refs/tags/v0.6.1^{commit}')" = "$merged_main_head"

expected_tags="$(cat <<'TAGS'
v0.1.0
v0.2.0
v0.4.0
v0.4.1
v0.4.2
v0.4.3
v0.5.0
v0.5.1
v0.6.0
v0.6.1
TAGS
)"
actual_tags="$(
  git ls-remote --refs --tags origin 'refs/tags/v*' |
    awk '{sub(/^refs\/tags\//, "", $2); print $2}' |
    LC_ALL=C sort
)"
test "$actual_tags" = "$expected_tags"

repository="repos/JustStas/Graph-MCP"
rulesets="$(gh api --paginate "$repository/rulesets" | jq -s 'add')"
authority_ruleset_id="$(jq -er '
  [.[] | select(.name == "Release tag administrator authority")] |
  if length == 1 then .[0].id else error("expected exactly one authority ruleset") end
' <<<"$rulesets")"
immutability_ruleset_id="$(jq -er '
  [.[] | select(.name == "Release tag immutability")] |
  if length == 1 then .[0].id else error("expected exactly one immutability ruleset") end
' <<<"$rulesets")"

gh api "$repository/rulesets/$authority_ruleset_id" | jq -e '
  .name == "Release tag administrator authority" and
  .target == "tag" and .enforcement == "active" and
  .conditions.ref_name == {include: ["refs/tags/v*"], exclude: []} and
  ([.bypass_actors[] | {actor_id, actor_type, bypass_mode}] == [
    {actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always"}
  ]) and
  (([.rules[].type] | sort) == ["creation", "deletion", "non_fast_forward", "update"])
'
gh api "$repository/rulesets/$immutability_ruleset_id" | jq -e '
  .name == "Release tag immutability" and
  .target == "tag" and .enforcement == "active" and
  .conditions.ref_name == {include: ["refs/tags/v*"], exclude: []} and
  .bypass_actors == [] and
  (([.rules[].type] | sort) == ["deletion", "non_fast_forward", "update"])
'
BASH
```

Expected: `v0.6.1` peels to the exact merged `main` HEAD, the remote inventory is the approved
historical baseline plus only `v0.6.1`, and both rulesets remain active with exact policies.

- [ ] **Step 7: Run prepare-only packaging on GitHub**

```bash
dispatch_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run publish.yml --repo JustStas/Graph-MCP --ref main -f tag=v0.6.1 -f prepare_only=true
run_id="$(gh run list --repo JustStas/Graph-MCP --workflow publish.yml --event workflow_dispatch \
  --created ">=$dispatch_time" --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$run_id"
gh run watch --repo JustStas/Graph-MCP "$run_id"
```

Expected: package succeeds, publish is skipped, and the run succeeds.

- [ ] **Step 8: Download and inspect the prepared artifact**

```bash
run_id="$(gh run list --repo JustStas/Graph-MCP --workflow publish.yml --event workflow_dispatch \
  --limit 1 --json databaseId,conclusion \
  --jq 'if length == 1 and .[0].conclusion == "success" then .[0].databaseId else error("latest prepare-only run did not succeed") end')"
release_dir="$(mktemp -d)"
chmod 700 "$release_dir"
gh run download --repo JustStas/Graph-MCP "$run_id" --name npm-package-0.6.1 --dir "$release_dir"
test "$(find "$release_dir" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')" = 2
test -f "$release_dir/package-metadata.json"
test -f "$release_dir/juststas-graph-mcp-0.6.1.tgz"
test ! -L "$release_dir/package-metadata.json"
test ! -L "$release_dir/juststas-graph-mcp-0.6.1.tgz"
chmod 600 "$release_dir/package-metadata.json" "$release_dir/juststas-graph-mcp-0.6.1.tgz"
node -e 'const fs=require("fs"); const path=require("path"); const m=JSON.parse(fs.readFileSync(path.join(process.argv[1],"package-metadata.json"),"utf8")); if(m.name!=="@juststas/graph-mcp"||m.version!=="0.6.1"||m.tag!=="v0.6.1"||m.filename!=="juststas-graph-mcp-0.6.1.tgz"||!/^sha512-[A-Za-z0-9+/]+={2}$/.test(m.integrity)||!/^[a-f0-9]{40}$/.test(m.shasum)) process.exit(1); console.log(JSON.stringify(m,null,2))' "$release_dir"
```

Expected: a private directory containing only exact scoped metadata and its exact regular-file
tarball. Task 8 independently validates the bytes and npm dry-run manifest before publication.

## Task 8: Bootstrap npm trust, publish the GitHub Release, and verify deployment

**Files:**

- Use the downloaded release artifact from Task 7.
- No source edits.

- [ ] **Step 1: Confirm the package version is absent**

```bash
npm view @juststas/graph-mcp@0.6.1 version --json --registry https://registry.npmjs.org/
```

Expected: npm E404. If the version exists, stop and compare its dist.integrity with package-metadata.json before any other action.

- [ ] **Step 2: Publish the exact prepared tarball with 2FA**

```bash
set -euo pipefail

validate_snapshot() {
  node --input-type=module - "$release_dir" <<'NODE'
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

const expected = {
  name: "@juststas/graph-mcp",
  version: "0.6.1",
  tag: "v0.6.1",
  filename: "juststas-graph-mcp-0.6.1.tgz",
};
const releaseDirectory = await realpath(process.argv[2]);
const metadataPath = join(releaseDirectory, "package-metadata.json");
const metadataStat = await lstat(metadataPath);
if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
  throw new Error("metadata must be a regular non-symlink file");
}
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
for (const [key, value] of Object.entries(expected)) {
  if (metadata[key] !== value) throw new Error(`unexpected metadata ${key}`);
}
if (!/^[a-f0-9]{40}$/.test(metadata.shasum)) throw new Error("invalid metadata shasum");
const tarballPath = join(releaseDirectory, expected.filename);
const tarballStat = await lstat(tarballPath);
if (tarballStat.isSymbolicLink() || !tarballStat.isFile()) {
  throw new Error("tarball must be a regular non-symlink file");
}
const realTarball = await realpath(tarballPath);
if (dirname(realTarball) !== releaseDirectory) throw new Error("tarball escaped release directory");
const bytes = await readFile(realTarball);
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const shasum = createHash("sha1").update(bytes).digest("hex");
if (integrity !== metadata.integrity || shasum !== metadata.shasum) {
  throw new Error("tarball digests do not match metadata");
}
process.stdout.write(realTarball);
NODE
}

chmod 700 "$release_dir"
tarball="$(validate_snapshot)"
test "$tarball" = "$(cd "$release_dir" && pwd -P)/juststas-graph-mcp-0.6.1.tgz"
dry_run_file="$release_dir/npm-publish-dry-run.json"
trap 'rm -f "$dry_run_file"' EXIT
npm publish "$tarball" --dry-run --json --access public --tag latest --ignore-scripts \
  --registry https://registry.npmjs.org/ > "$dry_run_file"
chmod 600 "$dry_run_file"
node --input-type=module - "$release_dir/package-metadata.json" "$dry_run_file" <<'NODE'
import { readFile } from "node:fs/promises";

const metadata = JSON.parse(await readFile(process.argv[2], "utf8"));
const dryRun = JSON.parse(await readFile(process.argv[3], "utf8"));
const expected = {
  id: `${metadata.name}@${metadata.version}`,
  name: metadata.name,
  version: metadata.version,
  filename: metadata.filename,
  shasum: metadata.shasum,
  integrity: metadata.integrity,
};
for (const [key, value] of Object.entries(expected)) {
  if (dryRun[key] !== value) throw new Error(`npm dry-run ${key} mismatch`);
}
NODE
test "$(validate_snapshot)" = "$tarball"
npm publish "$tarball" --access public --tag latest --ignore-scripts \
  --registry https://registry.npmjs.org/
rm -f "$dry_run_file"
trap - EXIT
```

Expected: validation proves the private snapshot matches both recorded digests and npm's exact
JSON dry-run identity before any registry write. The user then completes npm's passkey/2FA
prompt, and npm reports `+ @juststas/graph-mcp@0.6.1` from that same snapshot. Stop without
publishing if any validation fails.

- [ ] **Step 3: Verify bootstrap bytes**

```bash
npm view @juststas/graph-mcp@0.6.1 version dist.integrity repository --json \
  --registry https://registry.npmjs.org/
node -e 'const fs=require("fs"); const path=require("path"); const cp=require("child_process"); const local=JSON.parse(fs.readFileSync(path.join(process.argv[1],"package-metadata.json"),"utf8")); const remote=JSON.parse(cp.execFileSync("npm",["view","@juststas/graph-mcp@0.6.1","version","dist.integrity","--json","--registry","https://registry.npmjs.org/"],{encoding:"utf8"})); if(remote.version!==local.version||remote["dist.integrity"]!==local.integrity) process.exit(1)' "$release_dir"
```

Expected: registry version and integrity match the GitHub-prepared artifact exactly.

- [ ] **Step 4: Reverify both existing tag rulesets before environment or npm trust**

```bash
bash <<'BASH'
set -euo pipefail

repository="repos/JustStas/Graph-MCP"
rulesets="$(gh api --paginate "$repository/rulesets" | jq -s 'add')"
authority_ruleset_id="$(jq -er '
  [.[] | select(.name == "Release tag administrator authority")] |
  if length == 1 then .[0].id else error("expected exactly one authority ruleset") end
' <<<"$rulesets")"
immutability_ruleset_id="$(jq -er '
  [.[] | select(.name == "Release tag immutability")] |
  if length == 1 then .[0].id else error("expected exactly one immutability ruleset") end
' <<<"$rulesets")"

gh api "$repository/rulesets/$authority_ruleset_id" | jq -e '
  .name == "Release tag administrator authority" and
  .target == "tag" and
  .enforcement == "active" and
  .conditions.ref_name.include == ["refs/tags/v*"] and
  .conditions.ref_name.exclude == [] and
  ([.bypass_actors[] | {actor_id, actor_type, bypass_mode}] == [
    {actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always"}
  ]) and
  (([.rules[].type] | sort) == ["creation", "deletion", "non_fast_forward", "update"])
'

gh api "$repository/rulesets/$immutability_ruleset_id" | jq -e '
  .name == "Release tag immutability" and
  .target == "tag" and
  .enforcement == "active" and
  .conditions.ref_name.include == ["refs/tags/v*"] and
  .conditions.ref_name.exclude == [] and
  .bypass_actors == [] and
  (([.rules[].type] | sort) == ["deletion", "non_fast_forward", "update"])
'
BASH
```

Expected: both exact checks exit 0. Stop before creating the environment or npm trust if either
ruleset is missing, duplicated, disabled, renamed, or has different conditions, bypasses, or
rules. Task 8 never creates or repairs tag rulesets.

- [ ] **Step 5: Create the GitHub npm environment with custom deployment policies**

```bash
gh api --method PUT repos/JustStas/Graph-MCP/environments/npm --input - <<'JSON'
{
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
JSON
```

Expected: GitHub returns environment name npm with custom_branch_policies true and
protected_branches false. Both tag rulesets must already be active.

- [ ] **Step 6: Create separate typed branch and tag deployment policies**

```bash
gh api --method POST repos/JustStas/Graph-MCP/environments/npm/deployment-branch-policies \
  -f type=branch \
  -f name=main
gh api --method POST repos/JustStas/Graph-MCP/environments/npm/deployment-branch-policies \
  -f type=tag \
  -f 'name=v*'
```

Expected: GitHub creates one policy with type branch and name main, and a separate policy
with type tag and name v*. Do not replace these with two untyped patterns: GitHub matches
branch and tag policy types separately against GITHUB_REF.

- [ ] **Step 7: Verify the environment and both typed policies before npm trust**

```bash
gh api repos/JustStas/Graph-MCP/environments/npm \
  --jq '{name, deployment_branch_policy}'
policies="$(gh api --paginate \
  repos/JustStas/Graph-MCP/environments/npm/deployment-branch-policies \
  --jq '.branch_policies[] | [.type, .name] | @tsv' | sort)"
test "$policies" = $'branch\tmain\ntag\tv*'
```

Expected: npm uses custom deployment policies, and the exact sorted policy set is branch
main plus tag v*. A required reviewer is optional operational hardening and is not created by
this plan.

- [ ] **Step 8: Configure and verify npm Trusted Publishing**

```bash
npx --yes npm@11.15.0 trust github @juststas/graph-mcp --file publish.yml --repo JustStas/Graph-MCP --env npm --allow-publish
npx --yes npm@11.15.0 trust list @juststas/graph-mcp --json
```

Expected: the user completes npm 2FA if prompted. The saved relationship identifies GitHub, JustStas/Graph-MCP, publish.yml, environment npm, and publish permission.

- [ ] **Step 9: Disable traditional publish tokens**

Open @juststas/graph-mcp package settings on npm, select “Require two-factor authentication and disallow tokens,” save it, and complete the passkey prompt. Verify the setting remains selected after reload.

This browser action requires the user's active npm session and 2FA confirmation.

- [ ] **Step 10: Create the GitHub Release**

```bash
gh release create v0.6.1 --repo JustStas/Graph-MCP --title "Graph MCP v0.6.1" --notes "First public npm release under @juststas/graph-mcp.

- Keeps the graph-mcp executable and Claude/Codex plugin names.
- Adds tokenless npm Trusted Publishing for future releases.
- Adds integrity-safe GitHub Release automation.

Version 0.6.1 is the manual package bootstrap and does not have provenance. OIDC provenance begins with 0.6.2."
```

- [ ] **Step 11: Watch the release workflow**

```bash
release_run_id="$(gh run list --repo JustStas/Graph-MCP --workflow publish.yml --event release \
  --limit 1 --json databaseId --jq '.[0].databaseId')"
test -n "$release_run_id"
gh run watch --repo JustStas/Graph-MCP "$release_run_id"
```

Expected: package passes; publish reports an integrity-matched already-published no-op; the
workflow succeeds without an npm token. Because no new npm publish occurs, this run does not
exercise the OIDC exchange.

- [ ] **Step 12: Verify a clean registry installation**

```bash
install_root="$(mktemp -d)"
npm install --global --prefix "$install_root" @juststas/graph-mcp@0.6.1
"$install_root/bin/graph-mcp" --version
"$install_root/bin/graph-mcp" --help
```

Expected: version output is 0.6.1 and help starts with Graph MCP 0.6.1.

- [ ] **Step 13: Verify the installed MCP server exposes 44 tools**

Run this from the repository, where @modelcontextprotocol/sdk is installed:

```bash
GRAPH_MCP_BIN="$install_root/bin/graph-mcp" node --input-type=module -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: process.env.GRAPH_MCP_BIN,
  env: { ...process.env, HOME: process.env.TMPDIR || "/tmp" },
});
const client = new Client({ name: "registry-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const version = client.getServerVersion();
  const tools = await client.listTools();
  if (version?.name !== "Graph MCP" || version.version !== "0.6.1") process.exitCode = 1;
  if (tools.tools.length !== 44) process.exitCode = 1;
  console.log("NPM_REGISTRY_INSTALL_OK", tools.tools.length);
} finally {
  await client.close();
}
'
```

Expected:

```text
NPM_REGISTRY_INSTALL_OK 44
```

- [ ] **Step 14: Record the provenance boundary**

Verify the npm package page does not claim OIDC provenance for 0.6.1, and verify the saved
trusted-publisher identity fields for future versions. Do not attempt to republish 0.6.1. The
0.6.1 no-op cannot validate OIDC authentication. Version 0.6.2 must be checked for both a real
OIDC publish and provenance.

- [ ] **Step 15: Final repository and release verification**

```bash
git status --short --branch
gh release view v0.6.1 --repo JustStas/Graph-MCP --json tagName,name,isDraft,isPrerelease,publishedAt,url
npm view @juststas/graph-mcp@0.6.1 version dist-tags dist.integrity repository --json
```

Expected: main is clean, the GitHub Release is published, latest points to 0.6.1, and registry integrity remains unchanged.

```

```
