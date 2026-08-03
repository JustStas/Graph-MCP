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
const READBACK_ATTEMPTS = 6;
const READBACK_DELAY_MS = 2_000;
const READBACK_DELAY_CAP_MS = 30_000;
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

const PUBLISH_REPORT_LIMIT = 600;

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

/**
 * npm can exit zero without the version reaching the registry, and its own explanation is
 * only on stdout or stderr. Keep a bounded copy so a readback failure can report it instead
 * of leaving the operator with no reason at all.
 *
 * @param {{ stdout?: unknown, stderr?: unknown }} result @returns {string}
 */
function publishReport(result) {
  const parts = [result.stdout, result.stderr]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  const combined = parts.join(" | ").replaceAll(/\s+/gu, " ");
  if (combined.length === 0) {
    return "no output.";
  }
  return combined.length > PUBLISH_REPORT_LIMIT
    ? combined.slice(0, PUBLISH_REPORT_LIMIT) + "..."
    : combined;
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

/**
 * npm 10 prints the dry-run manifest as a flat object, while npm 11 nests it under the
 * package name. Accept either shape so the publish job keeps validating the same fields
 * whichever OIDC-capable npm the runner provides.
 *
 * @param {Record<string, unknown>} result @param {string} name
 * @returns {Record<string, unknown>}
 */
function unwrapDryRunManifest(result, name) {
  if (!Object.hasOwn(result, name)) {
    return result;
  }
  return requireRecord(result[name], "npm publish dry-run " + name + " manifest");
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
  const result = requireRecord(parsed, "npm publish dry-run result");
  const manifest = unwrapDryRunManifest(result, metadata.name);
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
 * npm's registry is read-through and eventually consistent, so a freshly published version can
 * take tens of seconds to become visible. Back off exponentially rather than declaring failure
 * after a few seconds: a successful publish followed by an impatient readback reports a release
 * as broken when it actually shipped.
 *
 * @param {number} attempt The 1-based attempt that just failed.
 * @returns {number} Milliseconds to wait before the next attempt.
 */
function readbackDelayMs(attempt) {
  return Math.min(READBACK_DELAY_MS * 2 ** (attempt - 1), READBACK_DELAY_CAP_MS);
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
      await wait(readbackDelayMs(attempt));
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
  const remote = await readRegistryMetadata(metadata.name, metadata.version, runFile);
  const state = classifyRegistryState(remote, metadata);
  if (state === "already-published") {
    return publishedResult(metadata, state);
  }
  const snapshot = await createPrivateSnapshot(tarballBytes);
  try {
    const { stdout: dryRunStdout } = await runFile("npm", publishArguments(snapshot.path, true), {
      encoding: "utf8",
      maxBuffer: 2_000_000,
    });
    validateDryRunManifest(dryRunStdout, metadata);
    /** @type {Error | undefined} */
    let publishError;
    /** @type {string} */
    let publishOutput = "";
    try {
      const published = await runFile("npm", publishArguments(snapshot.path, false), {
        encoding: "utf8",
        maxBuffer: 2_000_000,
      });
      publishOutput = publishReport(published);
    } catch (error) {
      publishError = error instanceof Error ? error : new Error(String(error));
    }

    try {
      await pollForPublishedMetadata(metadata, runFile, wait);
    } catch (error) {
      if (publishError !== undefined && error instanceof RegistryReadbackExhaustedError) {
        throw publishError;
      }
      if (error instanceof RegistryReadbackExhaustedError) {
        throw new Error(error.message + " npm publish reported: " + publishOutput);
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
