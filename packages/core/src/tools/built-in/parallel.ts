import { z } from "zod"
import { normalizeToolInputForParse } from "../../agent/tool-execution.js"
import type { ToolDef, ToolContext } from "../../types.js"

const MAX_BATCH_TOOLS = 25

const schema = z.object({
  tool_uses: z.array(z.object({
    recipient_name: z.string().describe("Tool name to call. Supports canonical names (Read, Grep), provider-style aliases (read_file, grep_search, execute_command), and namespace prefixes (functions.read_file)."),
    parameters: z.record(z.unknown()).describe("Arguments to pass to the tool"),
  })).min(1).max(MAX_BATCH_TOOLS).describe("The tools to execute in parallel. Max 25 calls per batch."),
})

type ParallelToolUse = z.infer<typeof schema>["tool_uses"][number]

type ParallelResult = {
  recipient_name: string
  resolved_name?: string
  success: boolean
  output: string
}

const ALIAS_TO_TOOL: Record<string, string> = {
  readfile: "Read",
  listdir: "List",
  listdirectory: "List",
  listdefinitions: "ListCodeDefinitions",
  readlints: "ReadLints",
  writefile: "Write",
  writetofile: "Write",
  editfile: "Edit",
  replaceinfile: "Edit",
  executecommand: "Bash",
  runterminalcmd: "Bash",
  grepsearch: "Grep",
  filesearch: "Glob",
  globfilesearch: "Glob",
  codebasesearch: "CodebaseSearch",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  askfollowupquestion: "AskFollowupQuestion",
}

function canonicalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
}

function normalizeRecipientName(rawName: string): string {
  const trimmed = rawName.trim()
  if (!trimmed) return trimmed
  const lower = trimmed.toLowerCase()
  const prefixes = ["functions.", "function.", "multi_tool_use.", "tools.", "tool."]
  const match = prefixes.find((prefix) => lower.startsWith(prefix))
  if (match) return trimmed.slice(match.length)
  return trimmed
}

function resolveTool(
  use: ParallelToolUse,
  byExactName: Map<string, ToolDef>,
  byCanonicalName: Map<string, ToolDef>,
): ToolDef | undefined {
  const normalized = normalizeRecipientName(use.recipient_name)
  const exact = byExactName.get(normalized)
  if (exact) return exact
  const canonical = canonicalizeToolName(normalized)
  const aliasedName = ALIAS_TO_TOOL[canonical]
  if (aliasedName && byExactName.has(aliasedName)) return byExactName.get(aliasedName)
  return byCanonicalName.get(canonical)
}

export const parallelTool: ToolDef<z.infer<typeof schema>> = {
  name: "Parallel",
  description: `Run multiple independent read-only tools in a single call. Use this to batch discovery work (e.g. several Read or Grep calls) instead of calling them one by one.

- Pass tool_uses: an array of { recipient_name, parameters } for each tool to run.
- recipient_name can be canonical (Read), provider-style alias (read_file), or namespaced alias (functions.read_file).
- Maximum 25 tool calls per batch.
- Only read-only tools are allowed in Parallel. Write/Edit/Bash and other mutating tools must be called directly.
- All tools in the array run in parallel; results are combined and returned in order.
- Use when operations do not depend on each other's output. When one tool's result is needed to decide the next, call tools sequentially instead.`,
  parameters: schema,
  readOnly: true,

  async execute({ tool_uses }, ctx: ToolContext) {
    const tools = ctx.resolvedTools ?? []
    if (tools.length === 0) {
      return { success: false, output: "Parallel is not available: no resolved tools in context." }
    }

    const byExactName = new Map(tools.map((tool) => [tool.name, tool]))
    const byCanonicalName = new Map<string, ToolDef>(
      tools.map((tool) => [canonicalizeToolName(tool.name), tool]),
    )

    const promises = tool_uses.map(async (use): Promise<ParallelResult> => {
      const tool = resolveTool(use, byExactName, byCanonicalName)
      if (!tool) {
        return {
          recipient_name: use.recipient_name,
          success: false,
          output: `Unknown tool: ${use.recipient_name}. Available: ${[...byExactName.keys()].join(", ")}.`,
        }
      }
      if (tool.name === "Parallel") {
        return {
          recipient_name: use.recipient_name,
          resolved_name: tool.name,
          success: false,
          output: "Nested Parallel calls are not allowed. Put all independent tools in one Parallel.tool_uses array.",
        }
      }
      if (!tool.readOnly) {
        return {
          recipient_name: use.recipient_name,
          resolved_name: tool.name,
          success: false,
          output: `Tool "${tool.name}" is not read-only and cannot be run via Parallel. Call it directly.`,
        }
      }

      let parsed: unknown
      try {
        const input = typeof use.parameters === "object" && use.parameters != null
          ? { ...use.parameters }
          : {}
        const normalized = normalizeToolInputForParse(tool.name, input as Record<string, unknown>)
        parsed = tool.parameters.parse(normalized)
      } catch (err) {
        return {
          recipient_name: use.recipient_name,
          resolved_name: tool.name,
          success: false,
          output: `Invalid arguments: ${err}`,
        }
      }
      try {
        const result = await tool.execute(parsed as Record<string, unknown>, ctx)
        return {
          recipient_name: use.recipient_name,
          resolved_name: tool.name,
          success: result.success,
          output: result.output,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          recipient_name: use.recipient_name,
          resolved_name: tool.name,
          success: false,
          output: `Error: ${msg}`,
        }
      }
    })

    const results = await Promise.all(promises)
    const successful = results.filter((result) => result.success).length
    const parts = [
      `Executed ${results.length} tool calls in parallel (${successful}/${results.length} successful).`,
      ...results.map((result) => {
        const label = result.resolved_name ?? result.recipient_name
        return `## ${label}\n${result.success ? result.output : `[failed] ${result.output}`}`
      }),
    ]
    const allOk = successful === results.length
    return {
      success: allOk,
      output: parts.join("\n\n"),
      metadata: {
        total: results.length,
        successful,
        results: results.map((result) => ({
          recipient_name: result.recipient_name,
          tool: result.resolved_name ?? result.recipient_name,
          success: result.success,
          output: result.output,
        })),
      },
    }
  },
}
