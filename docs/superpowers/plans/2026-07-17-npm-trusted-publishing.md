# Graph MCP npm Trusted Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Publish Graph MCP as @juststas/graph-mcp@0.6.1 and establish a least-privilege GitHub Release workflow that publishes later versions through npm Trusted Publishing.

**Architecture:** Keep package construction and verification in an unprivileged GitHub Actions job, transfer only the prepared tarball plus release metadata, and grant OIDC permission only to a separate publish job bound to the npm GitHub environment. The first scoped version is published interactively with 2FA because npm requires the package to exist before trust can be configured; automated OIDC publishing and provenance begin with 0.6.2.

**Tech Stack:** Node.js 24 in GitHub Actions, TypeScript, Vitest, npm 11.15+ for trust management, GitHub Actions, npm Trusted Publishing (OIDC), GitHub CLI.

---

## File Map

**Create**

- .github/workflows/publish.yml — release and recovery workflow, job permissions, artifact transfer, and OIDC publication.
- scripts/release-package.mjs — deterministic package metadata validation, tarball preparation, registry-integrity comparison, and idempotent publication.
- tests/release-package.test.ts — unit contract for release metadata and registry decisions.
- tests/release-workflow.test.ts — static security and behavior contract for publish.yml.

**Modify**

- package.json — scoped package name, 0.6.1, normalized bin/repository fields, and public publish configuration.
- package-lock.json — synchronized root package identity and version.
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

- [ ] **Step 1: Write failing release-package tests**

Create tests/release-package.test.ts:

```typescript
import { describe, expect, test } from "vitest";

import {
  classifyRegistryState,
  validatePackResult,
  validateReleaseIdentity,
} from "../scripts/release-package.mjs";

const packageJson = {
  name: "@juststas/graph-mcp",
  version: "0.6.1",
  repository: {
    type: "git",
    url: "git+https://github.com/JustStas/Graph-MCP.git",
  },
  publishConfig: { access: "public" },
};

const localMetadata = {
  name: "@juststas/graph-mcp",
  version: "0.6.1",
  tag: "v0.6.1",
  filename: "juststas-graph-mcp-0.6.1.tgz",
  integrity: "sha512-local",
  shasum: "0123456789012345678901234567890123456789",
};

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
    [packageJson, "0.6.1", "release tag"],
    [{ ...packageJson, publishConfig: {} }, "v0.6.1", "public"],
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

  test("publishes only when the version is absent", () => {
    expect(classifyRegistryState(undefined, localMetadata)).toBe("publish");
  });

  test("treats matching immutable bytes as an idempotent success", () => {
    expect(
      classifyRegistryState({ version: "0.6.1", integrity: "sha512-local" }, localMetadata),
    ).toBe("already-published");
  });

  test("rejects an existing version with different bytes", () => {
    expect(() =>
      classifyRegistryState({ version: "0.6.1", integrity: "sha512-other" }, localMetadata),
    ).toThrow("different integrity");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```bash
npx vitest run tests/release-package.test.ts
```

Expected: FAIL because scripts/release-package.mjs does not exist.

- [ ] **Step 3: Implement release-package.mjs**

Create scripts/release-package.mjs:

```javascript
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXPECTED_NAME = "@juststas/graph-mcp";
const EXPECTED_REPOSITORY = "git+https://github.com/JustStas/Graph-MCP.git";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** @typedef {{ name: string, version: string, tag: string }} ReleaseIdentity */
/** @typedef {ReleaseIdentity & { filename: string, integrity: string, shasum: string }} PackageMetadata */
/** @typedef {{ version: string, integrity: string }} RegistryMetadata */

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
  if (!/^sha512-\S+$/.test(integrity)) {
    throw new Error("packed integrity must be a sha512 value.");
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

/** @param {unknown} error */
function isNpmNotFound(error) {
  return (
    isRecord(error) &&
    typeof error.stderr === "string" &&
    /(?:\bE404\b|404 Not Found)/.test(error.stderr)
  );
}

/** @param {string} name @param {string} version @returns {Promise<RegistryMetadata | undefined>} */
async function readRegistryMetadata(name, version) {
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["view", name + "@" + version, "version", "dist.integrity", "--json"],
      { encoding: "utf8", maxBuffer: 2_000_000 },
    );
    return parseRegistryMetadata(stdout);
  } catch (error) {
    if (isNpmNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

/** @param {string} tag @param {string} outputDirectory */
async function prepare(tag, outputDirectory) {
  /** @type {unknown} */
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const identity = validateReleaseIdentity(packageJson, tag);
  await execFileAsync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", output], {
    encoding: "utf8",
    maxBuffer: 2_000_000,
  });
  /** @type {unknown} */
  const packResult = JSON.parse(stdout);
  const metadata = validatePackResult(packResult, identity);
  await writeFile(
    join(output, "package-metadata.json"),
    JSON.stringify(metadata, null, 2) + "\n",
    "utf8",
  );
  await copyFile(fileURLToPath(import.meta.url), join(output, "release-package.mjs"));
  process.stdout.write(JSON.stringify(metadata, null, 2) + "\n");
}

/** @param {string} metadataPath */
async function publish(metadataPath) {
  const resolvedMetadata = resolve(metadataPath);
  /** @type {unknown} */
  const parsedMetadata = JSON.parse(await readFile(resolvedMetadata, "utf8"));
  const metadata = validateArtifactMetadata(parsedMetadata);
  const tarball = resolve(dirname(resolvedMetadata), metadata.filename);
  if (dirname(tarball) !== dirname(resolvedMetadata)) {
    throw new Error("tarball escaped the metadata directory.");
  }
  await stat(tarball);
  const remote = await readRegistryMetadata(metadata.name, metadata.version);
  const state = classifyRegistryState(remote, metadata);
  if (state === "publish") {
    await execFileAsync("npm", ["publish", tarball, "--access", "public"], {
      encoding: "utf8",
      maxBuffer: 2_000_000,
    });
  }
  const finalMetadata = await readRegistryMetadata(metadata.name, metadata.version);
  if (finalMetadata === undefined) {
    throw new Error("published package could not be read back from npm.");
  }
  classifyRegistryState(finalMetadata, metadata);
  process.stdout.write(
    JSON.stringify({ state, version: metadata.version, integrity: metadata.integrity }) + "\n",
  );
}

/** @param {readonly string[]} args */
async function main(args) {
  const [command, first, second] = args;
  if (command === "prepare" && first !== undefined && second !== undefined) {
    await prepare(first, second);
    return;
  }
  if (command === "publish" && first !== undefined && second === undefined) {
    await publish(first);
    return;
  }
  throw new Error(
    "Usage: release-package.mjs prepare <tag> <output-directory> | publish <metadata-json>",
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

- [ ] **Step 4: Run release-package tests**

Run:

```bash
npx vitest run tests/release-package.test.ts
```

Expected: all release-package tests PASS.

- [ ] **Step 5: Commit the release package logic**

```bash
git add scripts/release-package.mjs tests/release-package.test.ts
git commit -m "feat: add deterministic npm release packaging"
```

## Task 3: Add the least-privilege GitHub Actions workflow

**Files:**

- Create: tests/release-workflow.test.ts
- Create: .github/workflows/publish.yml

- [ ] **Step 1: Write the failing workflow contract test**

Create tests/release-workflow.test.ts:

```typescript
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const workflowUrl = new URL("../.github/workflows/publish.yml", import.meta.url);
const pinnedActions = [
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
];

function jobBlock(workflow: string, name: "package" | "publish"): string {
  const startMarker = "  " + name + ":\n";
  const start = workflow.indexOf(startMarker);
  if (start < 0) {
    throw new Error("Missing workflow job: " + name);
  }
  const end = name === "package" ? workflow.indexOf("\n  publish:\n", start) : workflow.length;
  if (end < 0) {
    throw new Error("Missing publish job boundary.");
  }
  return workflow.slice(start, end);
}

describe("npm publish workflow", () => {
  test("uses release and controlled manual triggers", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    expect(workflow).toContain("types: [published]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("prepare_only:");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  test("pins every external action to an audited full SHA", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    for (const action of pinnedActions) {
      expect(workflow).toContain(action);
    }
    const references = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)];
    expect(references.length).toBeGreaterThanOrEqual(5);
    expect(references.every((match) => /^[a-f0-9]{40}$/.test(match[1] ?? ""))).toBe(true);
  });

  test("keeps OIDC out of package construction", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const packageJob = jobBlock(workflow, "package");
    expect(packageJob).not.toContain("id-token: write");
    expect(packageJob).toContain("package-manager-cache: false");
    expect(packageJob).toContain("node-version: 24");
    expect(packageJob).toContain("npm ci");
    expect(packageJob).toContain("npm run verify");
    expect(packageJob).toContain("release-package.mjs prepare");
  });

  test("grants OIDC only to the artifact-only publish job", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const publishJob = jobBlock(workflow, "publish");
    expect(publishJob.match(/id-token: write/g)).toHaveLength(1);
    expect(publishJob).toContain("environment: npm");
    expect(publishJob).toContain("needs: package");
    expect(publishJob).toContain("release-package.mjs publish");
    expect(publishJob).not.toContain("actions/checkout@");
    expect(publishJob).not.toContain("npm ci");
    expect(publishJob).not.toContain("npm run verify");
  });

  test("contains no long-lived npm credential", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
  });
});
```

- [ ] **Step 2: Run the workflow test and confirm it fails**

Run:

```bash
npx vitest run tests/release-workflow.test.ts
```

Expected: FAIL with ENOENT for .github/workflows/publish.yml.

- [ ] **Step 3: Create publish.yml**

Create .github/workflows/publish.yml with this structure and exact action pins:

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
          if [[ -z "$RELEASE_TAG" ]]; then
            echo "Release tag is required." >&2
            exit 1
          fi
          echo "tag=$RELEASE_TAG" >> "$GITHUB_OUTPUT"

      - name: Check out release tag
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          ref: ${{ steps.release.outputs.tag }}
          fetch-depth: 0

      - name: Fetch main ancestry
        run: git fetch --no-tags origin main:refs/remotes/origin/main

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
          node -e 'const [a,b]=process.argv[1].split(".").map(Number); if(a<11||(a===11&&b<5)) process.exit(1)' "$npm_version"

      - name: Install locked dependencies
        run: npm ci

      - name: Verify source and package
        run: npm run verify

      - name: Prepare release tarball
        run: node scripts/release-package.mjs prepare "$RELEASE_TAG" release

      - name: Read artifact name
        id: metadata
        shell: bash
        run: |
          version="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync("release/package-metadata.json","utf8")).version)')"
          echo "artifact_name=npm-package-$version" >> "$GITHUB_OUTPUT"

      - name: Upload release tarball
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: ${{ steps.metadata.outputs.artifact_name }}
          path: release/
          if-no-files-found: error
          retention-days: 1

  publish:
    if: ${{ github.event_name == 'release' || inputs.prepare_only != true }}
    needs: package
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: npm
    permissions:
      actions: read
      contents: read
      id-token: write
    steps:
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
          node -e 'const [a,b]=process.argv[1].split(".").map(Number); if(a<11||(a===11&&b<5)) process.exit(1)' "$npm_version"

      - name: Download release tarball
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: ${{ needs.package.outputs.artifact_name }}
          path: release

      - name: Publish or verify immutable version
        run: node release/release-package.mjs publish release/package-metadata.json
```

- [ ] **Step 4: Run workflow contract and formatting checks**

Run:

```bash
npx vitest run tests/release-workflow.test.ts
npx prettier --check .github/workflows/publish.yml tests/release-workflow.test.ts
```

Expected: all workflow tests PASS and Prettier reports both files formatted.

- [ ] **Step 5: Verify every action pin against GitHub**

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

- [ ] **Step 6: Commit the workflow**

```bash
git add .github/workflows/publish.yml tests/release-workflow.test.ts
git commit -m "ci: add npm trusted publishing workflow"
```

## Task 4: Document scoped installation and release operations

**Files:**

- Modify: tests/project-metadata.test.ts
- Modify: README.md
- Modify: CHANGELOG.md

- [ ] **Step 1: Add a failing README contract**

Add this test to tests/project-metadata.test.ts:

```typescript
test("documents the scoped package while preserving the graph-mcp command", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  expect(readme).toContain("npm install --global @juststas/graph-mcp");
  expect(readme).toContain("graph-mcp setup");
  expect(readme).toContain("release: types: [published]");
  expect(readme).toContain("0.6.1");
  expect(readme).toContain("provenance starts with 0.6.2");
  expect(readme).not.toMatch(/npm install --global graph-mcp(?:\s|$)/);
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

Graph MCP is published to npm as the public package @juststas/graph-mcp. There is no
Python/PyPI release step.

#### Normal releases

1. Update package.json, package-lock.json, both plugin manifests, runtime metadata,
   CHANGELOG.md, and the committed plugin bundle to one version.
2. Run npm ci, npm run verify, node scripts/test-plugin-install.mjs, and
   npm pack --json --dry-run from a clean worktree.
3. Merge the reviewed pull request to main and create an annotated v<version> tag on the
   merged commit.
4. Publish the matching GitHub Release. The trusted workflow uses
   release: types: [published].
5. The package job installs locked dependencies, runs all verification, and prepares the
   exact tarball without OIDC permission.
6. The publish job runs in the npm GitHub environment, receives only the prepared artifact,
   and uses npm Trusted Publishing. It has no NODE_AUTH_TOKEN or npm secret.
7. Verify the workflow, npm version, dist.integrity, installed CLI version, and 44-tool MCP
   inventory.

Workflow reruns are idempotent. If the version already exists, the workflow succeeds only
when npm's dist.integrity equals the prepared tarball. A different integrity fails and
requires a new patch version.

#### First scoped-package bootstrap

npm requires a package to exist before Trusted Publishing can be configured. Version 0.6.1
is therefore prepared by publish.yml with prepare_only enabled and published once with the
maintainer's interactive 2FA. Configure trust afterward:

```bash
npx --yes npm@11.15.0 trust github @juststas/graph-mcp \
  --file publish.yml \
  --repo JustStas/Graph-MCP \
  --env npm \
  --allow-publish
```

Verify the saved repository, workflow filename, environment, and publish permission, then
set npm publishing access to require 2FA and disallow traditional tokens.

The manual 0.6.1 bootstrap has no provenance, and its integrity-matched release workflow is
a no-op that does not test the OIDC exchange. The first real OIDC publish and provenance
check occur with 0.6.2.

#### Recovery

Use workflow_dispatch with an existing tag to rerun publication. Use prepare_only when only
the verified tarball is needed. Never move a published tag or overwrite an npm version; use
a new patch release after a bad publication.
````

- [ ] **Step 5: Add the 0.6.1 changelog entry**

Insert above 0.6.0:

```markdown
## 0.6.1 - 2026-07-17

### Changed

- Published the npm distribution as @juststas/graph-mcp while preserving the graph-mcp
  executable and Claude/Codex plugin names.
- Normalized npm bin and repository metadata and synchronized all runtime and plugin versions.
- Updated installation and release documentation for the scoped package.

### Added

- A GitHub Release workflow with separate package and OIDC publish jobs, immutable action pins,
  disabled release caching, integrity-safe reruns, and a non-publishing bootstrap mode.
- npm Trusted Publishing setup for tokenless releases beginning after the manual 0.6.1
  bootstrap. OIDC-published versions beginning with 0.6.2 receive npm provenance.
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

## Task 7: Tag and prepare the exact bootstrap tarball

**Files:**

- Operate from: /Users/juststas/Documents/Graph MCP
- No source edits.

- [ ] **Step 1: Fast-forward merged main and verify it**

```bash
git switch main
git pull --ff-only origin main
npm ci
npm run verify
git status --short
```

Expected: verification passes and the main checkout is clean.

- [ ] **Step 2: Create and push v0.6.1**

First prove the tag is unused:

```bash
git ls-remote --exit-code --tags origin refs/tags/v0.6.1
```

Expected: exit 2 with no matching tag.

Then create it:

```bash
git tag -a v0.6.1 -m "Graph MCP v0.6.1"
git push origin v0.6.1
```

- [ ] **Step 3: Run prepare-only packaging on GitHub**

```bash
gh workflow run publish.yml --repo JustStas/Graph-MCP --ref main -f tag=v0.6.1 -f prepare_only=true
```

Find and watch the run:

```bash
gh run list --repo JustStas/Graph-MCP --workflow publish.yml --event workflow_dispatch --limit 1 --json databaseId,status,conclusion,headBranch
gh run watch --repo JustStas/Graph-MCP <run-id>
```

Expected: package succeeds, publish is skipped, and the run succeeds.

- [ ] **Step 4: Download and inspect the prepared artifact**

```bash
release_dir="$(mktemp -d)"
gh run download --repo JustStas/Graph-MCP <run-id> --name npm-package-0.6.1 --dir "$release_dir"
node -e 'const fs=require("fs"); const path=require("path"); const m=JSON.parse(fs.readFileSync(path.join(process.argv[1],"package-metadata.json"),"utf8")); if(m.name!=="@juststas/graph-mcp"||m.version!=="0.6.1"||m.tag!=="v0.6.1"||!m.integrity.startsWith("sha512-")) process.exit(1); console.log(JSON.stringify(m,null,2))' "$release_dir"
```

Expected: valid scoped metadata and one tarball whose filename equals the metadata filename.

## Task 8: Bootstrap npm trust, publish the GitHub Release, and verify deployment

**Files:**

- Use the downloaded release artifact from Task 7.
- No source edits.

- [ ] **Step 1: Confirm the package version is absent**

```bash
npm view @juststas/graph-mcp@0.6.1 version --json
```

Expected: npm E404. If the version exists, stop and compare its dist.integrity with package-metadata.json before any other action.

- [ ] **Step 2: Publish the exact prepared tarball with 2FA**

```bash
tarball="$(node -e 'const fs=require("fs"); const path=require("path"); const m=JSON.parse(fs.readFileSync(path.join(process.argv[1],"package-metadata.json"),"utf8")); process.stdout.write(path.join(process.argv[1],m.filename))' "$release_dir")"
npm publish "$tarball" --access public
```

Expected: the user completes npm's passkey/2FA prompt and npm reports + @juststas/graph-mcp@0.6.1.

- [ ] **Step 3: Verify bootstrap bytes**

```bash
npm view @juststas/graph-mcp@0.6.1 version dist.integrity repository --json
node -e 'const fs=require("fs"); const path=require("path"); const cp=require("child_process"); const local=JSON.parse(fs.readFileSync(path.join(process.argv[1],"package-metadata.json"),"utf8")); const remote=JSON.parse(cp.execFileSync("npm",["view","@juststas/graph-mcp@0.6.1","version","dist.integrity","--json"],{encoding:"utf8"})); if(remote.version!==local.version||remote["dist.integrity"]!==local.integrity) process.exit(1)' "$release_dir"
```

Expected: registry version and integrity match the GitHub-prepared artifact exactly.

- [ ] **Step 4: Create the GitHub npm environment**

```bash
gh api --method PUT repos/JustStas/Graph-MCP/environments/npm
```

Expected: GitHub returns environment name npm.

- [ ] **Step 5: Configure and verify npm Trusted Publishing**

```bash
npx --yes npm@11.15.0 trust github @juststas/graph-mcp --file publish.yml --repo JustStas/Graph-MCP --env npm --allow-publish
npx --yes npm@11.15.0 trust list @juststas/graph-mcp --json
```

Expected: the user completes npm 2FA if prompted. The saved relationship identifies GitHub, JustStas/Graph-MCP, publish.yml, environment npm, and publish permission.

- [ ] **Step 6: Disable traditional publish tokens**

Open @juststas/graph-mcp package settings on npm, select “Require two-factor authentication and disallow tokens,” save it, and complete the passkey prompt. Verify the setting remains selected after reload.

This browser action requires the user's active npm session and 2FA confirmation.

- [ ] **Step 7: Create the GitHub Release**

```bash
gh release create v0.6.1 --repo JustStas/Graph-MCP --title "Graph MCP v0.6.1" --notes "First public npm release under @juststas/graph-mcp.

- Keeps the graph-mcp executable and Claude/Codex plugin names.
- Adds tokenless npm Trusted Publishing for future releases.
- Adds integrity-safe GitHub Release automation.

Version 0.6.1 is the manual package bootstrap and does not have provenance. OIDC provenance begins with 0.6.2."
```

- [ ] **Step 8: Watch the release workflow**

```bash
gh run list --repo JustStas/Graph-MCP --workflow publish.yml --event release --limit 1 --json databaseId,status,conclusion,headBranch
gh run watch --repo JustStas/Graph-MCP <release-run-id>
```

Expected: package passes; publish reports an integrity-matched already-published no-op; the
workflow succeeds without an npm token. Because no new npm publish occurs, this run does not
exercise the OIDC exchange.

- [ ] **Step 9: Verify a clean registry installation**

```bash
install_root="$(mktemp -d)"
npm install --global --prefix "$install_root" @juststas/graph-mcp@0.6.1
"$install_root/bin/graph-mcp" --version
"$install_root/bin/graph-mcp" --help
```

Expected: version output is 0.6.1 and help starts with Graph MCP 0.6.1.

- [ ] **Step 10: Verify the installed MCP server exposes 44 tools**

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

- [ ] **Step 11: Record the provenance boundary**

Verify the npm package page does not claim OIDC provenance for 0.6.1, and verify the saved
trusted-publisher identity fields for future versions. Do not attempt to republish 0.6.1. The
0.6.1 no-op cannot validate OIDC authentication. Version 0.6.2 must be checked for both a real
OIDC publish and provenance.

- [ ] **Step 12: Final repository and release verification**

```bash
git status --short --branch
gh release view v0.6.1 --repo JustStas/Graph-MCP --json tagName,name,isDraft,isPrerelease,publishedAt,url
npm view @juststas/graph-mcp@0.6.1 version dist-tags dist.integrity repository --json
```

Expected: main is clean, the GitHub Release is published, latest points to 0.6.1, and registry integrity remains unchanged.

```

```
