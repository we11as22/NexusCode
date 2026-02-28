import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  result: z.string().describe("Summary of what was accomplished"),
  command: z.string().optional().describe("Optional command to run to demonstrate the result (e.g., 'npm run dev', 'open index.html')"),
  task_progress: z.string().optional(),
})

export const attemptCompletionTool: ToolDef<z.infer<typeof schema>> = {
  name: "attempt_completion",
  description: `Signal that the task is complete and present the result to the user.
Call this when you have finished the task and want to present the outcome.
Include a clear summary of what was accomplished.
Optionally include a command that demonstrates the result.
This ends the current agent loop.`,
  parameters: schema,

  async execute({ result, command }, ctx: ToolContext) {
    let output = result
    if (command) {
      output += `\n\nTo see the result, run:\n\`\`\`\n${command}\n\`\`\``
    }
    return { success: true, output }
  },
}

const askSchema = z.object({
  question: z.string().describe("The question to ask the user"),
  options: z.array(z.string()).optional().describe("Optional list of suggested answers"),
  task_progress: z.string().optional(),
})

export const askFollowupTool: ToolDef<z.infer<typeof askSchema>> = {
  name: "ask_followup_question",
  description: `Ask the user a clarifying question when you need more information to proceed.
Use this sparingly — only when you genuinely cannot proceed without the information.
Don't ask obvious questions. Don't ask multiple questions in one call.`,
  parameters: askSchema,

  async execute({ question, options }, ctx: ToolContext) {
    const optionsStr = options && options.length > 0
      ? `\n\nOptions:\n${options.map(o => `- ${o}`).join("\n")}`
      : ""
    const formatted = `${question}${optionsStr}`

    // Show approval dialog to get user response
    const result = await ctx.host.showApprovalDialog({
      type: "read",
      tool: "ask_followup_question",
      description: formatted,
    })

    return {
      success: true,
      output: result.approved ? "User acknowledged the question." : "User declined to answer.",
    }
  },
}

const todoSchema = z.object({
  todo: z.string().describe("Complete todo list in markdown checklist format:\n- [x] Completed item\n- [ ] Pending item"),
})

export const updateTodoTool: ToolDef<z.infer<typeof todoSchema>> = {
  name: "update_todo_list",
  description: `Update the current task's todo/checklist.
Use markdown format: "- [ ] item" for pending, "- [x] item" for done.
Update this frequently to show your progress.
Keep it concise — focus on meaningful milestones, not micro-steps.`,
  parameters: todoSchema,

  async execute({ todo }, ctx: ToolContext) {
    ctx.session.updateTodo(todo)
    return { success: true, output: "Todo list updated." }
  },
}

const createRuleSchema = z.object({
  content: z.string().describe("Rule content in markdown format"),
  filename: z.string().optional().describe("Filename (default: rule-{timestamp}.md)"),
  global: z.boolean().optional().describe("Save to global rules (~/.nexus/rules/) instead of project"),
})

export const createRuleTool: ToolDef<z.infer<typeof createRuleSchema>> = {
  name: "create_rule",
  description: `Create a new rule in .nexus/rules/ to guide future interactions.
Rules are automatically loaded in future sessions.
Use this to codify project conventions, preferences, or important context.`,
  parameters: createRuleSchema,

  async execute({ content, filename, global: isGlobal }, ctx: ToolContext) {
    const { writeFile, mkdir } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { homedir } = await import("node:os")

    const dir = isGlobal
      ? join(homedir(), ".nexus", "rules")
      : join(ctx.cwd, ".nexus", "rules")

    await mkdir(dir, { recursive: true })

    const name = filename ?? `rule-${Date.now()}.md`
    const filePath = join(dir, name)
    await writeFile(filePath, content, "utf8")

    return { success: true, output: `Created rule: ${filePath}` }
  },
}
