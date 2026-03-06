import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  tool_uses: z.array(z.object({
    recipient_name: z.string().describe("Name of the tool to call (must be one of the available tools)"),
    parameters: z.record(z.unknown()).describe("Arguments to pass to the tool"),
  })).min(1).describe("The tools to execute in parallel. Only built-in and MCP tools from the available list are permitted."),
})

export const parallelTool: ToolDef<z.infer<typeof schema>> = {
  name: "Parallel",
  description: `Run multiple tools in a single call. Use this to batch independent operations (e.g. several Read or Grep calls) instead of calling them one by one.

- Pass tool_uses: an array of { recipient_name, parameters } for each tool to run.
- recipient_name must match an available tool name exactly (e.g. Read, Grep, Glob, CodebaseSearch).
- All tools in the array run in parallel; results are combined and returned in order.
- Use when operations do not depend on each other's output. When one tool's result is needed to decide the next, call tools sequentially instead.`,
  parameters: schema,

  async execute({ tool_uses }, ctx: ToolContext) {
    const tools = ctx.resolvedTools ?? []
    if (tools.length === 0) {
      return { success: false, output: "Parallel is not available: no resolved tools in context." }
    }

    const byName = new Map(tools.map(t => [t.name, t]))
    const results: Array<{ name: string; success: boolean; output: string }> = []

    const promises = tool_uses.map(async (use) => {
      const tool = byName.get(use.recipient_name)
      if (!tool) {
        return { name: use.recipient_name, success: false, output: `Unknown tool: ${use.recipient_name}. Available: ${[...byName.keys()].join(", ")}.` }
      }
      let parsed: unknown
      try {
        parsed = tool.parameters.parse(use.parameters ?? {})
      } catch (err) {
        return { name: use.recipient_name, success: false, output: `Invalid arguments: ${err}` }
      }
      try {
        const result = await tool.execute(parsed as Record<string, unknown>, ctx)
        return { name: use.recipient_name, success: result.success, output: result.output }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { name: use.recipient_name, success: false, output: `Error: ${msg}` }
      }
    })

    const resolved = await Promise.all(promises)
    results.push(...resolved)

    const parts = results.map(r => `## ${r.name}\n${r.success ? r.output : `[failed] ${r.output}`}`)
    const allOk = results.every(r => r.success)
    return {
      success: allOk,
      output: parts.join("\n\n"),
      metadata: { results: results.map(r => ({ tool: r.name, success: r.success })) },
    }
  },
}
