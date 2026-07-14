import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPaths = [
  "package.json",
  "plugins/graph-mcp/.claude-plugin/plugin.json",
  "plugins/graph-mcp/.codex-plugin/plugin.json",
];

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
async function readVersion(path) {
  /** @type {unknown} */
  const payload = JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
  if (!isRecord(payload) || typeof payload.version !== "string" || payload.version.length === 0) {
    throw new Error(`${path} does not contain a non-empty version.`);
  }
  return payload.version;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function verifyPluginVersions() {
  const versions = await Promise.all(
    manifestPaths.map(async (path) => ({ path, version: await readVersion(path) })),
  );
  const expectedVersion = versions[0]?.version;
  if (expectedVersion === undefined) {
    throw new Error("No package or plugin versions were found.");
  }
  const mismatches = versions.filter(({ version }) => version !== expectedVersion);

  if (mismatches.length > 0) {
    throw new Error(
      `Version mismatch: ${versions.map(({ path, version }) => `${path}=${version}`).join(", ")}`,
    );
  }

  return expectedVersion;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version = await verifyPluginVersions();
  process.stdout.write(`Plugin versions synchronized at ${version}\n`);
}
