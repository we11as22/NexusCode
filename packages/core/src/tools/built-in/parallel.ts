import { z } from "zod"
import {
  coerceQuestionOptionStrings,
  formatToolValidationError,
  normalizeToolInputForParse,
} from "../../agent/tool-execution.js"
import type { ToolDef, ToolContext, UserQuestionRequest, UserQuestionItem } from "../../types.js"
import { buildUserQuestionOptions, normalizeCustomOptionLabel } from "../user-question-utils.js"

const MAX_BATCH_TOOLS = 25

const schema = z.object({
  tool_uses: z.array(
    z.object({
      recipient_name: z.string().describe("Tool name to call. Supports canonical names (Read, Grep), provider-style aliases (read_file, grep_search, execute_command), and namespace prefixes (functions.read_file)."),
      parameters: z.record(z.unknown()).describe("Arguments to pass to the tool"),
    }).passthrough()  // Allow extra fields from LLMs without failing validation
  ).min(1).max(MAX_BATCH_TOOLS).describe("The tools to execute in parallel. Max 25 calls per batch."),
}).passthrough()  // Allow extra top-level fields (e.g. recipient_name) without failing

type ParallelToolUse = z.infer<typeof schema>["tool_uses"][number]

type ParallelResult = {
  recipient_name: string
  resolved_name?: string
  success: boolean
  output: string
}

const ALIAS_TO_TOOL: Record<string, string> = {
  readfile: "Read",
  listdir: "List",
  listdirectory: "List",
  listdefinitions: "ListCodeDefinitions",
  readlints: "ReadLints",
  writefile: "Write",
  writetofile: "Write",
  editfile: "Edit",
  replaceinfile: "Edit",
  executecommand: "Bash",
  runterminalcmd: "Bash",
  grepsearch: "Grep",
  filesearch: "Glob",
  globfilesearch: "Glob",
  codebasesearch: "CodebaseSearch",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  askfollowupquestion: "AskFollowupQuestion",
  spawnagent: "SpawnAgent",
  spawnagents: "SpawnAgent",
  spawnagentoutput: "SpawnAgentOutput",
  spawnagentstop: "SpawnAgentStop",
}

function canonicalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
}

function normalizeRecipientName(rawName: string): string {
  const trimmed = rawName.trim()
  if (!trimmed) return trimmed
  const lower = trimmed.toLowerCase()
  const prefixes = ["functions.", "function.", "multi_tool_use.", "tools.", "tool."]
  const match = prefixes.find((prefix) => lower.startsWith(prefix))
  if (match) return trimmed.slice(match.length)
  return trimmed
}

function resolveTool(
  use: ParallelToolUse,
  byExactName: Map<string, ToolDef>,
  byCanonicalName: Map<string, ToolDef>,
): ToolDef | undefined {
  const normalized = normalizeRecipientName(use.recipient_name)
  const exact = byExactName.get(normalized)
  if (exact) return exact
  const canonical = canonicalizeToolName(normalized)
  const aliasedName = ALIAS_TO_TOOL[canonical]
  if (aliasedName && byExactName.has(aliasedName)) return byExactName.get(aliasedName)
  return byCanonicalName.get(canonical)
}

export const parallelTool: ToolDef<z.infer<typeof schema>> = {
  name: "Parallel",
  description: `Run multiple independent tools in a single call. Use to batch read-only discovery (e.g. several Read, Grep, CodebaseSearch, Glob, ListCodeDefinitions) and to run multiple SpawnAgent tasks concurrently.

- tool_uses: ARRAY of { recipient_name, parameters } — not a string. Each object is one tool call.
- recipient_name: tool name — canonical (Read, Grep), alias (read_file), or namespaced (functions.read_file).
- parameters: object with the tool's arguments (same as calling the tool directly).
- Maximum 25 tool calls per batch.
- Allowed in Parallel: read-only tools, and SpawnAgent.
- Write/Edit/Bash and other mutating tools must be called directly (not through Parallel).
- All tools run in parallel; results are combined and returned in order.
- For multiple SpawnAgent calls, prefer SpawnAgentsParallel (simpler, no wrapping needed).

CORRECT format:
  Parallel({tool_uses: [
    {recipient_name: "Read", parameters: {file_path: "src/foo.ts"}},
    {recipient_name: "Grep", parameters: {pattern: "class Foo", path: "src/"}}
  ]})

For concurrent sub-agents (simpler):
  SpawnAgentsParallel({agents: [
    {description: "Explore API routes"},
    {description: "Explore data store"}
  ]})`,
  parameters: schema,
  readOnly: true,

  formatValidationError(err: z.ZodError): string {
    const issues = err.issues.map(i => `  - ${i.path.join(".") || "root"}: ${i.message}`).join("\n")
    return `Invalid arguments for Parallel tool:\n${issues}\n\n` +
      `tool_uses MUST be a JSON array, not a string. Correct format:\n` +
      `  Parallel({tool_uses: [\n` +
      `    {recipient_name: "Read", parameters: {file_path: "path/to/file.ts"}},\n` +
      `    {recipient_name: "Grep", parameters: {pattern: "myFunc", path: "src/"}}\n` +
      `  ]})\n\n` +
      `For concurrent sub-agents use SpawnAgentsParallel instead:\n` +
      `  SpawnAgentsParallel({agents: [\n` +
      `    {description: "Task 1 description"},\n` +
      `    {description: "Task 2 description"}\n` +
      `  ]})`
  },

  async execute({ tool_uses }, ctx: ToolContext) {
    const tools = ctx.resolvedTools ?? []
    if (tools.length === 0) {
      return { success: false, output: "Parallel is not available: no resolved tools in context." }
    }

    const byExactName = new Map(tools.map((tool) => [tool.name, tool]))
    const byCanonicalName = new Map<string, ToolDef>(
      tools.map((tool) => [canonicalizeToolName(tool.name), tool]),
    )

    const resolvedToolUses = tool_uses
      .map((use) => ({ use, tool: resolveTool(use, byExactName, byCanonicalName) }))
    const allAskQuestions =
      resolvedToolUses.length > 0 &&
      resolvedToolUses.every(({ tool }) => tool?.name === "AskFollowupQuestion")
    const hasAnyAskQuestion = resolvedToolUses.some(({ tool }) => tool?.name === "AskFollowupQuestion")

    if (hasAnyAskQuestion && !allAskQuestions) {
      return {
        success: false,
        output: 'AskFollowupQuestion calls cannot be mixed with other tools inside one Parallel batch. Put all questions in a dedicated Parallel({ tool_uses: [...] }) call or ask a single structured AskFollowupQuestion directly.',
      }
    }

    if (allAskQuestions) {
      const questions: UserQuestionItem[] = []
      let title = ""
      let submitLabel = ""
      let customOptionLabel = ""
      for (const { use } of resolvedToolUses) {
        let rawParams = use.parameters
        if (typeof rawParams === "string") {
          try { rawParams = JSON.parse(rawParams as string) } catch {}
        }
        const input = typeof rawParams === "object" && rawParams != null ? { ...rawParams } : {}
        const normalized = normalizeToolInputForParse("AskFollowupQuestion", input as Record<string, unknown>) as Record<string, unknown>
        const nextTitle = typeof normalized.title === "string" ? normalized.title.trim() : ""
        const nextSubmitLabel = typeof normalized.submit_label === "string" ? normalized.submit_label.trim() : ""
        const nextCustomOptionLabel = typeof normalized.custom_option_label === "string" ? normalized.custom_option_label.trim() : ""
        if (!title && nextTitle) title = nextTitle
        if (!submitLabel && nextSubmitLabel) submitLabel = nextSubmitLabel
        if (!customOptionLabel && nextCustomOptionLabel) customOptionLabel = nextCustomOptionLabel
        if (Array.isArray(normalized.questions)) {
          normalized.questions.forEach((item) => {
            const q = item as Record<string, unknown>
            const options = coerceQuestionOptionStrings(q.options ?? q.choices ?? q.answers ?? q.values)
            if (typeof q.question !== "string" || q.question.trim().length === 0) return
            const idx = questions.length
            questions.push({
              id: typeof q.id === "string" && q.id.trim() ? q.id.trim() : `parallel_question_${idx + 1}`,
              question: q.question.trim(),
              options: buildUserQuestionOptions(options, normalizeCustomOptionLabel(customOptionLabel), idx),
              allowCustom: true,
            })
          })
        } else if (typeof normalized.question === "string" && normalized.question.trim()) {
          const options = coerceQuestionOptionStrings(normalized.options ?? normalized.choices ?? normalized.answers)
          const idx = questions.length
          questions.push({
            id: `parallel_question_${idx + 1}`,
            question: normalized.question.trim(),
            options: buildUserQuestionOptions(options, normalizeCustomOptionLabel(customOptionLabel), idx),
            allowCustom: true,
          })
        }
      }
      if (questions.length === 0) {
        return { success: false, output: "Parallel AskFollowupQuestion batch is empty or invalid." }
      }
      const request: UserQuestionRequest = {
        requestId: `question_request_${Date.now()}`,
        title: title || "Asking questions",
        submitLabel: submitLabel || "Continue",
        customOptionLabel: normalizeCustomOptionLabel(customOptionLabel),
        questions,
      }
      ctx.host.emit({ type: "question_request", request, partId: ctx.partId })
      return {
        success: true,
        output: "User input is required before the task can continue.",
        metadata: { questionRequest: true, request },
      }
    }

    const promises = tool_uses.map(async (use): Promise<ParallelResult> => {
      const tool = resolveTool(use, byExactName, byCanonicalName)
      if (!tool) {
        return {
          recipient_name: use.recipient_name,
          success: false,
          output: `Unknown tool: ${use.recipient_name}. Available: ${[...byExactName.keys()].join(", ")}.`,
        }
      }
      if (tool.name === "Parallel") {
        return {
          recipient_name: use.recipient_name,
          resolved_name: tool.name,
          success: false,
          output: "Nested Parallel calls are not allowed. Put all independent tools in one Parallel.tool_uses array.",
        }
      }
      const isSpawnAgent = tool.name === "SpawnAgent" || tool.name === "SpawnAgents"
      if (!tool.readOnly && !isSpawnAgent) {
        return {
          recipient_name: use.recipient_name,
          resolved_name: tool.name,
          success: false,
          output: `Tool "${tool.name}" is not read-only and cannot be run via Parallel. Call it directly.`,
        }
      }

      let parsed: unknown
      let normalized: Record<string, unknown> = {}
      try {
        // parameters may be a JSON string if LLM stringified it
        let rawParams = use.parameters
        if (typeof rawParams === "string") {
          try { rawParams = JSON.parse(rawParams as string) } catch { /* leave as-is */ }
        }
        const input = typeof rawParams === "object" && rawParams != null ? { ...rawParams } : {}
        normalized = normalizeToolInputForParse(tool.name, input as Record<string, unknown>)
        parsed = tool.parameters.parse(normalized)
      } catch (err) {
        // Use the tool's own formatValidationError if available (kilocode pattern)
        const friendlyMsg =
          err instanceof z.ZodError && tool.formatValidationError
            ? tool.formatValidationError(err)
            : err instanceof z.ZodError
              ? formatToolValidationError(tool.name, err, normalized)
              : `Invalid arguments for ${tool.name}: ${err}`
        return {
          recipient_name: use.recipient_name,
          resolved_name: tool.name,
          success: false,
          output: friendlyMsg,
        }
      }
      try {
        const result = await tool.execute(parsed as Record<string, unknown>, ctx)
        return {
          recipient_name: use.recipient_name,
          resolved_name: tool.name,
          success: result.success,
          output: result.output,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          recipient_name: use.recipient_name,
          resolved_name: tool.name,
          success: false,
          output: `Error: ${msg}`,
        }
      }
    })

    const results = await Promise.all(promises)
    const successful = results.filter((result) => result.success).length
    const parts = [
      `Executed ${results.length} tool calls in parallel (${successful}/${results.length} successful).`,
      ...results.map((result) => {
        const label = result.resolved_name ?? result.recipient_name
        return `## ${label}\n${result.success ? result.output : `[failed] ${result.output}`}`
      }),
    ]
    const allOk = successful === results.length
    return {
      success: allOk,
      output: parts.join("\n\n"),
      metadata: {
        total: results.length,
        successful,
        results: results.map((result) => ({
          recipient_name: result.recipient_name,
          tool: result.resolved_name ?? result.recipient_name,
          success: result.success,
          output: result.output,
        })),
      },
    }
  },
}
