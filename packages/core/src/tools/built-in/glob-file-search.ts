import { z } from "zod"
import * as path from "node:path"
import { glob } from "glob"
import type { ToolDef, ToolContext } from "../../types.js"

const MAX_RESULTS = 500

const globSchema = z.object({
  glob_pattern: z.string().describe("Glob pattern to match files (e.g. '**/*.ts', 'src/**/*.tsx'). Patterns not starting with '**/' are searched recursively from the target directory."),
  target_directory: z.string().optional().describe("Directory to search in (relative to project root). Omit to search from project root."),
  max_results: z.number().int().positive().max(2000).optional().describe("Max number of file paths to return (default: 500)"),
  task_progress: z.string().optional(),
})

export const globFileSearchTool: ToolDef<z.infer<typeof globSchema>> = {
  name: "glob",
  description: `Find files by name/pattern. Fast, works with codebases of any size. Returns matching paths sorted by modification time (newest first).

When to use:
- Find files by extension or name: "**/*.ts", "**/*.test.ts", "**/package.json".
- Locate config or specific modules: "**/tsconfig*.json", "src/**/*.tsx".
- Prefer over list_files when you know the pattern; prefer over execute_command find/ls for speed and consistent behavior.

When NOT to use:
- Searching by content (strings, code): use grep or codebase_search.
- Reading a file: use read_file.

Parameters:
- glob_pattern: e.g. "**/*.js", "src/**/*.{ts,tsx}". Recursive by default.
- target_directory: optional; relative to project root. Omit for whole repo.
- max_results: cap (default 500, max 2000).`,
  parameters: globSchema,
  readOnly: true,

  async execute({ glob_pattern, target_directory, max_results }, ctx) {
    const cwd = target_directory ? path.resolve(ctx.cwd, target_directory) : ctx.cwd
    const cap = Math.min(max_results ?? MAX_RESULTS, 2000)

    try {
      const pattern = glob_pattern.includes("**") || glob_pattern.includes("*") ? glob_pattern : `**/${glob_pattern}`
      const matches = await glob(pattern, {
        cwd,
        absolute: true,
        nodir: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.nexus/**"],
      })

      if (matches.length === 0) {
        return { success: true, output: `No files matched pattern "${glob_pattern}"${target_directory ? ` in ${target_directory}` : ""}.` }
      }

      const toStat = matches.length > cap ? matches.slice(0, 3000) : matches
      const { stat } = await import("node:fs/promises")
      const withMtime = await Promise.all(
        toStat.map(async (absPath) => {
          const mtime = await stat(absPath).then(s => s.mtimeMs).catch(() => 0)
          return { rel: path.relative(ctx.cwd, absPath), mtime }
        })
      )
      withMtime.sort((a, b) => b.mtime - a.mtime)
      const sorted = withMtime.slice(0, cap).map(({ rel }) => rel)
      const truncated = matches.length > cap

      const header = `Found ${sorted.length} file(s)${truncated ? ` (showing first ${cap} by mtime)` : ""} for "${glob_pattern}":`
      return {
        success: true,
        output: `${header}\n\n${sorted.join("\n")}`,
      }
    } catch (err) {
      return { success: false, output: `glob failed: ${(err as Error).message}` }
    }
  },
}
