import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("package metadata", () => {
  test("publishes an ESM Node 22 CLI as graph-mcp", async () => {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const pkg: unknown = JSON.parse(await readFile(packageJsonUrl, "utf8"));
    expect(pkg).toMatchObject({
      name: "graph-mcp",
      version: "0.6.0",
      type: "module",
      bin: { "graph-mcp": "./dist/cli.js" },
      engines: { node: ">=22" },
    });
  });
});
