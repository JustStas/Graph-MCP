import { builtinModules } from "node:module";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import process from "node:process";

import { build } from "esbuild";
import { verifyPluginVersions } from "./verify-plugin-versions.mjs";

await verifyPluginVersions();

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node:*", ...builtinModules, ...builtinModules.map((moduleName) => `${moduleName}/*`)],
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
await chmod("dist/cli.js", 0o755);

if (process.env.GRAPH_MCP_SKIP_PLUGIN_SYNC !== "1") {
  await mkdir("plugins/graph-mcp/dist", { recursive: true });
  await copyFile("dist/cli.js", "plugins/graph-mcp/dist/graph-mcp.js");
  await chmod("plugins/graph-mcp/dist/graph-mcp.js", 0o755);
  await copyFile("dist/cli.js.map", "plugins/graph-mcp/dist/cli.js.map");
  await copyFile("LICENSE", "plugins/graph-mcp/LICENSE");
}
