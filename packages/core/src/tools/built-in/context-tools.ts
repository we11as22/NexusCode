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
  name: "Condense",
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
 * Plan exit — signal that planning is complete (Kilocode/OpenCode-style).
 * Only available in plan mode. Ends the agent loop; host may show "Ready to implement?" (New session / Continue here).
 */
const planExitSchema = z.object({
  summary: z.string().optional().describe("Optional brief summary of the plan for the user"),
  task_progress: z.string().optional(),
})

export const planExitTool: ToolDef<z.infer<typeof planExitSchema>> = {
  name: "PlanExit",
  description: `Signal that planning is complete (plan mode only). Call once you have finalized the plan file and are confident it is ready. This ends your planning turn and hands control back to the user.

Call this tool:
- After you have written a complete plan to a file in \`.nexus/plans/\` (e.g. \`.nexus/plans/plan.md\`). plan_exit is rejected until at least one such file exists.
- After you have clarified any questions with the user.
- When you are confident the plan is ready for implementation.

Do NOT call this tool before you have created or finalized the plan file, or if you still have unanswered questions.`,
  parameters: planExitSchema,
  modes: ["plan"],

  async execute(args, ctx: ToolContext) {
    const summary = args.summary?.trim() ?? "Plan is ready."
    return { success: true, output: `Plan complete.\n\n${summary}` }
  },
}
