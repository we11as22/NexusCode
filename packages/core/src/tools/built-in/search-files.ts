import { z } from "zod"
import { execa } from "execa"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"

const MAX_RESULTS = 500
const MAX_OUTPUT_CHARS = 100_000
const DEFAULT_CODE_GLOBS = [
  "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs",
  "*.py", "*.rs", "*.go", "*.java", "*.c", "*.cpp", "*.h", "*.hpp",
  "*.cs", "*.rb", "*.php", "*.swift", "*.kt", "*.scala",
  "*.md", "*.mdx",
]

const searchSchema = z.object({
  pattern: z.string().optional().describe("Regex pattern to search for (ripgrep syntax; escape special chars or use raw string)"),
  patterns: z.array(z.string()).min(1).max(20).optional().describe("Multiple regex patterns in one call"),
  path: z.string().optional().describe("Directory or file to search in (relative to project root); use to restrict scope"),
  paths: z.array(z.string()).min(1).max(20).optional().describe("Multiple directories/files to search in"),
  include: z.string().optional().describe("File glob to include, e.g. '*.ts' or '**/*.{ts,tsx}'"),
  exclude: z.string().optional().describe("File glob to exclude"),
  context_lines: z.number().int().min(0).max(10).optional().describe("Lines of context around matches (0-10)"),
  case_sensitive: z.boolean().optional().describe("Case sensitive search (default: false)"),
  max_results: z.number().int().positive().max(2000).optional().describe("Max total matches (default: 500)"),
  task_progress: z.string().optional(),
})

export const grepTool: ToolDef<z.infer<typeof searchSchema>> = {
  name: "grep",
  description: `Search file contents with regex (ripgrep). Use for exact text, identifiers, or complex patterns. Use grep to locate code before reading; then use read_file with start_line/end_line for only those ranges.

When to use:
- **Locate before reading** — Use grep (and list_code_definitions) to find where code lives; then use read_file with start_line/end_line to read only that section. Use grep early and often when discovering structure or finding usages.
- Find exact strings, identifiers, or regex patterns in the codebase.
- Complex patterns (e.g. "function\\\\s+\\\\w+", "class\\\\s+[A-Z]\\\\w*", "TODO|FIXME").
- Restrict to a folder (path/paths), file types (include), or exclude files (exclude).

Parameters:
- pattern / patterns: regex (ripgrep syntax). Escape special chars — e.g. to match literal \`interface{}\` in Go use \`interface\\{\\}\`. Use raw string or escape backslashes.
- path / paths: directory or file to search (relative to project root). Omit for whole repo.
- include: glob for file types (e.g. "*.ts"). Default: common code/md extensions.
- exclude: glob to exclude.
- context_lines: lines before/after match (0-10).
- case_sensitive: default false.
- max_results: cap total matches (default 500, max 2000).

Use codebase_search for semantic/meaning-based search when vector index is available.`,
  parameters: searchSchema,
  readOnly: true,

  async execute({ pattern, patterns, path: searchPath, paths, include, exclude, context_lines, case_sensitive, max_results }, ctx) {
    const allPatterns = (patterns?.length ? patterns : (pattern ? [pattern] : [])).map((p) => p.trim()).filter(Boolean)
    if (allPatterns.length === 0) {
      return { success: false, output: "Provide pattern or patterns." }
    }
    const targets = (paths?.length ? paths : (searchPath ? [searchPath] : ["."]))
      .map((p) => path.resolve(ctx.cwd, p))
    const maxMatches = Math.min(max_results ?? MAX_RESULTS, 2000)

    try {
      const results: string[] = []
      const seen = new Set<string>()
      let matchCount = 0

      for (const pat of allPatterns) {
        if (matchCount >= maxMatches) break
        for (const target of targets) {
          if (matchCount >= maxMatches) break
          const args = ["--json", "-e", pat]
          if (!case_sensitive) args.push("--ignore-case")
          if (include) {
            args.push("--glob", include)
          } else {
            for (const g of DEFAULT_CODE_GLOBS) {
              args.push("--glob", g)
            }
          }
          if (exclude) args.push("--glob", `!${exclude}`)
          if (context_lines) args.push("--context", String(context_lines))
          args.push(target)

          const { stdout } = await execa("rg", args, { cwd: ctx.cwd, reject: false })
          if (!stdout) continue

          const lines = stdout.split("\n").filter(Boolean)
          for (const line of lines) {
            if (matchCount >= maxMatches) break
            try {
              const obj = JSON.parse(line) as { type: string; data: Record<string, unknown> }
              if (obj.type !== "match") continue
              const data = obj.data as { path: { text: string }; line_number: number; lines: { text: string } }
              const relPath = path.relative(ctx.cwd, data.path.text)
              const text = `${relPath}:${data.line_number}:${data.lines.text.trimEnd()}`
              const key = `${pat}|${text}`
              if (seen.has(key)) continue
              seen.add(key)
              results.push(`[${pat}] ${text}`)
              matchCount++
            } catch {}
          }
        }
      }

      if (results.length === 0) {
        return { success: true, output: `No matches found for: ${allPatterns.join(", ")}` }
      }

      let output = results.join("\n")
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated, ${matchCount} total matches)`
      }

      return {
        success: true,
        output: `Found ${matchCount} matches for ${allPatterns.length} pattern(s) in ${targets.length} target(s):\n\n${output}`,
      }
    } catch (err) {
      // rg not found — fallback
      return {
        success: false,
        output: `Search failed: ${(err as Error).message}. Install ripgrep (rg) for grep support.`,
      }
    }
  },
}

const listSchema = z.object({
  path: z.string().optional().describe("Directory to list (relative to project root, default: root)"),
  recursive: z.boolean().optional().describe("List recursively (default: false for top-level, true for subdirs)"),
  include: z.string().optional().describe("Glob pattern to filter files"),
  max_entries: z.number().int().positive().max(5000).optional().describe("Max entries (default: 200)"),
  task_progress: z.string().optional(),
})

export const listFilesTool: ToolDef<z.infer<typeof listSchema>> = {
  name: "list_files",
  description: `List files and directories. Tree-like structure; respects .gitignore and common ignores.

When to use:
- **Discover project layout first** — Use list_files (root and key dirs like ., src, packages) at the start of a task. Use once or twice for layout; do not list every nested folder. Then use list_code_definitions and grep to find code; use read_file only for targeted ranges.
- Find file names or directory structure.
- Check presence of config files, scripts, or modules.

When NOT to use:
- Finding by content: use codebase_search (semantic) or grep (regex).
- Reading a file: use read_file (prefer after list_code_definitions or grep so you have start_line/end_line).
- Glob by extension: use path + include (e.g. include="*.ts").

Parameters:
- path: directory to list (default: project root). Relative to cwd.
- recursive: include subdirectories (default: false for root, true for subdirs).
- include: glob to filter entries (e.g. "*.ts").
- max_entries: cap output (default 200, max 5000).`,
  parameters: listSchema,
  readOnly: true,

  async execute({ path: listPath, recursive, include, max_entries }, ctx) {
    const targetDir = listPath ? path.resolve(ctx.cwd, listPath) : ctx.cwd
    const maxEntries = max_entries ?? 200
    const maxActual = Math.min(maxEntries, 2000)

    try {
      const { readdir, stat } = await import("node:fs/promises")
      const ignoreMod = await import("ignore")
      const ignoreFactory = ((ignoreMod as any).default ?? ignoreMod) as (...args: unknown[]) => ReturnType<typeof import("ignore").default>

      let ig = ignoreFactory()
      // When listing a specific subdirectory, do NOT use project .gitignore — otherwise
      // listing e.g. "sources" would show nothing if sources/ is in .gitignore.
      const useGitignore = !listPath || listPath === "."
      if (useGitignore) {
        try {
          const gitignoreContent = await import("node:fs/promises").then(f =>
            f.readFile(path.join(ctx.cwd, ".gitignore"), "utf8").catch(() => "")
          )
          ig = ig.add(gitignoreContent)
        } catch {}
      }
      ig.add([".git", "node_modules", ".nexus"])

      const entries: string[] = []

      async function walk(dir: string, prefix: string, depth: number) {
        if (entries.length >= maxActual) return
        if (depth > (recursive ? 10 : 1)) return

        const items = await readdir(dir).catch(() => [] as string[])
        for (const item of items.sort()) {
          if (entries.length >= maxActual) break
          const fullPath = path.join(dir, item)
          const relPath = path.relative(ctx.cwd, fullPath)

          if (ig.ignores(relPath)) continue
          const itemStat = await stat(fullPath).catch(() => null)
          if (!itemStat) continue

          if (itemStat.isDirectory()) {
            entries.push(`${prefix}${item}/`)
            if (recursive || depth === 0) {
              await walk(fullPath, prefix + "  ", depth + 1)
            }
          } else {
            // Apply include glob filter for files
            if (include) {
              const { minimatch } = await import("minimatch")
              if (!minimatch(item, include, { matchBase: true })) continue
            }
            entries.push(`${prefix}${item}`)
          }
        }
      }

      await walk(targetDir, "", 0)

      if (entries.length === 0) {
        return { success: true, output: `Empty directory: ${listPath ?? "."}` }
      }

      const header = `${listPath ?? "."} (${entries.length} entries${entries.length >= maxActual ? ", truncated" : ""}):`
      return {
        success: true,
        output: `${header}\n${entries.join("\n")}`,
      }
    } catch (err) {
      return { success: false, output: `Failed to list ${listPath}: ${(err as Error).message}` }
    }
  },
}
