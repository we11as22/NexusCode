import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  reasoning_and_next_actions: z
    .string()
    .describe(
      "Your reasoning and potential next steps in one text. Required. This is stored in context for you and for summarization; include what you are considering and what you might do next."
    ),
  user_message: z
    .string()
    .optional()
    .describe(
      "Optional short message shown to the user in the chat (e.g. 'Checking auth flow.', 'Reading config next.'). If omitted, only the reasoning is recorded."
    ),
})

export const thinkingPreambleTool: ToolDef<z.infer<typeof schema>> = {
  name: "thinking_preamble",
  description: `Emit a thinking preamble before taking action: (1) reasoning_and_next_actions — your reasoning and potential next steps (required, single text); (2) user_message — optional short text shown to the user.

Use when switching context, before a batch of tools, or to record your plan. Do NOT call twice in a row; after each thinking_preamble you must call a different tool next.`,
  parameters: schema,

  async execute({ reasoning_and_next_actions, user_message }, ctx: ToolContext) {
    const messages = ctx.session.messages
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
      const parts = lastMsg.content as Array<{ type: string; tool?: string }>
      const lastTool = parts.filter((p) => p.type === "tool").pop() as { tool?: string } | undefined
      if (lastTool?.tool === "thinking_preamble") {
        return {
          success: false,
          output:
            "[BLOCKED] Do not call thinking_preamble twice in a row. Your next action MUST be a different tool (read_file, grep, write_to_file, etc.).",
        }
      }
    }

    return {
      success: true,
      output: user_message?.trim()
        ? "[Displayed to user.]"
        : "[Reasoning recorded.]",
    }
  },
}
