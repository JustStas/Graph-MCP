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

function nestedDryRunManifestJson(
  metadata: typeof localMetadata,
  overrides: Partial<typeof localMetadata & { id: string }> = {},
  key: string = metadata.name,
): string {
  return JSON.stringify({
    [key]: JSON.parse(dryRunManifestJson(metadata, overrides)) as unknown,
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

  test("rejects malformed npm publish dry-run JSON after registry absence", async () => {
    const artifact = await createReleaseArtifact();
    let registryCalls = 0;
    let actualPublishCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        return Promise.resolve({ stdout: "{not-json", stderr: "" });
      }
      if (args[0] === "view") {
        registryCalls += 1;
        return Promise.reject(missingVersionFailure(artifact.metadata.version));
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
    expect(registryCalls).toBe(1);
    expect(actualPublishCalls).toBe(0);
  });

  test.each([
    {
      label: "npm 11 nests the manifest under the package name",
      stdout: (metadata: typeof localMetadata) => nestedDryRunManifestJson(metadata),
    },
    {
      label: "npm 10 prints the manifest flat",
      stdout: (metadata: typeof localMetadata) => dryRunManifestJson(metadata),
    },
  ])("publishes when $label", async ({ stdout }) => {
    const artifact = await createReleaseArtifact();
    let viewCalls = 0;
    let actualPublishCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        return Promise.resolve({ stdout: stdout(artifact.metadata), stderr: "" });
      }
      if (args[0] === "view") {
        viewCalls += 1;
        if (viewCalls === 1) {
          return Promise.reject(missingVersionFailure(artifact.metadata.version));
        }
        return Promise.resolve({ stdout: registryMetadataJson(artifact.metadata), stderr: "" });
      }
      if (isActualPublish(args)) {
        actualPublishCalls += 1;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error("unexpected subprocess call"));
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
    expect(actualPublishCalls).toBe(1);
  });

  test("rejects a nested npm publish dry-run manifest that is not an object", async () => {
    const artifact = await createReleaseArtifact();
    let actualPublishCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        return Promise.resolve({
          stdout: JSON.stringify({ [artifact.metadata.name]: "not-a-manifest" }),
          stderr: "",
        });
      }
      if (args[0] === "view") {
        return Promise.reject(missingVersionFailure(artifact.metadata.version));
      }
      if (isActualPublish(args)) {
        actualPublishCalls += 1;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
    ).rejects.toThrow("manifest must be an object");
    expect(actualPublishCalls).toBe(0);
  });

  test("rejects a nested npm publish dry-run manifest whose fields mismatch", async () => {
    const artifact = await createReleaseArtifact();
    let actualPublishCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        return Promise.resolve({
          stdout: nestedDryRunManifestJson(artifact.metadata, { shasum: "0".repeat(40) }),
          stderr: "",
        });
      }
      if (args[0] === "view") {
        return Promise.reject(missingVersionFailure(artifact.metadata.version));
      }
      if (isActualPublish(args)) {
        actualPublishCalls += 1;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      return Promise.reject(new Error("unexpected subprocess call"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
    ).rejects.toThrow("shasum does not match package metadata");
    expect(actualPublishCalls).toBe(0);
  });

  test("rejects a non-object npm publish dry-run result after registry absence", async () => {
    const artifact = await createReleaseArtifact();
    let registryCalls = 0;
    let actualPublishCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        return Promise.resolve({ stdout: "[]", stderr: "" });
      }
      if (args[0] === "view") {
        registryCalls += 1;
        return Promise.reject(missingVersionFailure(artifact.metadata.version));
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
    expect(registryCalls).toBe(1);
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
    "rejects npm publish dry-run %s mismatch after registry absence",
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
          return Promise.reject(missingVersionFailure(artifact.metadata.version));
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
      expect(registryCalls).toBe(1);
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
        return Promise.reject(new Error("duplicate version dry run must not execute"));
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
    expect(viewCalls).toBe(1);
    expect(publishCalls).toBe(0);
    expect(dryRunCalls).toBe(0);
  });

  test("rejects an initial registry integrity mismatch before publication", async () => {
    const artifact = await createReleaseArtifact();
    const otherIntegrity =
      "sha512-" + createHash("sha512").update("different bytes").digest("base64");
    let dryRunCalls = 0;
    let viewCalls = 0;
    let publishCalls = 0;
    const execFile: ExecFileFunction = (file, args) => {
      if (isDryRunPublish(args)) {
        dryRunCalls += 1;
      }
      if (args[0] === "view") {
        viewCalls += 1;
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
      }
      return Promise.reject(new Error("publication must not execute"));
    };

    await expect(
      publishRelease(artifact.metadataPath, artifact.metadata.tag, { execFile }),
    ).rejects.toThrow("different integrity");
    expect(viewCalls).toBe(1);
    expect(dryRunCalls).toBe(0);
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
