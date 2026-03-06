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
  pattern: z.string().describe("The regular expression pattern to search for in file contents"),
  path: z.string().optional().describe("File or directory to search in (rg PATH). Defaults to current working directory."),
  glob: z.string().optional().describe("Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob"),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\"."),
  "-B": z.number().int().min(0).optional().describe("Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise."),
  "-A": z.number().int().min(0).optional().describe("Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise."),
  "-C": z.number().int().min(0).optional().describe("Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise."),
  "-n": z.boolean().optional().describe("Show line numbers in output (rg -n). Requires output_mode: \"content\", ignored otherwise."),
  "-i": z.boolean().optional().describe("Case insensitive search (rg -i)"),
  type: z.string().optional().describe("File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than glob for standard file types."),
  head_limit: z.number().int().positive().max(2000).optional().describe("Limit output to first N lines/entries. Works across all output modes. When unspecified, shows all results from ripgrep."),
  multiline: z.boolean().optional().describe("Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false."),
})

export const grepTool: ToolDef<z.infer<typeof searchSchema>> = {
  name: "Grep",
  description: `A powerful search tool built on ripgrep

Usage:
- ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
- Supports full regex syntax (e.g., "log.*Error", "function\\\\s+\\\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
- Use Task tool for open-ended searches requiring multiple rounds
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\\\{\\\\}\` to find \`interface{}\` in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\\\{[\\\\s\\\\S]*?field\`, use \`multiline: true\``,
  parameters: searchSchema,
  readOnly: true,

  async execute({ pattern, path: searchPath, glob: includeGlob, output_mode, "-B": before, "-A": after, "-C": context, "-n": lineNumbers, "-i": case_sensitive, type: fileType, head_limit: max_results, multiline }, ctx) {
    const context_lines = context ?? before ?? after ?? 0
    const targets = searchPath ? [path.resolve(ctx.cwd, searchPath)] : [ctx.cwd]
    const include = includeGlob ?? (fileType ? `*.${fileType}` : undefined)
    const maxMatches = Math.min(max_results ?? 500, 2000)

    try {
      const results: string[] = []
      const seen = new Set<string>()
      let matchCount = 0

      const args = ["--json", "-e", pattern]
      if (case_sensitive !== true) args.push("--ignore-case")
      if (include) {
        args.push("--glob", include)
      } else {
        for (const g of DEFAULT_CODE_GLOBS) {
          args.push("--glob", g)
        }
      }
      if (context_lines) args.push("--context", String(context_lines))
      args.push(targets[0]!)

      const { stdout } = await execa("rg", args, { cwd: ctx.cwd, reject: false })
      if (!stdout) {
        return { success: true, output: `No matches found for: ${pattern}` }
      }

      const lines = stdout.split("\n").filter(Boolean)
      const fileCounts = new Map<string, number>()
      for (const line of lines) {
        if (matchCount >= maxMatches && output_mode !== "count") break
        try {
          const obj = JSON.parse(line) as { type: string; data: Record<string, unknown> }
          if (obj.type !== "match") continue
          const data = obj.data as { path: { text: string }; line_number: number; lines: { text: string } }
          const relPath = path.relative(ctx.cwd, data.path.text)
          if (output_mode === "count") {
            fileCounts.set(relPath, (fileCounts.get(relPath) ?? 0) + 1)
            matchCount++
            continue
          }
          if (output_mode === "files_with_matches") {
            if (seen.has(relPath)) continue
            seen.add(relPath)
            results.push(relPath)
            matchCount++
            continue
          }
          const text = lineNumbers !== false
            ? `${relPath}:${data.line_number}:${data.lines.text.trimEnd()}`
            : `${relPath}:${data.lines.text.trimEnd()}`
          const key = `${pattern}|${text}`
          if (seen.has(key)) continue
          seen.add(key)
          results.push(text)
          matchCount++
        } catch {}
      }

      if (output_mode === "count") {
        const countLines = [...fileCounts.entries()].map(([p, n]) => `${p}: ${n}`)
        const out = countLines.slice(0, maxMatches).join("\n")
        return { success: true, output: `Count for "${pattern}":\n\n${out}` }
      }

      if (results.length === 0) {
        return { success: true, output: `No matches found for: ${pattern}` }
      }

      let output = results.join("\n")
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated, ${matchCount} total matches)`
      }

      const header = output_mode === "files_with_matches"
        ? `Found ${matchCount} file(s) matching "${pattern}":\n\n${output}`
        : `Found ${matchCount} matches for "${pattern}":\n\n${output}`
      return { success: true, output: header }
    } catch (err) {
      return {
        success: false,
        output: `Search failed: ${(err as Error).message}. Install ripgrep (rg) for Grep support.`,
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
  name: "ListFiles",
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
