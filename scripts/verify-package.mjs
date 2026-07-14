import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_FILES = ["dist/cli.js", "README.md", "LICENSE", "package.json"];

/** @typedef {(file: string) => boolean} FileMatcher */
/** @typedef {{ label: string, matches: FileMatcher }} ForbiddenRule */
/** @typedef {{ path: string }} PackFile */
/** @typedef {{ files: PackFile[] }} PackResult */

/** @type {ForbiddenRule[]} */
const FORBIDDEN_RULES = [
  {
    label: "Python source or test file",
    matches: (file) => file.endsWith(".py"),
  },
  {
    label: "legacy Python source tree",
    matches: (file) => /^src\/graph_mcp(?:\/|$)/i.test(file),
  },
  {
    label: "runtime secret or configuration file",
    matches: (file) =>
      /(^|\/)(?:config(?:\.[^/]*)?|tokens?(?:[-_.][^/]*)?|.*(?:secret|credential|private)[^/]*|\.key(?:[-_.][^/]*)?)(?:$|\/)/i.test(
        file,
      ),
  },
  {
    label: "plugin or cache artifact",
    matches: (file) =>
      /(^|\/)(?:plugins?|node_modules|\.cache|cache|coverage|\.codex|\.claude)(?:\/|$)/i.test(file),
  },
];

async function packageFiles() {
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--dry-run"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 2_000_000,
  });
  // JSON.parse is typed as any by the Node runtime declarations.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = /** @type {PackResult[]} */ (JSON.parse(stdout));
  if (!Array.isArray(result)) {
    throw new Error("npm pack returned an unexpected JSON shape.");
  }
  return result.flatMap((pack) => {
    if (!pack || !Array.isArray(pack.files)) {
      throw new Error("npm pack returned a result without a files list.");
    }
    return pack.files.map((file) => file.path);
  });
}

try {
  const files = await packageFiles();
  const violations = [];

  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) {
      violations.push(`missing required file: ${required}`);
    }
  }
  for (const file of files) {
    for (const rule of FORBIDDEN_RULES) {
      if (rule.matches(file)) {
        violations.push(`${rule.label}: ${file}`);
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write("npm package verification failed:\n");
    for (const violation of violations) {
      process.stderr.write(`- ${violation}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(`npm package verification passed (${files.length} files).\n`);
  }
} catch (error) {
  process.stderr.write(
    `npm package verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
