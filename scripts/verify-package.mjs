import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_PATHS = Object.freeze([
  "LICENSE",
  "README.md",
  "dist/cli.js",
  "dist/cli.js.map",
  "package.json",
]);
const REQUIRED_PATH_SET = new Set(REQUIRED_PATHS);
const EXECUTABLE_MODE = 0o755;

/** @typedef {{ path: string, mode: number }} NormalizedPackFile */
/** @typedef {{ violations: string[], files: NormalizedPackFile[] }} ValidationReport */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is unknown[]}
 */
function isUnknownArray(value) {
  return Array.isArray(value);
}

/**
 * @param {string} value
 * @returns {{ path: string } | { error: string }}
 */
function normalizePackagePath(value) {
  if (value.length === 0) {
    return { error: "empty path" };
  }
  if (value.includes("\0")) {
    return { error: "NUL byte in path" };
  }

  let candidate = value.replaceAll("\\", "/");
  if (candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) {
    return { error: "absolute path" };
  }
  while (candidate.startsWith("./")) {
    candidate = candidate.slice(2);
  }
  if (candidate.length === 0) {
    return { error: "empty path" };
  }
  if (candidate.split("/").some((segment) => segment === "..")) {
    return { error: "path traversal" };
  }

  const normalized = posix.normalize(candidate);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    return { error: "path traversal" };
  }
  if (normalized.length === 0) {
    return { error: "empty path" };
  }
  return { path: normalized };
}

/** @param {string} value */
function hasForbiddenPath(value) {
  const segments = value.split("/");
  const hasPythonOrCache = segments.some(
    (segment) =>
      segment === "__pycache__" ||
      segment === ".pytest_cache" ||
      segment.toLowerCase().endsWith(".py") ||
      segment.toLowerCase().endsWith(".pyc"),
  );
  const hasLegacyPythonSource = value === "src/graph_mcp" || value.startsWith("src/graph_mcp/");
  const hasRuntimeSecret = segments.some(
    (segment) =>
      segment === ".env" ||
      segment.startsWith(".env.") ||
      /(?:access[-_]token|refresh[-_]token|authorization[-_]code|(?:pkce[-_]?|code[-_])verifier|encryption[-_]?key)/i.test(
        segment,
      ) ||
      /\.key$/i.test(segment) ||
      /(?:token|secret|credential|private|config)/i.test(segment),
  );
  const hasPluginOrCache = segments.some((segment) =>
    new Set([
      ".codex-plugin",
      ".claude-plugin",
      ".codex",
      ".claude",
      "plugin",
      "plugins",
      "cache",
      ".cache",
      "node_modules",
      "coverage",
    ]).has(segment.toLowerCase()),
  );

  return [
    hasPythonOrCache ? "forbidden Python/cache path" : undefined,
    hasLegacyPythonSource ? "forbidden legacy Python source path" : undefined,
    hasRuntimeSecret ? "forbidden runtime secret/config path" : undefined,
    hasPluginOrCache ? "forbidden plugin/cache path" : undefined,
  ].filter((value) => value !== undefined);
}

/**
 * Validate the parsed JSON returned by `npm pack --json --dry-run`.
 *
 * @param {unknown} input
 * @returns {ValidationReport}
 */
export function validatePackageResult(input) {
  const violations = [];
  /** @type {NormalizedPackFile[]} */
  const files = [];

  if (!isUnknownArray(input)) {
    violations.push("npm pack result must be an array.");
  } else {
    if (input.length !== 1) {
      violations.push(`npm pack result must contain exactly one result; found ${input.length}.`);
    }

    input.forEach((pack, resultIndex) => {
      if (!isRecord(pack)) {
        violations.push(`npm pack result ${resultIndex} must be an object.`);
        return;
      }
      const packFiles = pack.files;
      if (!isUnknownArray(packFiles)) {
        violations.push(`npm pack result ${resultIndex} files must be an array.`);
        return;
      }

      packFiles.forEach((file, fileIndex) => {
        const prefix = `file ${fileIndex} in result ${resultIndex}`;
        if (!isRecord(file)) {
          violations.push(`${prefix} must be an object.`);
          return;
        }

        if (typeof file.path !== "string") {
          violations.push(`${prefix} path must be a string.`);
        }
        const mode = file.mode;
        if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o777) {
          violations.push(`${prefix} mode must be an integer between 0 and 511.`);
        }
        if (typeof file.path !== "string") {
          return;
        }

        const normalized = normalizePackagePath(file.path);
        if ("error" in normalized) {
          violations.push(`${prefix} has an invalid path: ${normalized.error}.`);
          return;
        }
        files.push({
          path: normalized.path,
          mode: typeof mode === "number" ? mode : -1,
        });
      });
    });
  }

  const counts = new Map();
  for (const file of files) {
    counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
  }
  for (const [path, count] of counts) {
    if (count > 1) {
      violations.push(`duplicate normalized path: ${path}.`);
    }
  }

  for (const requiredPath of REQUIRED_PATHS) {
    if (!counts.has(requiredPath)) {
      violations.push(`missing required path: ${requiredPath}.`);
    }
  }

  for (const file of files) {
    if (!REQUIRED_PATH_SET.has(file.path)) {
      violations.push(`unexpected path: ${file.path}.`);
    }
    for (const reason of hasForbiddenPath(file.path)) {
      violations.push(`${reason}: ${file.path}.`);
    }
    if (file.path === "dist/cli.js" && file.mode !== EXECUTABLE_MODE) {
      violations.push(`dist/cli.js must have mode 0755; found ${file.mode}.`);
    }
  }

  return { violations, files };
}

/** @returns {Promise<unknown>} */
async function readNpmPackResult() {
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--dry-run"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 2_000_000,
  });
  // JSON.parse is typed as any by the Node runtime declarations.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return JSON.parse(stdout);
}

async function runVerifier() {
  /** @type {unknown} */
  let input;
  try {
    input = await readNpmPackResult();
  } catch {
    process.stderr.write("npm package verification failed: unable to read npm pack output.\n");
    return 1;
  }

  const report = validatePackageResult(input);
  if (report.violations.length > 0) {
    process.stderr.write("npm package verification failed:\n");
    for (const violation of report.violations) {
      process.stderr.write(`- ${violation}\n`);
    }
    return 1;
  }

  process.stdout.write(`npm package verification passed (${report.files.length} files).\n`);
  return 0;
}

function isDirectEntry() {
  const entry = process.argv[1];
  if (typeof entry !== "string") {
    return false;
  }

  let candidatePath;
  try {
    candidatePath = resolve(entry);
  } catch {
    return false;
  }

  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  const entryPath = realpathCandidateOrUndefined(candidatePath);
  return entryPath !== undefined && modulePath === entryPath;
}

/** @param {string} path */
function realpathCandidateOrUndefined(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" ||
          error.code === "EACCES" ||
          error.code === "ENOTDIR" ||
          error.code === "ERR_INVALID_ARG_TYPE"))
    ) {
      return undefined;
    }
    throw error;
  }
}

if (isDirectEntry()) {
  void runVerifier().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
