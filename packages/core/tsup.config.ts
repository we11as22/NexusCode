import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "web-tree-sitter",
    "vscode",
    "puppeteer",
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
  target: "node24",
  // ESM bundles have no `__dirname`; wasm-paths uses createRequire(path.join(__dirname, ...)).
  esbuildOptions(options, { format }) {
    if (format === "esm") {
      options.banner = {
        js: `import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
`,
      }
    }
  },
})
