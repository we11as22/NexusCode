import { z } from "zod"
import * as path from "node:path"
import type { ToolDef, ToolContext, DiagnosticItem } from "../../types.js"

const readLintsSchema = z.object({
  paths: z
    .array(z.string())
    .optional()
    .describe(
      "Optional. Paths to files or directories (relative to project root). If provided, returns diagnostics only for these paths. If omitted, returns diagnostics for the whole workspace (capped)."
    ),
  task_progress: z.string().optional(),
})

const MAX_DIAGNOSTICS = 100

/** Filter diagnostics to those under the given paths (prefix or exact file match). */
function filterByPaths(items: DiagnosticItem[], paths: string[], cwd: string): DiagnosticItem[] {
  if (paths.length === 0) return items
  const normalizedPaths = paths.map((p) => {
    const resolved = path.resolve(cwd, p).replace(/\\/g, "/")
    const rel = path.relative(cwd, resolved).replace(/\\/g, "/")
    return rel.startsWith("..") ? p.replace(/\\/g, "/") : rel
  })
  return items.filter((d) => {
    const fileNorm = d.file.replace(/\\/g, "/")
    return normalizedPaths.some((p) => fileNorm === p || fileNorm.startsWith(p + "/"))
  })
}

export const readLintsTool: ToolDef<z.infer<typeof readLintsSchema>> = {
  name: "read_lints",
  description: `Read linter/compiler diagnostics (errors, warnings) from the workspace. Use when you need to check for issues in specific files after editing or before finishing.

When to use:
- After editing files: call read_lints with the paths you changed to see current errors/warnings.
- Before final_report_to_user (when finishing): optionally check that your changes did not introduce new errors.
- Prefer passing paths to limit output; the system prompt may already include a snapshot of active diagnostics at turn start.

When NOT to use:
- NEVER call this tool on a file unless you have edited it or are about to edit it. Do not call read_lints on the whole workspace without paths unless you need a global snapshot (output is capped).
- In CLI/server mode diagnostics are not available (only in the VS Code extension); the tool will return an explanatory message — use execute_command to run the linter (e.g. eslint, tsc) if needed.

Parameters:
- paths: optional array of file or directory paths (relative to project root). If omitted, returns up to ${MAX_DIAGNOSTICS} diagnostics from the whole workspace.`,
  parameters: readLintsSchema,
  readOnly: true,

  async execute({ paths: pathsArg }, ctx: ToolContext) {
    if (!ctx.host.getProblems) {
      return {
        success: true,
        output:
          "Linter diagnostics are only available in the VS Code extension. In CLI or server mode, run the linter manually (e.g. eslint, tsc) via execute_command if needed.",
      }
    }

    try {
      let diagnostics = await ctx.host.getProblems()
      if (pathsArg && pathsArg.length > 0) {
        diagnostics = filterByPaths(diagnostics, pathsArg, ctx.cwd)
      }
      if (diagnostics.length === 0) {
        const scope = pathsArg?.length ? ` for the specified path(s)` : ""
        return { success: true, output: `No linter errors or warnings${scope}.` }
      }
      const capped = diagnostics.slice(0, MAX_DIAGNOSTICS)
      const lines = capped.map(
        (d) => `[${d.severity.toUpperCase()}] ${d.file}:${d.line}:${d.col} — ${d.message}`
      )
      const truncated = diagnostics.length > MAX_DIAGNOSTICS
      const header = truncated
        ? `Found ${diagnostics.length} diagnostic(s), showing first ${MAX_DIAGNOSTICS}:`
        : `Found ${capped.length} diagnostic(s):`
      return {
        success: true,
        output: `${header}\n\n${lines.join("\n")}`,
      }
    } catch (err) {
      return { success: false, output: `read_lints failed: ${(err as Error).message}` }
    }
  },
}
