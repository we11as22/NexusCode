import React, { useMemo, useState } from "react"
import { postMessage } from "../vscode.js"
import type { SessionMessage, ToolPart } from "../stores/chat.js"

const EDIT_TOOLS = new Set(["replace_in_file", "write_to_file"])

function getLangBadge(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    ts: "TS", tsx: "TSX", js: "JS", jsx: "JSX", mjs: "JS", cjs: "JS",
    py: "PY", rs: "RS", go: "GO", java: "JAVA", c: "C", cpp: "CPP", h: "H",
    md: "MD", json: "JSON", yaml: "YAML", yml: "YAML", html: "HTML", css: "CSS",
    vue: "VUE", svelte: "SVELTE",
  }
  return (map[ext] ?? ext.toUpperCase().slice(0, 4)) || "FILE"
}

function getDiffStats(output: string): { add: number; del: number } {
  let add = 0, del = 0
  const lines = output.split("\n")
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++
    else if (line.startsWith("-") && !line.startsWith("---")) del++
  }
  return { add, del }
}

function getFileEditPath(part: ToolPart): string | null {
  const pathVal = part.input?.path
  if (pathVal != null && String(pathVal).trim()) return String(pathVal).trim()
  const m = part.output?.match(/<file_content\s+path="([^"]+)"/)
  if (m) return m[1]!
  return null
}

function getStatLabel(part: ToolPart): string {
  const output = part.output ?? ""
  const stats = getDiffStats(output)
  const isDiff = output.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-")).length >= 3
  if (isDiff && (stats.add > 0 || stats.del > 0)) {
    return [stats.add > 0 ? `+${stats.add}` : "", stats.del > 0 ? `-${stats.del}` : ""].filter(Boolean).join(" ")
  }
  if (part.tool === "write_to_file") {
    const m = output.match(/\((\d+)\s+lines?\)/)
    if (m) return `+${m[1]}`
  }
  return "edited"
}

export interface EditableFileEntry {
  path: string
  part: ToolPart
  statLabel: string
  langBadge: string
  fileName: string
}

function collectEditedFiles(messages: SessionMessage[]): EditableFileEntry[] {
  const byPath = new Map<string, EditableFileEntry>()
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type !== "tool") continue
      const toolPart = part as ToolPart
      if (!EDIT_TOOLS.has(toolPart.tool) || toolPart.status !== "completed") continue
      const path = getFileEditPath(toolPart)
      if (!path) continue
      const statLabel = getStatLabel(toolPart)
      const fileName = path.split("/").pop() ?? path
      byPath.set(path, {
        path,
        part: toolPart,
        statLabel,
        langBadge: getLangBadge(path),
        fileName,
      })
    }
  }
  return Array.from(byPath.values())
}

function DiffPreview({ output }: { output: string }) {
  const lines = output.split("\n")
  const looksLikeDiff = lines.filter((l) => l.startsWith("+") || l.startsWith("-")).length >= 3
  if (looksLikeDiff) {
    return (
      <pre className="bg-[var(--vscode-editor-background)] rounded p-1.5 overflow-x-auto text-[10px] whitespace-pre-wrap max-h-64 overflow-y-auto font-mono diff-output">
        {lines.map((line, i) => {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            return <div key={i} className="text-green-500 bg-green-500/10">{line}</div>
          }
          if (line.startsWith("-") && !line.startsWith("---")) {
            return <div key={i} className="text-red-400 bg-red-500/10">{line}</div>
          }
          return <div key={i} className="text-[var(--vscode-foreground)]">{line}</div>
        })}
      </pre>
    )
  }
  const maxShow = 4000
  const truncated = output.length > maxShow
  const show = truncated ? output.slice(0, maxShow) + "\n… [truncated]" : output
  return (
    <pre className="bg-[var(--vscode-editor-background)] rounded p-1.5 overflow-x-auto text-[10px] whitespace-pre-wrap max-h-64 overflow-y-auto font-mono">
      {show}
    </pre>
  )
}

interface Props {
  return (
    <span
      className="flex-shrink-0 text-[var(--vscode-descriptionForeground)] transition-transform inline-flex"
      style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}
    >
      ▼
    </span>
  )
}

interface Props {
  messages: SessionMessage[]
}

export function EditableFilesBlock({ messages }: Props) {
  const entries = useMemo(() => collectEditedFiles(messages), [messages])
  const [expandedByPath, setExpandedByPath] = useState<Record<string, boolean>>({})
  const [hoverPath, setHoverPath] = useState<string | null>(null)

  if (entries.length === 0) return null

  const toggle = (path: string) => {
    setExpandedByPath((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  return (
    <div
      data-editable-files-block
      className="flex-shrink-0 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] overflow-hidden"
    >
      {entries.map((entry) => {
        const expanded = expandedByPath[entry.path] ?? false
        const showChevron = hoverPath === entry.path
        return (
          <div
            key={entry.path}
            className="border-b border-[var(--vscode-panel-border)] last:border-b-0"
          >
            <div
              className="nexus-file-edit-header flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-xs hover:bg-[var(--vscode-list-hoverBackground)]"
              onMouseEnter={() => setHoverPath(entry.path)}
              onMouseLeave={() => setHoverPath(null)}
            >
              <button
                type="button"
                className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]"
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(entry.path)
                }}
                aria-label={expanded ? "Collapse" : "Expand"}
              >
                {showChevron ? (
                  <ChevronIcon expanded={expanded} />
                ) : (
                  <span className="nexus-file-edit-badge text-[9px] px-1.5 py-0.5">
                    {entry.langBadge}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="flex-1 min-w-0 text-left truncate font-medium text-[var(--vscode-foreground)] hover:underline"
                onClick={(e) => {
                  e.stopPropagation()
                  postMessage({ type: "showDiff", path: entry.path })
                }}
              >
                {entry.fileName}
              </button>
              <span className="flex-shrink-0 text-[10px] text-[var(--vscode-descriptionForeground)]">
                {entry.statLabel}
              </span>
            </div>
            {expanded && (
              <div className="nexus-file-edit-content border-t border-[var(--vscode-panel-border)] px-3 pb-2">
                <DiffPreview output={entry.part.output ?? ""} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
