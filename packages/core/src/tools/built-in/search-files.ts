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
  explanation: z.string().optional().describe("One sentence explanation of why this search is needed and how it contributes to the goal."),
  path: z.string().optional().describe("File or directory to search in (rg PATH). Defaults to current working directory."),
  glob: z.string().optional().describe("Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob"),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\"."),
  "-B": z.coerce.number().int().min(0).optional().describe("Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise."),
  "-A": z.coerce.number().int().min(0).optional().describe("Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise."),
  "-C": z.coerce.number().int().min(0).optional().describe("Alias for context. Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise."),
  context: z.coerce.number().int().min(0).optional().describe("Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise."),
  "-n": z.boolean().optional().describe("Show line numbers in output (rg -n). Requires output_mode: \"content\", ignored otherwise. Defaults to true."),
  "-i": z.boolean().optional().describe("Case insensitive search (rg -i)"),
  type: z.string().optional().describe("File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than glob for standard file types."),
  head_limit: z.coerce.number().int().positive().max(2000).optional().describe("Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). When unspecified, shows all results from ripgrep."),
  offset: z.coerce.number().int().min(0).optional().describe("Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0."),
  multiline: z.boolean().optional().describe("Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false."),
})

export const grepTool: ToolDef<z.infer<typeof searchSchema>> = {
  name: "Grep",
  description: `**ALWAYS use Grep for exact text/symbol/pattern searches.** Grep is your primary tool for finding known identifiers, imports, strings, and patterns.

A powerful search tool built on ripgrep

Usage:
- ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
- Supports full regex syntax (e.g., "log.*Error", "function\\\\s+\\\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows only file paths (default), "count" shows match counts per file
- For open-ended investigations requiring multiple rounds, run several Grep/CodebaseSearch calls in parallel or use SpawnAgent for broader research when that will clearly save context
- Pattern syntax: Uses ripgrep (not grep) — literal braces need escaping (use \`interface\\\\{\\\\}\` to find \`interface{}\` in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\\\{[\\\\s\\\\S]*?field\`, use \`multiline: true\`
- Avoid overly broad glob patterns (e.g. \`--glob *\`) as they can bypass .gitignore and be slow. Use \`type\` or \`glob\` only when you are certain of the file type needed
- Results are capped for responsiveness; truncated results show "at least" counts. Use head_limit to bound output (e.g. equivalent to "| head -N")
- Content output follows ripgrep format: \`-\` for context lines, \`:\` for match lines, grouped by file
- Unsaved or out-of-workspace active editors are also searched and show "(unsaved)" or "(out of workspace)". Use absolute paths to read/edit these.`,
  parameters: searchSchema,
  readOnly: true,

  async execute({ pattern, path: searchPath, glob: includeGlob, output_mode, "-B": before, "-A": after, "-C": contextC, context: contextAlias, "-n": lineNumbers, "-i": case_sensitive, type: fileType, head_limit, offset: skipOffset, multiline }, ctx) {
    const context_lines = contextC ?? contextAlias ?? before ?? after ?? 0
    const targets = searchPath ? [path.resolve(ctx.cwd, searchPath)] : [ctx.cwd]
    const include = includeGlob ?? (fileType ? `*.${fileType}` : undefined)
    const skipN = skipOffset ?? 0
    const maxResults = Math.min(head_limit ?? 500, 2000)
    const collectLimit = skipN + maxResults

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
      if (multiline) args.push("-U", "--multiline-dotall")
      if (context_lines) args.push("--context", String(context_lines))
      args.push(targets[0]!)

      const { stdout } = await execa("rg", args, { cwd: ctx.cwd, reject: false })
      if (!stdout) {
        return { success: true, output: `No matches found for: ${pattern}` }
      }

      const lines = stdout.split("\n").filter(Boolean)
      const fileCounts = new Map<string, number>()
      for (const line of lines) {
        if (matchCount >= collectLimit && output_mode !== "count") break
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
        const sliced = countLines.slice(skipN, skipN + maxResults)
        const out = sliced.join("\n")
        return { success: true, output: `Count for "${pattern}":\n\n${out}` }
      }

      const displayed = results.slice(skipN, skipN + maxResults)
      if (displayed.length === 0) {
        return { success: true, output: `No matches found for: ${pattern}` }
      }

      let output = displayed.join("\n")
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated, ${matchCount} total matches)`
      }

      const header = output_mode === "files_with_matches"
        ? `Found ${displayed.length} file(s) matching "${pattern}":\n\n${output}`
        : `Found ${displayed.length} matches for "${pattern}":\n\n${output}`
      return { success: true, output: header }
    } catch (err) {
      return {
        success: false,
        output: `Search Failed: ${(err as Error).message}. Install ripgrep (rg) for Grep support.`,
      }
    }
  },
}

// List: single "path" parameter only. No "paths" array.
const listSchema = z
  .object({
    path: z
      .string()
      .describe("Single directory to list (relative to project root or absolute). Use \".\" for root. Do NOT use 'paths' (array). Example: \"src\", \"packages\"."),
    ignore: z.array(z.string()).optional().describe("List of glob patterns to ignore (e.g. \"*.log\", \"**/node_modules/**\")"),
    recursive: z.boolean().optional().describe("List recursively (default: false for top-level, true for subdirs)"),
    include: z.string().optional().describe("Glob pattern to filter files (e.g. \"*.ts\", \"*.json\")"),
    max_entries: z.coerce.number().int().positive().max(5000).optional().describe("Max entries (default: 200)"),
    task_progress: z.string().optional(),
  })
  .strict()

export const listTool: ToolDef<z.infer<typeof listSchema>> = {
  name: "List",
  description: `Lists files and directories in a given path.

**Input: exactly one parameter \`path\` (string).** Do not use \`paths\` (array). Use \`path\` only (e.g. \".\", \"src\", \"packages\").

### When to Use

- **Project layout discovery** — Use at the start of a task on root and key dirs (e.g. \`.\`, \`src\`, \`packages\`) to understand structure. Use once or twice; do not list every nested folder.
- **Verify directory exists** — Before running commands that create files/dirs (e.g. \`mkdir foo/bar\`), use List to check the parent directory exists and is the correct location.
- **Find file names or check presence** — Config files, scripts, modules. Use \`include\` to filter by extension.

**Note:** The result does not display dot-files and dot-directories by default (e.g. \`.env\`, \`.gitignore\` may be hidden depending on ignore rules).

### When NOT to Use

- **Finding by content** — Use CodebaseSearch (semantic) or Grep (regex/exact).
- **Reading a file** — Use Read (with offset/limit from Grep or ListCodeDefinitions results).
- **Finding by extension recursively** — Use Glob with a pattern like \`**/*.ts\` instead.

### Parameters

- \`path\`: directory to list (default: \".\"). **Single string only — do not use \`paths\` (array).**
- \`ignore\`: optional list of glob patterns to ignore (e.g. \`[\"*.log\", \"**/build/**\"]\`).
- \`recursive\`: include subdirectories (default: false for root, true for subdirs).
- \`include\`: glob to filter entries (e.g. \`"*.ts"\`, \`"*.json"\`).
- \`max_entries\`: cap output (default 200, max 5000).
- Results are sorted alphabetically; directories shown with trailing \`/\`.`,
  parameters: listSchema,
  readOnly: true,

  async execute({ path: listPathArg, ignore: ignorePatterns, recursive, include, max_entries }, ctx) {
    const listPath =
      typeof listPathArg === "string" && listPathArg.length > 0 ? listPathArg : undefined
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
      // Hide heavy internals by default, but do not hide .nexus when the user
      // is explicitly listing it (or any of its children).
      ig.add([".git", "node_modules"])
      const targetRel = path.relative(ctx.cwd, targetDir).replace(/\\/g, "/")
      const listingInsideNexus =
        targetRel === ".nexus" || targetRel.startsWith(".nexus/")
      if (!listingInsideNexus) {
        ig.add([".nexus"])
      }
      if (ignorePatterns?.length) {
        ig.add(ignorePatterns)
      }

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
