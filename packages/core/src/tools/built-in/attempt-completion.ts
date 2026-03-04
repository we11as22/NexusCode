import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  result: z.string().describe("Summary of what was accomplished"),
  command: z.string().optional().describe("Optional command to run to demonstrate the result (e.g., 'npm run dev', 'open index.html')"),
  task_progress: z.string().optional(),
})

export const attemptCompletionTool: ToolDef<z.infer<typeof schema>> = {
  name: "attempt_completion",
  description: `Signal that the task is complete and present the result. Call when the user's request is fully done.

When to use:
- All requested changes are implemented and verified.
- You have a clear summary and, if useful, a demo command.

When NOT to use:
- Task only partially done: continue with tools and then call attempt_completion.
- Plan mode: use plan_exit instead.

Provide a concise summary in result. Optionally give a command to run (e.g. npm run dev, pytest). This ends the current agent turn.`,
  parameters: schema,

  async execute({ result, command }, ctx: ToolContext) {
    let output = result
    if (command) {
      const approval = await ctx.host.showApprovalDialog({
        type: "execute",
        tool: "attempt_completion",
        description: `Run demo command: ${command}`,
      })
      if (approval.approved) {
        try {
          const run = await ctx.host.runCommand(command, ctx.cwd, ctx.signal)
          const out = [run.stdout, run.stderr].filter(Boolean).join("\n").trim()
          output += `\n\nDemo command output:\n\`\`\`\n${out || "(no output)"}\n\`\`\``
        } catch (e) {
          output += `\n\nDemo command failed: ${(e as Error).message}`
        }
      } else {
        output += `\n\nTo see the result, run:\n\`\`\`\n${command}\n\`\`\``
      }
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
  description: `Ask the user a clarifying question when you cannot proceed without their input.

When to use:
- Genuinely blocked (e.g. choice between options, missing config, ambiguous requirement).
- After doing all non-blocked work; ask one focused question.

When NOT to use:
- Info you can get via tools (read config, search codebase).
- Obvious or multiple questions; prefer making a reasonable choice and stating it.
- Permission prompts ("Should I run tests?"); just run them if relevant.`,
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
  items: z.array(z.object({
    done: z.boolean().describe("Whether this item is completed"),
    text: z.string().describe("Short label for the item"),
  })).describe("Full list of todo items; pass the complete list each time with your updates (add/check/uncheck)."),
})

export const updateTodoTool: ToolDef<z.infer<typeof todoSchema>> = {
  name: "update_todo_list",
  description: `Update the task checklist. Use frequently on multi-step tasks so the user sees progress. Structured output: pass an array of items, each with done (boolean) and text (string).

When to use:
- Complex tasks (3+ steps): start with a checklist, update as you complete items.
- Scope changes: rewrite the list to match new steps.

When NOT to use:
- Trivial 1–2 step tasks: optional.
- Do not put exploratory steps (e.g. "search codebase") as todo items; focus on deliverable milestones.

Create only when the session has no current todo list (see "Current Todo List" in context). If a list already exists, pass the full list with your edits (add/check/uncheck items); do not replace with a brand new list. When you call attempt_completion, the list is cleared after your response so you can create a new one next time.`,
  parameters: todoSchema,

  async execute({ items }, ctx: ToolContext) {
    const json = JSON.stringify(items)
    ctx.session.updateTodo(json)
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
  description: `Create a rule in .nexus/rules/ (or ~/.nexus/rules/ if global) to guide future sessions. Rules are loaded automatically in later conversations.

When to use:
- Codify project conventions, preferred patterns, or tooling (e.g. "always use pnpm", "tests go in __tests__").
- Save important context that should apply to many future tasks.

When NOT to use:
- One-off task context: use @mentions or include in the message instead.
- Secrets or env-specific paths: avoid; use docs or env vars.`,
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
