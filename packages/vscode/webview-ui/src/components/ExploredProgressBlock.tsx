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

const FILE_TOOLS = new Set([
  "read_file", "list_dir",
  "Read", "List", // core built-in names
])
const SEARCH_TOOLS = new Set([
  "grep", "codebase_search", "search_files", "list_code_definitions",
  "Grep", "CodebaseSearch", "Glob", "ListCodeDefinitions", // core built-in names
])
/** Only these increase "N files" in Explored label. list_dir/List is in Explored but not counted. */
const FILE_COUNT_TOOLS = new Set(["read_file", "Read"])

/** Whether this tool counts as exploration (file read/list or search) for the collapsed "Explored" block. */
export function isExplorationTool(tool: string): boolean {
  return FILE_TOOLS.has(tool) || SEARCH_TOOLS.has(tool)
}

/** One item in the explored block: either a thought (reasoning without user_message) or an exploration tool. */
export type ExploredPrefixItem =
  | { type: "reasoning"; text: string; durationMs?: number }
  | { type: "tool"; part: ToolPart; entry: ExploredEntry }

/** Parts: collect ALL reasoning and ALL exploration tools in the message (in order). Block is shown only when there is at least one tool; if only reasoning, return empty so we show Thought(s) as-is. We do not stop at first text — so list_dir etc. later in the message are still inside Explored. */
export function getExploredPrefixFromParts(parts: MessagePart[]): {
  prefixItems: ExploredPrefixItem[]
  prefixIndices: Set<number>
  /** True if there is at least one part after the last prefix index — then collapse by default when complete or when text has user_message. */
  hasContentAfterPrefix: boolean
} {
  const prefixItems: ExploredPrefixItem[] = []
  const prefixIndices = new Set<number>()
  let partIndex = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part.type === "reasoning") {
      const r = part as { text: string; durationMs?: number }
      prefixItems.push({ type: "reasoning", text: r.text, durationMs: r.durationMs })
      prefixIndices.add(i)
      partIndex++
      continue
    }
    if (part.type === "text") continue
    if (part.type === "tool") {
      const toolPart = part as ToolPart
      if (!isExplorationTool(toolPart.tool)) continue
      const entry = getToolEntry(toolPart, partIndex++)
      if (entry) prefixItems.push({ type: "tool", part: toolPart, entry })
      prefixIndices.add(i)
      continue
    }
  }
  const lastPrefixIndex = prefixIndices.size > 0 ? Math.max(...prefixIndices) : -1
  const hasContentAfterPrefix = lastPrefixIndex >= 0 && lastPrefixIndex < parts.length - 1
  if (prefixItems.length === 0) return { prefixItems: [], prefixIndices: new Set(), hasContentAfterPrefix }
  const hasAtLeastOneTool = prefixItems.some((x) => x.type === "tool")
  if (!hasAtLeastOneTool) {
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
      const start = (part.input?.startLine ?? part.input?.offset) as number | undefined
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
      const pathScope = (part.input?.pathScope ?? part.input?.path) as string
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

/** Per-message: compute files/searches count and entries from tool parts only. list_dir/List is in entries but not counted in files (files = read_file only). */
export function getExploredFromParts(parts: MessagePart[]): {
  filesCount: number
  searchesCount: number
  entries: ExploredEntry[]
} {
  let filesCount = 0
  let searchesCount = 0
  const entries: ExploredEntry[] = []
  let partIndex = 0
  for (const part of parts) {
    if (part.type !== "tool") continue
    const toolPart = part as ToolPart
    if (FILE_COUNT_TOOLS.has(toolPart.tool)) filesCount++
    if (SEARCH_TOOLS.has(toolPart.tool)) searchesCount++
    const entry = getToolEntry(toolPart, partIndex++)
    if (entry) entries.push(entry)
  }
  return { filesCount, searchesCount, entries }
}

/** Inline collapsible "Explored [N files,] [M searches]" — list_dir/List is in the block but not counted; N = read_file only, M = grep/search. If N or M is 0 that part is omitted. */
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
  // list_dir/List is in Explored but not counted; N files = FILE_COUNT_TOOLS only, M searches = SEARCH_TOOLS
  const filesCount = prefixItems.filter((x) => x.type === "tool" && FILE_COUNT_TOOLS.has(x.part.tool)).length
  const searchesCount = prefixItems.filter((x) => x.type === "tool" && SEARCH_TOOLS.has(x.part.tool)).length
  const labelParts: string[] = []
  if (filesCount > 0) labelParts.push(`${filesCount} file${filesCount === 1 ? "" : "s"}`)
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
): { filesCount: number; searchesCount: number; entries: ExploredEntry[] } {
  return useMemo(() => {
    let filesCount = 0
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
        if (FILE_COUNT_TOOLS.has(toolPart.tool)) filesCount++
        if (SEARCH_TOOLS.has(toolPart.tool)) searchesCount++
        const entry = getToolEntry(toolPart, partIndex++)
        if (entry) entries.push(entry)
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

    return { filesCount, searchesCount, entries }
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
  const { filesCount, searchesCount, entries } = useExploredFromMessages(
    messages,
    isRunning,
    reasoningStartTime
  )

  const total = filesCount + searchesCount
  // Do not show "Explored" when there are no file reads or searches (list_dir/List is in entries but not counted)
  if (total === 0 && entries.length === 0) return null
  const labelParts: string[] = []
  if (filesCount > 0) labelParts.push(`${filesCount} file${filesCount === 1 ? "" : "s"}`)
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
