/**
 * Resolve tree-sitter WASM paths from installed npm packages (`tree-sitter-wasms`, `web-tree-sitter`).
 * Uses `__dirname` (not `import.meta.url`) so the same source typechecks under CommonJS + ESM builds.
 */
import * as path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(path.join(__dirname, "wasm-paths.js"))

export function getTreeSitterLanguageWasmsDir(): string {
  return path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out")
}

export function getWebTreeSitterWasmPath(): string {
  return path.join(path.dirname(require.resolve("web-tree-sitter/package.json")), "tree-sitter.wasm")
}
