import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "vscode",
    "@xenova/transformers",
    "puppeteer",
    // Native modules — keep as external to avoid require() in ESM
    "better-sqlite3",
    "node:fs",
    "node:path",
    "node:os",
    "node:crypto",
    "node:stream",
    "node:events",
    "node:util",
    "node:child_process",
    "node:readline",
  ],
  noExternal: [],
  treeshake: true,
  target: "node18",
})
