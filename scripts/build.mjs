import { builtinModules } from "node:module";
import { chmod } from "node:fs/promises";

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
