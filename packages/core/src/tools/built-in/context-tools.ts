import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

/**
 * Condense — compress conversation context.
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
 * Plan exit — signal that planning is complete (Kilocode/OpenCode-style).
 * Only available in plan mode. Ends the agent loop; host may show "Ready to implement?" (New session / Continue here).
 */
const planExitSchema = z.object({
  summary: z.string().optional().describe("Optional brief summary of the plan for the user"),
  task_progress: z.string().optional(),
})

export const planExitTool: ToolDef<z.infer<typeof planExitSchema>> = {
  name: "PlanExit",
  description: `Signal that planning is complete (plan mode only). Call once you have finalized the plan file and are ready for user approval. This ends your planning turn and hands control to the user.

Call this tool:
- After you have written or updated the plan via \`Write\` / \`Edit\` under \`.nexus/plans/*.md\` or \`.txt\`. PlanExit is rejected until this **session** has at least one **completed** plan-file \`Write\` or \`Edit\` (same turn as PlanExit is OK). Files present only on disk from before your tool calls do **not** satisfy the gate.
- When you are confident the plan is ready for implementation (and any blocking questions have been resolved via AskFollowupQuestion).
- When your summary for the user is short and high-signal; the detailed plan belongs in the plan file, not in the tool args.

When NOT to use:
- For research-only tasks (searching, reading, understanding the codebase) — do NOT use PlanExit. Use it only when the task requires planning the implementation steps of code changes.
- Do NOT use AskFollowupQuestion to ask "Is my plan ready?" or "Should I proceed?" — that is what PlanExit does. Use PlanExit to request approval of your plan.
- Do NOT call before you have created or finalized the plan file, or if you still have unresolved blocking questions.`,
  parameters: planExitSchema,
  modes: ["plan"],

  async execute(args, _ctx: ToolContext) {
    const summary = args.summary?.trim() ?? "Plan is ready."
    return { success: true, output: `Plan complete.\n\n${summary}` }
  },
}
