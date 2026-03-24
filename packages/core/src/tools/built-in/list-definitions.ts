import { z } from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { extractSymbols } from "../../indexer/ast-extractor.js"
import {
  loadDefinitionQueryParsers,
  parseDefinitionsForFile,
  parseDefinitionsTopLevelDirectory,
  isDefinitionQueryExtension,
  type DefinitionQueryParsersByExt,
} from "../../indexer/definition-queries/index.js"
import type { SymbolEntry, ToolDef, ToolContext } from "../../types.js"

/** Same language coverage as the codebase indexer (symbolExtract path), minus markdown sections. */
const WALK_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java",
  ".c", ".h", ".cpp", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".scala",
])

const DEFAULT_MAX_DEPTH = 3
const DEFAULT_MAX_FILES = 80
const DEFAULT_MAX_OUTPUT_CHARS = 120_000

const schema = z.object({
  path: z.string().describe("File or directory to extract code definitions from (relative to project root or absolute)"),
  shallow: z
    .boolean()
    .optional()
    .describe(
      "If true, non-recursive directory listing: only immediate files in the folder (max 50 parseable sources after extension filter). Ignored when path is a file.",
    ),
  max_depth: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe(
      `Max directory nesting depth when listing a folder (default ${DEFAULT_MAX_DEPTH}). Ignored when shallow is true.`,
    ),
  max_files: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(`Max source files to analyze (default ${DEFAULT_MAX_FILES}). Prevents huge context usage.`),
  max_output_chars: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(500_000)
    .optional()
    .describe(`Truncate combined output past this many characters (default ${DEFAULT_MAX_OUTPUT_CHARS}).`),
  task_progress: z.string().optional(),
})

function formatSymbolsForTool(relPath: string, symbols: SymbolEntry[]): string {
  const defs = symbols.filter((s) => s.kind !== "chunk")
  if (defs.length === 0) {
    return `${relPath}: no named definitions extracted (file may be minified or use patterns we do not parse). Use Read or Grep.`
  }
  const lines = defs.map((s) => {
    const parent = s.parent ? ` in ${s.parent}` : ""
    return `  [${s.kind}] ${s.name}${parent} (L${s.startLine})`
  })
  return `${relPath}:\n${lines.join("\n")}`
}

async function extractFromFile(
  absPath: string,
  cwd: string,
  sharedParsers?: DefinitionQueryParsersByExt,
): Promise<{ success: boolean; output: string }> {
  const relPath = path.relative(cwd, absPath).replace(/\\/g, "/")
  const ext = path.extname(absPath).toLowerCase()

  if (!WALK_EXTENSIONS.has(ext)) {
    return { success: true, output: `${relPath}: unsupported file type (${ext}) for ListCodeDefinitions` }
  }

  /** Tree-sitter definition queries from `indexer/definition-queries/queries`. */
  if (isDefinitionQueryExtension(ext)) {
    try {
      const parsers = sharedParsers ?? (await loadDefinitionQueryParsers([absPath]))
      const defs = await parseDefinitionsForFile(absPath, parsers)
      if (defs !== null) {
        if (defs.startsWith("Unsupported file type:")) {
          return { success: true, output: `${relPath}\n${defs}` }
        }
        return { success: true, output: `${relPath}\n${defs}`.trimEnd() }
      }
    } catch (err) {
      console.warn("[nexus] ListCodeDefinitions tree-sitter failed, using regex fallback:", (err as Error).message)
    }
  }

  let content: string
  try {
    content = await fs.readFile(absPath, "utf8")
  } catch {
    return { success: false, output: `Cannot read ${relPath}` }
  }

  const symbols = extractSymbols(content, relPath, ext)
  return { success: true, output: formatSymbolsForTool(relPath, symbols) }
}

async function collectFiles(
  absDir: string,
  cwd: string,
  opts: { shallow: boolean; maxDepth: number; maxFiles: number },
): Promise<string[]> {
  const out: string[] = []
  const ignoreMod = await import("ignore")
  const ignoreFactory = (ignoreMod as any).default ?? ignoreMod
  let ig = ignoreFactory()
  try {
    const gi = await fs.readFile(path.join(cwd, ".gitignore"), "utf8").catch(() => "")
    ig = ignoreFactory().add(gi)
  } catch {
    /* empty */
  }
  ig.add([".git", "node_modules", "dist", "build", ".nexus"])

  async function processDir(dir: string, depth: number): Promise<void> {
    if (out.length >= opts.maxFiles) return
    if (opts.shallow && depth > 0) return
    if (!opts.shallow && depth > opts.maxDepth) return

    const items = await fs.readdir(dir).catch(() => [] as string[])
    for (const item of items.sort()) {
      if (out.length >= opts.maxFiles) return
      const fullPath = path.join(dir, item)
      const relPath = path.relative(cwd, fullPath)
      if (ig.ignores(relPath)) continue

      const st = await fs.stat(fullPath).catch(() => null)
      if (!st) continue

      if (st.isDirectory()) {
        if (!opts.shallow) {
          await processDir(fullPath, depth + 1)
        }
      } else {
        const ext = path.extname(item).toLowerCase()
        if (WALK_EXTENSIONS.has(ext)) {
          out.push(fullPath)
        }
      }
    }
  }

  await processDir(absDir, 0)
  return out
}

function truncateOutput(text: string, maxChars: number, filesProcessed: number, totalFiles: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  const note = `\n\n[Output truncated at ${maxChars} characters. Processed ${filesProcessed}/${totalFiles} files — narrow path, raise max_output_chars, or use Glob+Grep.]`
  return head + note
}

export const listDefinitionsTool: ToolDef<z.infer<typeof schema>> = {
  name: "ListCodeDefinitions",
  description: `List code definitions for a file or directory.

**Parsing:** For supported languages, **web-tree-sitter** runs bundled **definition queries** (\`packages/core/src/indexer/definition-queries/queries\`). Output uses \`│\` lines and \`|----\` separators when parsing succeeds. Other extensions (e.g. \`.scala\`) use the legacy regex extractor.

**Directory behavior:** **shallow: true** — non-recursive, only files directly in the folder, up to 50 parseable files. **shallow: false** — recursion with \`max_depth\` / \`max_files\`.

When to use:
- Before Read: see definition lines, then Read(path, offset, limit) for detail.
- Quick structural overview of a file or folder.

When NOT to use: semantic search → CodebaseSearch; exact text → Grep.`,

  parameters: schema,
  readOnly: true,

  async execute(
    {
      path: targetPath,
      shallow = false,
      max_depth: maxDepthArg,
      max_files: maxFilesArg,
      max_output_chars: maxOutArg,
    },
    ctx: ToolContext,
  ) {
    const absPath = path.resolve(ctx.cwd, targetPath)
    const maxDepth = maxDepthArg ?? DEFAULT_MAX_DEPTH
    const maxFiles = maxFilesArg ?? DEFAULT_MAX_FILES
    const maxOut = maxOutArg ?? DEFAULT_MAX_OUTPUT_CHARS

    let indexerNote = ""
    const stIndexer = ctx.indexer?.status()
    if (stIndexer && stIndexer.state === "ready" && "symbols" in stIndexer) {
      indexerNote = `\n(Indexer: ${stIndexer.files} files indexed, ${stIndexer.symbols} vector/chunk entries — index uses semantic chunks; this tool uses definition-query tree-sitter.)`
    }

    try {
      const stat = await fs.stat(absPath)
      if (stat.isDirectory() && shallow) {
        const body = await parseDefinitionsTopLevelDirectory(absPath)
        return {
          success: true,
          output: truncateOutput(body + indexerNote, maxOut, 1, 1),
        }
      }

      if (stat.isDirectory()) {
        const files = await collectFiles(absPath, ctx.cwd, {
          shallow,
          maxDepth,
          maxFiles,
        })
        if (files.length === 0) {
          return { success: true, output: `No matching source files under ${path.relative(ctx.cwd, absPath) || "."}.${indexerNote}` }
        }

        const definitionQueryFiles = files.filter((f) => isDefinitionQueryExtension(path.extname(f)))
        let sharedParsers: DefinitionQueryParsersByExt | undefined
        if (definitionQueryFiles.length > 0) {
          try {
            sharedParsers = await loadDefinitionQueryParsers(definitionQueryFiles)
          } catch {
            sharedParsers = undefined
          }
        }

        const parts: string[] = []
        for (const file of files) {
          const r = await extractFromFile(file, ctx.cwd, sharedParsers)
          parts.push(r.output)
        }

        let body = parts.join("\n\n")
        if (files.length >= maxFiles) {
          body += `\n\n[Stopped after ${maxFiles} files (max_files). Narrow the path or increase max_files.]`
        }
        body = truncateOutput(body, maxOut, files.length, files.length)
        return { success: true, output: body + indexerNote }
      }

      const r = await extractFromFile(absPath, ctx.cwd)
      if (!r.success) return r
      return { success: true, output: truncateOutput(r.output, maxOut, 1, 1) + indexerNote }
    } catch {
      return { success: false, output: `Path not found: ${targetPath}` }
    }
  },
}
