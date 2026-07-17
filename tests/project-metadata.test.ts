import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("package metadata", () => {
  test("publishes an ESM Node 22 CLI as graph-mcp", async () => {
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
});
