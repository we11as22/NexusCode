import React, { useState } from "react"

export interface TodoItem {
  id: number
  done: boolean
  label: string
  inProgress: boolean
}

export function parseTodo(todo: string): TodoItem[] {
  const lines = todo.split("\n").map((s) => s.trim()).filter(Boolean)
  const items: TodoItem[] = []
  lines.forEach((line, i) => {
    const done = /^-\s*\[x\]/i.test(line) || /^-\s*\[X\]/.test(line)
    const pending = /^-\s*\[\s*\]/.test(line)
    const label = line.replace(/^-\s*\[[xX\s]\]\s*/, "").trim()
    if (pending || done) {
      items.push({ id: i, done, label, inProgress: false })
    } else if (label) {
      items.push({ id: i, done: false, label, inProgress: false })
    }
  })
  return items
}

export function useTodoWithProgress(todo: string, isRunning: boolean): { items: TodoItem[]; currentIndex: number; total: number } {
  const items = React.useMemo(() => parseTodo(todo), [todo])
  const completedCount = items.filter((i) => i.done).length
  const total = items.length
  const firstPendingIndex = items.findIndex((i) => !i.done)
  const inProgressIndex = isRunning && firstPendingIndex >= 0 ? firstPendingIndex : -1
  const withProgress = items.map((item, idx) => ({
    ...item,
    inProgress: idx === inProgressIndex,
  }))
  const currentIndex = inProgressIndex >= 0 ? inProgressIndex + 1 : completedCount
  return { items: withProgress, currentIndex, total }
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

function CircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

function FilledCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="8" />
    </svg>
  )
}

interface Props {
  todo: string
  isRunning: boolean
  /** Optional header (e.g. last user message). Falls back to "Progress". */
  header?: string
}

export function ProgressTodoBlock({ todo, isRunning, header }: Props) {
  const [open, setOpen] = useState(true)
  const { items, currentIndex, total } = useTodoWithProgress(todo, isRunning)
  const headerText = header?.trim() || "Progress"

  if (items.length === 0) return null

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="flex-shrink-0 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]"
    >
      <summary className="list-none cursor-pointer select-none">
        <div className="px-3 py-2 flex items-center justify-between gap-2 text-xs text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]">
          <span className="font-medium truncate flex-1 min-w-0">{headerText}</span>
          <span
            className="flex-shrink-0 text-[var(--vscode-descriptionForeground)] transition-transform"
            style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
          >
            ▼
          </span>
        </div>
      </summary>
      <div className="px-3 pb-3 pt-0 space-y-1.5 border-t border-[var(--vscode-panel-border)]">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 text-xs text-[var(--vscode-foreground)]"
          >
            <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
              {item.done && (
                <span className="text-green-500 flex items-center justify-center">
                  <CheckIcon className="w-3.5 h-3.5" />
                </span>
              )}
              {item.inProgress && (
                <span className="text-[var(--nexus-accent)] flex items-center justify-center">
                  <SpinnerIcon className="w-4 h-4" />
                </span>
              )}
              {!item.done && !item.inProgress && (
                <span className="text-[var(--vscode-descriptionForeground)]">
                  <CircleIcon className="w-4 h-4" />
                </span>
              )}
            </span>
            <span
              className={
                item.done
                  ? "text-[var(--vscode-descriptionForeground)] line-through flex-1 min-w-0 truncate"
                  : item.inProgress
                    ? "font-medium flex-1 min-w-0 truncate"
                    : "flex-1 min-w-0 truncate"
              }
            >
              {item.label}
            </span>
            {item.inProgress && total > 0 && (
              <span className="flex-shrink-0 text-[10px] text-[var(--vscode-descriptionForeground)]">
                {currentIndex}/{total}
              </span>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}
