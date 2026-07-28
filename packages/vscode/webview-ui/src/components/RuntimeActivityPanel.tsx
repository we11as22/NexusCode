import React, { useMemo, useState } from "react"

import type { RuntimeTaskActivity } from "../stores/chat.js"

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "killed",
  "cancelled",
  "deleted",
])

export function selectVisibleRuntimeTasks(
  tasks: RuntimeTaskActivity[],
): RuntimeTaskActivity[] {
  return tasks.filter((task) => !TERMINAL_STATUSES.has(task.status))
}

function statusLabel(task: RuntimeTaskActivity): string {
  if (task.currentTool) return task.currentTool
  if (task.exitCode != null) return `exit ${task.exitCode}`
  return task.status.replace("_", " ")
}

export function RuntimeActivityPanel({
  tasks,
}: {
  tasks: RuntimeTaskActivity[]
}) {
  const [expanded, setExpanded] = useState(false)
  const visible = useMemo(() => selectVisibleRuntimeTasks(tasks), [tasks])

  if (visible.length === 0) return null
  const shown = expanded ? visible : visible.slice(0, 3)

  return (
    <section
      className="border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] px-3 py-2"
      aria-label="Agent tasks and background activity"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-[11px] text-[var(--vscode-descriptionForeground)]"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span
          className="codicon codicon-list-tree"
          aria-hidden="true"
        />
        <span className="flex-1">
          Activity · {visible.length} task{visible.length === 1 ? "" : "s"}
        </span>
        <span
          className={`codicon codicon-chevron-${expanded ? "down" : "right"}`}
          aria-hidden="true"
        />
      </button>
      <div className="mt-1.5 flex flex-col gap-1">
        {shown.map((task) => {
          return (
            <div
              key={task.id}
              className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-[var(--vscode-list-hoverBackground)]"
              title={task.description || task.subject}
            >
              <span
                className="codicon codicon-loading codicon-modifier-spin text-[var(--vscode-progressBar-background)]"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-[var(--vscode-foreground)]">
                {task.subject}
              </span>
              <span className="max-w-[40%] truncate text-[var(--vscode-descriptionForeground)]">
                {statusLabel(task)}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
