import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

test("installs the plugin through Claude and Codex local marketplaces", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/test-plugin-install.mjs"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });

  expect(stdout).toContain("CLAUDE_PLUGIN_INSTALL_OK 44");
  expect(stdout).toContain("CODEX_PLUGIN_INSTALL_OK 44");
});
