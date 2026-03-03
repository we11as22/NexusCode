import { z } from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  path: z.string().describe("File or directory to extract code definitions from"),
  task_progress: z.string().optional(),
})

export const listDefinitionsTool: ToolDef<z.infer<typeof schema>> = {
  name: "list_code_definitions",
  description: `List top-level code definitions (classes, functions, methods, interfaces, types) for a file or directory. No full bodies — structure only.

When to use:
- Understand file or module structure before reading or searching.
- Find where a symbol is defined (then use read_file or codebase_search for details).
- Quick overview of many files in a directory.

When NOT to use:
- Semantic search: use codebase_search.
- Exact pattern in content: use grep.
- Reading implementation: use read_file.

Supports: TS/JS, Python, Rust, Go, Java, C/C++. Returns path and line (e.g. "function foo (L42)").`,
  parameters: schema,
  readOnly: true,

  async execute({ path: targetPath }, ctx: ToolContext) {
    const absPath = path.resolve(ctx.cwd, targetPath)

    try {
      const stat = await fs.stat(absPath)
      if (stat.isDirectory()) {
        return extractFromDirectory(absPath, ctx.cwd)
      }
      return extractFromFile(absPath, ctx.cwd)
    } catch {
      return { success: false, output: `Path not found: ${targetPath}` }
    }
  },
}

async function extractFromFile(absPath: string, cwd: string): Promise<{ success: boolean; output: string }> {
  const relPath = path.relative(cwd, absPath)
  const ext = path.extname(absPath).toLowerCase()

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return { success: true, output: `${relPath}: unsupported file type (${ext})` }
  }

  let content: string
  try {
    content = await fs.readFile(absPath, "utf8")
  } catch {
    return { success: false, output: `Cannot read ${relPath}` }
  }

  const definitions = extractDefinitions(content, ext)
  if (definitions.length === 0) {
    return { success: true, output: `${relPath}: no top-level definitions found` }
  }

  const output = `${relPath}:\n${definitions.map(d => `  ${d}`).join("\n")}`
  return { success: true, output }
}

async function extractFromDirectory(
  absDir: string,
  cwd: string
): Promise<{ success: boolean; output: string }> {
  const { readdir } = await import("node:fs/promises")
  const results: string[] = []
  const ignoreMod = await import("ignore")
  const ignoreFactory = (ignoreMod as any).default ?? ignoreMod
  let ig = ignoreFactory()
  try {
    const gi = await fs.readFile(path.join(cwd, ".gitignore"), "utf8").catch(() => "")
    ig = ignoreFactory().add(gi)
  } catch {}
  ig.add([".git", "node_modules", "dist", "build"])

  async function processDir(dir: string, depth: number) {
    if (depth > 3) return
    const items = await readdir(dir).catch(() => [] as string[])
    for (const item of items.sort()) {
      const fullPath = path.join(dir, item)
      const relPath = path.relative(cwd, fullPath)
      if (ig.ignores(relPath)) continue

      const st = await fs.stat(fullPath).catch(() => null)
      if (!st) continue

      if (st.isDirectory()) {
        await processDir(fullPath, depth + 1)
      } else {
        const ext = path.extname(item).toLowerCase()
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          const r = await extractFromFile(fullPath, cwd)
          if (r.success && r.output && !r.output.includes("no top-level")) {
            results.push(r.output)
          }
        }
      }
    }
  }

  await processDir(absDir, 0)

  if (results.length === 0) {
    return { success: true, output: "No code definitions found" }
  }

  return { success: true, output: results.join("\n\n") }
}

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp"])

// Regex-based extraction (lightweight, no tree-sitter dependency needed for basic use)
function extractDefinitions(content: string, ext: string): string[] {
  const defs: string[] = []
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd()
    const def = extractDefinitionFromLine(line, ext, i + 1)
    if (def) defs.push(def)
  }

  return defs
}

function extractDefinitionFromLine(line: string, ext: string, lineNum: number): string | null {
  const stripped = line.trim()

  // TypeScript/JavaScript
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    // Export class
    let m = stripped.match(/^(export\s+)?(abstract\s+)?class\s+(\w+)/)
    if (m) return `class ${m[3]} (L${lineNum})`

    // Export function
    m = stripped.match(/^(export\s+)?(async\s+)?function\s+(\w+)/)
    if (m) return `function ${m[3]} (L${lineNum})`

    // Export const arrow function
    m = stripped.match(/^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/)
    if (m) return `const ${m[2]} (L${lineNum})`

    // Export interface
    m = stripped.match(/^(export\s+)?interface\s+(\w+)/)
    if (m) return `interface ${m[2]} (L${lineNum})`

    // Export type
    m = stripped.match(/^(export\s+)?type\s+(\w+)\s*=/)
    if (m) return `type ${m[2]} (L${lineNum})`

    // Export enum
    m = stripped.match(/^(export\s+)?(?:const\s+)?enum\s+(\w+)/)
    if (m) return `enum ${m[2]} (L${lineNum})`
  }

  // Python
  if (ext === ".py") {
    let m = stripped.match(/^class\s+(\w+)/)
    if (m) return `class ${m[1]} (L${lineNum})`
    m = stripped.match(/^(async\s+)?def\s+(\w+)/)
    if (m) return `def ${m[2]} (L${lineNum})`
  }

  // Rust
  if (ext === ".rs") {
    let m = stripped.match(/^pub\s+(?:async\s+)?fn\s+(\w+)/)
    if (m) return `fn ${m[1]} (L${lineNum})`
    m = stripped.match(/^pub\s+struct\s+(\w+)/)
    if (m) return `struct ${m[1]} (L${lineNum})`
    m = stripped.match(/^pub\s+trait\s+(\w+)/)
    if (m) return `trait ${m[1]} (L${lineNum})`
    m = stripped.match(/^pub\s+enum\s+(\w+)/)
    if (m) return `enum ${m[1]} (L${lineNum})`
  }

  // Go
  if (ext === ".go") {
    let m = stripped.match(/^func\s+(?:\([\w\s*]+\)\s+)?(\w+)/)
    if (m) return `func ${m[1]} (L${lineNum})`
    m = stripped.match(/^type\s+(\w+)\s+struct/)
    if (m) return `struct ${m[1]} (L${lineNum})`
    m = stripped.match(/^type\s+(\w+)\s+interface/)
    if (m) return `interface ${m[1]} (L${lineNum})`
  }

  return null
}
