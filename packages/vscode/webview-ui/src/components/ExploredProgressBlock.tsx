import React, { useMemo, useState, useEffect } from "react"
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
])
/** Only these increase "N files" in Explored label. */
const FILE_COUNT_TOOLS = new Set(["read_file", "Read"])
/** Count list tools separately in Explored label. */
const LIST_COUNT_TOOLS = new Set(["list_dir", "List"])
function canonicalToolName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
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
      return "ListCodeDefinitions"
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
    const expanded = uses.map((use, index) => {
      const recipient = typeof use.recipient_name === "string" ? use.recipient_name : ""
      const tool = normalizeNestedToolName(recipient)
      const input = asObject(use.parameters) ?? {}
      return {
        type: "tool" as const,
        id: `${part.id}-parallel-${index + 1}`,
        tool,
        status: part.status,
        input,
        timeStart: part.timeStart,
        timeEnd: part.timeEnd,
      } satisfies ToolPart
    })
    return expanded.filter((item) => isDirectExplorationToolName(item.tool))
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

/** One item in the explored block: either a thought (reasoning without user_message) or an exploration tool. */
export type ExploredPrefixItem =
  | { type: "reasoning"; text: string; durationMs?: number }
  | { type: "tool"; part: ToolPart; entry: ExploredEntry }

/** Parts: collect only the leading contiguous exploration/reasoning prefix. Stop when first non-exploration content appears. */
export function getExploredPrefixFromParts(parts: MessagePart[]): {
  prefixItems: ExploredPrefixItem[]
  prefixIndices: Set<number>
  /** True if there is at least one part after the last prefix index — then collapse by default when complete or when text has user_message. */
  hasContentAfterPrefix: boolean
} {
  const prefixItems: ExploredPrefixItem[] = []
  const prefixIndices = new Set<number>()
  let partIndex = 0
  let hasSeenExplorationTool = false

  const hasVisibleText = (part: MessagePart): boolean => {
    if (part.type !== "text") return false
    const textPart = part as { text?: string; user_message?: string }
    return Boolean(textPart.text?.trim() || textPart.user_message?.trim())
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part.type === "text") {
      if (hasVisibleText(part)) break
      continue
    }
    if (part.type === "reasoning") {
      const r = part as { text: string; durationMs?: number }
      prefixItems.push({ type: "reasoning", text: r.text, durationMs: r.durationMs })
      prefixIndices.add(i)
      partIndex++
      continue
    }
    if (part.type === "tool") {
      const toolPart = part as ToolPart
      const expanded = expandExplorationToolParts(toolPart)
      if (expanded.length === 0) break
      hasSeenExplorationTool = true
      for (const expandedPart of expanded) {
        const entry = getToolEntry(expandedPart, partIndex++)
        if (entry) prefixItems.push({ type: "tool", part: expandedPart, entry })
      }
      prefixIndices.add(i)
      continue
    }
    break
  }
  const lastPrefixIndex = prefixIndices.size > 0 ? Math.max(...prefixIndices) : -1
  const hasContentAfterPrefix = lastPrefixIndex >= 0 && lastPrefixIndex < parts.length - 1
  if (prefixItems.length === 0) return { prefixItems: [], prefixIndices: new Set(), hasContentAfterPrefix }
  if (!hasSeenExplorationTool) {
    return { prefixItems: [], prefixIndices: new Set(), hasContentAfterPrefix }
  }
  return { prefixItems, prefixIndices, hasContentAfterPrefix }
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
        label: `Read ${pathStr}${lineStr}${dur}`,
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
        label: `Listed ${path}${dur}`,
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
        label: `Grepped ${shortPattern}${scope}${dur}`,
        path: typeof pathScope === "string" ? pathScope : undefined,
        durationSec,
      }
    }
    case "codebase_search":
    case "CodebaseSearch": {
      const query = (part.input?.query as string) ?? "…"
      const short = query.length > 50 ? query.slice(0, 47) + "…" : query
      return { id, kind: "search", label: `Codebase search: ${short}${dur}`, durationSec }
    }
    case "search_files": {
      const q = (part.input?.query as string) ?? "…"
      return { id, kind: "search", label: `Search files: ${q}${dur}`, durationSec }
    }
    case "list_code_definitions":
    case "ListCodeDefinitions": {
      const scope = (part.input?.pathScope ?? part.input?.path) as string ?? "codebase"
      return { id, kind: "search", label: `List definitions in ${scope}${dur}`, durationSec }
    }
    case "glob":
    case "Glob": {
      const pattern = (part.input?.pattern ?? part.input?.glob_pattern) as string ?? "…"
      const short = pattern.length > 40 ? pattern.slice(0, 37) + "…" : pattern
      return { id, kind: "search", label: `Glob: ${short}${dur}`, durationSec }
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
        label: `${formatToolName(part.tool)}${dur}`,
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
    glob: "Glob", read_lints: "ReadLints", update_todo_list: "TodoWrite",
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
  defaultCollapsed,
  onOpenFile,
}: {
  prefixItems: ExploredPrefixItem[]
  defaultCollapsed: boolean
  onOpenFile?: (path: string, line?: number, endLine?: number) => void
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (defaultCollapsed) setOpen(false)
  }, [defaultCollapsed])
  // list_dir/List is in Explored and counted as separate "lists" metric.
  const filesCount = prefixItems.filter((x) => x.type === "tool").reduce((acc, x) => acc + countExplorationMetrics(x.part.tool).files, 0)
  const listCount = prefixItems.filter((x) => x.type === "tool").reduce((acc, x) => acc + countExplorationMetrics(x.part.tool).lists, 0)
  const searchesCount = prefixItems.filter((x) => x.type === "tool").reduce((acc, x) => acc + countExplorationMetrics(x.part.tool).searches, 0)
  const labelParts: string[] = []
  if (filesCount > 0) labelParts.push(`${filesCount} file${filesCount === 1 ? "" : "s"}`)
  if (listCount > 0) labelParts.push(`${listCount} list${listCount === 1 ? "" : "s"}`)
  if (searchesCount > 0) labelParts.push(`${searchesCount} search${searchesCount === 1 ? "" : "es"}`)
  const total = prefixItems.length
  if (total === 0) return null
  const headerLabel = labelParts.length > 0 ? `Explored ${labelParts.join(", ")}` : "Explored"

  return (
    <div
      data-explored-inline
      className="nexus-explored-block my-2 overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="nexus-explored-header w-full flex items-center gap-2 text-left cursor-pointer select-none"
      >
        <span className="flex-1 min-w-0 truncate text-[var(--vscode-foreground)] text-xs">
          {headerLabel}
        </span>
        <span
          className="nexus-explored-chevron flex-shrink-0 text-[var(--vscode-descriptionForeground)] text-[10px] transition-transform"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
        >
          ▼
        </span>
      </button>
      {open && (
        <div className="nexus-explored-content">
          {prefixItems.map((item, idx) => {
            if (item.type === "reasoning") {
              return (
                <ExploredThoughtRow
                  key={`thought-${idx}`}
                  text={item.text}
                  durationMs={item.durationMs}
                />
              )
            }
            const e = item.entry
            return (
              <div key={e.id} className="nexus-explored-entry">
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
          })}
        </div>
      )}
    </div>
  )
}

/** One thought row inside Explored block — one line "Thought for Xs" / "Thought briefly", expandable on click for full text. */
function ExploredThoughtRow({ text, durationMs }: { text: string; durationMs?: number }) {
  const [expanded, setExpanded] = useState(false)
  const label =
    durationMs != null
      ? `Thought for ${(durationMs / 1000).toFixed(0)}s`
      : text.trim().length < 80
        ? "Thought briefly"
        : "Thought"

  return (
    <div className="nexus-explored-entry">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="nexus-explored-entry-btn w-full text-left"
      >
        <span className="nexus-explored-thought-chevron" style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}>▼</span>
        <span>{label}</span>
      </button>
      {expanded && text.trim() && (
        <div className="nexus-explored-thought-expanded">
          {text.trim()}
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
