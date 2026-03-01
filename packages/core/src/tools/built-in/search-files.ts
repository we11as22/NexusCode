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
  pattern: z.string().optional().describe("Regex pattern to search for"),
  patterns: z.array(z.string()).min(1).max(20).optional().describe("Multiple regex patterns to search in one call"),
  path: z.string().optional().describe("Directory or file to search in (relative to project root)"),
  paths: z.array(z.string()).min(1).max(20).optional().describe("Multiple directories/files to search in"),
  include: z.string().optional().describe("File glob pattern to include, e.g. '*.ts' or '**/*.{ts,tsx}'"),
  exclude: z.string().optional().describe("File glob pattern to exclude"),
  context_lines: z.number().int().min(0).max(10).optional().describe("Lines of context around matches (0-10)"),
  case_sensitive: z.boolean().optional().describe("Case sensitive search (default: false)"),
  max_results: z.number().int().positive().max(2000).optional().describe("Max total matches across all patterns/paths (default: 500)"),
  task_progress: z.string().optional(),
})

export const searchFilesTool: ToolDef<z.infer<typeof searchSchema>> = {
  name: "search_files",
  description: `Search file contents using regex patterns (powered by ripgrep).
Returns matching lines with file path and line numbers.
Maximum ${MAX_RESULTS} results.

Examples:
- Find all TODO comments: pattern="TODO|FIXME"
- Find function definitions: pattern="^(export )?function \\w+", include="*.ts"
- Find class usages: pattern="new MyClass\\("`,
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
        output: `Search failed: ${(err as Error).message}. Install ripgrep (rg) for search support.`,
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
  description: `List files and directories.
Shows a tree-like structure with files and subdirectories.
Use recursive=true to list all files in a directory tree.
Maximum 2000 entries.`,
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

      // Load .gitignore
      let ig = ignoreFactory()
      try {
        const gitignoreContent = await import("node:fs/promises").then(f =>
          f.readFile(path.join(ctx.cwd, ".gitignore"), "utf8").catch(() => "")
        )
        ig = ig.add(gitignoreContent)
      } catch {}
      ig.add([".git", "node_modules", ".nexus/index", ".nexus/checkpoints"])

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
