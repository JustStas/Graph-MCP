import { builtinModules } from "node:module";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

import { build } from "esbuild";

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

await mkdir("plugins/graph-mcp/dist", { recursive: true });
await copyFile("dist/cli.js", "plugins/graph-mcp/dist/graph-mcp.js");
const pluginBundle = await readFile("plugins/graph-mcp/dist/graph-mcp.js", "utf8");
await writeFile("plugins/graph-mcp/dist/graph-mcp.js", pluginBundle.replace(/[ \t]+$/gm, ""));
await chmod("plugins/graph-mcp/dist/graph-mcp.js", 0o755);
await copyFile("LICENSE", "plugins/graph-mcp/LICENSE");
