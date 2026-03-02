import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

/**
 * Condense — compress conversation context (Cline-style).
 * Triggers LLM-based compaction so the next turn has a summary of prior messages.
 */
const condenseSchema = z.object({
  reason: z.string().optional().describe("Brief reason for condensing (e.g. context getting long)"),
  task_progress: z.string().optional(),
})

export const condenseTool: ToolDef<z.infer<typeof condenseSchema>> = {
  name: "condense",
  description: `Request conversation context compaction. Prior messages are summarized so you can continue within the context window.

When to use:
- Context usage is high (check Environment "Context: X / Y tokens") and the dialogue is long.
- You want to free tokens while keeping task context; then continue the task.

When NOT to use:
- Short conversations or when context is not near the limit.
- When you need exact prior code or output — compaction loses detail; use for high-level summary only.`,
  parameters: condenseSchema,
  readOnly: true,

  async execute(_args, ctx: ToolContext) {
    if (!ctx.compactSession) {
      return { success: false, output: "Context compaction is not available in this session." }
    }
    await ctx.compactSession()
    return { success: true, output: "Context has been condensed. A summary of the conversation has been added; you can continue with the task." }
  },
}

/**
 * Summarize task — brief summary of the current task state (Cline-style).
 */
const summarizeTaskSchema = z.object({
  task_progress: z.string().optional(),
})

export const summarizeTaskTool: ToolDef<z.infer<typeof summarizeTaskSchema>> = {
  name: "summarize_task",
  description: `Request a summary of the current task and conversation state. Triggers compaction and adds a summary to context.

When to use:
- Long conversation and you need a refreshed view of goal and progress.
- Before a long chain of tool calls to keep context manageable.

When NOT to use:
- Short sessions or when you have clear recent context.`,
  parameters: summarizeTaskSchema,
  readOnly: true,

  async execute(_args, ctx: ToolContext) {
    if (!ctx.compactSession) {
      return { success: false, output: "Summarization is not available in this session." }
    }
    await ctx.compactSession()
    return { success: true, output: "Task summary has been generated and added to the conversation context." }
  },
}

/**
 * Plan exit — signal that planning is complete (OpenCode-style).
 * Only available in plan mode. Ends the agent loop like attempt_completion.
 */
const planExitSchema = z.object({
  summary: z.string().describe("Brief summary of the plan for the user"),
  task_progress: z.string().optional(),
})

export const planExitTool: ToolDef<z.infer<typeof planExitSchema>> = {
  name: "plan_exit",
  description: `Signal that planning is complete (plan mode only). Call after writing the plan to .nexus/plans/ and present a short summary to the user. Ends the turn like attempt_completion in agent mode.`,
  parameters: planExitSchema,
  modes: ["plan"],

  async execute({ summary }, ctx: ToolContext) {
    return { success: true, output: `Plan complete.\n\n${summary}` }
  },
}
