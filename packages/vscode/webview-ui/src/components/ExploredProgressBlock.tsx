import React, { useEffect, useMemo, useRef, useState } from "react"
import { postMessage } from "../vscode.js"
import type { SessionMessage, MessagePart, ToolPart } from "../stores/chat.js"

export interface ExploredEntry {
  id: string
  kind: "thought" | "read" | "list" | "grep" | "search"
  label: string
  path?: string
  line?: number
  endLine?: number
  durationSec?: number
}

const FILE_TOOLS = new Set(["read_file", "list_dir", "Read", "List"])
const SEARCH_TOOLS = new Set([
  "grep", "codebase_search", "search_files", "list_code_definitions", "glob",
  "Grep", "CodebaseSearch", "Glob", "ListCodeDefinitions",
  "read_lints", "ReadLints", "lsp", "LSP",
  "web_fetch", "WebFetch", "web_search", "WebSearch",
])
/** Only these increase "N files" in Explored label. */
const FILE_COUNT_TOOLS = new Set(["read_file", "Read"])
/** Count list tools separately in Explored label. */
const LIST_COUNT_TOOLS = new Set(["list_dir", "List"])
function canonicalToolName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Same idea as CLI `EXPLORE_GLUE_CANONICAL`: auxiliary tools that must not end an exploration segment. */
const EXPLORATION_GLUE_CANONICAL = new Set([
  "todowrite",
  "updatetodolist",
  "spawnagentoutput",
  "spawnagentstop",
  "bashoutput",
  "killbash",
  "enterworktree",
  "exitworktree",
  "toolsearch",
  "taskoutput",
  "tasksnapshot",
  "taskget",
  "tasklist",
  "listmcresources",
  "readmcpresource",
  "mcpauthenticate",
  "memorylist",
  "memoryget",
  "listagentruns",
  "agentrunsnapshot",
])

/** Hide these tool rows in the main transcript when they sit inside an Explored segment (shown as aux lines). */
export function isExplorationSegmentGlueTool(tool: string): boolean {
  return EXPLORATION_GLUE_CANONICAL.has(canonicalToolName(tool))
}

function normalizeNestedToolName(rawRecipientName: string): string {
  const trimmed = rawRecipientName.trim()
  if (!trimmed) return trimmed
  const lower = trimmed.toLowerCase()
  const prefixes = ["functions.", "function.", "multi_tool_use.", "tools.", "tool."]
  const prefix = prefixes.find((item) => lower.startsWith(item))
  const normalized = prefix ? trimmed.slice(prefix.length) : trimmed
  const canonical = canonicalToolName(normalized)
  switch (canonical) {
    case "read":
    case "readfile":
    case "readfiletool":
    case "read_file":
      return "Read"
    case "list":
    case "listdir":
    case "listdirectory":
    case "list_dir":
      return "List"
    case "grep":
    case "grepsearch":
    case "searchfiles":
      return "Grep"
    case "glob":
    case "filesearch":
    case "globfilesearch":
      return "Glob"
    case "codebasesearch":
      return "CodebaseSearch"
    case "listcodedefinitions":
    case "listdefinitions":
    case "list_code_definitions":
      return "ListCodeDefinitions"
    case "readlints":
    case "read_lints":
      return "ReadLints"
    case "lsp":
      return "LSP"
    case "webfetch":
    case "web_fetch":
      return "WebFetch"
    case "websearch":
    case "web_search":
      return "WebSearch"
    default:
      return normalized
  }
}

function isDirectExplorationToolName(tool: string): boolean {
  return FILE_TOOLS.has(tool) || SEARCH_TOOLS.has(tool)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => item != null)
}

function expandExplorationToolParts(part: ToolPart): ToolPart[] {
  if (isDirectExplorationToolName(part.tool)) return [part]

  if (part.tool === "Parallel" || part.tool === "parallel") {
    const uses = asObjectArray(part.input?.tool_uses)
    if (uses.length === 0) return []
    let sawExplore = false
    const out: ToolPart[] = []
    for (let index = 0; index < uses.length; index++) {
      const use = uses[index]!
      const recipient = typeof use.recipient_name === "string" ? use.recipient_name : ""
      const tool = normalizeNestedToolName(recipient)
      if (isExplorationSegmentGlueTool(tool)) continue
      if (!isDirectExplorationToolName(tool)) return []
      sawExplore = true
      const input = asObject(use.parameters) ?? {}
      out.push({
        type: "tool" as const,
        id: `${part.id}-parallel-${index + 1}`,
        tool,
        status: part.status,
        input,
        timeStart: part.timeStart,
        timeEnd: part.timeEnd,
      } satisfies ToolPart)
    }
    return sawExplore ? out : []
  }

  if (part.tool === "batch" || part.tool === "Batch") {
    const inputObj = asObject(part.input) ?? {}
    const reads = asObjectArray(inputObj.reads).map((p, i) => ({
      type: "tool" as const,
      id: `${part.id}-batch-read-${i + 1}`,
      tool: "Read",
      status: part.status,
      input: p,
      timeStart: part.timeStart,
      timeEnd: part.timeEnd,
    } satisfies ToolPart))
    const lists = asObjectArray(inputObj.lists).map((p, i) => ({
      type: "tool" as const,
      id: `${part.id}-batch-list-${i + 1}`,
      tool: "List",
      status: part.status,
      input: p,
      timeStart: part.timeStart,
      timeEnd: part.timeEnd,
    } satisfies ToolPart))
    const searches = asObjectArray(inputObj.searches).map((p, i) => ({
      type: "tool" as const,
      id: `${part.id}-batch-search-${i + 1}`,
      tool:
        typeof p.pattern === "string" || typeof p.query === "string"
          ? "Grep"
          : typeof p.glob_pattern === "string"
            ? "Glob"
            : "CodebaseSearch",
      status: part.status,
      input: p,
      timeStart: part.timeStart,
      timeEnd: part.timeEnd,
    } satisfies ToolPart))
    return [...reads, ...lists, ...searches]
  }

  return []
}

function countExplorationMetrics(tool: string): { files: number; lists: number; searches: number } {
  return {
    files: FILE_COUNT_TOOLS.has(tool) ? 1 : 0,
    lists: LIST_COUNT_TOOLS.has(tool) ? 1 : 0,
    searches: SEARCH_TOOLS.has(tool) ? 1 : 0,
  }
}

/** Whether this tool counts as exploration (file read/list or search) for the collapsed "Explored" block. */
export function isExplorationTool(tool: string): boolean {
  return isDirectExplorationToolName(tool)
}

function shortArg(v: unknown, max = 36): string {
  if (typeof v !== "string") return ""
  const s = v.replace(/\s+/g, " ").trim()
  return s.length <= max ? s : s.slice(0, max - 1) + "…"
}

/** One-line label for glue tools inside the Explored block (matches CLI exploreGlueDisplayLabel). */
function webviewGlueAuxLabel(tool: string, input: Record<string, unknown>): string {
  const c = canonicalToolName(tool)
  const s = (k: string) => shortArg(input[k], 36)
  if (c === "todowrite" || c === "updatetodolist") return "TodoWrite"
  if (c === "toolsearch") return "ToolSearch"
  if (c === "enterworktree") {
    const p = s("path")
    return p ? `EnterWorktree(${p})` : "EnterWorktree"
  }
  if (c === "exitworktree") return "ExitWorktree"
  if (c === "bashoutput") return "BashOutput"
  if (c === "killbash") return "KillBash"
  if (c === "spawnagentoutput") return "SpawnAgentOutput"
  if (c === "spawnagentstop") return "SpawnAgentStop"
  if (c === "taskoutput") {
    const tid = s("task_id") || s("taskId")
    return tid ? `TaskOutput(${tid})` : "TaskOutput"
  }
  if (c === "tasksnapshot") {
    const tid = s("task_id") || s("taskId")
    return tid ? `TaskSnapshot(${tid})` : "TaskSnapshot"
  }
  if (c === "taskget") {
    const tid = s("task_id") || s("taskId")
    return tid ? `TaskGet(${tid})` : "TaskGet"
  }
  if (c === "tasklist") return "TaskList"
  if (c === "listmcresources") return "ListMcpResources"
  if (c === "readmcpresource") return "ReadMcpResource"
  if (c === "mcpauthenticate") return "MCPAuthenticate"
  if (c === "memorylist") return "MemoryList"
  if (c === "memoryget") {
    const k = s("key")
    return k ? `MemoryGet(${k})` : "MemoryGet"
  }
  if (c === "listagentruns") return "ListAgentRuns"
  if (c === "agentrunsnapshot") return "AgentRunSnapshot"
  return tool.trim() || "Tool"
}

function buildExplorationPrefixItemsFromToolPart(
  part: ToolPart,
  nextPartIndex: () => number
): ExploredPrefixItem[] {
  if (part.tool === "Parallel" || part.tool === "parallel") {
    const uses = asObjectArray(part.input?.tool_uses)
    if (uses.length === 0) return []
    let sawExplore = false
    const items: ExploredPrefixItem[] = []
    for (let index = 0; index < uses.length; index++) {
      const use = uses[index]!
      const recipient = typeof use.recipient_name === "string" ? use.recipient_name : ""
      const tool = normalizeNestedToolName(recipient)
      const input = asObject(use.parameters) ?? {}
      if (isExplorationSegmentGlueTool(tool)) {
        items.push({
          type: "aux",
          id: `${part.id}-p-${index}`,
          label: webviewGlueAuxLabel(tool, input),
        })
        continue
      }
      if (!isDirectExplorationToolName(tool)) return []
      sawExplore = true
      const synthetic: ToolPart = {
        type: "tool",
        id: `${part.id}-parallel-${index + 1}`,
        tool,
        status: part.status,
        input,
        timeStart: part.timeStart,
        timeEnd: part.timeEnd,
      }
      const entry = getToolEntry(synthetic, nextPartIndex())
      if (entry) items.push({ type: "tool", part: synthetic, entry })
    }
    return sawExplore ? items : []
  }

  const expanded = expandExplorationToolParts(part)
  const items: ExploredPrefixItem[] = []
  for (const expandedPart of expanded) {
    const entry = getToolEntry(expandedPart, nextPartIndex())
    if (entry) items.push({ type: "tool", part: expandedPart, entry })
  }
  return items
}

/** One item in the explored block: thought, exploration tool, or auxiliary glue line. */
export type ExploredPrefixItem =
  | { type: "reasoning"; text: string; durationMs?: number }
  | { type: "tool"; part: ToolPart; entry: ExploredEntry }
  | { type: "aux"; id: string; label: string }

export function getExplorationItemsFromToolPart(part: ToolPart): ExploredPrefixItem[] {
  let idx = 0
  return buildExplorationPrefixItemsFromToolPart(part, () => idx++).filter(
    (it): it is ExploredPrefixItem & { type: "tool" } => it.type === "tool"
  )
}

export function countExplorationMetricsFromItems(prefixItems: ExploredPrefixItem[]): {
  filesCount: number
  listCount: number
  searchesCount: number
} {
  return prefixItems.reduce(
    (acc, item) => {
      if (item.type !== "tool") return acc
      const metrics = countExplorationMetrics(item.part.tool)
      acc.filesCount += metrics.files
      acc.listCount += metrics.lists
      acc.searchesCount += metrics.searches
      return acc
    },
    { filesCount: 0, listCount: 0, searchesCount: 0 }
  )
}

export type AssistantDisplaySegment =
  | { type: "part"; index: number; part: MessagePart }
  | { type: "explored"; startIndex: number; endIndex: number; prefixItems: ExploredPrefixItem[] }

function explorationPrefixItemSignature(item: ExploredPrefixItem): string {
  if (item.type === "reasoning") {
    return `reasoning:${(item.text ?? "").trim()}`
  }
  if (item.type === "aux") {
    return `aux:${item.id}`
  }
  return `tool:${item.part.id}`
}

function dedupeExplorationPrefixItems(items: ExploredPrefixItem[]): ExploredPrefixItem[] {
  if (items.length <= 1) return items
  const seen = new Set<string>()
  const deduped: ExploredPrefixItem[] = []
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    const signature = explorationPrefixItemSignature(item)
    if (seen.has(signature)) continue
    seen.add(signature)
    deduped.push(item)
  }
  return deduped.reverse()
}

/** Split assistant parts into chronological display segments; each explored segment is one contiguous exploration sequence. */
export function getAssistantDisplaySegments(parts: MessagePart[]): AssistantDisplaySegment[] {
  const segments: AssistantDisplaySegment[] = []
  let sequenceStartIndex: number | null = null
  let sequenceEndIndex: number | null = null
  let sequenceItems: ExploredPrefixItem[] = []
  let sequenceHasExplorationTool = false
  let partIndex = 0
  const nextExploredPartIndex = () => partIndex++

  const flushSequence = () => {
    if (sequenceItems.length === 0 || sequenceStartIndex == null || sequenceEndIndex == null) {
      sequenceStartIndex = null
      sequenceEndIndex = null
      sequenceItems = []
      sequenceHasExplorationTool = false
      return
    }
    if (sequenceHasExplorationTool) {
      segments.push({
        type: "explored",
        startIndex: sequenceStartIndex,
        endIndex: sequenceEndIndex,
        prefixItems: dedupeExplorationPrefixItems(sequenceItems),
      })
    } else {
      for (let i = sequenceStartIndex; i <= sequenceEndIndex; i++) {
        const part = parts[i]
        if (part) segments.push({ type: "part", index: i, part })
      }
    }
    sequenceStartIndex = null
    sequenceEndIndex = null
    sequenceItems = []
    sequenceHasExplorationTool = false
  }

  const beginSequenceIfNeeded = (index: number) => {
    if (sequenceStartIndex == null) sequenceStartIndex = index
    sequenceEndIndex = index
  }

  const hasVisibleText = (part: MessagePart): boolean => {
    if (part.type !== "text") return false
    const textPart = part as { text?: string; user_message?: string }
    return Boolean(textPart.text?.trim() || textPart.user_message?.trim())
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part.type === "reasoning") {
      beginSequenceIfNeeded(i)
      const r = part as { text: string; durationMs?: number }
      sequenceItems.push({ type: "reasoning", text: r.text, durationMs: r.durationMs })
      continue
    }

    if (part.type === "tool") {
      const toolPart = part as ToolPart
      if (isExplorationSegmentGlueTool(toolPart.tool)) {
        if (sequenceStartIndex != null && sequenceHasExplorationTool) {
          beginSequenceIfNeeded(i)
          sequenceItems.push({
            type: "aux",
            id: toolPart.id,
            label: webviewGlueAuxLabel(
              toolPart.tool,
              asObject(toolPart.input) ?? {}
            ),
          })
        }
        continue
      }
      const prefixItems = buildExplorationPrefixItemsFromToolPart(toolPart, nextExploredPartIndex)
      if (prefixItems.length > 0 && prefixItems.some((it) => it.type === "tool")) {
        beginSequenceIfNeeded(i)
        sequenceHasExplorationTool = true
        for (const pi of prefixItems) sequenceItems.push(pi)
        continue
      }
      flushSequence()
      segments.push({ type: "part", index: i, part })
      continue
    }

    if (part.type === "text") {
      if (hasVisibleText(part)) {
        flushSequence()
        segments.push({ type: "part", index: i, part })
      }
      continue
    }

    flushSequence()
    segments.push({ type: "part", index: i, part })
  }

  flushSequence()
  return segments
}

/** Prefix failed tool rows inside Exploring/Explored so they stay in the block but read as a recoverable attempt. */
function explorationEntryLabel(part: ToolPart, baseLabel: string): string {
  if (part.status === "error" && part.timeEnd != null) {
    return `Attempt ${baseLabel}`
  }
  return baseLabel
}

function getToolEntry(part: ToolPart, index: number): ExploredEntry | null {
  const id = `${part.id}-${index}`
  const durationSec =
    part.timeStart != null && part.timeEnd != null
      ? (part.timeEnd - part.timeStart) / 1000
      : undefined
  const dur = durationSec != null ? ` (${durationSec.toFixed(1)}s)` : ""

  switch (part.tool) {
    case "read_file":
    case "Read": {
      const path = (part.input?.path ?? part.input?.file_path) as string | undefined
      const start = (part.input?.startLine ?? part.input?.start_line ?? part.input?.offset) as number | undefined
      const limit = part.input?.limit as number | undefined
      const end = start != null && limit != null ? start + limit - 1 : undefined
      const pathStr = path ?? "file"
      const lineStr =
        start != null && end != null ? ` L${start}-${end}` : start != null ? ` L${start}` : ""
      return {
        id,
        kind: "read",
        label: explorationEntryLabel(part, `Read ${pathStr}${lineStr}${dur}`),
        path,
        line: start,
        endLine: end,
        durationSec,
      }
    }
    case "list_dir":
    case "List": {
      const path = (part.input?.path ?? part.input?.directory) as string | undefined ?? "."
      return {
        id,
        kind: "list",
        label: explorationEntryLabel(part, `Listed ${path}${dur}`),
        path: path !== "." ? path : undefined,
        durationSec,
      }
    }
    case "grep":
    case "Grep": {
      const pattern = (part.input?.pattern ?? part.input?.query) as string ?? "…"
      const pathScope =
        (part.input?.pathScope ?? part.input?.path) as string ??
        (Array.isArray(part.input?.paths) && typeof part.input?.paths?.[0] === "string"
          ? (part.input?.paths?.[0] as string)
          : undefined)
      const scope = pathScope ? ` in ${pathScope}` : ""
      const shortPattern = pattern.length > 40 ? pattern.slice(0, 37) + "…" : pattern
      return {
        id,
        kind: "grep",
        label: explorationEntryLabel(part, `Grepped ${shortPattern}${scope}${dur}`),
        path: typeof pathScope === "string" ? pathScope : undefined,
        durationSec,
      }
    }
    case "codebase_search":
    case "CodebaseSearch": {
      const query = (part.input?.query as string) ?? "…"
      const short = query.length > 50 ? query.slice(0, 47) + "…" : query
      return {
        id,
        kind: "search",
        label: explorationEntryLabel(part, `Codebase search: ${short}${dur}`),
        durationSec,
      }
    }
    case "search_files": {
      const q = (part.input?.query as string) ?? "…"
      return {
        id,
        kind: "search",
        label: explorationEntryLabel(part, `Search files: ${q}${dur}`),
        durationSec,
      }
    }
    case "list_code_definitions":
    case "ListCodeDefinitions": {
      const scope = (part.input?.pathScope ?? part.input?.path) as string ?? "codebase"
      return {
        id,
        kind: "search",
        label: explorationEntryLabel(part, `List definitions in ${scope}${dur}`),
        durationSec,
      }
    }
    case "glob":
    case "Glob": {
      const pattern = (part.input?.pattern ?? part.input?.glob_pattern) as string ?? "…"
      const short = pattern.length > 40 ? pattern.slice(0, 37) + "…" : pattern
      return {
        id,
        kind: "search",
        label: explorationEntryLabel(part, `Glob: ${short}${dur}`),
        durationSec,
      }
    }
    case "read_lints":
    case "ReadLints": {
      const paths = part.input?.paths
      const n = Array.isArray(paths) ? paths.length : 0
      const hint = n > 0 ? ` (${n} path${n === 1 ? "" : "s"})` : ""
      return {
        id,
        kind: "search",
        label: explorationEntryLabel(part, `Read lints${hint}${dur}`),
        durationSec,
      }
    }
    case "lsp":
    case "LSP": {
      const op = (part.input?.operation as string) ?? "query"
      const fp = (part.input?.filePath ?? part.input?.file_path) as string | undefined
      const shortFp = fp && fp.length > 36 ? fp.slice(0, 33) + "…" : fp
      const tail = shortFp ? ` ${shortFp}` : ""
      return {
        id,
        kind: "search",
        label: explorationEntryLabel(part, `LSP ${op}${tail}${dur}`),
        path: fp,
        durationSec,
      }
    }
    case "WebFetch": {
      const url = (part.input?.url as string) ?? "…"
      const short = url.length > 45 ? url.slice(0, 42) + "…" : url
      return {
        id,
        kind: "search",
        label: explorationEntryLabel(part, `WebFetch ${short}${dur}`),
        durationSec,
      }
    }
    case "WebSearch": {
      const q = (part.input?.query as string) ?? "…"
      const short = q.length > 50 ? q.slice(0, 47) + "…" : q
      return {
        id,
        kind: "search",
        label: explorationEntryLabel(part, `Web search: ${short}${dur}`),
        durationSec,
      }
    }
    case "execute_command":
    case "Bash":
    case "Parallel":
    case "parallel":
    case "batch":
    case "Batch":
      return null
    default:
      return {
        id,
        kind: "search",
        label: explorationEntryLabel(part, `${formatToolName(part.tool)}${dur}`),
        durationSec,
      }
  }
}

function formatToolName(tool: string): string {
  if (tool === "execute_command" || tool === "Bash") return "Bash"
  const core: Record<string, string> = {
    read_file: "Read", list_dir: "List",
    replace_in_file: "Edit", write_to_file: "Write",
    grep: "Grep", search_files: "Grep",
    codebase_search: "CodebaseSearch", list_code_definitions: "ListCodeDefinitions",
    glob: "Glob", read_lints: "ReadLints", lsp: "LSP", update_todo_list: "TodoWrite",
    web_fetch: "WebFetch", web_search: "WebSearch",
  }
  return core[tool] ?? tool
}

/** Per-message: compute files/lists/searches count and entries from tool parts only. */
export function getExploredFromParts(parts: MessagePart[]): {
  filesCount: number
  listCount: number
  searchesCount: number
  entries: ExploredEntry[]
} {
  let filesCount = 0
  let listCount = 0
  let searchesCount = 0
  const entries: ExploredEntry[] = []
  let partIndex = 0
  for (const part of parts) {
    if (part.type !== "tool") continue
    const toolPart = part as ToolPart
    const expanded = expandExplorationToolParts(toolPart)
    for (const expandedPart of expanded) {
      const metric = countExplorationMetrics(expandedPart.tool)
      filesCount += metric.files
      listCount += metric.lists
      searchesCount += metric.searches
      const entry = getToolEntry(expandedPart, partIndex++)
      if (entry) entries.push(entry)
    }
  }
  return { filesCount, listCount, searchesCount, entries }
}

/** Inline collapsible "Explored [N files,] [L lists,] [M searches]". If a metric is 0 it is omitted. */
export function ExploredSummaryInline({
  prefixItems,
  isRunning,
  onOpenFile,
  onLayoutHint,
}: {
  prefixItems: ExploredPrefixItem[]
  isRunning: boolean
  onOpenFile?: (path: string, line?: number, endLine?: number) => void
  onLayoutHint?: () => void
}) {
  const [open, setOpen] = useState(false)
  const previousRunningRef = useRef(isRunning)
  useEffect(() => {
    if (previousRunningRef.current && !isRunning) {
      setOpen(false)
      onLayoutHint?.()
    }
    previousRunningRef.current = isRunning
  }, [isRunning, onLayoutHint])
  const { filesCount, listCount, searchesCount } = countExplorationMetricsFromItems(prefixItems)
  const labelParts: string[] = []
  if (filesCount > 0) labelParts.push(`${filesCount} file${filesCount === 1 ? "" : "s"}`)
  if (listCount > 0) labelParts.push(`${listCount} list${listCount === 1 ? "" : "s"}`)
  if (searchesCount > 0) labelParts.push(`${searchesCount} search${searchesCount === 1 ? "" : "es"}`)
  const total = prefixItems.length
  if (total === 0) return null
  const statusLabel = isRunning ? "Exploring" : "Explored"
  const metricsLabel = labelParts.length > 0 ? ` ${labelParts.join(", ")}` : ""
  const headerLabel = `${statusLabel}${metricsLabel}`
  const previewItems = isRunning && !open ? prefixItems.slice(-4) : []

  const renderItem = (item: ExploredPrefixItem, idx: number, compact: boolean) => {
    if (item.type === "reasoning") {
      return (
        <ExploredThoughtRow
          key={`thought-${idx}`}
          text={item.text}
          durationMs={item.durationMs}
          compact={compact}
          onLayoutHint={onLayoutHint}
        />
      )
    }
    if (item.type === "aux") {
      return (
        <div
          key={`aux-${item.id}`}
          className={`nexus-explored-entry${compact ? " nexus-explored-entry-compact" : ""}`}
        >
          <span className="nexus-explored-entry-text opacity-85 text-[var(--vscode-descriptionForeground)] text-xs">
            {item.label}
          </span>
        </div>
      )
    }
    const e = item.entry
    return (
      <div key={e.id} className={`nexus-explored-entry${compact ? " nexus-explored-entry-compact" : ""}`}>
        {e.path != null && (e.line != null || e.endLine != null) && onOpenFile ? (
          <button
            type="button"
            onClick={() => onOpenFile(e.path!, e.line, e.endLine)}
            className="nexus-explored-entry-btn"
            title={e.path}
          >
            {e.label}
          </button>
        ) : (
          <span className="nexus-explored-entry-text">{e.label}</span>
        )}
      </div>
    )
  }

  return (
    <div
      data-explored-inline
      className="nexus-explored-block my-2 overflow-hidden"
    >
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o)
          onLayoutHint?.()
        }}
        className="nexus-explored-header w-full flex items-center gap-2 text-left cursor-pointer select-none"
      >
        <span className="flex-1 min-w-0 truncate text-[var(--vscode-foreground)] text-xs">
          {isRunning ? (
            <>
              <span className="nexus-exploring-wave-text">Exploring</span>
              {metricsLabel}
            </>
          ) : (
            headerLabel
          )}
        </span>
        <span
          className="nexus-explored-chevron flex-shrink-0 text-[var(--vscode-descriptionForeground)] text-[10px] transition-transform"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
        >
          ▼
        </span>
      </button>
      {!open && previewItems.length > 0 && (
        <div className="nexus-explored-preview-window">
          {previewItems.map((item, idx) => renderItem(item, idx, true))}
        </div>
      )}
      {open && (
        <div className="nexus-explored-content">
          {prefixItems.map((item, idx) => renderItem(item, idx, false))}
        </div>
      )}
    </div>
  )
}

/** One thought row inside Explored block — one line "Thought for Xs" / "Thought briefly", expandable on click for full text. */
function ExploredThoughtRow({
  text,
  durationMs,
  compact = false,
  onLayoutHint,
}: {
  text: string
  durationMs?: number
  compact?: boolean
  onLayoutHint?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const label =
    durationMs != null
      ? `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`
      : text.trim().length < 80
        ? "Thought briefly"
        : "Thought"

  return (
    <div className={`nexus-explored-entry${compact ? " nexus-explored-entry-compact" : ""}`}>
      <button
        type="button"
        onClick={() => {
          if (compact) return
          setExpanded((e) => !e)
          onLayoutHint?.()
        }}
        className="nexus-explored-entry-btn w-full text-left"
      >
        <span
          className="nexus-explored-thought-chevron"
          style={{ transform: compact ? "rotate(-90deg)" : expanded ? "rotate(0deg)" : "rotate(-90deg)" }}
        >
          ▼
        </span>
        <span>{label}</span>
      </button>
      {expanded && !compact && (
        <div className="nexus-explored-thought-expanded">
          {text.trim() || "Model reasoning is active, but no visible reasoning text was streamed."}
        </div>
      )}
    </div>
  )
}

export function useExploredFromMessages(
  messages: SessionMessage[],
  isRunning: boolean,
  reasoningStartTime: number | null
): { filesCount: number; listCount: number; searchesCount: number; entries: ExploredEntry[] } {
  return useMemo(() => {
    let filesCount = 0
    let listCount = 0
    let searchesCount = 0
    const entries: ExploredEntry[] = []
    let partIndex = 0

    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "reasoning") {
        const text = (part as { text: string }).text
        entries.push({
          id: `reasoning-${partIndex++}`,
          kind: "thought",
          label: text.trim().length < 80 ? "Thought briefly" : "Thought",
        })
        continue
      }
      if (part.type === "tool") {
        const toolPart = part as ToolPart
        const expanded = expandExplorationToolParts(toolPart)
        for (const expandedPart of expanded) {
          const metric = countExplorationMetrics(expandedPart.tool)
          filesCount += metric.files
          listCount += metric.lists
          searchesCount += metric.searches
          const entry = getToolEntry(expandedPart, partIndex++)
          if (entry) entries.push(entry)
        }
      }
    }
    }

    if (isRunning && reasoningStartTime != null) {
      entries.push({
        id: "reasoning-current",
        kind: "thought",
        label: "Thought…",
      })
    }

    return { filesCount, listCount, searchesCount, entries }
  }, [messages, isRunning, reasoningStartTime])
}

function ChevronDownIcon({ open }: { open: boolean }) {
  return (
    <span
      className="nexus-explored-chevron flex-shrink-0 text-[var(--vscode-descriptionForeground)] text-[10px] transition-transform"
      style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
    >
      ▼
    </span>
  )
}

function ExploredIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

interface Props {
  messages: SessionMessage[]
  isRunning: boolean
  reasoningStartTime: number | null
}

export function ExploredProgressBlock({ messages, isRunning, reasoningStartTime }: Props) {
  const [open, setOpen] = useState(false)
  const { filesCount, listCount, searchesCount, entries } = useExploredFromMessages(
    messages,
    isRunning,
    reasoningStartTime
  )

  const total = filesCount + listCount + searchesCount
  // Do not show "Explored" when there are no exploration metrics and no entries.
  if (total === 0 && entries.length === 0) return null
  const labelParts: string[] = []
  if (filesCount > 0) labelParts.push(`${filesCount} file${filesCount === 1 ? "" : "s"}`)
  if (listCount > 0) labelParts.push(`${listCount} list${listCount === 1 ? "" : "s"}`)
  if (searchesCount > 0) labelParts.push(`${searchesCount} search${searchesCount === 1 ? "" : "es"}`)
  const label = labelParts.length > 0 ? labelParts.join(", ") : "Explored"

  return (
    <div
      data-explored-block
      className="nexus-explored-block flex-shrink-0 overflow-hidden"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Enter" && setOpen((o) => !o)}
        className="nexus-explored-header flex items-center gap-2 cursor-pointer select-none"
      >
        <span className="flex-1 min-w-0 truncate text-[var(--vscode-foreground)] text-xs">
          {label}
        </span>
        <ChevronDownIcon open={open} />
      </div>
      {open && (
        <div className="nexus-explored-content">
          {entries.map((e) => (
            <div key={e.id} className="nexus-explored-entry">
              {e.path != null && (e.line != null || e.endLine != null) ? (
                <button
                  type="button"
                  onClick={() =>
                    postMessage({
                      type: "openFileAtLocation",
                      path: e.path!,
                      line: e.line,
                      endLine: e.endLine,
                    })
                  }
                  className="nexus-explored-entry-btn"
                  title={e.path}
                >
                  {e.label}
                </button>
              ) : (
                <span className="nexus-explored-entry-text">{e.label}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
