import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

/** Tool that explicitly sends a text result to the user. Must be called at the end of each reply so the user sees a clear summary. */
const reportToUserSchema = z.object({
  message: z.string().describe("Result text for the user: what was done, key findings, and what they need to know. This is shown in the chat and included in context for the next turn."),
})

export const reportToUserTool: ToolDef<z.infer<typeof reportToUserSchema>> = {
  name: "final_report_to_user",
  description: `Send the result of your work to the user as plain text. You MUST call this at the end of every reply (after using tools) so the user sees a clear summary.

When to use:
- After any batch of tool use (exploration, edits, runs): call once with a concise summary for the user.
- When the task is done: call final_report_to_user with your final summary — this ends the turn.

The message is shown in the chat and saved for context/compaction. Keep it clear and concise.`,
  parameters: reportToUserSchema,

  async execute({ message }, ctx: ToolContext) {
    return { success: true, output: message }
  },
}

const progressNoteSchema = z.object({
  message: z.string().describe("Brief progress note for the user: what just happened, what you are about to do, or any blocker. Shown in the chat; keep it short and conversational."),
})

export const progressNoteTool: ToolDef<z.infer<typeof progressNoteSchema>> = {
  name: "progress_note",
  description: `Show the user a brief progress update. Call this so the user sees what you are doing without waiting for the final summary.

Always output the first-line JSON preamble with \`reasoning\` before calling this tool — the loop's built-in thought (Thought in UI) must come first; then call progress_note.

When to use:
- Before the first tool call each turn: one short note (e.g. "Scanning the codebase for auth logic.").
- Before each new batch of tools: note what you are about to do (e.g. "Reading the relevant files next.").
- Before ending your turn: a brief note before you call final_report_to_user with the summary.

Critical: If you say you are about to do something, do it in the same turn (call the tool right after this note). Do not use headings like "Update:"; write in a continuous conversational style. Use backticks for file/dir names.`,
  parameters: progressNoteSchema,
  readOnly: true,

  async execute({ message }, ctx: ToolContext) {
    return { success: true, output: message }
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
    description: z.string().optional().describe("Optional note for yourself (not shown in UI); use to clarify scope or context of this step."),
  })).describe("Full list of todo items; pass the complete list each time with your updates (add/check/uncheck)."),
})

export const updateTodoTool: ToolDef<z.infer<typeof todoSchema>> = {
  name: "update_todo_list",
  description: `Update the task checklist. Use frequently on multi-step tasks so the user sees progress. Structured output: pass an array of items, each with done (boolean), text (string), and optional description (string).

When to use:
- Complex tasks (3+ steps): start with a checklist, update as you complete items.
- Scope changes: rewrite the list to match new steps.

When NOT to use:
- Trivial 1–2 step tasks: optional.
- **NEVER include operational steps in todos** — Do not add items like "run lint", "run tests", "search codebase", "read file X", or "examine Y". Todos are deliverable milestones (e.g. "Add dark mode toggle", "Fix login validation"), not actions you do in service of the task.

Use description to add a note for yourself (e.g. scope, file names, acceptance criteria); it is shown only in your context, not in the UI. Create only when the session has no current todo list (see "Current Todo List" in context). If a list already exists, pass the full list with your edits (add/check/uncheck items); do not replace with a brand new list. When you call final_report_to_user to finish the turn, the list is cleared after your response so you can create a new one next time.`,
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
