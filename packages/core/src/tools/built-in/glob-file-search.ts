import { z } from "zod"
import * as path from "node:path"
import { glob } from "glob"
import type { ToolDef, ToolContext } from "../../types.js"

const MAX_RESULTS = 500

const globSchema = z.object({
  pattern: z.string().describe("The glob pattern to match files against. Patterns not starting with '**/' are searched recursively from the target directory."),
  path: z.string().optional().describe("The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided."),
  explanation: z.string().optional().describe("One sentence explanation of why this glob search is needed."),
})

export const globFileSearchTool: ToolDef<z.infer<typeof globSchema>> = {
  name: "Glob",
  description: `Fast file pattern matching that works with any codebase size.

- Supports glob patterns like "**/*.js", "src/**/*.ts", "**/test/**/test_*.ts". Patterns not starting with "**/" are searched recursively from the target directory.
- Returns matching file paths sorted by modification time (newest first). Capped at 500 results.
- Use this tool when you need to find files by name or path pattern. Prefer Glob over List when you know the pattern (e.g. all .ts files, all package.json).
- When NOT to use: finding by content → Grep; finding by meaning → CodebaseSearch; listing directory structure → List.
- For open-ended discovery that may require multiple rounds, run multiple Glob/Grep/CodebaseSearch calls in parallel in one turn, or use SpawnAgent for broad research when that will clearly save context.
- You can call multiple tools in a single response. Prefer batching multiple Glob (or Glob + Grep) calls in parallel when they are independent.`,
  parameters: globSchema,
  readOnly: true,

  async execute({ pattern: glob_pattern, path: target_directory }, ctx) {
    const cwd = target_directory ? path.resolve(ctx.cwd, target_directory) : ctx.cwd
    const cap = 500

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
