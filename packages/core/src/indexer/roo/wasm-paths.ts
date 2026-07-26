/**
 * Resolve tree-sitter WASM paths from installed npm packages (`tree-sitter-wasms`, `web-tree-sitter`).
 * Uses `__dirname` (not `import.meta.url`) so the same source typechecks under CommonJS + ESM builds.
 */
import * as path from "node:path"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"

const moduleRequire = createRequire(path.join(__dirname, "wasm-paths.js"))

export function getTreeSitterLanguageWasmsDir(): string {
  const bundled = path.join(__dirname, "tree-sitter", "languages")
  if (existsSync(bundled)) return bundled
  return path.join(
    path.dirname(moduleRequire.resolve("tree-sitter-wasms/package.json")),
    "out",
  )
}

export function getWebTreeSitterWasmPath(): string {
  const bundled = path.join(__dirname, "tree-sitter", "tree-sitter.wasm")
  if (existsSync(bundled)) return bundled
  // `web-tree-sitter` 0.25+ does not export `./package.json`; resolving the
  // public CommonJS entry lands in the same package directory as the core WASM.
  return path.join(
    path.dirname(moduleRequire.resolve("web-tree-sitter")),
    "tree-sitter.wasm",
  )
}
