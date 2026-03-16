import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

const askSchema = z.object({
  question: z.string().describe("The question to ask the user"),
  options: z.array(z.string()).optional().describe("Optional list of suggested answers"),
  task_progress: z.string().optional(),
})

export const askFollowupTool: ToolDef<z.infer<typeof askSchema>> = {
  name: "AskFollowupQuestion",
  description: `Ask the user a clarifying question when you cannot proceed without their input.

When to use:
- Genuinely blocked: choice between options, missing config, ambiguous requirement that tools cannot resolve.
- After doing all non-blocked work; ask one focused question at a time.

When NOT to use:
- Information you can get via tools (read config, search codebase, grep).
- Permission or approval prompts ("Should I run tests?", "Is my plan ready?"). For tests, just run them if relevant. For plan approval, use PlanExit (in plan mode), not AskFollowupQuestion.
- Multiple or vague questions; prefer making a reasonable choice and stating it.

Prefer making a reasonable choice and stating the assumption over asking. Examples of when NOT to ask:
- "Should I run tests?" → just run them
- "Which file format?" → pick the one already used in the project
- "Is it okay if I create X file?" → just create it
- "Does the plan look good?" (in plan mode) → use PlanExit instead`,
  parameters: askSchema,

  async execute({ question, options }, ctx: ToolContext) {
    const optionsStr = options && options.length > 0
      ? `\n\nOptions:\n${options.map(o => `- ${o}`).join("\n")}`
      : ""
    const formatted = `${question}${optionsStr}`

    // Show approval dialog to get user response
    const result = await ctx.host.showApprovalDialog({
      type: "read",
      tool: "AskFollowupQuestion",
      description: formatted,
    })

    return {
      success: true,
      output: result.approved ? "User acknowledged the question." : "User declined to answer.",
    }
  },
}

const todoSchema = z.object({
  merge: z.boolean().describe("Whether to merge the todos with the existing todos. If true, the todos will be merged into the existing todos based on the id field. If false, the new todos will replace the existing todos."),
  todos: z.array(z.object({
    id: z.string().describe("Unique identifier for the todo item"),
    content: z.string().describe("The description/content of the todo item"),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]).describe("The current status of the todo item"),
  })).describe("Array of todo items to write. When merge is true, items are merged by id; when false, they replace the list."),
})

export const todoWriteTool: ToolDef<z.infer<typeof todoSchema>> = {
  name: "TodoWrite",
  description: `Create and manage a structured task list for the current conversation. Use proactively to track progress and give the user visibility.

When to use:
- Complex multi-step tasks (3+ distinct steps)
- Non-trivial tasks requiring careful planning
- User explicitly requests a todo list
- User provides multiple tasks (numbered or comma-separated)
- After receiving new instructions — capture requirements as todos (merge=false)
- After completing tasks — mark complete with merge=true and add follow-ups
- When starting a new task — mark it in_progress (only one in_progress at a time)

When NOT to use:
- Single, straightforward tasks
- Trivial tasks with no organizational benefit (< 3 steps)
- Purely conversational or informational requests
- NEVER include operational/housekeeping steps in todos: do NOT add items for "run lint", "run tests", "search codebase", "read file X". Todo items must be deliverable milestones (e.g. "Add dark mode toggle", "Fix login validation", "Implement API endpoint").

Task states: pending | in_progress | completed | cancelled. Use merge=true to update existing todos by id; use merge=false to replace the entire list. Mark tasks completed IMMEDIATELY after finishing; do not batch completions. Prefer creating the first todo as in_progress and starting work in the same turn. Do not announce "I'm updating the todo list" — just call the tool.`,
  parameters: todoSchema,

  async execute({ merge, todos }, ctx: ToolContext) {
    const raw = ctx.session.getTodo().trim()
    let current: Array<{ id: string; content: string; status: string }> = []
    if (raw && raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw) as Array<{ id?: string; content?: string; status?: string }>
        if (Array.isArray(parsed)) {
          current = parsed
            .filter((i): i is { id: string; content: string; status: string } =>
              typeof i.id === "string" && typeof i.content === "string" && typeof i.status === "string")
            .map(i => ({ id: i.id, content: i.content, status: i.status }))
        }
      } catch {
        // ignore invalid JSON
      }
    }
    const next = merge
      ? (() => {
          const byId = new Map(current.map(t => [t.id, t]))
          for (const t of todos) {
            byId.set(t.id, { id: t.id, content: t.content, status: t.status })
          }
          return Array.from(byId.values())
        })()
      : todos.map(t => ({ id: t.id, content: t.content, status: t.status }))
    ctx.session.updateTodo(JSON.stringify(next))
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
