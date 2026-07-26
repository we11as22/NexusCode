import * as esbuild from "esbuild"
import * as path from "path"
import * as fs from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes("--watch")
const require = createRequire(import.meta.url)

async function copyTreeSitterRuntime() {
  const outputDir = path.join(__dirname, "dist", "tree-sitter")
  const querySourceDir = path.join(
    __dirname,
    "src",
    "services",
    "autocomplete",
    "continuedev",
    "tree-sitter",
  )
  const webTreeSitterDir = path.dirname(require.resolve("web-tree-sitter"))
  const languagePackage = require.resolve("tree-sitter-wasms/package.json")
  const languageDir = path.join(path.dirname(languagePackage), "out")
  await fs.mkdir(outputDir, { recursive: true })
  await fs.copyFile(
    path.join(webTreeSitterDir, "tree-sitter.wasm"),
    path.join(outputDir, "tree-sitter.wasm"),
  )
  await fs.cp(languageDir, path.join(outputDir, "languages"), {
    recursive: true,
    force: true,
  })
  await fs.cp(querySourceDir, path.join(outputDir, "queries"), {
    recursive: true,
    force: true,
  })
}

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: [
    "vscode",
    "@xenova/transformers",
  ],
  plugins: [
    {
      name: "resolve-core-workspace",
      setup(build) {
        build.onResolve({ filter: /^@nexuscode\/core$/ }, () => ({
          path: path.join(__dirname, "..", "core", "src", "index.ts"),
        }))
      },
    },
  ],
  format: "cjs",
  platform: "node",
  target: "node20",
  // Production VSIX packages must not ship the full extension source map.
  // Keep maps only for the local watch/debug loop.
  sourcemap: watch,
  minify: !watch,
  loader: { ".md": "text", ".txt": "text" },
})

if (watch) {
  await copyTreeSitterRuntime()
  await ctx.watch()
  console.log("Watching for changes...")
} else {
  await ctx.rebuild()
  await copyTreeSitterRuntime()
  await ctx.dispose()
  console.log("Extension built.")
}
