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
} from "../types.js"
import { PLAN_MODE_ALLOWED_WRITE_PATTERN, PLAN_MODE_BLOCKED_EXTENSIONS, READ_ONLY_TOOLS } from "./modes.js"
import { getMessagesForActiveContext } from "../session/active-context.js"
import { truncateOutput } from "../context/truncate.js"

const DOOM_LOOP_THRESHOLD = 3
const DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND = 5

export { DOOM_LOOP_THRESHOLD, DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND }

export function extractWriteTargetPath(toolName: string, toolInput: Record<string, unknown>): string | undefined {
  const pathVal = toolInput["file_path"] ?? toolInput["path"]
  if (typeof pathVal === "string" && pathVal) return pathVal
  return undefined
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
 * Session/UI still store the shorter `output` on ToolPart; this is applied in buildMessagesFromSession only.
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
  toolName: string,
): Array<{ input: Record<string, unknown>; status: string }> {
  const out: Array<{ input: Record<string, unknown>; status: string }> = []
  for (const m of getMessagesForActiveContext(session.messages)) {
    if (!Array.isArray(m.content)) continue
    for (const p of m.content as Array<{ type: string; tool?: string; input?: unknown; status?: string }>) {
      if (p.type !== "tool" || p.tool !== toolName) continue
      const st = p.status
      if (st !== "completed" && st !== "error") continue
      const input = p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : {}
      out.push({ input, status: st })
    }
  }
  return out
}

/**
 * Doom loop: block only **repeated identical failures** (true infinite retry loops).
 *
 * Rules (all tools, including MCP, Write, Bash, TodoWrite, Parallel, …):
 * 1. Ignore `pending` parts (the in-flight call is not counted).
 * 2. Only look at messages in **active context** (after the latest compaction summary), not ancient session history.
 * 3. Compare arguments with noise keys stripped (`task_progress`, `reason`).
 * 4. Take the longest suffix of this tool with the same signature as the current call; doom iff length ≥ threshold and **every** part in the suffix is `error`.
 *
 * Any successful (`completed`) call in that suffix breaks the chain — safe for Read-after-Write, retries after transient errors,
 * repeated TodoWrite / MCP reads with the same payload, etc. Pure "success spam" is not blocked here by design.
 */
export async function detectDoomLoop(
  session: ISession,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<boolean> {
  const threshold = toolName === "Bash" ? DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND : DOOM_LOOP_THRESHOLD
  const currentSig = getDoomLoopSignature(toolName, toolInput)
  if (toolName === "Bash" && currentSig === "") return false

  const terminal = collectTerminalToolParts(session, toolName)
  const suffix: Array<{ input: Record<string, unknown>; status: string }> = []
  for (let i = terminal.length - 1; i >= 0; i--) {
    const p = terminal[i]!
    if (getDoomLoopSignature(toolName, p.input) !== currentSig) break
    suffix.push(p)
  }

  if (suffix.length < threshold) return false
  return suffix.every(p => p.status === "error")
}

export function getDoomLoopSignature(toolName: string, input: Record<string, unknown>): string {
  const cleaned = inputForDoomSignature(input)
  if (toolName === "Bash") {
    const cmd = cleaned.command != null ? String(cleaned.command).trim() : ""
    return cmd
  }
  return canonicalJsonForDoomLoop(cleaned)
}

function canonicalJsonForDoomLoop(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort()
  return JSON.stringify(obj, keys as unknown as string[])
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
  Bash: ["run_in_background", "dangerouslyDisableSandbox"],
  TodoWrite: ["merge", "allow_custom"],
  Edit: ["replace_all"],
  create_rule: ["global"],
  AskFollowupQuestion: ["allow_custom"],
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
  if (val === undefined || val === null) return []
  if (typeof val === "string") {
    const s = val.trim()
    if (!s) return []
    // Models often send one CSV string instead of string[] (e.g. "A, B, C, Other").
    if (/[,;|]/.test(s)) {
      return s
        .split(/[,;|]/)
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
    }
    return [s]
  }
  if (typeof val === "number" || typeof val === "boolean") return [String(val)]
  if (!Array.isArray(val)) return []
  const out: string[] = []
  for (const el of val) {
    if (typeof el === "string") {
      if (el.trim()) out.push(el.trim())
      continue
    }
    if (typeof el === "number" || typeof el === "boolean") {
      out.push(String(el))
      continue
    }
    if (el != null && typeof el === "object") {
      const row = el as Record<string, unknown>
      const s = pickFirstStringField(row, [
        "label",
        "text",
        "value",
        "title",
        "name",
        "option",
        "answer",
        "description",
        "content",
      ])
      if (s) out.push(s)
    }
  }
  return out
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

  const fromCoerceTop = coerceQuestionOptionStrings(raw.options ?? raw.choices ?? raw.answers)
  const fromStringsTop = normalizeOptionalStringArray(raw.options) ?? []
  const mergedTopOptions = fromCoerceTop.length > 0 ? fromCoerceTop : fromStringsTop

  let nextQuestions: unknown = questionsEarly
  if (Array.isArray(questionsEarly)) {
    nextQuestions = questionsEarly.map((item: unknown) => {
      if (typeof item !== "object" || item === null) return item
      const q = item as Record<string, unknown>
      const qText =
        typeof q.question === "string" && q.question.trim().length > 0
          ? q.question.trim()
          : pickFirstStringField(q, [...QUESTION_ALIASES]) ??
            (typeof q.q === "string" && q.q.trim() ? q.q.trim() : undefined)
      const opts = coerceQuestionOptionStrings(q.options ?? q.choices ?? q.answers ?? q.values)
      return {
        ...q,
        ...(qText ? { question: qText } : {}),
        ...(opts.length > 0 ? { options: opts } : {}),
      }
    })
  }

  const out: Record<string, unknown> = { ...raw }
  if (Array.isArray(nextQuestions)) {
    out.questions = nextQuestions
  }
  if (topQuestion) {
    out.question = topQuestion
  }
  out.options = mergedTopOptions.length > 0 ? mergedTopOptions : undefined
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
  // Exa tools (optional MCP): numeric args as strings
  if (name === "exa_web_search") {
    let n = coerceNumericFields(raw, [
      { key: "numResults", min: 1, max: 20 },
      { key: "contextMaxCharacters", min: 1, max: 500_000 },
    ])
    const liveSet = new Set(["fallback", "preferred"])
    if (typeof n.livecrawl === "string") {
      const s = n.livecrawl.trim().toLowerCase()
      if (liveSet.has(s)) n = { ...n, livecrawl: s }
    }
    const typeSet = new Set(["auto", "fast", "deep"])
    if (typeof n.type === "string") {
      const s = n.type.trim().toLowerCase()
      if (typeSet.has(s)) n = { ...n, type: s }
    }
    return n
  }
  if (name === "exa_code_search") {
    return coerceNumericFields(raw, [{ key: "tokensNum", min: 1000, max: 50_000 }])
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

function commandMatchesPattern(normalizedCommand: string, pattern: string): boolean {
  const p = pattern.trim()
  if (!p) return false
  const bashMatch = p.match(/^Bash\((.+):\*\)$/)
  if (bashMatch) {
    const prefix = normalizeCommand(bashMatch[1]!)
    return normalizedCommand === prefix || normalizedCommand.startsWith(prefix + " ")
  }
  if (p.endsWith("*")) {
    const prefix = p.slice(0, -1).trim()
    return normalizedCommand === prefix || normalizedCommand.startsWith(prefix + " ")
  }
  return normalizedCommand === p
}

export function buildApprovalAction(toolName: string, toolInput: Record<string, unknown>): ApprovalAction {
  if (["Write", "Edit"].includes(toolName)) {
    return {
      type: "write",
      tool: toolName,
      description: `Write to ${(toolInput["file_path"] ?? toolInput["path"]) ?? "file"}`,
      content: toolInput["content"] as string | undefined,
    }
  }
  if (toolName === "Bash") {
    const cmd = typeof toolInput["command"] === "string" ? toolInput["command"] : ""
    const shortDesc = typeof toolInput["description"] === "string" ? toolInput["description"] : undefined
    return {
      type: "execute",
      tool: toolName,
      description: `Run: ${cmd}`,
      content: cmd || undefined,
      shortDescription: shortDesc,
    }
  }
  if (toolName.includes("__")) {
    return {
      type: "mcp",
      tool: toolName,
      description: `MCP: ${toolName}`,
    }
  }
  return {
    type: "read",
    tool: toolName,
    description: `${toolName}(${JSON.stringify(toolInput).slice(0, 100)})`,
  }
}

export function toolNeedsApproval(
  toolName: string,
  toolInput: Record<string, unknown>,
  autoApproveActions: Set<string>,
  config: NexusConfig,
  mcpToolNames: Set<string>
): boolean {
  if (mcpToolNames.has(toolName)) {
    const allowedMcp = config.permissions.allowedMcpTools ?? []
    if (allowedMcp.includes(toolName)) return false
    return !(config.permissions.autoApproveMcp ?? false)
  }
  if (READ_ONLY_TOOLS.has(toolName)) {
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
  if (["Write", "Edit"].includes(toolName)) {
    return !config.permissions.autoApproveWrite && !autoApproveActions.has("write")
  }
  if (toolName === "Bash") {
    const cmd = typeof toolInput["command"] === "string" ? toolInput["command"] : ""
    const normalized = normalizeCommand(cmd)
    const denyPatterns = config.permissions.denyCommandPatterns ?? []
    const allowPatterns = config.permissions.allowCommandPatterns ?? []
    const askPatterns = config.permissions.askCommandPatterns ?? []
    const allowed = config.permissions.allowedCommands ?? []
    if (normalized && denyPatterns.some((p) => commandMatchesPattern(normalized, p))) return true
    if (normalized && allowPatterns.some((p) => commandMatchesPattern(normalized, p))) return false
    if (normalized && allowed.some((c) => normalizeCommand(c) === normalized)) return false
    if (normalized && askPatterns.some((p) => commandMatchesPattern(normalized, p))) return true
    return !config.permissions.autoApproveCommand && !autoApproveActions.has("execute")
  }
  return false
}

function evaluatePermissionRules(
  toolName: string,
  toolInput: Record<string, unknown>,
  config: NexusConfig
): "allow" | "deny" | "ask" | null {
  const rules = config.permissions.rules ?? []
  for (const rule of rules) {
    if (!ruleMatchesTool(rule.tool, toolName)) continue
    if (rule.pathPattern && !ruleMatchesPath(rule.pathPattern, toolInput)) continue
    if (rule.commandPattern && !ruleMatchesCommand(rule.commandPattern, toolInput)) continue
    return rule.action
  }
  return null
}

function findRuleReason(toolName: string, toolInput: Record<string, unknown>, config: NexusConfig): string | undefined {
  const rules = config.permissions.rules ?? []
  for (const rule of rules) {
    if (!ruleMatchesTool(rule.tool, toolName)) continue
    if (rule.pathPattern && !ruleMatchesPath(rule.pathPattern, toolInput)) continue
    if (rule.commandPattern && !ruleMatchesCommand(rule.commandPattern, toolInput)) continue
    return rule.reason
  }
  return undefined
}

function ruleMatchesTool(pattern: string | undefined, toolName: string): boolean {
  if (!pattern) return true
  if (pattern.includes("*") || pattern.includes("?")) {
    return matchesGlob(toolName, pattern)
  }
  return pattern === toolName || toolName.startsWith(pattern + "_")
}

function ruleMatchesPath(pathPattern: string, toolInput: Record<string, unknown>): boolean {
  const filePath = (toolInput["file_path"] ?? toolInput["path"]) as string | undefined
  if (!filePath) return false
  return matchesGlob(filePath, pathPattern)
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

export async function executeToolCall(
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
  mcpToolNames: Set<string>
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

  const ctxWithPartId = ctx as ToolContext & { partId?: string }
  ctxWithPartId.partId = `part_${toolCallId}`

  if (mode === "plan" && ["Write", "Edit"].includes(resolvedToolName)) {
    const targetPath = extractWriteTargetPath(toolName, toolInput)
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
  }

  const ruleResult = evaluatePermissionRules(toolName, toolInput, config)
  if (ruleResult === "deny") {
    const ruleReason = findRuleReason(toolName, toolInput, config)
    return { success: false, output: `Access denied by permission rule${ruleReason ? `: ${ruleReason}` : ""}` }
  }
  if (ruleResult === "ask") {
    const action = buildApprovalAction(toolName, toolInput)
    action.description = `[Permission Rule] ${action.description}`
    host.emit({ type: "tool_approval_needed", action, partId: `part_${toolCallId}` })
    const approval = await host.showApprovalDialog(action)
    if (!approval.approved) {
      return { success: false, output: `User denied ${toolName}` }
    }
  }

  const writePath = (toolInput["file_path"] ?? toolInput["path"]) as string | undefined
  if (ruleResult === null && writePath) {
    for (const pattern of config.permissions.denyPatterns) {
      if (matchesGlob(writePath, pattern)) {
        return { success: false, output: `Access denied: path matches deny pattern "${pattern}"` }
      }
    }
  }

  const useFileEditFlow =
    (toolName === "Write" || toolName === "Edit") &&
    typeof host.openFileEdit === "function" &&
    typeof host.saveFileEdit === "function" &&
    typeof host.revertFileEdit === "function"

  if (ruleResult === null && !useFileEditFlow) {
    const needsApproval = toolNeedsApproval(toolName, toolInput, autoApproveActions, config, mcpToolNames)
    if (needsApproval) {
      const action = buildApprovalAction(toolName, toolInput)
      host.emit({ type: "tool_approval_needed", action, partId: `part_${toolCallId}` })

      const approval = await host.showApprovalDialog(action)
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
        return { success: false, output: `User denied ${toolName}` }
      }
      if (approval.addToAllowedCommand != null && toolName === "Bash") {
        const toAdd = normalizeCommand(approval.addToAllowedCommand)
        if (toAdd) {
          await host.addAllowedCommand?.(ctx.cwd, toAdd)
          if (!config.permissions.allowedCommands) config.permissions.allowedCommands = []
          if (!config.permissions.allowedCommands.includes(toAdd)) {
            config.permissions.allowedCommands.push(toAdd)
          }
        }
      }
      if (approval.addToAllowedPattern != null && toolName === "Bash") {
        const pattern = approval.addToAllowedPattern.trim()
        if (pattern) {
          await host.addAllowedPattern?.(ctx.cwd, pattern)
          if (!config.permissions.allowCommandPatterns) config.permissions.allowCommandPatterns = []
          if (!config.permissions.allowCommandPatterns.includes(pattern)) {
            config.permissions.allowCommandPatterns.push(pattern)
          }
        }
      }
      if (approval.addToAllowedMcpTool != null && mcpToolNames.has(toolName)) {
        const tool = approval.addToAllowedMcpTool.trim()
        if (tool) {
          await host.addAllowedMcpTool?.(ctx.cwd, tool)
          if (!config.permissions.allowedMcpTools) config.permissions.allowedMcpTools = []
          if (!config.permissions.allowedMcpTools.includes(tool)) {
            config.permissions.allowedMcpTools.push(tool)
          }
        }
      }
    }
  }

  let validatedArgs: unknown
  let inputToParse: Record<string, unknown> =
    typeof toolInput === "object" && toolInput !== null ? { ...toolInput } : {}
  try {
    inputToParse = normalizeToolInputForParse(resolvedToolName, inputToParse) as Record<string, unknown>
    validatedArgs = tool.parameters.parse(inputToParse)
  } catch (err) {
    // Use tool's formatValidationError if available (kilocode pattern):
    // returns a helpful message with the correct format so the LLM can self-correct.
    if (err instanceof z.ZodError && tool.formatValidationError) {
      return { success: false, output: tool.formatValidationError(err) }
    }
    return { success: false, output: formatToolValidationError(resolvedToolName, err, inputToParse) }
  }

  try {
    const result = await tool.execute(validatedArgs as Record<string, unknown>, ctx)

    if (result.success && ctx.indexer && ["Write", "Edit"].includes(toolName)) {
      const targetPath = extractWriteTargetPath(toolName, validatedArgs as Record<string, unknown>)
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

    // Kilocode-style: truncate large tool output, save full content to global data dir (~/.nexus/data/tool-output/), return shortened + hint
    if (
      result.success &&
      typeof result.output === "string" &&
      (result.metadata as { truncated?: boolean } | undefined)?.truncated !== true
    ) {
      const truncated = await truncateOutput(result.output, { cwd: ctx.cwd })
      if (truncated.truncated) {
        return {
          success: result.success,
          output: truncated.content,
          metadata: {
            ...result.metadata,
            truncated: true,
            outputPath: truncated.outputPath,
          },
        }
      }
    }

    return { success: result.success, output: result.output, metadata: result.metadata }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, output: `Tool ${toolName} error: ${msg}` }
  }
}
