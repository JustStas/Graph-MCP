import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await Promise.all(
  ["dist", "coverage"].map((directory) =>
    rm(resolve(rootDir, directory), { recursive: true, force: true }),
  ),
);
