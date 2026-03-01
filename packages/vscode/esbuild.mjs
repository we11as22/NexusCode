import * as esbuild from "esbuild"
import * as path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes("--watch")

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
  target: "node18",
  sourcemap: true,
  minify: !watch,
  loader: { ".md": "text", ".txt": "text" },
})

if (watch) {
  await ctx.watch()
  console.log("Watching for changes...")
} else {
  await ctx.rebuild()
  await ctx.dispose()
  console.log("Extension built.")
}
