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

export async function detectDoomLoop(
  session: ISession,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<boolean> {
  const threshold = toolName === "Bash" ? DOOM_LOOP_THRESHOLD_EXECUTE_COMMAND : DOOM_LOOP_THRESHOLD
  const allParts = session.messages
    .flatMap(m => {
      if (!Array.isArray(m.content)) return []
      return (m.content as Array<{ type: string; tool?: string; input?: Record<string, unknown> }>)
        .filter(p => p.type === "tool" && p.tool === toolName)
        .map(p => p.input)
    })
    .slice(-threshold)

  if (allParts.length < threshold) return false

  const currentSig = getDoomLoopSignature(toolName, toolInput)
  if (toolName === "Bash" && currentSig === "") return false
  return allParts.every(p => getDoomLoopSignature(toolName, (p ?? {}) as Record<string, unknown>) === currentSig)
}

function getDoomLoopSignature(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const cmd = input?.command != null ? String(input.command).trim() : ""
    return cmd
  }
  return canonicalJson(input)
}

function canonicalJson(obj: Record<string, unknown>): string {
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
  if (typeof val === "string") return val.trim() ? [val.trim()] : []
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
 * Applied to all built-in tools that have optional string arrays or path/paths.
 */
export function normalizeToolInputForParse(
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  const raw = input
  // Resolve gateway name so we apply the right normalizer
  const name =
    toolName === "list_dir" || toolName === "ListDirectory" || toolName === "list_directory"
      ? "List"
      : toolName
  // List: only "path" (string); gateway may send "paths" (array) or paths[0] undefined
  if (name === "List") {
    const pathVal =
      typeof raw.path === "string" && raw.path.length > 0
        ? raw.path
        : Array.isArray(raw.paths) && raw.paths.length > 0 && typeof raw.paths[0] === "string"
          ? (raw.paths[0] as string)
          : "."
    return {
      path: pathVal,
      ignore: raw.ignore,
      recursive: raw.recursive,
      include: raw.include,
      max_entries: raw.max_entries,
      task_progress: raw.task_progress,
    }
  }
  // ReadLints: paths optional array of strings
  if (name === "ReadLints") {
    const paths = normalizeOptionalStringArray(raw.paths)
    return { ...raw, paths: paths ?? undefined }
  }
  // CodebaseSearch: target_directories optional array of strings
  if (name === "CodebaseSearch") {
    const target_directories = normalizeOptionalStringArray(raw.target_directories)
    return { ...raw, target_directories: target_directories ?? undefined }
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
  // Grep: ignore optional array of strings
  if (name === "Grep") {
    const ignore = normalizeOptionalStringArray(raw.ignore)
    return { ...raw, ignore: ignore ?? undefined }
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
