import React, { useState } from "react"
import { postMessage } from "../vscode.js"
import type { ToolPart, SubAgentState } from "../stores/chat.js"
import {
  TOOL_ICONS as TOOL_ICONS_META,
  getParallelUses as getParallelUsesMeta,
  normalizeParallelRecipientName as normalizeParallelRecipientNameMeta,
  toolDisplayName as toolDisplayNameMeta,
} from "../transcript/toolMeta.js"
import { buildFileChangePreview } from "./fileChangePreview.js"

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
  /** After expand/collapse so virtualized chat can re-pin to bottom when appropriate. */
  onLayoutHint?: () => void
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
  return ["read_file", "Read", "write_to_file", "Write", "replace_in_file", "Edit"].includes(part.tool)
}

/** Up to 4 changed lines (+/- only). */
function getDiffPreviewHunks(hunks: Array<{ type: string; lineNum: number; line: string }>): Array<{ type: string; lineNum: number; line: string }> {
  if (!hunks.length) return []
  return hunks.filter((h) => h.type === "add" || h.type === "remove").slice(0, 4)
}

/** What Edit actually replaced (snippets), capped for the inline preview. */
function getAppliedReplacementsPreviewLines(
  applied: Array<{ oldSnippet: string; newSnippet: string }>,
  maxLines: number,
): Array<{ type: "add" | "remove"; lineNum: number; line: string }> {
  const out: Array<{ type: "add" | "remove"; lineNum: number; line: string }> = []
  let lineNum = 1
  outer: for (const { oldSnippet, newSnippet } of applied) {
    for (const line of oldSnippet.split(/\r?\n/)) {
      out.push({ type: "remove", lineNum: lineNum++, line: line || " " })
      if (out.length >= maxLines) break outer
    }
    for (const line of newSnippet.split(/\r?\n/)) {
      out.push({ type: "add", lineNum: lineNum++, line: line || " " })
      if (out.length >= maxLines) break outer
    }
  }
  return out
}

const DIFF_PREVIEW_LINE_HEIGHT = 1.4
const DIFF_PREVIEW_MAX_LINES = 6
const diffPreviewMaxHeightRem = DIFF_PREVIEW_MAX_LINES * DIFF_PREVIEW_LINE_HEIGHT
/** Larger cap for expanded file-edit card (still snippet-based for Edit when appliedReplacements set). */
const FILE_EDIT_EXPANDED_MAX_LINES = 120

function getFileEditPath(part: ToolPart): string | null {
  if (part.path != null && String(part.path).trim()) return String(part.path).trim()
  const pathVal = part.input?.path ?? part.input?.file_path
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
  if (part.tool === "read_file" || part.tool === "Read") {
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
  if (part.tool === "write_to_file" || part.tool === "Write") {
    const m = output.match(/\((\d+)\s+lines?\)/)
    if (m) return `+${m[1]}`
  }
  return "edited"
}

/** Inline file-edit block in chat: one block per replace_in_file/write_to_file, chronological. Collapsible, hover chevron, click filename opens diff in VS Code. When diffHunks present, shows line-by-line diff (red/green). */
export function InlineFileEditBlock({
  part,
  approval,
  onLayoutHint,
}: {
  part: ToolPart
  approval?: React.ReactNode
  onLayoutHint?: () => void
}) {
  const path = getFileEditPath(part)
  const output = part.output ?? ""
  const [expanded, setExpanded] = useState(true)
  if (!path && !output && !(part.diffHunks?.length)) return null
  const fileName = path ? path.split("/").pop() ?? path : "file"
  const preview = buildFileChangePreview(part, DIFF_PREVIEW_MAX_LINES)

  return (
    <div className="nexus-file-edit-block nexus-chat-column-frame">
      <div
        className="nexus-file-edit-header"
        role="button"
        tabIndex={0}
        aria-label={`Toggle diff preview for ${fileName}`}
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((prev) => !prev)
          onLayoutHint?.()
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setExpanded((prev) => !prev)
            onLayoutHint?.()
          }
        }}
      >
        <span className="nexus-file-edit-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" focusable="false">
            <path d="M3.5 1.5h5l4 4v9h-9z" />
            <path d="M8.5 1.5v4h4" />
            <path d="M5.5 8h5M5.5 10.5h5" />
          </svg>
        </span>
        <div className="nexus-file-edit-title-cluster">
          <button
            type="button"
            className="nexus-file-edit-path"
            onClick={(e) => {
              e.stopPropagation()
              if (path) postMessage({ type: "showDiff", path })
            }}
          >
            {fileName}
          </button>
          <span className="nexus-file-edit-stats">
            {preview.stats.added > 0 && (
              <span className="nexus-file-edit-additions">+{preview.stats.added}</span>
            )}
            {preview.stats.removed > 0 && (
              <span className="nexus-file-edit-deletions">-{preview.stats.removed}</span>
            )}
          </span>
        </div>
        <span
          aria-hidden="true"
          className={`nexus-file-edit-chevron${expanded ? " nexus-file-edit-chevron--open" : ""}`}
        >
          ›
        </span>
      </div>
      {expanded && (
        <div className="nexus-file-edit-content">
          {!preview.statusOnly ? (
            <div className="nexus-diff-view">
              <pre
                className="nexus-diff-preview-pre"
                style={{ lineHeight: DIFF_PREVIEW_LINE_HEIGHT, maxHeight: `${diffPreviewMaxHeightRem}rem` }}
              >
                {preview.lines.map((line, index) => (
                  <div
                    key={`${line.type}-${line.lineNum}-${index}`}
                    className={`nexus-diff-line nexus-diff-line--${line.type}`}
                    data-change-kind={line.type}
                  >
                    <span className="nexus-diff-line-number">{line.lineNum}</span>
                    <span className="nexus-diff-line-marker">
                      {line.type === "add" ? "+" : "-"}
                    </span>
                    <span className="nexus-diff-line-text">{line.line || " "}</span>
                  </div>
                ))}
              </pre>
              {preview.hiddenLineCount > 0 && (
                <div className="nexus-diff-hidden-lines">
                  <span>{preview.hiddenLineCount} more changed lines</span>
                </div>
              )}
            </div>
          ) : (
            <div className="nexus-file-edit-status-only">
              Diff preview unavailable
            </div>
          )}
        </div>
      )}
      {approval}
    </div>
  )
}

export function ApplyPatchFileChangesBlock({
  part,
  approval,
  onLayoutHint,
}: {
  part: ToolPart
  approval?: React.ReactNode
  onLayoutHint?: () => void
}) {
  const files = part.changeFiles ?? []
  if (files.length === 0) return null

  return (
    <div className="nexus-apply-patch-file-list">
      {files.map((file, index) => (
        <InlineFileEditBlock
          key={`${file.oldPath ?? file.path}:${file.path}:${index}`}
          part={{
            type: "tool",
            id: `${part.id}:file:${index}`,
            tool: file.operation === "create" ? "Write" : "Edit",
            status: part.status,
            path: file.path,
            diffStats: file.diffStats,
            diffHunks: file.diffHunks,
            compacted: part.compacted,
          }}
          onLayoutHint={onLayoutHint}
        />
      ))}
      {approval}
    </div>
  )
}

/** File edit/add block: language badge + path + diff stats, then code with green/red highlights (reference design). When diffHunks present, shows line-by-line diff. */
function FileEditBlock({ part }: { part: ToolPart }) {
  const path = getFileEditPath(part)
  const output = part.output ?? ""
  const appliedEdit =
    (part.tool === "Edit" || part.tool === "replace_in_file") &&
    Array.isArray(part.appliedReplacements) &&
    part.appliedReplacements.length > 0
      ? part.appliedReplacements
      : null
  const hasDiffHunks = Array.isArray(part.diffHunks) && part.diffHunks.length > 0
  if (!path && !output && !hasDiffHunks && !appliedEdit) return null
  const lang = path ? getLangBadge(path) : "FILE"
  const fileName = path ? path.split("/").pop() ?? path : "file"
  const stats = getDiffStats(output)
  const isDiff = output.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-")).length >= 3
  const fallbackLabel =
    isDiff && (stats.add > 0 || stats.del > 0)
      ? [stats.add > 0 ? `+${stats.add}` : "", stats.del > 0 ? `-${stats.del}` : ""].filter(Boolean).join(" ")
      : part.tool === "read_file" || part.tool === "Read"
        ? getEditStatLabel(part)
        : ""

  return (
    <div className="nexus-file-edit-block">
      <div className="nexus-file-edit-header flex items-center gap-2">
        <span className="nexus-file-edit-badge flex-shrink-0">{lang}</span>
        <div className="nexus-file-edit-title-cluster">
          <span className="nexus-file-edit-path font-medium">{fileName}</span>
          {part.diffStats != null ? (
            <span className="nexus-file-edit-stats flex items-center gap-1">
              {part.diffStats.added > 0 && <span className="text-green-500">+{part.diffStats.added}</span>}
              {part.diffStats.removed > 0 && <span className="text-red-400">-{part.diffStats.removed}</span>}
            </span>
          ) : fallbackLabel ? (
            <span className="nexus-file-edit-stats">{fallbackLabel}</span>
          ) : null}
        </div>
      </div>
      <div className="nexus-file-edit-content">
        {appliedEdit ? (
          <div className="nexus-diff-view rounded overflow-hidden border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
            <pre className="p-0 overflow-x-auto text-[11px] leading-relaxed font-mono overflow-y-auto max-h-[min(70vh,480px)]">
              {getAppliedReplacementsPreviewLines(appliedEdit, FILE_EDIT_EXPANDED_MAX_LINES).map((h, i) => {
                if (h.type === "add") {
                  return (
                    <div key={i} className="px-2 py-0.5 bg-green-500/15 text-green-600 dark:text-green-400 whitespace-pre">
                      <span className="inline-block w-8 text-right mr-2 text-[var(--vscode-descriptionForeground)] select-none">{h.lineNum}</span>
                      <span className="text-green-600 dark:text-green-400">+</span> {h.line || " "}
                    </div>
                  )
                }
                return (
                  <div key={i} className="px-2 py-0.5 bg-red-500/15 text-red-600 dark:text-red-400 whitespace-pre">
                    <span className="inline-block w-8 text-right mr-2 text-[var(--vscode-descriptionForeground)] select-none">{h.lineNum}</span>
                    <span className="text-red-600 dark:text-red-400">-</span> {h.line || " "}
                  </div>
                )
              })}
            </pre>
          </div>
        ) : hasDiffHunks ? (
          <div className="nexus-diff-view rounded overflow-hidden border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
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
                return null
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
  const pathVal = inp["path"] ?? inp["file_path"]
  const pathStr = pathVal != null ? String(pathVal).trim() : ""
  const startLine = inp["start_line"] ?? inp["offset"]
  const endLine = inp["end_line"]
  const limit = inp["limit"]
  const pattern = inp["pattern"]
  const patterns = inp["patterns"]
  const pathsArr = inp["paths"]
  const command = inp["command"]
  const query = inp["query"]
  const url = inp["url"]
  const short = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s)

  switch (part.tool) {
    case "read_file":
    case "Read": {
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
      if (!range && typeof startLine === "number" && (typeof endLine === "number" || typeof limit === "number")) {
        const end = typeof endLine === "number" ? endLine : (typeof limit === "number" ? (startLine as number) + limit - 1 : undefined)
        range = end != null ? ` (lines ${startLine}–${end})` : ` (line ${startLine})`
      } else if (!range && typeof startLine === "number") range = ` (line ${startLine})`
      return short(pathStr, 56) + range
    }
    case "list_dir":
    case "List":
      return pathStr ? `folder ${short(pathStr, 48)}` : "folder ."
    case "write_to_file":
    case "Write":
    case "replace_in_file":
    case "Edit":
      return pathStr ? short(pathStr, 56) : ""
    case "search_files":
    case "Grep": {
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
    case "codebase_search":
    case "CodebaseSearch": {
      const q = query && typeof query === "string" ? short(String(query).replace(/\s+/g, " "), 36) : ""
      const scope = Array.isArray(pathsArr) && pathsArr.length
        ? pathsArr.slice(0, 1).join("")
        : pathStr || ""
      return scope ? `${q} in ${short(scope, 24)}` : q || "search"
    }
    case "execute_command":
    case "Bash":
      return command && typeof command === "string" ? short(String(command).replace(/\s+/g, " "), 48) : ""
    case "web_fetch":
    case "WebFetch":
    case "web_search":
    case "WebSearch":
      return url && typeof url === "string" ? short(String(url), 52) : ""
    case "glob":
    case "Glob":
      return (inp["glob_pattern"] ?? inp["pattern"]) && typeof (inp["glob_pattern"] ?? inp["pattern"]) === "string"
        ? short(String(inp["glob_pattern"] ?? inp["pattern"]), 48)
        : ""
    case "read_lints":
    case "ReadLints": {
      const paths = inp["paths"]
      if (Array.isArray(paths) && paths.length > 0) return short(paths.slice(0, 3).join(", "), 52)
      return "workspace"
    }
    case "list_code_definitions":
    case "ListCodeDefinitions":
      return pathStr ? short(pathStr, 56) : ""
    case "batch":
    case "Batch": {
      const reads = (inp["reads"] as unknown[])?.length ?? 0
      const searches = (inp["searches"] as unknown[])?.length ?? 0
      const lists = (inp["lists"] as unknown[])?.length ?? 0
      const replaces = (inp["replaces"] as unknown[])?.length ?? 0
      return [
        reads && `${reads} read(s)`,
        lists && `${lists} list(s)`,
        searches && `${searches} search(es)`,
        replaces && `${replaces} replace(s)`,
      ].filter(Boolean).join(", ") || "batch"
    }
    case "Parallel":
    case "parallel": {
      const uses = getParallelUsesMeta(inp)
      if (uses.length === 0) return "parallel"
      const names = uses
        .map((u) => (typeof u.recipient_name === "string" ? normalizeParallelRecipientNameMeta(u.recipient_name) : ""))
        .filter(Boolean)
      const unique = [...new Set(names)]
      if (unique.length === 1) {
        if (unique[0] === "Read") return `Read ${uses.length} ${uses.length === 1 ? "file" : "files"}`
        if (unique[0] === "List") return `List ${uses.length} ${uses.length === 1 ? "dir" : "dirs"}`
        if (unique[0] === "Grep" || unique[0] === "Glob" || unique[0] === "CodebaseSearch") {
          return `${unique[0]} ${uses.length} ${uses.length === 1 ? "query" : "queries"}`
        }
      }
      return `${uses.length} parallel ${uses.length === 1 ? "tool" : "tools"}`
    }
    case "TaskCreate":
    case "spawn_agents":
    case "SpawnAgent":
    case "SpawnAgents": {
      const desc = inp["description"]
      return desc && typeof desc === "string" ? short(desc.replace(/\s+/g, " "), 48) : "subtask"
    }
    case "TaskCreateBatch":
      return Array.isArray(inp["tasks"]) ? `${(inp["tasks"] as unknown[]).length} tasks` : "task batch"
    case "ask_followup_question":
    case "AskFollowupQuestion": {
      const qs = inp["questions"]
      if (Array.isArray(qs) && qs.length > 0) {
        const first = qs[0] as Record<string, unknown>
        const q = typeof first.question === "string" ? short(first.question.replace(/\s+/g, " "), 36) : ""
        return qs.length > 1 ? `${qs.length} Q · ${q}` : q || "question"
      }
      const q = inp["question"] && typeof inp.question === "string" ? short(String(inp.question).replace(/\s+/g, " "), 44) : ""
      return q || "question"
    }
    default:
      return Object.entries(inp)
        .filter(([k]) => k !== "task_progress")
        .map(([k, v]) => {
          const rendered =
            typeof v === "string"
              ? v
              : Array.isArray(v)
                ? JSON.stringify(v)
                : v != null && typeof v === "object"
                  ? JSON.stringify(v)
                  : String(v)
          return `${k}: ${rendered.slice(0, 40)}`
        })
        .slice(0, 2)
        .join(", ") || ""
  }
}

function SubAgentDisplay({ subagents }: { subagents?: SubAgentState[] }) {
  if (!subagents?.length) return null
  return (
    <div className="mt-1 pl-2 border-l-2 border-[var(--vscode-panel-border)] space-y-0.5">
      {subagents.map((sa) => {
        const isRunning = sa.status === "running"
        const isCompleted = sa.status === "completed"
        const dot = isRunning ? "●" : isCompleted ? "✓" : "✗"
        const dotColor = isRunning ? "text-blue-400" : isCompleted ? "text-green-500" : "text-red-500"
        const taskShort = sa.task.replace(/\s+/g, " ").trim().slice(0, 44) + (sa.task.length > 44 ? "…" : "")
        const toolHistory = sa.toolHistory?.slice(-3) ?? []
        return (
          <div key={sa.id} className="text-[10px]">
            <div className="flex items-center gap-1.5">
              <span className={`flex-shrink-0 ${dotColor}`}>{dot}</span>
              <span className="text-[var(--vscode-foreground)] truncate">{taskShort}</span>
              {isRunning && sa.currentTool && (
                <span className="text-[var(--vscode-descriptionForeground)] truncate flex-shrink-0">→ {sa.currentTool}</span>
              )}
            </div>
            {isRunning && toolHistory.length > 0 && (
              <div className="ml-4 text-[var(--vscode-descriptionForeground)] truncate">
                {toolHistory.join(" → ")}
              </div>
            )}
            {sa.status === "error" && sa.error && (
              <div className="ml-4 text-red-400 truncate">{sa.error.slice(0, 60)}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function ToolCallCard({ part, approval, onLayoutHint }: Props) {
  const [expanded, setExpanded] = useState(false)
  const icon = TOOL_ICONS_META[part.tool] ?? "🔧"
  const toolTitle =
    part.status === "error" && part.timeEnd != null
      ? `Attempt ${toolDisplayNameMeta(part.tool)}`
      : toolDisplayNameMeta(part.tool)
  const isMcp = part.tool.includes("__")
  const isAskFollowup = part.tool === "AskFollowupQuestion" || part.tool === "ask_followup_question"
  const hideGenericQuestionOutput =
    isAskFollowup &&
    typeof part.output === "string" &&
    part.output.includes("User input is required") &&
    part.status === "completed"
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
    <div className={`nexus-tool-call-card my-1 text-xs min-w-0 overflow-x-hidden ${STATUS_STYLES[part.status]}${isAskFollowup ? " nexus-tool-row--askfollowup" : ""}`}>
      <button
        onClick={() => {
          setExpanded(!expanded)
          onLayoutHint?.()
        }}
        className="w-full flex items-center gap-2 px-1 py-0.5 text-left hover:opacity-80 transition-opacity"
      >
        <span className="flex-shrink-0">{icon}</span>
        <span className="font-mono text-[var(--vscode-foreground)] flex-shrink-0">{toolTitle}</span>
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

      {part.subagents && part.subagents.length > 0 && (
        <SubAgentDisplay subagents={part.subagents} />
      )}
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          {isFileEditTool(part) && part.output && (
            <FileEditBlock part={part} />
          )}
          {part.input && Object.keys(part.input).length > 0 && !(isFileEditTool(part) && part.output) && (
            <div>
              <div className="text-[var(--vscode-descriptionForeground)] mb-0.5">Input:</div>
              <pre className="nexus-output-pre bg-[var(--vscode-editor-background)] rounded overflow-x-auto text-[10px] whitespace-pre-wrap max-h-32 overflow-y-auto">
                {JSON.stringify(
                  Object.fromEntries(Object.entries(part.input).filter(([k]) => k !== "task_progress")),
                  null, 2
                )}
              </pre>
            </div>
          )}
          {part.output && !isFileEditTool(part) && !hideGenericQuestionOutput && (
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
      <pre className="nexus-output-pre bg-[var(--vscode-editor-background)] rounded text-[10px] text-[var(--vscode-descriptionForeground)]">
        {output.trim() || "[Old tool result content cleared]"}
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
        <pre className="nexus-output-pre bg-[var(--vscode-editor-background)] rounded overflow-x-auto text-[10px] whitespace-pre-wrap max-h-64 overflow-y-auto font-mono">
          {content.trim()}
        </pre>
      </div>
    )
  }
  const lines = output.split("\n")
  const looksLikeDiff = lines.filter((l) => l.startsWith("+") || l.startsWith("-")).length >= 3
  if (looksLikeDiff) {
    return (
      <pre className="nexus-output-pre bg-[var(--vscode-editor-background)] rounded overflow-x-auto text-[10px] whitespace-pre-wrap max-h-64 overflow-y-auto font-mono diff-output">
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
    <pre className="nexus-output-pre bg-[var(--vscode-editor-background)] rounded overflow-x-auto text-[10px] whitespace-pre-wrap max-h-64 overflow-y-auto">
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
