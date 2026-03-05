import React, { useState } from "react"
import { postMessage } from "../vscode.js"
import type { ToolPart } from "../stores/chat.js"

/** Extract path:line pairs from search/codebase output for "Open in editor" links */
function extractPathLinePairs(output: string): Array<{ path: string; line: number }> {
  const seen = new Set<string>()
  const out: Array<{ path: string; line: number }> = []
  // Match path-like (with / or .ext) then :digits (e.g. src/foo.ts:42 or path/to/file:10)
  const re = /\b([a-zA-Z0-9_][a-zA-Z0-9_./-]*):(\d+)(?=[:\s\n]|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) {
    const path = m[1]!
    const line = parseInt(m[2]!, 10)
    if (path.includes("/") || /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|cpp|h|md|json|yaml|yml)$/i.test(path)) {
      const key = `${path}:${line}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ path, line })
      }
    }
  }
  return out.slice(0, 12)
}

interface Props {
  part: ToolPart
  /** When set, render approval UI inline inside the card (same field as tool). */
  approval?: React.ReactNode
}

const TOOL_ICONS: Record<string, string> = {
  read_file: "📄",
  write_to_file: "✍️",
  replace_in_file: "✏️",
  execute_command: "⌨️",
  search_files: "🔍",
  list_files: "📁",
  list_code_definitions: "🏗️",
  read_lints: "⚠️",
  codebase_search: "🔎",
  web_fetch: "🌐",
  web_search: "🌍",
  glob: "📋",
  browser_action: "🖥️",
  spawn_agent: "🤖",
  use_skill: "💡",
  final_report_to_user: "✅",
  ask_followup_question: "❓",
  progress_note: "📌",
  update_todo_list: "📝",
  thinking_preamble: "💭",
  create_rule: "📏",
  batch: "📦",
}

function toolDisplayName(tool: string): string {
  if (tool === "execute_command") return "bash"
  return tool
}

/* Tool cards (except file edit): on chat background, only subtle status bar */
const STATUS_STYLES = {
  pending:   "border-l-2 border-l-yellow-500",
  running:   "border-l-2 border-l-blue-400",
  completed: "border-l-2 border-l-green-500",
  error:     "border-l-2 border-l-red-500",
}

function getLangBadge(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
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

function isFileEditTool(part: ToolPart): boolean {
  return ["read_file", "write_to_file", "replace_in_file"].includes(part.tool)
}

/** Up to 4 lines: first added/removed line, 1 line above, then window of 4 lines down (or until 1 context line inclusive). */
function getDiffPreviewHunks(hunks: Array<{ type: string; lineNum: number; line: string }>): Array<{ type: string; lineNum: number; line: string }> {
  if (!hunks.length) return []
  const firstChangeIdx = hunks.findIndex((h) => h.type === "add" || h.type === "remove")
  if (firstChangeIdx === -1) return hunks.slice(0, 4)
  const start = Math.max(0, firstChangeIdx - 1)
  let end = start + 4
  for (let i = start; i < Math.min(hunks.length, start + 4); i++) {
    if (i > firstChangeIdx && hunks[i]!.type === "context") {
      end = i + 1
      break
    }
    end = i + 1
  }
  return hunks.slice(start, end)
}

const DIFF_PREVIEW_LINE_HEIGHT = 1.4
const DIFF_PREVIEW_MAX_LINES = 4
const diffPreviewMaxHeightRem = DIFF_PREVIEW_MAX_LINES * DIFF_PREVIEW_LINE_HEIGHT

/** Parse "Successfully updated path\n...\n<updated_content>\n...\n</updated_content>" for fallback. */
function parseSuccessfullyUpdatedOutput(output: string): { content: string } | null {
  const contentMatch = output.match(/<updated_content>\s*([\s\S]*?)<\/updated_content>/)
  const content = contentMatch?.[1]?.trim() ?? ""
  if (!content) return null
  return { content }
}

/** Fallback diff hunks from raw content when diffHunks missing — first N lines as "add". */
function buildFallbackDiffHunks(content: string, maxLines = 4): Array<{ type: "add"; lineNum: number; line: string }> {
  const lines = content.split(/\r?\n/)
  return lines.slice(0, maxLines).map((line, i) => ({ type: "add" as const, lineNum: i + 1, line: line || " " }))
}

function getFileEditPath(part: ToolPart): string | null {
  if (part.path != null && String(part.path).trim()) return String(part.path).trim()
  const pathVal = part.input?.path
  if (pathVal != null && String(pathVal).trim()) return String(pathVal).trim()
  const m = part.output?.match(/<file_content\s+path="([^"]+)"/)
  if (m) return m[1]!
  return null
}

function getEditStatLabel(part: ToolPart): string {
  if (part.diffStats != null) {
    const { added, removed } = part.diffStats
    return [added > 0 ? `+${added}` : "", removed > 0 ? `-${removed}` : ""].filter(Boolean).join(" ")
  }
  const output = part.output ?? ""
  if (part.tool === "read_file") {
    const m = output.match(/<file_content\s+path="[^"]+"\s+lines="([^"]+)"\s+total="([^"]+)">/)
    if (m) {
      const [, linesAttr, total] = m
      if (linesAttr && total) {
        const totalNum = parseInt(total, 10)
        const isFull = linesAttr === `1-${totalNum}` || linesAttr === `1-${total}`
        if (!isFull) return `lines ${linesAttr}`
      }
    }
    return "view"
  }
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

/** Inline file-edit block in chat: one block per replace_in_file/write_to_file, chronological. Collapsible, hover chevron, click filename opens diff in VS Code. When diffHunks present, shows line-by-line diff (red/green). */
export function InlineFileEditBlock({ part, approval }: { part: ToolPart; approval?: React.ReactNode }) {
  const path = getFileEditPath(part)
  const output = part.output ?? ""
  const [expanded, setExpanded] = useState(true)
  const [hovered, setHovered] = useState(false)
  if (!path && !output && !(part.diffHunks?.length)) return null
  const lang = path ? getLangBadge(path) : "FILE"
  const fileName = path ? path.split("/").pop() ?? path : "file"
  const statLabel = getEditStatLabel(part)
  const hasDiffHunks = Array.isArray(part.diffHunks) && part.diffHunks.length > 0
  const fallback = !hasDiffHunks ? parseSuccessfullyUpdatedOutput(output) : null
  const previewHunks = hasDiffHunks
    ? getDiffPreviewHunks(part.diffHunks!)
    : fallback
      ? buildFallbackDiffHunks(fallback.content, DIFF_PREVIEW_MAX_LINES)
      : []
  const showDiffPreview = previewHunks.length > 0
  return (
    <div
      className="nexus-file-edit-block my-2"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="nexus-file-edit-header flex items-center gap-2">
        <button
          type="button"
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((prev) => !prev)
          }}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {hovered ? (
            <span
              className="text-[var(--vscode-descriptionForeground)] transition-transform inline-flex"
              style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}
            >
              ▼
            </span>
          ) : (
            <span className="nexus-file-edit-badge">{lang}</span>
          )}
        </button>
        <button
          type="button"
          className="nexus-file-edit-path flex-1 min-w-0 text-left truncate font-medium text-[var(--vscode-foreground)] hover:underline"
          onClick={(e) => {
            e.stopPropagation()
            if (path) postMessage({ type: "showDiff", path })
          }}
        >
          {fileName}
        </button>
        {part.diffStats != null ? (
          <span className="nexus-file-edit-stats flex-shrink-0 flex items-center gap-1">
            {part.diffStats.added > 0 && <span className="text-green-500">+{part.diffStats.added}</span>}
            {part.diffStats.removed > 0 && <span className="text-red-400">-{part.diffStats.removed}</span>}
          </span>
        ) : statLabel ? (
          <span className="nexus-file-edit-stats flex-shrink-0">
            {statLabel.startsWith("+") && !statLabel.includes("-") ? (
              <span className="text-green-500">{statLabel}</span>
            ) : (
              statLabel
            )}
          </span>
        ) : null}
      </div>
      {expanded && (
        <div className="nexus-file-edit-content">
          {showDiffPreview ? (
            <div className="nexus-diff-view rounded overflow-hidden border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
              <div className="nexus-diff-view-header px-2 py-1 text-[10px] font-mono border-b border-[var(--vscode-panel-border)] flex items-center gap-2">
                {fileName}
                {part.diffStats != null && (
                  <>
                    {part.diffStats.added > 0 && <span className="text-green-500">+{part.diffStats.added}</span>}
                    {part.diffStats.removed > 0 && <span className="text-red-400">-{part.diffStats.removed}</span>}
                  </>
                )}
                {fallback && part.diffStats == null && output.includes("replaced") && (
                  <span className="text-[var(--vscode-descriptionForeground)]">edited</span>
                )}
              </div>
              <pre
                className="p-0 overflow-x-auto text-[11px] leading-relaxed font-mono overflow-y-auto nexus-diff-preview-pre"
                style={{ lineHeight: DIFF_PREVIEW_LINE_HEIGHT, maxHeight: `${diffPreviewMaxHeightRem}rem` }}
              >
                {previewHunks.map((h, i) => {
                  if (h.type === "add") {
                    return (
                      <div key={i} className="px-2 py-0.5 bg-green-500/15 text-green-600 dark:text-green-400 whitespace-pre">
                        <span className="inline-block w-8 text-right mr-2 text-[var(--vscode-descriptionForeground)] select-none">{h.lineNum}</span>
                        <span className="text-green-600 dark:text-green-400">+</span> {h.line || " "}
                      </div>
                    )
                  }
                  if (h.type === "remove") {
                    return (
                      <div key={i} className="px-2 py-0.5 bg-red-500/15 text-red-600 dark:text-red-400 whitespace-pre">
                        <span className="inline-block w-8 text-right mr-2 text-[var(--vscode-descriptionForeground)] select-none">{h.lineNum}</span>
                        <span className="text-red-600 dark:text-red-400">-</span> {h.line || " "}
                      </div>
                    )
                  }
                  return (
                    <div key={i} className="px-2 py-0.5 text-[var(--vscode-foreground)] whitespace-pre">
                      <span className="inline-block w-8 text-right mr-2 text-[var(--vscode-descriptionForeground)] select-none">{h.lineNum}</span>
                      {h.line || " "}
                    </div>
                  )
                })}
              </pre>
            </div>
          ) : (
            <ToolOutputBlock output={output} compacted={part.compacted} />
          )}
        </div>
      )}
      {approval}
    </div>
  )
}

/** File edit/add block: language badge + path + diff stats, then code with green/red highlights (reference design). When diffHunks present, shows line-by-line diff. */
function FileEditBlock({ part }: { part: ToolPart }) {
  const path = getFileEditPath(part)
  const output = part.output ?? ""
  const hasDiffHunks = Array.isArray(part.diffHunks) && part.diffHunks.length > 0
  if (!path && !output && !hasDiffHunks) return null
  const lang = path ? getLangBadge(path) : "FILE"
  const fileName = path ? path.split("/").pop() ?? path : "file"
  const stats = getDiffStats(output)
  const isDiff = output.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-")).length >= 3
  const fallbackLabel =
    isDiff && (stats.add > 0 || stats.del > 0)
      ? [stats.add > 0 ? `+${stats.add}` : "", stats.del > 0 ? `-${stats.del}` : ""].filter(Boolean).join(" ")
      : part.tool === "read_file"
        ? getEditStatLabel(part)
        : ""

  return (
    <div className="nexus-file-edit-block">
      <div className="nexus-file-edit-header">
        <span className="nexus-file-edit-badge">{lang}</span>
        <span className="nexus-file-edit-path">{fileName}</span>
        {part.diffStats != null ? (
          <span className="nexus-file-edit-stats flex items-center gap-1">
            {part.diffStats.added > 0 && <span className="text-green-500">+{part.diffStats.added}</span>}
            {part.diffStats.removed > 0 && <span className="text-red-400">-{part.diffStats.removed}</span>}
          </span>
        ) : fallbackLabel ? (
          <span className="nexus-file-edit-stats">{fallbackLabel}</span>
        ) : null}
      </div>
      <div className="nexus-file-edit-content">
        {hasDiffHunks ? (
          <div className="nexus-diff-view rounded overflow-hidden border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
            <div className="nexus-diff-view-header px-2 py-1 text-[10px] font-mono border-b border-[var(--vscode-panel-border)] flex items-center gap-2">
              {fileName}
              {part.diffStats != null && (
                <>
                  {part.diffStats.added > 0 && <span className="text-green-500">+{part.diffStats.added}</span>}
                  {part.diffStats.removed > 0 && <span className="text-red-400">-{part.diffStats.removed}</span>}
                </>
              )}
            </div>
            <pre className="p-0 overflow-x-auto text-[11px] leading-relaxed font-mono overflow-y-auto">
              {getDiffPreviewHunks(part.diffHunks!).map((h, i) => {
                if (h.type === "add") {
                  return (
                    <div key={i} className="px-2 py-0.5 bg-green-500/15 text-green-600 dark:text-green-400 whitespace-pre">
                      <span className="inline-block w-8 text-right mr-2 text-[var(--vscode-descriptionForeground)] select-none">{h.lineNum}</span>
                      <span className="text-green-600 dark:text-green-400">+</span> {h.line || " "}
                    </div>
                  )
                }
                if (h.type === "remove") {
                  return (
                    <div key={i} className="px-2 py-0.5 bg-red-500/15 text-red-600 dark:text-red-400 whitespace-pre">
                      <span className="inline-block w-8 text-right mr-2 text-[var(--vscode-descriptionForeground)] select-none">{h.lineNum}</span>
                      <span className="text-red-600 dark:text-red-400">-</span> {h.line || " "}
                    </div>
                  )
                }
                return (
                  <div key={i} className="px-2 py-0.5 text-[var(--vscode-foreground)] whitespace-pre">
                    <span className="inline-block w-8 text-right mr-2 text-[var(--vscode-descriptionForeground)] select-none">{h.lineNum}</span>
                    {h.line || " "}
                  </div>
                )
              })}
            </pre>
          </div>
        ) : (
          <ToolOutputBlock output={output} compacted={part.compacted} />
        )}
      </div>
    </div>
  )
}

/** One-line progress preview: file path + lines, folder, or other key args (same idea as CLI formatToolPreview). */
function formatToolInputPreview(part: ToolPart): string {
  const inp = part.input ?? {}
  const pathVal = inp["path"]
  const pathStr = pathVal != null ? String(pathVal).trim() : ""
  const startLine = inp["start_line"]
  const endLine = inp["end_line"]
  const pattern = inp["pattern"]
  const patterns = inp["patterns"]
  const pathsArr = inp["paths"]
  const command = inp["command"]
  const query = inp["query"]
  const url = inp["url"]
  const short = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s)

  switch (part.tool) {
    case "read_file": {
      if (!pathStr) return ""
      let range = ""
      const out = part.output ?? ""
      const fileContentMatch = out.match(/<file_content\s+path="[^"]+"\s+lines="([^"]+)"\s+total="([^"]+)">/)
      if (fileContentMatch) {
        const [, linesAttr, total] = fileContentMatch
        if (linesAttr && total) {
          const totalNum = parseInt(total, 10)
          const isFull = linesAttr === `1-${totalNum}` || linesAttr === `1-${total}`
          if (!isFull) range = ` (lines ${linesAttr})`
        }
      }
      if (!range && typeof startLine === "number" && typeof endLine === "number") range = ` (lines ${startLine}–${endLine})`
      else if (!range && typeof startLine === "number") range = ` (line ${startLine})`
      return short(pathStr, 56) + range
    }
    case "list_files":
      return pathStr ? `folder ${short(pathStr, 48)}` : "folder ."
    case "write_to_file":
    case "replace_in_file":
      return pathStr ? short(pathStr, 56) : ""
    case "search_files": {
      const pat = Array.isArray(patterns) && patterns.length
        ? `patterns(${patterns.length})`
        : pattern && typeof pattern === "string"
          ? short(String(pattern).replace(/\s+/g, " "), 32)
          : ""
      const scope = Array.isArray(pathsArr) && pathsArr.length
        ? pathsArr.slice(0, 2).join(", ")
        : pathStr
          ? pathStr
          : ""
      return [pat, scope].filter(Boolean).join(" in ") || "search"
    }
    case "codebase_search": {
      const q = query && typeof query === "string" ? short(String(query).replace(/\s+/g, " "), 36) : ""
      const scope = Array.isArray(pathsArr) && pathsArr.length
        ? pathsArr.slice(0, 1).join("")
        : pathStr || ""
      return scope ? `${q} in ${short(scope, 24)}` : q || "search"
    }
    case "execute_command":
      return command && typeof command === "string" ? short(String(command).replace(/\s+/g, " "), 48) : ""
    case "web_fetch":
    case "web_search":
      return url && typeof url === "string" ? short(String(url), 52) : ""
    case "glob":
      return (inp["glob_pattern"] && typeof inp["glob_pattern"] === "string")
        ? short(String(inp["glob_pattern"]), 48)
        : ""
    case "read_lints": {
      const paths = inp["paths"]
      if (Array.isArray(paths) && paths.length > 0) return short(paths.slice(0, 3).join(", "), 52)
      return "workspace"
    }
    case "list_code_definitions":
      return pathStr ? short(pathStr, 56) : ""
    case "batch": {
      const reads = (inp["reads"] as unknown[])?.length ?? 0
      const searches = (inp["searches"] as unknown[])?.length ?? 0
      const replaces = (inp["replaces"] as unknown[])?.length ?? 0
      return [reads && `${reads} read(s)`, searches && `${searches} search(es)`, replaces && `${replaces} replace(s)`].filter(Boolean).join(", ") || "batch"
    }
    case "spawn_agent": {
      const desc = inp["description"]
      return desc && typeof desc === "string" ? short(desc.replace(/\s+/g, " "), 48) : "subtask"
    }
    case "progress_note":
    case "final_report_to_user": {
      const msg = inp["message"]
      return msg && typeof msg === "string" ? short(String(msg).replace(/\s+/g, " "), 52) : ""
    }
    case "thinking_preamble": {
      const msg = inp["user_message"]
      const reasoning = inp["reasoning_and_next_actions"]
      if (msg && typeof msg === "string") return short(String(msg).replace(/\s+/g, " "), 52)
      if (reasoning && typeof reasoning === "string") return short(String(reasoning).replace(/\s+/g, " "), 52)
      return "thinking"
    }
    default:
      return Object.entries(inp)
        .filter(([k]) => k !== "task_progress")
        .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
        .slice(0, 2)
        .join(", ") || ""
  }
}

export function ToolCallCard({ part, approval }: Props) {
  const [expanded, setExpanded] = useState(false)
  const icon = TOOL_ICONS[part.tool] ?? "🔧"
  const isMcp = part.tool.includes("__")
  const elapsed = part.timeStart && part.timeEnd
    ? `${((part.timeEnd - part.timeStart) / 1000).toFixed(1)}s`
    : null

  const statusIcon = {
    pending:   <SpinnerIcon />,
    running:   <SpinnerIcon />,
    completed: "✓",
    error:     "✗",
  }[part.status]

  const inputPreview = formatToolInputPreview(part)

  return (
    <div className={`my-1 text-xs ${STATUS_STYLES[part.status]}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-1 py-0.5 text-left hover:opacity-80 transition-opacity"
      >
        <span className="flex-shrink-0">{icon}</span>
        <span className="font-mono text-[var(--vscode-foreground)] flex-shrink-0">{toolDisplayName(part.tool)}</span>
        {isMcp && (
          <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)]" title="MCP tool">
            MCP
          </span>
        )}
        {inputPreview && (
          <span className="text-[var(--vscode-descriptionForeground)] truncate flex-1 min-w-0">{inputPreview}</span>
        )}
        <span className="flex-shrink-0 ml-auto flex items-center gap-1">
          {elapsed && <span className="text-[var(--vscode-descriptionForeground)]">{elapsed}</span>}
          <span className={part.status === "completed" ? "text-green-500" : part.status === "error" ? "text-red-500" : "text-blue-400"}>
            {statusIcon}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="px-2 pb-2 space-y-1">
          {isFileEditTool(part) && part.output && (
            <FileEditBlock part={part} />
          )}
          {part.tool === "thinking_preamble" && part.input && (
            <div className="space-y-2 font-sans" style={{ fontFamily: "var(--vscode-font-family)" }}>
              {(part.input.user_message as string)?.trim() && (
                <div>
                  <div className="text-[var(--vscode-descriptionForeground)] mb-0.5 text-[10px]">Message</div>
                  <div className="text-sm text-[var(--vscode-foreground)] whitespace-pre-wrap break-words leading-relaxed bg-[var(--vscode-editor-background)] rounded p-1.5">
                    {(part.input.user_message as string).trim()}
                  </div>
                </div>
              )}
              {(part.input.reasoning_and_next_actions as string)?.trim() && (
                <div>
                  <div className="text-[var(--vscode-descriptionForeground)] mb-0.5 text-[10px]">Reasoning</div>
                  <div className="text-xs text-[var(--vscode-foreground)] whitespace-pre-wrap break-words leading-relaxed bg-[var(--vscode-editor-background)] rounded p-1.5 max-h-48 overflow-y-auto">
                    {(part.input.reasoning_and_next_actions as string).trim()}
                  </div>
                </div>
              )}
            </div>
          )}
          {part.input && Object.keys(part.input).length > 0 && !(isFileEditTool(part) && part.output) && part.tool !== "thinking_preamble" && (
            <div>
              <div className="text-[var(--vscode-descriptionForeground)] mb-0.5">Input:</div>
              <pre className="bg-[var(--vscode-editor-background)] rounded p-1.5 overflow-x-auto text-[10px] whitespace-pre-wrap max-h-32 overflow-y-auto">
                {JSON.stringify(
                  Object.fromEntries(Object.entries(part.input).filter(([k]) => k !== "task_progress")),
                  null, 2
                )}
              </pre>
            </div>
          )}
          {part.output && !isFileEditTool(part) && (
            <div>
              <div className="flex items-center justify-between gap-2 mb-0.5">
                <span className="text-[var(--vscode-descriptionForeground)]">Output:</span>
                <OpenAtLineLinks output={part.output} />
              </div>
              <ToolOutputBlock output={part.output} compacted={part.compacted} />
            </div>
          )}
          {part.output && isFileEditTool(part) && (
            <div className="flex items-center justify-end">
              <OpenAtLineLinks output={part.output} />
            </div>
          )}
          {part.error && (
            <div className="text-red-400 text-[10px] p-1.5 bg-red-500/10 rounded">{part.error}</div>
          )}
          {elapsed && part.status === "completed" && (
            <div className="nexus-tool-elapsed text-[10px] text-[var(--vscode-descriptionForeground)] pt-0.5">
              Ran in {elapsed}
            </div>
          )}
        </div>
      )}
      {approval}
    </div>
  )
}

function OpenAtLineLinks({ output }: { output: string }) {
  const pairs = extractPathLinePairs(output)
  if (pairs.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {pairs.map(({ path, line }, i) => (
        <button
          key={`${path}-${line}-${i}`}
          type="button"
          onClick={() => postMessage({ type: "openFileAtLocation", path, line })}
          className="text-[10px] font-medium text-[var(--nexus-accent)] hover:underline"
        >
          Open {path.split("/").pop()}:{line}
        </button>
      ))}
    </div>
  )
}

function ToolOutputBlock({ output, compacted }: { output: string; compacted?: boolean }) {
  if (compacted) {
    return (
      <pre className="bg-[var(--vscode-editor-background)] rounded p-1.5 text-[10px] text-[var(--vscode-descriptionForeground)]">
        [output pruned for context efficiency]
      </pre>
    )
  }
  const fileMatch = output.match(/<file_content\s+path="([^"]+)"\s+lines="([^"]+)"\s+total="([^"]+)">\s*([\s\S]*?)<\/file_content>/)
  if (fileMatch) {
    const [, path, lines, total, content] = fileMatch
    return (
      <div className="space-y-1">
        <div className="text-[10px] text-[var(--vscode-descriptionForeground)] font-mono">
          {path} (lines {lines}, total {total})
        </div>
        <pre className="bg-[var(--vscode-editor-background)] rounded p-1.5 overflow-x-auto text-[10px] whitespace-pre-wrap max-h-64 overflow-y-auto font-mono">
          {content.trim()}
        </pre>
      </div>
    )
  }
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
  const maxShow = 8000
  const truncated = output.length > maxShow
  return (
    <pre className="bg-[var(--vscode-editor-background)] rounded p-1.5 overflow-x-auto text-[10px] whitespace-pre-wrap max-h-64 overflow-y-auto">
      {truncated ? output.slice(0, maxShow) : output}
      {truncated ? "\n... (truncated)" : ""}
    </pre>
  )
}

function SpinnerIcon() {
  return (
    <svg className="animate-spin h-3 w-3 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}
