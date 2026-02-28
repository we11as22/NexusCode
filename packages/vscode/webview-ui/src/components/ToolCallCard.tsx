import React, { useState } from "react"
import type { ToolPart } from "../stores/chat.js"

interface Props {
  part: ToolPart
}

const TOOL_ICONS: Record<string, string> = {
  read_file: "📄",
  write_to_file: "✍️",
  replace_in_file: "✏️",
  apply_patch: "🔧",
  execute_command: "⚙️",
  search_files: "🔍",
  list_files: "📁",
  list_code_definitions: "🏗️",
  codebase_search: "🔎",
  web_fetch: "🌐",
  web_search: "🌍",
  browser_action: "🖥️",
  spawn_agent: "🤖",
  use_skill: "💡",
  attempt_completion: "✅",
  ask_followup_question: "❓",
  update_todo_list: "📝",
  create_rule: "📏",
}

const STATUS_STYLES = {
  pending:   "border-l-2 border-l-yellow-500 bg-yellow-500/5",
  running:   "border-l-2 border-l-blue-400 bg-blue-400/5",
  completed: "border-l-2 border-l-green-500 bg-green-500/5",
  error:     "border-l-2 border-l-red-500 bg-red-500/5",
}

export function ToolCallCard({ part }: Props) {
  const [expanded, setExpanded] = useState(false)
  const icon = TOOL_ICONS[part.tool] ?? "🔧"
  const elapsed = part.timeStart && part.timeEnd
    ? `${((part.timeEnd - part.timeStart) / 1000).toFixed(1)}s`
    : null

  const statusIcon = {
    pending:   <SpinnerIcon />,
    running:   <SpinnerIcon />,
    completed: "✓",
    error:     "✗",
  }[part.status]

  const inputPreview = part.input
    ? Object.entries(part.input)
        .filter(([k]) => k !== "task_progress")
        .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
        .slice(0, 2)
        .join(", ")
    : ""

  return (
    <div className={`my-1 rounded text-xs ${STATUS_STYLES[part.status]}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2 py-1 text-left hover:opacity-80 transition-opacity"
      >
        <span className="flex-shrink-0">{icon}</span>
        <span className="font-mono text-[var(--vscode-foreground)] flex-shrink-0">{part.tool}</span>
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
          {part.input && Object.keys(part.input).length > 0 && (
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
          {part.output && (
            <div>
              <div className="text-[var(--vscode-descriptionForeground)] mb-0.5">Output:</div>
              <pre className="bg-[var(--vscode-editor-background)] rounded p-1.5 overflow-x-auto text-[10px] whitespace-pre-wrap max-h-48 overflow-y-auto">
                {part.compacted ? "[output pruned for context efficiency]" : part.output.slice(0, 2000)}
                {!part.compacted && (part.output.length > 2000) ? "\n... (truncated)" : ""}
              </pre>
            </div>
          )}
          {part.error && (
            <div className="text-red-400 text-[10px] p-1.5 bg-red-500/10 rounded">{part.error}</div>
          )}
        </div>
      )}
    </div>
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
