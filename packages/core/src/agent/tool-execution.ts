import * as path from "node:path"
import { z } from "zod"
import type {
  IHost,
  ISession,
  ToolDef,
  ToolResult,
  ToolContext,
  NexusConfig,
  Mode,
  ApprovalAction,
  IIndexer,
  ToolApprovalCapability,
  ToolApprovalPolicy,
} from "../types.js"
import {
  PLAN_MODE_ALLOWED_WRITE_PATTERN,
  PLAN_MODE_BLOCKED_EXTENSIONS,
  READ_ONLY_TOOLS,
} from "./modes.js"
import { requestHostApproval } from "./approval-coordinator.js"
import { getMessagesForActiveContext } from "../session/active-context.js"
import { truncateOutput } from "../context/truncate.js"
import { registerToolOutputSpill } from "../context/tool-output-registry.js"
import { coerceQuestionOptionRows, splitQuestionOptionListString } from "../tools/user-question-utils.js"
import { extractApplyPatchPaths } from "../tools/built-in/apply-patch.js"
import { modeSpecificToolInputError } from "./mode-input-policy.js"
import { issueSandboxEscalationGrant } from "./sandbox-escalation.js"

export { modeSpecificToolInputError } from "./mode-input-policy.js"

const DOOM_LOOP_THRESHOLD = 3
const DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND = 5

export { DOOM_LOOP_THRESHOLD, DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND }

export function extractWriteTargetPath(toolName: string, toolInput: Record<string, unknown>): string | undefined {
  return extractWriteTargetPaths(toolName, toolInput)[0]
}

export function extractWriteTargetPaths(
  toolName: string,
  toolInput: Record<string, unknown>,
): string[] {
  const pathVal = toolInput["file_path"] ?? toolInput["path"]
  if (typeof pathVal === "string" && pathVal) return [pathVal]
  if (
    toolName === "ApplyPatch" &&
    typeof toolInput["patch"] === "string"
  ) {
    try {
      return extractApplyPatchPaths(toolInput["patch"])
    } catch {
      return []
    }
  }
  return []
}

function normalizePathForComparison(cwd: string, rawPath: string): string {
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath)
  return path.normalize(absolute).replace(/\\/g, "/")
}

function countPriorEditsForPathInMessage(
  session: ISession,
  messageId: string,
  cwd: string,
  targetPath: string,
): number {
  const targetNorm = normalizePathForComparison(cwd, targetPath)
  const msg = session.messages.find((m) => m.id === messageId)
  if (!msg || !Array.isArray(msg.content)) return 0
  let count = 0
  for (const part of msg.content as Array<{ type?: string; tool?: string; status?: string; input?: unknown }>) {
    if (part.type !== "tool" || part.tool !== "Edit") continue
    if (part.status !== "running" && part.status !== "completed" && part.status !== "error") continue
    const input = part.input && typeof part.input === "object" ? (part.input as Record<string, unknown>) : {}
    const candidatePath = extractWriteTargetPath("Edit", input)
    if (!candidatePath) continue
    if (normalizePathForComparison(cwd, candidatePath) === targetNorm) count++
  }
  return count
}

const MAX_TOOL_ARGS_SNIPPET_FOR_LLM = 4000

function stringifyToolInputForPrompt(input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== "object") return "(none)"
  try {
    const stripped = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "task_progress"))
    let s = JSON.stringify(stripped, null, 2)
    if (s.length > MAX_TOOL_ARGS_SNIPPET_FOR_LLM) {
      s = s.slice(0, MAX_TOOL_ARGS_SNIPPET_FOR_LLM) + "\n… [arguments truncated]"
    }
    return s
  } catch {
    return String(input)
  }
}

/**
 * Rich tool outcome for the next LLM turn: tool name, arguments, and error/outcome.
 * Session/UI store the tool `output` string (possibly truncated at execution via `truncateOutput`, KiloCode-style).
 */
export function formatToolAttemptForLanguageModel(
  toolName: string,
  input: Record<string, unknown> | undefined,
  outcome: string
): string {
  const argsBlock = stringifyToolInputForPrompt(input)
  const body = (outcome ?? "").trim() || "(no message)"
  return `[Tool attempt: ${toolName}]\nArguments:\n${argsBlock}\n\nOutcome:\n${body}`
}

/**
 * Optional metadata keys that must not affect "same arguments" detection (models often drift these between calls).
 */
const DOOM_SIGNATURE_IGNORE_KEYS = new Set([
  "task_progress",
  "reason", // Condense / similar
])

function inputForDoomSignature(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (DOOM_SIGNATURE_IGNORE_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}

/**
 * Collect finished tool parts in **active context** only (same window as the next LLM request), chronological order.
 * Pending omitted — the current call is still `pending` when we check.
 */
function collectTerminalToolParts(
  session: ISession,
): Array<{ tool: string; input: Record<string, unknown>; status: string }> {
  const out: Array<{
    tool: string
    input: Record<string, unknown>
    status: string
  }> = []
  for (const m of getMessagesForActiveContext(session.messages)) {
    if (!Array.isArray(m.content)) continue
    for (const p of m.content as Array<{ type: string; tool?: string; input?: unknown; status?: string }>) {
      if (p.type !== "tool" || !p.tool) continue
      const st = p.status
      if (st !== "completed" && st !== "error") continue
      const input = p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : {}
      out.push({ tool: p.tool, input, status: st })
    }
  }
  return out
}

/**
 * Doom loop: require an explicit host decision after repeated identical calls.
 *
 * Rules (all tools, including MCP, Write, Bash, TodoWrite, Parallel, …):
 * 1. Ignore `pending` parts (the in-flight call is not counted).
 * 2. Only look at messages in **active context** (after the latest compaction summary), not ancient session history.
 * 3. Compare arguments with noise keys stripped (`task_progress`, `reason`).
 * 4. Require a consecutive suffix of the entire tool stream. Intervening tools
 *    are progress and break the repeat chain.
 * 5. Count both success and failure. Repeating an idempotent success can burn
 *    context forever just as easily as retrying an error; the approval channel
 *    still lets an interactive user continue intentionally.
 *
 * This follows Kilo/OpenCode's status-independent repeated-call guard and
 * Kimi's "same call made no progress" recovery principle.
 */
export async function detectDoomLoop(
  session: ISession,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<boolean> {
  const threshold = toolName === "Bash" ? DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND : DOOM_LOOP_THRESHOLD
  const currentSig = getDoomLoopSignature(toolName, toolInput)
  if (toolName === "Bash" && currentSig === "") return false

  const terminal = collectTerminalToolParts(session)
  let suffixLength = 0
  for (let i = terminal.length - 1; i >= 0; i--) {
    const p = terminal[i]!
    if (p.tool !== toolName) break
    if (getDoomLoopSignature(toolName, p.input) !== currentSig) break
    suffixLength += 1
  }

  return suffixLength >= threshold
}

export function getDoomLoopSignature(toolName: string, input: Record<string, unknown>): string {
  const cleaned = inputForDoomSignature(input)
  if (toolName === "Bash") {
    const cmd = cleaned.command != null ? String(cleaned.command).trim() : ""
    return cmd
  }
  return canonicalJsonForDoomLoop(cleaned)
}

function canonicalJsonForDoomLoop(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonForDoomLoop).join(",")}]`
  }
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJsonForDoomLoop(object[key])}`,
    )
    .join(",")}}`
}

/** Ensure optional string-array param is undefined or an array of strings (gateway may send [undefined] or mixed). */
function normalizeOptionalStringArray(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined
  if (!Array.isArray(val)) return undefined
  const filtered = (val as unknown[]).filter((x): x is string => typeof x === "string")
  return filtered.length === 0 ? undefined : filtered
}

/**
 * Models often send booleans as strings (`"true"`, `"False"`) or 0/1. Used before strict Zod parse.
 */
export function coerceLooseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 1) return true
    if (value === 0) return false
    return undefined
  }
  if (typeof value === "string") {
    const s = value.trim().toLowerCase()
    if (s === "true" || s === "1" || s === "yes" || s === "y") return true
    if (s === "false" || s === "0" || s === "no" || s === "n") return false
    return undefined
  }
  return undefined
}

/** Tool name (after alias resolution) → argument keys that must be strict booleans. */
const TOOL_BOOLEAN_ARG_KEYS: Record<string, readonly string[]> = {
  List: ["recursive"],
  Grep: ["-n", "-i", "multiline"],
  Bash: ["run_in_background"],
  TodoWrite: ["merge"],
  Edit: ["replace_all"],
}

function coerceBooleanFields(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out = { ...input }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) continue
    const v = out[key]
    if (v === undefined) {
      delete out[key]
      continue
    }
    const c = coerceLooseBoolean(v)
    if (c !== undefined) {
      out[key] = c
    } else if (typeof v === "boolean") {
      out[key] = v
    } else {
      delete out[key]
    }
  }
  return out
}

/**
 * Integer fields that are plain `z.number()` in schemas (no `z.coerce`) — models often send numeric strings.
 */
function coerceNumericFields(
  input: Record<string, unknown>,
  specs: readonly { key: string; min?: number; max?: number }[],
): Record<string, unknown> {
  const out = { ...input }
  for (const { key, min, max } of specs) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) continue
    const v = out[key]
    if (v === undefined) continue
    const n = coerceLooseFiniteInt(v, { min, max })
    if (n !== undefined) out[key] = n
    else delete out[key]
  }
  return out
}

/** Parse string/number into a finite integer; optional bounds (inclusive). */
export function coerceLooseFiniteInt(
  value: unknown,
  bounds?: { min?: number; max?: number },
): number | undefined {
  if (value === undefined || value === null) return undefined
  let n: number
  if (typeof value === "number" && Number.isFinite(value)) n = value
  else if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim().replace(/_/g, ""))
    if (!Number.isFinite(parsed)) return undefined
    n = parsed
  } else {
    return undefined
  }
  const r = Math.trunc(n)
  if (!Number.isFinite(r)) return undefined
  if (bounds?.min !== undefined && r < bounds.min) return undefined
  if (bounds?.max !== undefined && r > bounds.max) return undefined
  return r
}

/**
 * Directory / path list: models send one string, newline- or comma-separated list, or a JSON array string.
 * Not used for glob `ignore` (commas can appear inside a single pattern).
 */
export function normalizeToStringArray(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined
  if (Array.isArray(val)) {
    const out: string[] = []
    for (const x of val) {
      if (typeof x === "string" && x.trim()) out.push(x.trim())
      else if (typeof x === "number" && Number.isFinite(x)) out.push(String(x))
    }
    return out.length > 0 ? out : undefined
  }
  if (typeof val === "string") {
    const s = val.trim()
    if (!s) return undefined
    if (s.startsWith("[") && s.endsWith("]")) {
      const parsed = tryParseLooseJson(s)
      const inner = normalizeToStringArray(parsed)
      if (inner && inner.length > 0) return inner
    }
    if (s.includes("\n")) {
      const parts = s.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length > 0)
      if (parts.length > 0) return parts
    }
    if (s.includes(",")) {
      const parts = s.split(",").map((x) => x.trim()).filter((x) => x.length > 0)
      if (parts.length > 1) return parts
    }
    return [s]
  }
  return undefined
}

/**
 * String[] params where a single string must stay one element (e.g. glob ignore — comma may be part of pattern).
 */
function wrapStringAsStringArray(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined
  if (Array.isArray(val)) return normalizeToStringArray(val)
  if (typeof val === "string") {
    const s = val.trim()
    if (!s) return undefined
    if (s.startsWith("[") && s.endsWith("]")) {
      const parsed = tryParseLooseJson(s)
      const inner = normalizeToStringArray(parsed)
      if (inner && inner.length > 0) return inner
    }
    return [s]
  }
  return undefined
}

const GREP_OUTPUT_MODES = new Set(["content", "files_with_matches", "count"])

function normalizeGrepOutputMode(v: unknown): unknown {
  if (typeof v !== "string") return v
  const s = v.trim().toLowerCase().replace(/\s+/g, "_")
  const aliases: Record<string, string> = {
    files: "files_with_matches",
    filenames: "files_with_matches",
    paths: "files_with_matches",
    file_list: "files_with_matches",
    names: "files_with_matches",
    lines: "content",
    matches: "content",
    text: "content",
  }
  const mapped = aliases[s] ?? s
  return GREP_OUTPUT_MODES.has(mapped) ? mapped : v
}

const CODEBASE_KINDS = new Set(["class", "function", "method", "interface", "type", "enum", "const", "any"])

function normalizeCodebaseSearchKind(v: unknown): unknown {
  if (typeof v !== "string") return v
  const s = v.trim().toLowerCase()
  return CODEBASE_KINDS.has(s) ? s : v
}

function stripPlaceholderOptionalPath(v: unknown): unknown {
  if (typeof v !== "string") return v
  const s = v.trim()
  if (s === "" || /^undefined$/i.test(s) || /^null$/i.test(s) || s === '""' || s === "''") return undefined
  return v
}

/** First non-empty string among known option/label keys (LLMs often send { label, value } instead of string[]). */
function pickFirstStringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === "string" && v.trim().length > 0) return v.trim()
  }
  return undefined
}

/**
 * Coerce model-supplied "options" shapes into a list of display strings.
 * Handles string[], mixed arrays, and { label | text | value | ... } rows.
 */
export function coerceQuestionOptionStrings(val: unknown): string[] {
  return coerceQuestionOptionRows(val).map((r) => r.label)
}

/**
 * Try to parse a JSON string that may use JS object literal syntax (unquoted keys).
 * Falls back to standard JSON.parse first, then tries a best-effort key-quoting regex.
 */
function tryParseLooseJson(s: string): unknown {
  try { return JSON.parse(s) } catch { /* fall through */ }
  try {
    // Quote unquoted identifier keys: {key: → {"key":
    // Also fix trailing commas and single-quoted strings.
    const fixed = s
      .replace(/,(\s*[}\]])/g, "$1")          // trailing commas
      .replace(/([{[,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')  // quote bare keys
    return JSON.parse(fixed)
  } catch { /* fall through */ }
  return null
}

/**
 * LLMs often send AskFollowupQuestion with `choices` instead of `options`, object-shaped option rows,
 * or `text`/`prompt` instead of `question`. Without coercion we end up with empty option lists and the
 * UI only shows generic padded labels.
 */
function normalizeAskFollowupQuestionInput(raw: Record<string, unknown>): Record<string, unknown> {
  const QUESTION_ALIASES = ["text", "prompt", "message", "body", "query", "content"] as const

  let questionsEarly: unknown = raw.questions
  if (typeof questionsEarly === "string") {
    questionsEarly = tryParseLooseJson(questionsEarly) ?? questionsEarly
  }
  const hasStructuredQuestions = Array.isArray(questionsEarly) && questionsEarly.length > 0

  const topQuestion =
    typeof raw.question === "string" && raw.question.trim().length > 0
      ? raw.question.trim()
      : !hasStructuredQuestions
        ? pickFirstStringField(raw, [...QUESTION_ALIASES])
        : undefined

  let mergedTopRows = coerceQuestionOptionRows(raw.options ?? raw.choices ?? raw.answers)
  if (mergedTopRows.length === 0) {
    const fromStringsTop = normalizeOptionalStringArray(raw.options) ?? []
    if (fromStringsTop.length > 0) mergedTopRows = fromStringsTop.map((s) => ({ label: s }))
  }

  let nextQuestions: unknown = questionsEarly
  if (Array.isArray(questionsEarly)) {
    nextQuestions = questionsEarly.map((item: unknown) => {
      if (typeof item !== "object" || item === null) return item
      const q = item as Record<string, unknown>
      const qNorm = { ...q }
      if (qNorm.multiSelect != null && qNorm.multi_select == null) {
        qNorm.multi_select = qNorm.multiSelect
      }
      if (typeof qNorm.header !== "string" && typeof qNorm.Header === "string") {
        qNorm.header = qNorm.Header
      }
      const qText =
        typeof qNorm.question === "string" && qNorm.question.trim().length > 0
          ? qNorm.question.trim()
          : pickFirstStringField(qNorm, [...QUESTION_ALIASES]) ??
            (typeof qNorm.q === "string" && qNorm.q.trim() ? qNorm.q.trim() : undefined)
      const optRows = coerceQuestionOptionRows(
        qNorm.options ?? qNorm.choices ?? qNorm.answers ?? qNorm.values,
      )
      return {
        ...qNorm,
        ...(qText ? { question: qText } : {}),
        ...(optRows.length > 0 ? { options: optRows } : {}),
      }
    })
  }

  const out: Record<string, unknown> = { ...raw }
  if (out.multiSelect != null && out.multi_select == null) {
    out.multi_select = out.multiSelect
  }
  if (typeof out.header !== "string" && typeof out.Header === "string") {
    out.header = out.Header
  }
  if (Array.isArray(nextQuestions)) {
    out.questions = nextQuestions
  }
  if (topQuestion) {
    out.question = topQuestion
  }
  out.options = mergedTopRows.length > 0 ? mergedTopRows : undefined
  return out
}

/**
 * Normalize tool input before Zod parse so gateway/API quirks (paths vs path, [undefined] in arrays) don't cause validation errors.
 * Also coerces common LLM type mistakes (string booleans, etc.) for known tools so execution-time Zod matches provider-time intent.
 */
export function normalizeToolInputForParse(
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  // Resolve gateway name so we apply the right normalizer
  const name =
    toolName === "list_dir" || toolName === "ListDirectory" || toolName === "list_directory"
      ? "List"
      : toolName === "ask_followup_question"
        ? "AskFollowupQuestion"
        : toolName

  let raw: Record<string, unknown> = input && typeof input === "object" ? { ...input } : {}
  const boolKeys = TOOL_BOOLEAN_ARG_KEYS[name]
  if (boolKeys) {
    raw = coerceBooleanFields(raw, boolKeys)
  }

  // List: only "path" (string); gateway may send "paths" (array) or paths[0] undefined
  if (name === "List") {
    const pathVal =
      typeof raw.path === "string" && raw.path.length > 0
        ? raw.path
        : Array.isArray(raw.paths) && raw.paths.length > 0 && typeof raw.paths[0] === "string"
          ? (raw.paths[0] as string)
          : "."
    const ign = wrapStringAsStringArray(raw.ignore) ?? normalizeOptionalStringArray(raw.ignore)
    return {
      path: pathVal,
      ignore: ign ?? undefined,
      recursive: raw.recursive,
      include: raw.include,
      max_entries: raw.max_entries,
      task_progress: raw.task_progress,
    }
  }
  // ReadLints: paths optional array of strings (often sent as one path string or JSON string)
  if (name === "ReadLints") {
    const paths = normalizeToStringArray(raw.paths) ?? normalizeOptionalStringArray(raw.paths)
    return { ...raw, paths: paths ?? undefined }
  }
  // CodebaseSearch: target_directories optional array of strings; kind enum case drift
  if (name === "CodebaseSearch") {
    const target_directories =
      normalizeToStringArray(raw.target_directories) ?? normalizeOptionalStringArray(raw.target_directories)
    const kind = normalizeCodebaseSearchKind(raw.kind)
    return { ...raw, target_directories: target_directories ?? undefined, kind }
  }
  // AskFollowupQuestion: coerce aliases and object-shaped options before Zod parse
  if (name === "AskFollowupQuestion") {
    return normalizeAskFollowupQuestionInput(raw)
  }
  if (name === "Skill") {
    const n =
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : typeof raw.skill === "string" && raw.skill.trim()
          ? raw.skill.trim()
          : undefined
    const out = { ...raw }
    if (n !== undefined) out.name = n
    delete out.skill
    return out
  }
  // Read: gateway/provider may send path instead of file_path; offset 0 / false / "0" means "from start" (omit key)
  if (name === "Read" || name === "read_file") {
    const {
      file_path: rawFilePath,
      path: rawPath,
      file: rawFile,
      offset: rawOffset,
      limit: rawLimit,
      ...rest
    } = raw
    const offsetNumber =
      typeof rawOffset === "number"
        ? rawOffset
        : typeof rawOffset === "string" && rawOffset.trim().length > 0
          ? Number(rawOffset)
          : undefined
    const limitNumber =
      typeof rawLimit === "number"
        ? rawLimit
        : typeof rawLimit === "string" && rawLimit.trim().length > 0
          ? Number(rawLimit)
          : undefined
    const file_path =
      typeof rawFilePath === "string" && rawFilePath.length > 0
        ? rawFilePath
        : typeof rawPath === "string" && rawPath.length > 0
          ? rawPath
          : typeof rawFile === "string" && rawFile.length > 0
            ? rawFile
            : undefined
    const out: Record<string, unknown> = { ...rest }
    if (file_path) out.file_path = file_path
    if (typeof offsetNumber === "number" && Number.isFinite(offsetNumber) && offsetNumber > 0) {
      out.offset = offsetNumber
    }
    if (typeof limitNumber === "number" && Number.isFinite(limitNumber) && limitNumber > 0) {
      out.limit = limitNumber
    }
    return out
  }
  // Grep: ignore optional array of strings; output_mode enum / alias drift
  if (name === "Grep") {
    const ignore = wrapStringAsStringArray(raw.ignore) ?? normalizeOptionalStringArray(raw.ignore)
    const output_mode = normalizeGrepOutputMode(raw.output_mode)
    return { ...raw, ignore: ignore ?? undefined, output_mode }
  }
  // Bash: timeout is z.number() — often arrives as string
  if (name === "Bash") {
    return coerceNumericFields(raw, [{ key: "timeout", min: 1, max: 600_000 }])
  }
  // WebFetch / WebSearch: numeric caps as strings
  if (name === "WebFetch") {
    return coerceNumericFields(raw, [{ key: "max_length", min: 1, max: 200_000 }])
  }
  if (name === "WebSearch") {
    return coerceNumericFields(raw, [{ key: "max_results", min: 1, max: 10 }])
  }
  // Glob: model sometimes literally sends path: "undefined"
  if (name === "Glob") {
    const next = { ...raw }
    const pc = stripPlaceholderOptionalPath(next.path)
    if (pc === undefined) {
      delete next.path
    } else {
      next.path = pc
    }
    return next
  }
  // TodoWrite: todos array sometimes JSON-stringified
  if (name === "TodoWrite") {
    let todos: unknown = raw.todos
    if (typeof todos === "string") {
      const parsed = tryParseLooseJson(todos)
      if (parsed !== null) todos = parsed
    }
    return { ...raw, todos }
  }
  // Parallel: tool_uses may arrive as a JSON string from some LLM providers.
  // Also: recipient_name may appear at the top level instead of inside each element.
  if (name === "Parallel") {
    let tool_uses = raw.tool_uses
    const topLevelRecipient = typeof raw.recipient_name === "string" ? raw.recipient_name : undefined
    if (typeof tool_uses === "string") {
      tool_uses = tryParseLooseJson(tool_uses) ?? tool_uses
    }
    if (Array.isArray(tool_uses) && topLevelRecipient) {
      tool_uses = tool_uses.map((item: unknown) => {
        if (typeof item !== "object" || item === null) return item
        const obj = item as Record<string, unknown>
        return obj.recipient_name ? obj : { recipient_name: topLevelRecipient, ...obj }
      })
    }
    return { ...raw, tool_uses }
  }
  return raw
}

export function formatToolValidationError(
  toolName: string,
  err: unknown,
  normalizedInput?: Record<string, unknown>,
): string {
  if (!(err instanceof z.ZodError)) {
    return [
      `Tool "${toolName}" failed validation: ${String(err)}`,
      "",
      "Fix the arguments and call the same tool again.",
    ].join("\n")
  }
  const issues = err.issues.map((issue) => {
    const pathLabel = issue.path.length > 0 ? issue.path.join(".") : "input"
    return `- ${pathLabel}: ${issue.message}`
  })
  const tips: string[] = []
  const offsetIssue = err.issues.some(
    (i) => i.path.join(".") === "offset" || (i.path.length === 1 && i.path[0] === "offset"),
  )
  if (toolName === "Read" && offsetIssue) {
    tips.push(
      "Read `offset` is 1-based and must be > 0 when set. To read from the start of the file, omit `offset` entirely (do not send 0).",
    )
  }
  const booleanTypeIssue = err.issues.some(
    (i) => typeof i.message === "string" && /\bboolean\b/i.test(i.message),
  )
  if (booleanTypeIssue) {
    tips.push(
      'For boolean parameters use JSON `true` or `false` only — not strings like `"False"` or `"true"`.',
    )
  }
  const numberTypeIssue = err.issues.some(
    (i) => typeof i.message === "string" && /\bnumber\b/i.test(i.message) && /\bstring\b/i.test(i.message),
  )
  if (numberTypeIssue) {
    tips.push("For numeric parameters send a JSON number (e.g. `120000`), not a quoted string.")
  }
  const arrayTypeIssue = err.issues.some(
    (i) => typeof i.message === "string" && /\barray\b/i.test(i.message) && /\bstring\b/i.test(i.message),
  )
  if (arrayTypeIssue) {
    tips.push('For array parameters send a JSON array of strings (e.g. `["src","tests"]`), not one comma-separated string.')
  }
  let received = ""
  if (normalizedInput && Object.keys(normalizedInput).length > 0) {
    try {
      const s = JSON.stringify(normalizedInput)
      received = s.length > 900 ? `${s.slice(0, 900)}…` : s
    } catch {
      received = "[unserializable input]"
    }
  }
  return [
    `Tool "${toolName}" validation failed — correct the parameters and retry:`,
    ...issues,
    ...(tips.length > 0 ? ["", ...tips] : []),
    ...(received ? ["", `Received: ${received}`] : []),
    "",
    "Call this tool again with fixed arguments.",
  ].join("\n")
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ")
}

/**
 * Prefix grants are intentionally narrower than shell syntax. They authorize
 * argv-style variations of one command, never a shell program assembled with
 * operators, expansion, redirection, comments, or environment assignments.
 * Exact grants are evaluated separately.
 */
function isSimpleCommandForPrefixGrant(command: string): boolean {
  const source = command.trim()
  if (!source) return false
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(source)) return false

  let quote: "'" | '"' | null = null
  let escaped = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (escaped) {
      if (char === "\n" || char === "\r") return false
      escaped = false
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      // Command/parameter expansion remains active inside double quotes.
      if (char === "$" || char === "`") return false
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (
      char === "\n" ||
      char === "\r" ||
      char === ";" ||
      char === "|" ||
      char === "&" ||
      char === "<" ||
      char === ">" ||
      char === "$" ||
      char === "`" ||
      char === "#" ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === "}" ||
      char === "!"
    ) {
      return false
    }
  }
  return quote === null && !escaped
}

function commandPatternPrefix(pattern: string): string {
  const trimmed = pattern.trim()
  const bashMatch = trimmed.match(/^Bash\((.+):\*\)$/)
  if (bashMatch) return normalizeCommand(bashMatch[1]!)
  if (trimmed.endsWith(":*")) {
    return normalizeCommand(trimmed.slice(0, -2))
  }
  if (trimmed.endsWith("*")) {
    return normalizeCommand(trimmed.slice(0, -1))
  }
  return normalizeCommand(trimmed)
}

function commandMatchesPattern(normalizedCommand: string, pattern: string): boolean {
  const p = pattern.trim()
  if (!p) return false
  const bashMatch = p.match(/^Bash\((.+):\*\)$/)
  if (bashMatch) {
    const prefix = normalizeCommand(bashMatch[1]!)
    return normalizedCommand === prefix || normalizedCommand.startsWith(prefix + " ")
  }
  if (p.endsWith(":*")) {
    const prefix = normalizeCommand(p.slice(0, -2))
    return normalizedCommand === prefix || normalizedCommand.startsWith(prefix + " ")
  }
  if (p.endsWith("*")) {
    const prefix = p.slice(0, -1).trim()
    return normalizedCommand === prefix || normalizedCommand.startsWith(prefix + " ")
  }
  return normalizedCommand === p
}

function commandMatchesAllowPattern(
  rawCommand: string,
  normalizedCommand: string,
  pattern: string,
): boolean {
  return (
    isSimpleCommandForPrefixGrant(rawCommand) &&
    isSimpleCommandForPrefixGrant(commandPatternPrefix(pattern)) &&
    commandMatchesPattern(normalizedCommand, pattern)
  )
}

const EXECUTION_APPROVAL_TOOLS = new Set([
  "RunPluginHook",
  "PluginTrust",
  "PluginEnable",
  "PluginConfigure",
  "PluginInstallLocal",
  "PluginRemove",
  "PluginReload",
])

interface ResolvedToolApproval {
  capability: ToolApprovalCapability
  action: ApprovalAction
  command?: string
  alwaysPrompt: boolean
}

function policyForInput(
  tool: ToolDef,
  toolInput: Record<string, unknown>,
): ResolvedToolApproval | null {
  const policy = tool.approval as
    | ToolApprovalPolicy<Record<string, unknown>>
    | undefined
  if (!policy) return null

  try {
    if (policy.when && !policy.when(toolInput)) return null
    const command = policy.command?.(toolInput)?.trim() || undefined
    const content = policy.content?.(toolInput)
    const shortDescription = policy.shortDescription?.(toolInput)
    const warning = policy.warning?.(toolInput)
    return {
      capability: policy.capability,
      command,
      alwaysPrompt: policy.alwaysPrompt === true,
      action: {
        type: policy.capability,
        tool: tool.name,
        description: policy.description(toolInput),
        ...(content ? { content } : {}),
        ...(shortDescription ? { shortDescription } : {}),
        ...(warning ? { warning } : {}),
      },
    }
  } catch {
    // Tool-owned approval metadata is part of the security boundary. A broken
    // resolver must fail closed without leaking its exception or payload.
    return {
      capability: "read",
      alwaysPrompt: true,
      action: {
        type: "read",
        tool: tool.name,
        description: `Approve sensitive tool invocation: ${tool.name}`,
        warning:
          "The tool could not describe its requested capability; approval is required.",
      },
    }
  }
}

function inferredToolApproval(
  tool: ToolDef,
  toolInput: Record<string, unknown>,
): ResolvedToolApproval | null {
  if (tool.integration?.kind === "mcp") {
    return {
      capability: "mcp",
      alwaysPrompt: false,
      action: {
        type: "mcp",
        tool: tool.name,
        description:
          `MCP ${tool.integration.serverName}/${tool.integration.originalName}`,
      },
    }
  }
  if (
    tool.integration?.kind === "custom" ||
    tool.integration?.kind === "plugin"
  ) {
    const source =
      tool.integration.kind === "plugin"
        ? `plugin ${tool.integration.pluginName}`
        : "local custom tool source"
    let content = "[unserializable custom tool arguments]"
    try {
      content = JSON.stringify(toolInput).slice(0, 4_096)
    } catch {}
    return {
      capability: "plugin",
      alwaysPrompt: true,
      action: {
        type: "plugin",
        tool: tool.name,
        description: `Run trusted ${source}: ${tool.name}`,
        content,
        warning:
          "This invokes exact-content trusted local code in an isolated worker.",
      },
    }
  }
  const fromPolicy = policyForInput(tool, toolInput)
  if (fromPolicy) return fromPolicy
  if (tool.approval) return null

  if (["Write", "Edit", "ApplyPatch"].includes(tool.name)) {
    const targets = extractWriteTargetPaths(tool.name, toolInput)
    const target =
      targets.length > 1
        ? `${targets.length} files`
        : targets[0] ?? "file"
    const content =
      typeof toolInput["content"] === "string"
        ? toolInput["content"]
        : undefined
    return {
      capability: "write",
      alwaysPrompt: false,
      action: {
        type: "write",
        tool: tool.name,
        description: `Write to ${target}`,
        ...(content ? { content } : {}),
      },
    }
  }
  if (tool.name === "Bash") {
    const command =
      typeof toolInput["command"] === "string"
        ? toolInput["command"].trim()
        : ""
    const shortDescription =
      typeof toolInput["description"] === "string"
        ? toolInput["description"].trim()
        : ""
    return {
      capability: "execute",
      command: command || undefined,
      alwaysPrompt: false,
      action: {
        type: "execute",
        tool: tool.name,
        description: `Run: ${command}`,
        ...(command ? { content: command } : {}),
        ...(shortDescription ? { shortDescription } : {}),
      },
    }
  }
  if (EXECUTION_APPROVAL_TOOLS.has(tool.name)) {
    const content = JSON.stringify(toolInput)
    return {
      capability: "plugin",
      alwaysPrompt: true,
      action: {
        type: "plugin",
        tool: tool.name,
        description: `${tool.name}: ${content.slice(0, 500)}`,
        content,
        warning:
          "This action can enable, execute, install, reconfigure, or remove trusted plugin code.",
      },
    }
  }
  if (tool.name === "Skill") {
    const name =
      typeof toolInput["name"] === "string" ? toolInput["name"] : ""
    return {
      capability: "read",
      alwaysPrompt: false,
      action: {
        type: "read",
        tool: tool.name,
        description: `Load skill: ${name || "(unnamed)"}`,
      },
    }
  }
  if (tool.name === "WebFetch") {
    const url =
      typeof toolInput["url"] === "string"
        ? toolInput["url"]
        : "(invalid URL)"
    return {
      capability: "browser",
      alwaysPrompt: false,
      action: {
        type: "browser",
        tool: tool.name,
        description: `Fetch public web content from ${url}`,
        content: url,
      },
    }
  }
  if (tool.name === "WebSearch") {
    const query =
      typeof toolInput["query"] === "string"
        ? toolInput["query"]
        : "(invalid query)"
    return {
      capability: "browser",
      alwaysPrompt: false,
      action: {
        type: "browser",
        tool: tool.name,
        description: `Search the public web for: ${query}`,
        content: query,
      },
    }
  }
  if (READ_ONLY_TOOLS.has(tool.name) || tool.readOnly) {
    return {
      capability: "read",
      alwaysPrompt: false,
      action: {
        type: "read",
        tool: tool.name,
        description: `${tool.name}(${JSON.stringify(toolInput).slice(0, 100)})`,
      },
    }
  }
  if (tool.requiresApproval) {
    return {
      capability: "read",
      alwaysPrompt: true,
      action: {
        type: "read",
        tool: tool.name,
        description: `${tool.name}(${JSON.stringify(toolInput).slice(0, 100)})`,
      },
    }
  }
  return null
}

function approvalActionForResolvedPolicy(
  tool: ToolDef,
  toolInput: Record<string, unknown>,
  approval: ResolvedToolApproval | null,
): ApprovalAction {
  return (
    approval?.action ?? {
      type: "read",
      tool: tool.name,
      description: `${tool.name}(${JSON.stringify(toolInput).slice(0, 100)})`,
    }
  )
}

export function buildApprovalAction(
  tool: ToolDef,
  toolInput: Record<string, unknown>,
): ApprovalAction {
  return approvalActionForResolvedPolicy(
    tool,
    toolInput,
    inferredToolApproval(tool, toolInput),
  )
}

function resolvedToolNeedsApproval(
  tool: ToolDef,
  toolInput: Record<string, unknown>,
  approval: ResolvedToolApproval | null,
  autoApproveActions: Set<string>,
  config: NexusConfig,
): boolean {
  if (!approval) return false
  if (approval.alwaysPrompt) return true

  if (approval.capability === "mcp") {
    const allowedMcp = config.permissions.allowedMcpTools ?? []
    if (allowedMcp.includes(tool.name)) return false
    return !(config.permissions.autoApproveMcp ?? false)
  }
  if (tool.name === "Skill") {
    return config.permissions.autoApproveSkillLoad === false
  }
  if (approval.capability === "browser") {
    return !(
      config.permissions.autoApproveBrowser === true ||
      autoApproveActions.has("browser")
    )
  }
  if (approval.capability === "read") {
    if (autoApproveActions.has("read")) return false
    if (toolInput["path"] && typeof toolInput["path"] === "string") {
      for (const pattern of config.permissions.autoApproveReadPatterns) {
        if (matchesGlob(toolInput["path"], pattern)) return false
      }
    }
    if (toolInput["file_path"] && typeof toolInput["file_path"] === "string") {
      for (const pattern of config.permissions.autoApproveReadPatterns) {
        if (matchesGlob(toolInput["file_path"], pattern)) return false
      }
    }
    return !config.permissions.autoApproveRead
  }
  if (approval.capability === "write") {
    return !config.permissions.autoApproveWrite && !autoApproveActions.has("write")
  }
  if (approval.capability === "execute") {
    const rawCommand = approval.command ?? ""
    const normalized = normalizeCommand(rawCommand)
    const denyPatterns = config.permissions.denyCommandPatterns ?? []
    const allowPatterns = config.permissions.allowCommandPatterns ?? []
    const askPatterns = config.permissions.askCommandPatterns ?? []
    const allowed = config.permissions.allowedCommands ?? []
    if (normalized && denyPatterns.some((p) => commandMatchesPattern(normalized, p))) return true
    // Repository ask-rules are restrictions and must remain able to tighten a
    // host-owned exact/prefix grant for this workspace.
    if (normalized && askPatterns.some((p) => commandMatchesPattern(normalized, p))) return true
    if (rawCommand.trim() && allowed.some((command) => command.trim() === rawCommand.trim())) {
      return false
    }
    if (
      normalized &&
      allowPatterns.some((pattern) =>
        commandMatchesAllowPattern(rawCommand, normalized, pattern)
      )
    ) {
      return false
    }
    return !config.permissions.autoApproveCommand && !autoApproveActions.has("execute")
  }
  if (approval.capability === "plugin") return true
  return false
}

export function toolNeedsApproval(
  tool: ToolDef,
  toolInput: Record<string, unknown>,
  autoApproveActions: Set<string>,
  config: NexusConfig,
): boolean {
  return resolvedToolNeedsApproval(
    tool,
    toolInput,
    inferredToolApproval(tool, toolInput),
    autoApproveActions,
    config,
  )
}

function evaluatePermissionRule(
  toolName: string,
  toolInput: Record<string, unknown>,
  config: NexusConfig
): NexusConfig["permissions"]["rules"][number] | null {
  const rules = config.permissions.rules ?? []
  let hostMatch: NexusConfig["permissions"]["rules"][number] | null = null
  let projectMatch: NexusConfig["permissions"]["rules"][number] | null = null
  for (const rule of rules) {
    if (!ruleMatchesTool(rule.tool, toolName)) continue
    if (
      rule.pathPattern &&
      !ruleMatchesPath(rule.pathPattern, toolName, toolInput)
    ) continue
    if (rule.commandPattern && !ruleMatchesCommand(rule.commandPattern, toolInput)) continue
    if (rule.authority === "project") {
      projectMatch ??= rule
    } else {
      hostMatch ??= rule
    }
    if (hostMatch && projectMatch) break
  }
  if (!hostMatch) return projectMatch
  if (!projectMatch) return hostMatch
  const priority = { allow: 1, ask: 2, deny: 3 } as const
  if (priority[projectMatch.action] > priority[hostMatch.action]) {
    return projectMatch
  }
  return hostMatch
}

function ruleMatchesTool(pattern: string | undefined, toolName: string): boolean {
  if (!pattern) return true
  if (pattern.includes("*") || pattern.includes("?")) {
    return matchesGlob(toolName, pattern)
  }
  return pattern === toolName || toolName.startsWith(pattern + "_")
}

function ruleMatchesPath(
  pathPattern: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  const filePaths = extractWriteTargetPaths(toolName, toolInput)
  if (filePaths.length > 0) {
    return filePaths.some((filePath) =>
      matchesGlob(filePath, pathPattern),
    )
  }
  const skillName = toolInput["name"] as string | undefined
  if (typeof skillName === "string" && skillName.trim()) return matchesGlob(skillName.trim(), pathPattern)
  return false
}

function ruleMatchesCommand(commandPattern: string, toolInput: Record<string, unknown>): boolean {
  const command = String(toolInput["command"] ?? "")
  try {
    return new RegExp(commandPattern).test(command)
  } catch {
    return command.includes(commandPattern)
  }
}

function matchesGlob(filePath: string, pattern: string): boolean {
  try {
    return globMatch(filePath, pattern)
  } catch {
    return filePath.includes(pattern.replace(/\*/g, ""))
  }
}

function globMatch(str: string, pattern: string): boolean {
  let regexStr = ""
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regexStr += ".*"
        i += 2
        if (pattern[i] === "/") i++
      } else {
        regexStr += "[^/]*"
        i++
      }
    } else if (c === "?") {
      regexStr += "[^/]"
      i++
    } else if (c === "{") {
      const end = pattern.indexOf("}", i)
      if (end === -1) {
        regexStr += "\\{"
        i++
        continue
      }
      const alts = pattern.slice(i + 1, end).split(",").map(escapeRegex)
      regexStr += `(?:${alts.join("|")})`
      i = end + 1
    } else {
      regexStr += escapeRegex(c)
      i++
    }
  }
  try {
    return new RegExp(`^${regexStr}$`).test(str)
  } catch {
    return str.includes(pattern.replace(/[*?{}]/g, ""))
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^$|()[\]\\]/g, "\\$&")
}

export type CompletionState = {
  doubleCheckEnabled: boolean
  pending: { current: boolean }
  checkpoint?: { commit(description?: string): Promise<string> }
}

export async function executeValidatedTool(
  toolCallId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  tools: ToolDef[],
  ctx: ToolContext,
  autoApproveActions: Set<string>,
  config: NexusConfig,
  host: IHost,
  session: ISession,
  messageId: string,
  completionState: CompletionState | undefined,
  mode: Mode,
  _mcpToolNames: Set<string>,
  prevalidatedArgs?: Record<string, unknown>,
): Promise<ToolResult> {
  const resolvedToolName =
    toolName === "list_dir" || toolName === "ListDirectory" || toolName === "list_directory"
      ? "List"
      : toolName === "ask_followup_question"
        ? "AskFollowupQuestion"
        : toolName
  const tool = tools.find(t => t.name === resolvedToolName)
  if (!tool) {
    const availableList = tools.map(t => t.name).join(", ")
    return {
      success: false,
      output: `ERROR: Tool "${toolName}" does not exist. IMPORTANT: Use ONLY these available tools: ${availableList}. To run shell commands, use Bash.`,
    }
  }

  const ctxWithPartId = ctx as ToolContext & { partId?: string; toolExecutionMessageId?: string }
  ctxWithPartId.partId ??= `part_${toolCallId}`
  ctxWithPartId.toolExecutionMessageId ??= messageId

  let validatedArgs: unknown
  let inputToParse: Record<string, unknown> =
    typeof toolInput === "object" && toolInput !== null ? { ...toolInput } : {}
  if (prevalidatedArgs) {
    validatedArgs = prevalidatedArgs
    toolInput = prevalidatedArgs
  } else {
    try {
      inputToParse = normalizeToolInputForParse(
        resolvedToolName,
        inputToParse,
      ) as Record<string, unknown>
      validatedArgs = tool.parameters.parse(inputToParse)
      if (
        validatedArgs &&
        typeof validatedArgs === "object" &&
        !Array.isArray(validatedArgs)
      ) {
        toolInput = validatedArgs as Record<string, unknown>
      }
    } catch (err) {
      if (err instanceof z.ZodError && tool.formatValidationError) {
        return { success: false, output: tool.formatValidationError(err) }
      }
      return {
        success: false,
        output: formatToolValidationError(
          resolvedToolName,
          err,
          inputToParse,
        ),
      }
    }
  }

  let validatedPlanFileWrite = false
  if (mode === "plan" && resolvedToolName === "ApplyPatch") {
    return {
      success: false,
      output:
        "ApplyPatch is disabled in plan mode. Use Write/Edit only for a plan under .nexus/plans/*.md or .txt.",
    }
  }
  if (mode === "plan" && ["Write", "Edit"].includes(resolvedToolName)) {
    const targetPath = extractWriteTargetPath(resolvedToolName, toolInput)
    if (!targetPath) {
      return {
        success: false,
        output: "In plan mode, write operations require an explicit target path under .nexus/plans/*.md or .txt.",
      }
    }
    const rel = path.isAbsolute(targetPath) ? path.relative(ctx.cwd, targetPath) : targetPath
    const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "")
    if (!PLAN_MODE_ALLOWED_WRITE_PATTERN.test(normalized)) {
      const extMatch = normalized.match(/\.[a-zA-Z0-9]+$/)
      const ext = extMatch ? extMatch[0].toLowerCase() : ""
      if (ext && PLAN_MODE_BLOCKED_EXTENSIONS.has(ext)) {
        return {
          success: false,
          output: `In plan mode you cannot modify source code files (${ext}). Write only the plan to .nexus/plans/*.md or .txt, then call PlanExit.`,
        }
      }
      return {
        success: false,
        output: "In plan mode you may only write plan documentation under .nexus/plans/ (*.md or *.txt). Do not modify source files.",
      }
    }
    validatedPlanFileWrite = true
  }

  const modeInputError = modeSpecificToolInputError(
    mode,
    resolvedToolName,
    toolInput,
  )
  if (modeInputError) {
    return {
      success: false,
      output: `ERROR: ${modeInputError}`,
    }
  }

  const resolvedApproval = inferredToolApproval(tool, toolInput)
  const permissionRule = evaluatePermissionRule(
    resolvedToolName,
    toolInput,
    config,
  )
  const ruleResult = permissionRule?.action ?? null
  if (ruleResult === "deny") {
    const ruleReason = permissionRule?.reason
    return { success: false, output: `Access denied by permission rule${ruleReason ? `: ${ruleReason}` : ""}` }
  }
  const useFileEditFlow =
    ["Write", "Edit", "ApplyPatch"].includes(resolvedToolName) &&
    ctx.changeSetService !== undefined &&
    ctx.executionIdentity !== undefined
  const fileEditApproval = useFileEditFlow
    ? {
        required:
          resolvedApproval?.alwaysPrompt === true ||
          ruleResult === "ask" ||
          (
            ruleResult === null &&
            !validatedPlanFileWrite &&
            resolvedToolNeedsApproval(
              tool,
              toolInput,
              resolvedApproval,
              autoApproveActions,
              config,
            )
          ),
        permissionRule: ruleResult === "ask",
      }
    : undefined
  let approvalGrantedByRule = false
  if (ruleResult === "ask" && !useFileEditFlow) {
    const action = approvalActionForResolvedPolicy(
      tool,
      toolInput,
      resolvedApproval,
    )
    action.description = `[Permission Rule] ${action.description}`
    const approval = await requestHostApproval(
      host,
      action,
      `part_${toolCallId}`,
      { signal: ctx.signal },
    )
    if (!approval.approved) {
      return { success: false, output: `User denied ${resolvedToolName}` }
    }
    approvalGrantedByRule = true
  }

  const writePaths = extractWriteTargetPaths(
    resolvedToolName,
    toolInput,
  )
  const writePath = writePaths[0]
  if (ruleResult === null && writePaths.length > 0) {
    for (const pattern of config.permissions.denyPatterns) {
      const deniedPath = writePaths.find((candidate) =>
        matchesGlob(candidate, pattern),
      )
      if (deniedPath) {
        return { success: false, output: `Access denied: path matches deny pattern "${pattern}"` }
      }
    }
  }

  // Kilo-style edit batching guardrail:
  // avoid many tiny sequential Edit calls to the same file in one assistant turn.
  if (resolvedToolName === "Edit" && writePath) {
    const priorEditsForSameFile = countPriorEditsForPathInMessage(session, messageId, ctx.cwd, writePath)
    if (priorEditsForSameFile >= 2) {
      return {
        success: false,
        output:
          `Too many sequential Edit calls for the same file in this turn: ${writePath}.\n` +
          `You already made ${priorEditsForSameFile} edits to this file.\n\n` +
          `Stop issuing micro-edits. Re-read the file once and apply the remaining changes in ONE larger Edit call ` +
          `using a bigger old_string context that covers all pending modifications for this file.`,
      }
    }
  }

  if (
    !useFileEditFlow &&
    !approvalGrantedByRule &&
    (ruleResult === null || resolvedApproval?.alwaysPrompt === true)
  ) {
    const needsApproval = resolvedToolNeedsApproval(
      tool,
      toolInput,
      resolvedApproval,
      autoApproveActions,
      config,
    )
    if (needsApproval) {
      const action = approvalActionForResolvedPolicy(
        tool,
        toolInput,
        resolvedApproval,
      )
      const approval = await requestHostApproval(
        host,
        action,
        `part_${toolCallId}`,
        { signal: ctx.signal },
      )
      if (!approval.approved) {
        if (approval.whatToDoInstead?.trim()) {
          session.addMessage({
            role: "user",
            content: `[Regarding the declined action: ${action.description}]\n\nDo this instead: ${approval.whatToDoInstead.trim()}`,
          })
          return {
            success: false,
            output: `User declined this action and asked to do the following instead:\n\n${approval.whatToDoInstead.trim()}\n\nContinue your work following this instruction; do not repeat the declined action.`,
          }
        }
        return { success: false, output: `User denied ${resolvedToolName}` }
      }
      if (
        approval.addToAllowedCommand != null &&
        resolvedApproval?.capability === "execute" &&
        resolvedApproval.command
      ) {
        const toAdd = normalizeCommand(approval.addToAllowedCommand)
        const approvedCommand = normalizeCommand(resolvedApproval.command)
        if (toAdd && toAdd === approvedCommand) {
          await host.addAllowedCommand?.(ctx.cwd, toAdd)
          if (!config.permissions.allowedCommands) config.permissions.allowedCommands = []
          if (!config.permissions.allowedCommands.includes(toAdd)) {
            config.permissions.allowedCommands.push(toAdd)
          }
        }
      }
      if (
        approval.addToAllowedPattern != null &&
        resolvedApproval?.capability === "execute" &&
        resolvedApproval.command
      ) {
        const pattern = approval.addToAllowedPattern.trim()
        const rawCommand = resolvedApproval.command
        const normalizedCommand = normalizeCommand(rawCommand)
        if (
          pattern &&
          commandMatchesAllowPattern(rawCommand, normalizedCommand, pattern)
        ) {
          await host.addAllowedPattern?.(ctx.cwd, pattern)
          if (!config.permissions.allowCommandPatterns) config.permissions.allowCommandPatterns = []
          if (!config.permissions.allowCommandPatterns.includes(pattern)) {
            config.permissions.allowCommandPatterns.push(pattern)
          }
        }
      }
      if (
        approval.addToAllowedMcpTool != null &&
        resolvedApproval?.capability === "mcp"
      ) {
        const allowedTool = approval.addToAllowedMcpTool.trim()
        if (allowedTool === tool.name) {
          await host.addAllowedMcpTool?.(ctx.cwd, allowedTool)
          if (!config.permissions.allowedMcpTools) config.permissions.allowedMcpTools = []
          if (!config.permissions.allowedMcpTools.includes(allowedTool)) {
            config.permissions.allowedMcpTools.push(allowedTool)
          }
        }
      }
    }
  }

  try {
    const executionContext = fileEditApproval
      ? { ...ctx, fileEditApproval }
      : ctx
    let result = await tool.execute(
      validatedArgs as Record<string, unknown>,
      executionContext,
    )

    if (
      (resolvedToolName === "Bash" || resolvedToolName === "PowerShell") &&
      result.metadata?.sandboxDenied === true &&
      typeof result.metadata.sandboxExecutionId === "string"
    ) {
      const command =
        typeof toolInput.command === "string" ? toolInput.command : ""
      const sandboxApproval = await requestHostApproval(
        host,
        {
          type: "sandbox_escalation",
          tool: resolvedToolName,
          description:
            "The OS sandbox blocked this command. Run this exact command once outside the sandbox?",
          shortDescription: "Run once outside the OS sandbox",
          content: command,
          warning:
            "This one-time run can access resources outside the workspace and is never added to an allow list.",
        },
        ctx.partId ?? `part_${toolCallId}`,
        { signal: ctx.signal },
      )
      if (!sandboxApproval.approved) {
        if (sandboxApproval.whatToDoInstead?.trim()) {
          const instruction = sandboxApproval.whatToDoInstead.trim()
          session.addMessage({
            role: "user",
            content:
              "[Regarding the declined sandbox escalation]\n\n" +
              `Do this instead: ${instruction}`,
          })
          return {
            success: false,
            output:
              "The command remained sandboxed and was not retried. " +
              `Follow the user's instruction instead: ${instruction}`,
            metadata: result.metadata,
          }
        }
        return {
          ...result,
          output:
            `${result.output}\n\n` +
            "The command was not retried outside the OS sandbox.",
        }
      }
      const sandboxEscalationGrant = issueSandboxEscalationGrant({
        executionId: result.metadata.sandboxExecutionId,
        command,
        cwd: ctx.cwd,
      })
      result = await tool.execute(
        validatedArgs as Record<string, unknown>,
        {
          ...executionContext,
          sandboxEscalationGrant,
        } as ToolContext,
      )
    }

    if (result.success && ctx.indexer && ["Write", "Edit"].includes(resolvedToolName)) {
      const targetPath = extractWriteTargetPath(resolvedToolName, validatedArgs as Record<string, unknown>)
      const refreshFile = ctx.indexer.refreshFile
      const refreshFileNow = ctx.indexer.refreshFileNow
      if (targetPath && (refreshFileNow || refreshFile)) {
        const absolutePath = path.isAbsolute(targetPath) ? targetPath : path.resolve(ctx.cwd, targetPath)
        try {
          if (refreshFileNow) {
            await refreshFileNow.call(ctx.indexer, absolutePath)
          } else if (refreshFile) {
            await refreshFile.call(ctx.indexer, absolutePath)
          }
        } catch {
          // ignore
        }
      }
    }

    // Bound every textual result, including failures from MCP/plugin tools.
    // Error payloads are just as capable of overflowing the next model request.
    if (
      typeof result.output === "string" &&
      (result.metadata as { truncated?: boolean } | undefined)?.truncated !== true
    ) {
      const truncated = await truncateOutput(result.output, {
        cwd: ctx.cwd,
        sessionId: session.id,
      })
      if (truncated.truncated) {
        if (truncated.absolutePath) {
          registerToolOutputSpill({
            cwd: ctx.cwd,
            sessionId: session.id,
            partId: ctx.partId ?? `part_${toolCallId}`,
            absolutePath: truncated.absolutePath,
            ...(truncated.artifactId
              ? { artifactId: truncated.artifactId }
              : {}),
            toolName: resolvedToolName,
          })
        }
        return {
          success: result.success,
          output: truncated.content,
          attachments: result.attachments,
          metadata: {
            ...result.metadata,
            truncated: true,
            outputPersistence: truncated.persisted,
            ...(truncated.artifactId
              ? {
                  outputArtifactId: truncated.artifactId,
                  outputArtifactOwnerSessionId: session.id,
                }
              : {}),
          },
        }
      }
    }

    return {
      success: result.success,
      output: result.output,
      attachments: result.attachments,
      metadata: result.metadata,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, output: `Tool ${toolName} error: ${msg}` }
  }
}
