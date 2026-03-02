import { z } from "zod"
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

const schema = z.object({
  reads: z.array(readOp).min(1).max(25).optional().describe("Batch of file reads (path + optional line range)"),
  searches: z.array(searchOp).min(1).max(15).optional().describe("Batch of content searches (pattern/paths)"),
  replaces: z.array(replaceOp).min(1).max(20).optional().describe("Batch of replace_in_file edits (path + diff)"),
}).refine(
  (data) => (data.reads?.length ?? 0) + (data.searches?.length ?? 0) + (data.replaces?.length ?? 0) >= 1,
  { message: "Provide at least one of reads, searches, or replaces." }
)

type BatchInput = z.infer<typeof schema>

export const batchTool: ToolDef<BatchInput> = {
  name: "batch",
  description: `Run multiple read, search, or replace operations in one call. Use when you need to:
- **Read** several files (or parts of files): provide \`reads\` with path and optional start_line/end_line.
- **Search** with multiple patterns or paths: provide \`searches\` (same options as search_files).
- **Replace** in multiple files: provide \`replaces\` with path and diff (search/replace blocks).

Order of execution: all reads first (parallel), then all searches (parallel), then all replaces (sequential).
At least one of reads, searches, replaces must be non-empty. Max 25 reads, 15 searches, 20 replaces per call.`,
  parameters: schema,
  readOnly: false,

  async execute(input: BatchInput, ctx: ToolContext) {
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
