import { z } from "zod"
import type { Mode } from "../../types.js"
import type { ToolDef, ToolContext } from "../../types.js"
import { readFileTool } from "./read-file.js"
import { searchFilesTool } from "./search-files.js"
import { replaceInFileTool } from "./replace-in-file.js"

const readOp = z.object({
  path: z.string().describe("File path to read"),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
})

const searchOp = z.object({
  pattern: z.string().optional(),
  patterns: z.array(z.string()).min(1).max(20).optional(),
  path: z.string().optional(),
  paths: z.array(z.string()).min(1).max(20).optional(),
  include: z.string().optional(),
  max_results: z.number().int().positive().max(500).optional(),
})

const replaceBlock = z.object({
  search: z.string(),
  replace: z.string(),
})
const replaceOp = z.object({
  path: z.string().describe("File to edit"),
  diff: z.array(replaceBlock).min(1).describe("Search/replace blocks in order"),
})

const schemaFull = z.object({
  reads: z.array(readOp).min(1).max(25).optional().describe("Batch of file reads (path + optional line range)"),
  searches: z.array(searchOp).min(1).max(15).optional().describe("Batch of content searches (pattern/paths)"),
  replaces: z.array(replaceOp).min(1).max(20).optional().describe("Batch of replace_in_file edits (path + diff)"),
}).refine(
  (data) => (data.reads?.length ?? 0) + (data.searches?.length ?? 0) + (data.replaces?.length ?? 0) >= 1,
  { message: "Provide at least one of reads, searches, or replaces." }
)

const schemaReadOnly = z.object({
  reads: z.array(readOp).min(1).max(25).optional().describe("Batch of file reads (path + optional line range)"),
  searches: z.array(searchOp).min(1).max(15).optional().describe("Batch of content searches (pattern/paths)"),
}).refine(
  (data) => (data.reads?.length ?? 0) + (data.searches?.length ?? 0) >= 1,
  { message: "Provide at least one of reads or searches." }
)

type BatchInputFull = z.infer<typeof schemaFull>
type BatchInputReadOnly = z.infer<typeof schemaReadOnly>

const DESCRIPTION_FULL = `Run multiple read, search, or replace operations in one call.

**When to use**
- You need to read several files (or regions) and/or run several content searches and/or apply several replace_in_file edits in a single step.
- Reduces round-trips: one tool call instead of many read_file/search_files/replace_in_file calls.

**Parameters**
- \`reads\`: array of { path, start_line?, end_line? }. Same semantics as read_file. Max 25.
- \`searches\`: array of search options (pattern/patterns, path/paths, include, max_results). Same as search_files. Max 15.
- \`replaces\`: array of { path, diff: [{ search, replace }, ...] }. Same as replace_in_file. Max 20.

**Order of execution**: all reads first (parallel), then all searches (parallel), then all replaces (sequential).
At least one of reads, searches, replaces must be non-empty.`

const DESCRIPTION_READ_ONLY = `Run multiple read and/or search operations in one call (no file edits).

**When to use**
- You need to read several files (or regions) and/or run several content searches in a single step.
- Reduces round-trips: one tool call instead of many read_file/search_files calls.

**Parameters**
- \`reads\`: array of { path, start_line?, end_line? }. Same semantics as read_file. Max 25.
- \`searches\`: array of search options (pattern/patterns, path/paths, include, max_results). Same as search_files. Max 15.

**Order of execution**: all reads first (parallel), then all searches (parallel).
At least one of reads or searches must be non-empty. File editing (replaces) is not available in this mode — use agent mode to change files.`

export const batchTool: ToolDef<BatchInputFull> = {
  name: "batch",
  description: DESCRIPTION_FULL,
  parameters: schemaFull,
  readOnly: false,

  async execute(input: BatchInputFull, ctx: ToolContext) {
    const sections: string[] = []

    if (input.reads?.length) {
      const results = await Promise.all(
        input.reads.map((r, i) =>
          readFileTool.execute(
            { path: r.path, start_line: r.start_line, end_line: r.end_line },
            ctx
          ).then((res) => ({ index: i, path: r.path, ...res }))
        )
      )
      for (const r of results) {
        const label = `[read ${r.index + 1}/${results.length}] ${r.path}`
        if (!r.success) {
          sections.push(`${label}\nError: ${r.output}`)
        } else {
          sections.push(`${label}\n${r.output}`)
        }
      }
    }

    if (input.searches?.length) {
      const results = await Promise.all(
        input.searches.map((s, i) =>
          searchFilesTool.execute(
            {
              pattern: s.pattern,
              patterns: s.patterns,
              path: s.path,
              paths: s.paths,
              include: s.include,
              max_results: s.max_results ?? 500,
            },
            ctx
          ).then((res) => ({ index: i, ...res }))
        )
      )
      for (const r of results) {
        const label = `[search ${r.index + 1}/${results.length}]`
        if (!r.success) {
          sections.push(`${label}\nError: ${r.output}`)
        } else {
          sections.push(`${label}\n${r.output}`)
        }
      }
    }

    if (input.replaces?.length) {
      for (let i = 0; i < input.replaces.length; i++) {
        const r = input.replaces[i]!
        const res = await replaceInFileTool.execute({ path: r.path, diff: r.diff }, ctx)
        const label = `[replace ${i + 1}/${input.replaces!.length}] ${r.path}`
        if (!res.success) {
          sections.push(`${label}\nError: ${res.output}`)
        } else {
          sections.push(`${label}\n${res.output}`)
        }
      }
    }

    return {
      success: true,
      output: sections.join("\n\n---\n\n"),
    }
  },
}

export const batchToolReadOnly: ToolDef<BatchInputReadOnly> = {
  name: "batch",
  description: DESCRIPTION_READ_ONLY,
  parameters: schemaReadOnly,
  readOnly: true,

  async execute(input: BatchInputReadOnly, ctx: ToolContext) {
    const sections: string[] = []

    if (input.reads?.length) {
      const results = await Promise.all(
        input.reads.map((r, i) =>
          readFileTool.execute(
            { path: r.path, start_line: r.start_line, end_line: r.end_line },
            ctx
          ).then((res) => ({ index: i, path: r.path, ...res }))
        )
      )
      for (const r of results) {
        const label = `[read ${r.index + 1}/${results.length}] ${r.path}`
        if (!r.success) {
          sections.push(`${label}\nError: ${r.output}`)
        } else {
          sections.push(`${label}\n${r.output}`)
        }
      }
    }

    if (input.searches?.length) {
      const results = await Promise.all(
        input.searches.map((s, i) =>
          searchFilesTool.execute(
            {
              pattern: s.pattern,
              patterns: s.patterns,
              path: s.path,
              paths: s.paths,
              include: s.include,
              max_results: s.max_results ?? 500,
            },
            ctx
          ).then((res) => ({ index: i, ...res }))
        )
      )
      for (const r of results) {
        const label = `[search ${r.index + 1}/${results.length}]`
        if (!r.success) {
          sections.push(`${label}\nError: ${r.output}`)
        } else {
          sections.push(`${label}\n${r.output}`)
        }
      }
    }

    return {
      success: true,
      output: sections.join("\n\n---\n\n"),
    }
  },
}

/**
 * Returns the batch tool definition for the given mode.
 * Only agent mode gets the full tool (reads + searches + replaces).
 * Plan and ask get the read-only variant (reads + searches only; no file edits).
 */
export function getBatchToolForMode(mode: Mode): ToolDef {
  return mode === "agent" ? batchTool : batchToolReadOnly
}
