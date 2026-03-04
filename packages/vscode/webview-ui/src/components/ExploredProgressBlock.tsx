import React, { useMemo, useState } from "react"
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

/** Per-message: compute files/searches count and entries from tool parts only */
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
    if (FILE_TOOLS.has(toolPart.tool)) filesCount++
    if (SEARCH_TOOLS.has(toolPart.tool)) searchesCount++
    const entry = getToolEntry(toolPart, partIndex++)
    if (entry) entries.push(entry)
  }
  return { filesCount, searchesCount, entries }
}

/** Inline collapsible "Explored X files, Y searches" block for one message (used inside chat) */
export function ExploredSummaryInline({
  filesCount,
  searchesCount,
  entries,
  defaultCollapsed,
  onOpenFile,
}: {
  filesCount: number
  searchesCount: number
  entries: ExploredEntry[]
  defaultCollapsed: boolean
  onOpenFile?: (path: string, line?: number, endLine?: number) => void
}) {
  const [open, setOpen] = useState(!defaultCollapsed)
  const total = filesCount + searchesCount
  // Do not show "Explored 0 files, 0 searches" when there are no file reads or searches.
  if (total === 0) return null
  if (entries.length === 0) return null

  return (
    <div
      data-explored-inline
      className="my-2 rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer select-none text-xs text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
      >
        <ExploredIcon className="w-4 h-4 flex-shrink-0 text-[var(--vscode-descriptionForeground)]" />
        <span className="flex-1 min-w-0 truncate">
          Explored {filesCount} file{filesCount === 1 ? "" : "s"}, {searchesCount} search{searchesCount === 1 ? "" : "es"}
        </span>
        <span
          className="flex-shrink-0 text-[var(--vscode-descriptionForeground)] transition-transform"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
        >
          ▼
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--vscode-panel-border)] max-h-[240px] overflow-y-auto py-2 px-3 space-y-1">
          {entries.map((e) => (
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
          ))}
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
          if (FILE_TOOLS.has(toolPart.tool)) filesCount++
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
  // Do not show "Explored 0 files, 0 searches" when there are no file reads or searches.
  if (total === 0) return null
  if (entries.length === 0) return null

  return (
    <div
      data-explored-block
      className="flex-shrink-0 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] overflow-hidden"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Enter" && setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-xs text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
      >
        <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-[var(--vscode-descriptionForeground)]">
          <ExploredIcon className="w-4 h-4" />
        </span>
        <span className="flex-1 min-w-0 truncate">
          Explored {filesCount} file{filesCount === 1 ? "" : "s"}, {searchesCount} search{searchesCount === 1 ? "" : "es"}
        </span>
        <ChevronDownIcon open={open} />
      </div>
      {open && (
        <div className="border-t border-[var(--vscode-panel-border)] max-h-[280px] overflow-y-auto py-2 px-3 space-y-1">
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
