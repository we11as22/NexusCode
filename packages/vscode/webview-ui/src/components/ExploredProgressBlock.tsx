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

const FILE_TOOLS = new Set(["read_file", "list_files"])
const SEARCH_TOOLS = new Set(["grep", "codebase_search", "search_files", "list_code_definitions"])
/** Only these increase "N files" in Explored label. list_files is in Explored but not counted. */
const FILE_COUNT_TOOLS = new Set(["read_file"])

/** Whether this tool counts as exploration (file read/list or search) for the collapsed "Explored" block. */
export function isExplorationTool(tool: string): boolean {
  return FILE_TOOLS.has(tool) || SEARCH_TOOLS.has(tool)
}

/** One item in the explored block: either a thought (reasoning without user_message) or an exploration tool. */
export type ExploredPrefixItem =
  | { type: "reasoning"; text: string; durationMs?: number }
  | { type: "tool"; part: ToolPart; entry: ExploredEntry }

/** Parts: collect ALL reasoning and ALL exploration tools in the message (in order). Block is shown only when there is at least one tool; if only reasoning, return empty so we show Thought(s) as-is. We do not stop at first text — so list_files etc. later in the message are still inside Explored. */
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
    case "read_file": {
      const path = part.input?.path as string | undefined
      const start = part.input?.startLine as number | undefined
      const end = part.input?.endLine as number | undefined
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
    case "list_files": {
      const path = (part.input?.path as string) ?? (part.input?.directory as string) ?? "."
      return {
        id,
        kind: "list",
        label: `Listed ${path}${dur}`,
        path: path !== "." ? path : undefined,
        durationSec,
      }
    }
    case "grep": {
      const pattern = (part.input?.pattern as string) ?? (part.input?.query as string) ?? "…"
      const pathScope = (part.input?.pathScope as string) ?? (part.input?.path as string)
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
    case "codebase_search": {
      const query = (part.input?.query as string) ?? "…"
      const short = query.length > 50 ? query.slice(0, 47) + "…" : query
      return { id, kind: "search", label: `Codebase search: ${short}${dur}`, durationSec }
    }
    case "search_files": {
      const q = (part.input?.query as string) ?? "…"
      return { id, kind: "search", label: `Search files: ${q}${dur}`, durationSec }
    }
    case "list_code_definitions": {
      const scope = (part.input?.pathScope as string) ?? "codebase"
      return { id, kind: "search", label: `List definitions in ${scope}${dur}`, durationSec }
    }
    case "execute_command":
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
  if (tool === "execute_command") return "bash"
  if (tool === "spawn_agent") return "spawn_agent"
  return tool
}

/** Per-message: compute files/searches count and entries from tool parts only. list_files is in entries but not counted in files (files = read_file only). */
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

/** Inline collapsible "Explored [N files,] [M searches]" — list_files is in the block but not counted; N = read_file only, M = grep/search. If N or M is 0 that part is omitted. */
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
  // list_files is in Explored but not counted; N files = FILE_COUNT_TOOLS only, M searches = SEARCH_TOOLS
  const filesCount = prefixItems.filter((x) => x.type === "tool" && FILE_COUNT_TOOLS.has(x.part.tool)).length
  const searchesCount = prefixItems.filter((x) => x.type === "tool" && SEARCH_TOOLS.has(x.part.tool)).length
  const labelParts: string[] = []
  if (filesCount > 0) labelParts.push(`${filesCount} file${filesCount === 1 ? "" : "s"}`)
  if (searchesCount > 0) labelParts.push(`${searchesCount} search${searchesCount === 1 ? "" : "es"}`)
  const total = prefixItems.length
  if (total === 0) return null

  return (
    <div
      data-explored-inline
      className="my-2 overflow-hidden bg-transparent"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left cursor-pointer select-none text-xs text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] rounded"
      >
        <ExploredIcon className="w-4 h-4 flex-shrink-0 text-[var(--vscode-descriptionForeground)]" />
        <span className="flex-1 min-w-0 truncate">
          Explored
          {labelParts.length > 0 && ` ${labelParts.join(", ")}`}
        </span>
        <span
          className="flex-shrink-0 text-[var(--vscode-descriptionForeground)] transition-transform"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
        >
          ▼
        </span>
      </button>
      {open && (
        <div className="max-h-[280px] overflow-y-auto py-1.5 px-2 space-y-1">
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
              <div key={e.id} className="text-[11px] leading-snug text-[var(--vscode-descriptionForeground)]">
                {e.path != null && (e.line != null || e.endLine != null) && onOpenFile ? (
                  <button
                    type="button"
                    onClick={() => onOpenFile(e.path!, e.line, e.endLine)}
                    className="text-left w-full rounded px-1.5 py-0.5 hover:bg-[var(--vscode-list-hoverBackground)] text-[var(--vscode-textLink-foreground)] truncate block"
                    title={e.path}
                  >
                    {e.label}
                  </button>
                ) : (
                  <span className="px-1.5 py-0.5 block truncate">{e.label}</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** One thought row inside Explored block — expandable on click. */
function ExploredThoughtRow({ text, durationMs }: { text: string; durationMs?: number }) {
  const [expanded, setExpanded] = useState(false)
  const durationStr = durationMs != null ? ` (${(durationMs / 1000).toFixed(1)}s)` : ""
  return (
    <div className="space-y-0">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left px-1.5 py-0.5 hover:bg-[var(--vscode-list-hoverBackground)] rounded text-[11px] text-[var(--vscode-descriptionForeground)] flex items-center gap-1"
      >
        <span className="flex-shrink-0 transition-transform" style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}>▼</span>
        <span>Thought{durationStr}</span>
      </button>
      {expanded && text.trim() && (
        <div className="pl-4 pr-1 py-1.5 text-[11px] text-[var(--vscode-foreground)] whitespace-pre-wrap break-words leading-relaxed font-sans max-h-[min(50vh,320px)] overflow-y-auto overflow-x-hidden rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
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
      className="flex-shrink-0 text-[var(--vscode-descriptionForeground)] transition-transform"
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
  // Do not show "Explored" when there are no file reads or searches (list_files is in entries but not counted)
  if (total === 0 && entries.length === 0) return null
  const labelParts: string[] = []
  if (filesCount > 0) labelParts.push(`${filesCount} file${filesCount === 1 ? "" : "s"}`)
  if (searchesCount > 0) labelParts.push(`${searchesCount} search${searchesCount === 1 ? "" : "es"}`)
  const label = labelParts.length > 0 ? labelParts.join(", ") : "Explored"

  return (
    <div
      data-explored-block
      className="flex-shrink-0 overflow-hidden bg-transparent"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Enter" && setOpen((o) => !o)}
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer select-none text-xs text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] rounded"
      >
        <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-[var(--vscode-descriptionForeground)]">
          <ExploredIcon className="w-4 h-4" />
        </span>
        <span className="flex-1 min-w-0 truncate">
          {label}
        </span>
        <ChevronDownIcon open={open} />
      </div>
      {open && (
        <div className="max-h-[280px] overflow-y-auto py-1.5 px-2 space-y-1">
          {entries.map((e) => (
            <div key={e.id} className="text-[11px] leading-snug text-[var(--vscode-descriptionForeground)]">
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
                  className="text-left w-full rounded px-1.5 py-0.5 hover:bg-[var(--vscode-list-hoverBackground)] text-[var(--vscode-textLink-foreground)] truncate block"
                  title={e.path}
                >
                  {e.label}
                </button>
              ) : (
                <span className="px-1.5 py-0.5 block truncate">{e.label}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
