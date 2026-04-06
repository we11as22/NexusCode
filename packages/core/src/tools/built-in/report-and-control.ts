import { z } from "zod"
import type { ToolDef, ToolContext, UserQuestionRequest, UserQuestionItem } from "../../types.js"
import { buildUserQuestionOptions, normalizeCustomOptionLabel, splitQuestionOptionListString } from "../user-question-utils.js"

/**
 * Models often send `options` as a single comma/semicolon-separated string instead of string[].
 * Coerce so Zod (and provider-side tool-arg validation) accepts both shapes.
 */
function preprocessQuestionOptions(val: unknown): unknown {
  if (val === undefined || val === null) return undefined
  if (Array.isArray(val)) {
    const out: string[] = []
    for (const el of val) {
      if (typeof el === "string" && el.trim()) {
        out.push(...splitQuestionOptionListString(el))
      } else if (el != null && (typeof el === "number" || typeof el === "boolean")) {
        out.push(String(el))
      }
    }
    return out.length > 0 ? out : undefined
  }
  if (typeof val === "string") {
    const s = val.trim()
    if (!s) return undefined
    const parts = splitQuestionOptionListString(s)
    return parts.length > 0 ? parts : undefined
  }
  return val
}

const optionalQuestionOptionsSchema = z.preprocess(
  preprocessQuestionOptions,
  z.array(z.string()).optional(),
)

const askQuestionItemSchema = z.object({
  id: z.string().optional().describe("Optional stable id for this question"),
  question: z.string().describe("The question to ask the user"),
  /** If empty or one item, core pads with generic brief/detailed choices. */
  options: optionalQuestionOptionsSchema.describe(
    "Suggested answer options as string[] OR one comma/semicolon-separated string (2+ recommended; host pads if fewer)",
  ),
  allow_custom: z.boolean().optional().describe("Deprecated — ignored. The UI always adds exactly one “Other/custom” row; do not put Other/custom in options."),
})

const askSchema = z.object({
  question: z.string().optional().describe("Single legacy question to ask the user"),
  options: optionalQuestionOptionsSchema.describe(
    "Suggested answers as string[] OR one comma/semicolon-separated string (if omitted, generic choices are added)",
  ),
  questions: z.array(askQuestionItemSchema).optional().describe("Structured multi-question form shown to the user at once"),
  title: z.string().optional().describe("Optional title for the grouped question panel"),
  submit_label: z.string().optional().describe("Optional label for the final submit button"),
  custom_option_label: z.string().optional().describe("Label for the host-added custom row (default Other). Do not duplicate this string inside options."),
  task_progress: z.string().optional(),
}).refine((value) => {
  if (Array.isArray(value.questions) && value.questions.length > 0) return true
  return typeof value.question === "string" && value.question.trim().length > 0
}, {
  message: "Provide either question or questions.",
})

/** Output shape after preprocess (options always string[] | undefined). */
type AskFollowupQuestionArgs = z.output<typeof askSchema>

function normalizeQuestionRequest(input: AskFollowupQuestionArgs): UserQuestionRequest {
  const customOptionLabel = normalizeCustomOptionLabel(input.custom_option_label)
  const questions: UserQuestionItem[] =
    Array.isArray(input.questions) && input.questions.length > 0
      ? input.questions.map((item, index) => ({
          id: item.id?.trim() || `question_${index + 1}`,
          question: item.question.trim(),
          options: buildUserQuestionOptions(item.options ?? [], customOptionLabel, index),
          allowCustom: true,
        }))
      : [{
          id: "question_1",
          question: input.question!.trim(),
          options: buildUserQuestionOptions(input.options ?? [], customOptionLabel, 0),
          allowCustom: true,
        }]

  return {
    requestId: `question_request_${Date.now()}`,
    title: input.title?.trim() || "Asking questions",
    submitLabel: input.submit_label?.trim() || "Continue",
    customOptionLabel,
    questions,
  }
}

export const askFollowupTool: ToolDef<AskFollowupQuestionArgs> = {
  name: "AskFollowupQuestion",
  description: `Ask the user a clarifying question when you cannot proceed without their input.

When to use:
- Genuinely blocked: choice between options, missing config, ambiguous requirement that tools cannot resolve.
- After doing all non-blocked work; ask one focused question at a time.
- When there is a real product or design choice the codebase cannot answer for you.

When NOT to use:
- Information you can get via tools (read config, search codebase, grep).
- Permission or approval prompts ("Should I run tests?", "Is my plan ready?"). For tests, just run them if relevant. For plan approval, use PlanExit (in plan mode), not AskFollowupQuestion.
- Multiple or vague questions unless they form one tight structured questionnaire.

Prefer making a reasonable choice and stating the assumption over asking. Examples of when NOT to ask:
- "Should I run tests?" → just run them
- "Which file format?" → pick the one already used in the project
- "Is it okay if I create X file?" → just create it
- "Does the plan look good?" (in plan mode) → use PlanExit instead

Structured questionnaire mode:
- Use \`questions\` to ask multiple tightly related questions in one panel.
- Each question should include real answer options when possible (do NOT include Other/custom; the UI adds exactly one automatically). If you omit options or send fewer than two, the host adds generic choices (brief vs detailed) so the questionnaire can render.
- Prefer \`options\` as a JSON array of strings. A single comma-separated string is also accepted (e.g. \`"A, B, C"\`).
- For batching multiple AskFollowupQuestion calls, prefer \`Parallel\` with only AskFollowupQuestion entries; the host will merge them into one questionnaire.`,
  parameters: askSchema as z.ZodType<AskFollowupQuestionArgs>,

  async execute(args, ctx: ToolContext) {
    const request = normalizeQuestionRequest(args)
    ctx.host.emit({
      type: "question_request",
      request,
      partId: ctx.partId,
    })
    return {
      success: true,
      output: "User input is required before the task can continue.",
      metadata: {
        questionRequest: true,
        request,
      },
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

Task states: pending | in_progress | completed | cancelled. Use merge=true to update existing todos by id; use merge=false to replace the entire list. Mark tasks completed IMMEDIATELY after finishing; do not batch completions. Prefer creating the first todo as in_progress and starting work in the same turn. Keep exactly one item in_progress. Do not announce "I'm updating the todo list" — just call the tool.`,
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
