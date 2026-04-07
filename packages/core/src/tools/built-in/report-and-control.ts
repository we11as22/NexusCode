import { z } from "zod"
import type { ToolDef, ToolContext, UserQuestionRequest, UserQuestionItem } from "../../types.js"
import { buildUserQuestionOptionsFromRows, coerceQuestionOptionRows, normalizeCustomOptionLabel } from "../user-question-utils.js"

const questionOptionRowSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
})

const optionalStructuredQuestionOptionsSchema = z.preprocess(
  (val) => {
    if (val === undefined || val === null) return undefined
    const rows = coerceQuestionOptionRows(val)
    return rows.length > 0 ? rows : undefined
  },
  z.array(questionOptionRowSchema).optional(),
)

const askQuestionItemSchema = z.object({
  id: z.string().optional().describe("Optional stable id for this question"),
  header: z.string().optional().describe("Very short chip/tag label for this question (OpenClaude-style, e.g. \"Auth method\")."),
  question: z.string().describe("The question to ask the user"),
  /** If empty or one item, core pads with generic brief/detailed choices. */
  options: optionalStructuredQuestionOptionsSchema.describe(
    "Options: string[], CSV string, or objects { label, description?, preview? }. Host pads if fewer than two. Do not use preview when multi_select is true.",
  ),
  multi_select: z.boolean().optional().describe(
    "When true, the user may pick multiple options; answers are comma-separated. Previews are disallowed in this mode.",
  ),
  allow_custom: z.boolean().optional().describe("Deprecated — ignored. The UI always adds exactly one “Other/custom” row; do not put Other/custom in options."),
})

const askSchema = z.object({
  question: z.string().optional().describe("Single legacy question to ask the user"),
  header: z.string().optional().describe("Chip/tag for the legacy single-question shape."),
  options: optionalStructuredQuestionOptionsSchema.describe(
    "Suggested answers: strings, CSV, or { label, description?, preview? } rows (if omitted, generic choices are added).",
  ),
  multi_select: z.boolean().optional().describe("Legacy single-question multi-select toggle."),
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
}).superRefine((data, ctx) => {
  if (Array.isArray(data.questions) && data.questions.length > 0) {
    for (let qi = 0; qi < data.questions.length; qi++) {
      const q = data.questions[qi]!
      if (!q.multi_select) continue
      const opts = q.options ?? []
      for (let oi = 0; oi < opts.length; oi++) {
        const p = opts[oi]?.preview
        if (typeof p === "string" && p.trim().length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "preview is not allowed when multi_select is true (OpenClaude rule)",
            path: ["questions", qi, "options", oi, "preview"],
          })
        }
      }
    }
    return
  }
  if (data.multi_select) {
    const opts = data.options ?? []
    for (let oi = 0; oi < opts.length; oi++) {
      const p = opts[oi]?.preview
      if (typeof p === "string" && p.trim().length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "preview is not allowed when multi_select is true (OpenClaude rule)",
          path: ["options", oi, "preview"],
        })
      }
    }
  }
})

type AskFollowupQuestionArgs = z.output<typeof askSchema>

function normalizeQuestionRequest(input: AskFollowupQuestionArgs): UserQuestionRequest {
  const customOptionLabel = normalizeCustomOptionLabel(input.custom_option_label)
  const fromItem = (
    item: z.infer<typeof askQuestionItemSchema>,
    index: number,
  ): UserQuestionItem => {
    const multiSelect = Boolean(item.multi_select)
    return {
      id: item.id?.trim() || `question_${index + 1}`,
      header: item.header?.trim() || undefined,
      question: item.question.trim(),
      multiSelect: multiSelect || undefined,
      options: buildUserQuestionOptionsFromRows(item.options ?? [], multiSelect, customOptionLabel, index),
      allowCustom: true,
    }
  }

  const questions: UserQuestionItem[] =
    Array.isArray(input.questions) && input.questions.length > 0
      ? input.questions.map((item, index) => fromItem(item, index))
      : [{
          id: "question_1",
          question: input.question!.trim(),
          header: input.header?.trim() || undefined,
          multiSelect: input.multi_select || undefined,
          options: buildUserQuestionOptionsFromRows(
            input.options ?? [],
            Boolean(input.multi_select),
            customOptionLabel,
            0,
          ),
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
  description: `Ask the user a clarifying question when you cannot proceed without their input. (Parity intent: OpenClaude \`AskUserQuestion\` — gather preferences, resolve ambiguity, choose between approaches while you work.)

When to use:
- Genuinely blocked: choice between options, missing config, ambiguous requirement that tools cannot resolve.
- After doing all non-blocked work; ask one focused question at a time (or one tight multi-question panel).
- Product or design choices only the user can decide (requirements, tradeoffs, edge-case priority).

When NOT to use:
- Anything discoverable with tools (config, codebase, grep, docs).
- Permission or approval prompts ("Should I run tests?", "Is my plan ready?"). For tests, run them when relevant. For plan handoff in **plan** mode, use \`PlanExit\`, not \`AskFollowupQuestion\`.
- Phrases that ask for **plan approval** or "how the plan looks" in any form — those belong in \`PlanExit\`, not here (even as normal text in the chat).

Plan mode (critical — matches OpenClaude plan UX):
- The user **cannot see** the plan file in the UI until \`PlanExit\`. Do **not** reference "the plan" in question text (e.g. "feedback on the plan?", "does the plan look good?", "changes before we start?"). Ask about **requirements and approaches** only. Use \`PlanExit\` when the written plan is ready for approval.

Options (OpenClaude-style):
- Prefer structured rows: \`{ "label": "Vitest (Recommended)", "description": "Fast, native ESM" }\` with optional \`preview\` (markdown: snippets, mockups, comparisons). **Never** set \`preview\` when \`multi_select\` is true — hosts hide previews for multi-select.
- \`multi_select: true\` when choices are not mutually exclusive; user answers are comma-separated in the injected user message.
- Optional \`header\` per question: very short chip (e.g. \`"Library"\`, \`"Auth"\`).
- Plain string arrays and CSV strings still work. Short labels; put **(Recommended)** on the first option when applicable.
- Do not add Other/custom yourself; the UI injects exactly one custom row.

Prefer making a reasonable choice and stating the assumption over asking. Examples of when NOT to ask:
- "Should I run tests?" → just run them
- "Which file format?" → pick the one already used in the project
- "Is it okay if I create X file?" → just create it

Structured questionnaire mode:
- Use \`questions\` to ask multiple tightly related questions in one panel.
- Each question should include real answer options when possible. If you omit options or send fewer than two, the host pads with generic choices so the UI can render.
- Prefer \`options\` as a JSON array of strings or \`{ label, description?, preview? }\` objects. A single comma-separated string is also accepted (e.g. \`"A, B, C"\`).
- For batching multiple AskFollowupQuestion calls, prefer \`Parallel\` with only AskFollowupQuestion entries; the host will merge them into one questionnaire.

Turn boundary (OpenClaude-style):
- After \`AskFollowupQuestion\`, **end your turn** — do not call other tools in the same assistant step. The run pauses until the user answers; continue in the **next** turn with their reply.
- Prefer **one** blocking question per pause (or one merged questionnaire). Do not chain unrelated AskFollowupQuestion rounds without doing work between them.`,
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

