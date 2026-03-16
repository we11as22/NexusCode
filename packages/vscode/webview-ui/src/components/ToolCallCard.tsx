import React, { useState } from "react"
import { postMessage } from "../vscode.js"
import type { ToolPart, SubAgentState } from "../stores/chat.js"

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
  Read: "📄",
  write_to_file: "✍️",
  Write: "✍️",
  replace_in_file: "✏️",
  Edit: "✏️",
  execute_command: "⌨️",
  Bash: "⌨️",
  search_files: "🔍",
  Grep: "🔍",
  list_dir: "📁",
  List: "📁",
  list_code_definitions: "🏗️",
  ListCodeDefinitions: "🏗️",
  read_lints: "⚠️",
  ReadLints: "⚠️",
  codebase_search: "🔎",
  CodebaseSearch: "🔎",
  web_fetch: "🌐",
  WebFetch: "🌐",
  web_search: "🌍",
  WebSearch: "🌍",
  glob: "📋",
  Glob: "📋",
  browser_action: "🖥️",
  SpawnAgent: "🤖",
  spawn_agents: "🤖",
  SpawnAgents: "🤖",
  SpawnAgentOutput: "🧵",
  SpawnAgentStop: "🛑",
  use_skill: "💡",
  Skill: "💡",
  ask_followup_question: "❓",
  AskFollowupQuestion: "❓",
  update_todo_list: "📝",
  TodoWrite: "📝",
  create_rule: "📏",
  batch: "📦",
  Parallel: "🧩",
  parallel: "🧩",
}

function toolDisplayName(tool: string): string {
  if (tool === "execute_command" || tool === "Bash") return "Bash"
  const labels: Record<string, string> = {
    read_file: "Read", Read: "Read",
    write_to_file: "Write", Write: "Write",
    replace_in_file: "Edit", Edit: "Edit",
    list_dir: "List", List: "List",
    search_files: "Grep", Grep: "Grep",
    codebase_search: "CodebaseSearch", CodebaseSearch: "CodebaseSearch",
    list_code_definitions: "ListCodeDefinitions", ListCodeDefinitions: "ListCodeDefinitions",
    read_lints: "ReadLints", ReadLints: "ReadLints",
    glob: "Glob", Glob: "Glob",
    update_todo_list: "TodoWrite", TodoWrite: "TodoWrite",
    SpawnAgentOutput: "SpawnAgentOutput",
    SpawnAgentStop: "SpawnAgentStop",
    Parallel: "Parallel", parallel: "Parallel",
    batch: "Batch", Batch: "Batch",
  }
  return labels[tool] ?? tool
}

function getParallelUses(input: Record<string, unknown>): Array<{ recipient_name?: unknown; parameters?: unknown }> {
  const uses = input["tool_uses"]
  if (!Array.isArray(uses)) return []
  return uses.filter((item): item is { recipient_name?: unknown; parameters?: unknown } => item != null && typeof item === "object")
}

function normalizeParallelRecipientName(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  const lower = trimmed.toLowerCase()
  const prefixes = ["functions.", "function.", "multi_tool_use.", "tools.", "tool."]
  const prefix = prefixes.find((item) => lower.startsWith(item))
  const normalized = prefix ? trimmed.slice(prefix.length) : trimmed
  const canonical = normalized.toLowerCase().replace(/[^a-z0-9]/g, "")
  switch (canonical) {
    case "read":
    case "readfile":
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
      return "ListCodeDefinitions"
    default:
      return normalized
  }
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
export function InlineFileEditBlock({ part, approval }: { part: ToolPart; approval?: React.ReactNode }) {
  const path = getFileEditPath(part)
  const output = part.output ?? ""
  const [expanded, setExpanded] = useState(true)
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
  const totalHunks = hasDiffHunks ? part.diffHunks!.filter((h) => h.type === "add" || h.type === "remove").length : 0
  const hiddenLinesCount = totalHunks > previewHunks.length ? totalHunks - previewHunks.length : 0

  return (
    <div className="nexus-file-edit-block my-2">
      <div
        className="nexus-file-edit-header flex items-center gap-2"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((prev) => !prev)}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((prev) => !prev)}
      >
        <span className="nexus-file-edit-badge flex-shrink-0">{lang}</span>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <button
            type="button"
            className="nexus-file-edit-path min-w-0 max-w-full text-left truncate font-medium text-[var(--vscode-foreground)] hover:underline"
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
      </div>
      {expanded && (
        <div className="nexus-file-edit-content">
          {showDiffPreview ? (
            <div className="nexus-diff-view rounded overflow-hidden border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
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
                  return null
                })}
              </pre>
              {hiddenLinesCount > 0 && (
                <div className="nexus-diff-hidden-lines flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] text-[var(--vscode-descriptionForeground)] border-t border-[var(--vscode-panel-border)]">
                  <span>{hiddenLinesCount} hidden lines</span>
                  <span className="text-[10px]">▼</span>
                </div>
              )}
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
      : part.tool === "read_file" || part.tool === "Read"
        ? getEditStatLabel(part)
        : ""

  return (
    <div className="nexus-file-edit-block">
      <div className="nexus-file-edit-header flex items-center gap-2">
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
      const uses = getParallelUses(inp)
      if (uses.length === 0) return "parallel"
      const names = uses
        .map((u) => (typeof u.recipient_name === "string" ? normalizeParallelRecipientName(u.recipient_name) : ""))
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
    case "spawn_agents":
    case "SpawnAgent":
    case "SpawnAgents": {
      const desc = inp["description"]
      return desc && typeof desc === "string" ? short(desc.replace(/\s+/g, " "), 48) : "subtask"
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

      {part.subagents && part.subagents.length > 0 && (
        <SubAgentDisplay subagents={part.subagents} />
      )}
      {expanded && (
        <div className="px-2 pb-2 space-y-1">
          {isFileEditTool(part) && part.output && (
            <FileEditBlock part={part} />
          )}
          {part.input && Object.keys(part.input).length > 0 && !(isFileEditTool(part) && part.output) && (
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
