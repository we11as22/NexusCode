import React, { useState, useRef, useEffect, useMemo, useLayoutEffect } from "react"
import { NEXUS_CHAT_LAYOUT_EVENT } from "../constants/chatLayoutEvent.js"

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect

export interface TodoItem {
  id: number
  done: boolean
  cancelled: boolean
  label: string
  inProgress: boolean
}

export function parseTodo(todo: string): TodoItem[] {
  const raw = todo.trim()
  if (!raw) return []
  // Structured format: JSON array of either legacy { done, text } or TodoWrite { id, content, status }
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw) as Array<{
        done?: boolean
        text?: string
        id?: string | number
        content?: string
        status?: string
      }>
      if (!Array.isArray(arr)) return []
      return arr.map((item, i) => ({
        id: i,
        done:
          typeof item.status === "string"
            ? item.status === "completed"
            : Boolean(item.done),
        cancelled: item.status === "cancelled",
        label:
          typeof item.content === "string"
            ? item.content
            : typeof item.text === "string"
              ? item.text
              : "",
        inProgress: typeof item.status === "string" ? item.status === "in_progress" : false,
      })).filter((item) => item.label.trim().length > 0)
    } catch {
      // fall through to markdown
    }
  }
  // Legacy markdown format
  const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean)
  const items: TodoItem[] = []
  lines.forEach((line, i) => {
    const done = /^-\s*\[x\]/i.test(line) || /^-\s*\[X\]/.test(line)
    const pending = /^-\s*\[\s*\]/.test(line)
    const label = line.replace(/^-\s*\[[xX\s]\]\s*/, "").trim()
    if (pending || done) {
      items.push({ id: i, done, cancelled: false, label, inProgress: false })
    } else if (label) {
      items.push({ id: i, done: false, cancelled: false, label, inProgress: false })
    }
  })
  return items
}

export function useTodoWithProgress(todo: string, isRunning: boolean): { items: TodoItem[]; currentIndex: number; total: number } {
  const items = React.useMemo(() => parseTodo(todo), [todo])
  const completedCount = items.filter((i) => i.done).length
  const total = items.length
  const explicitInProgressIndex = items.findIndex((i) => i.inProgress)
  const firstPendingIndex = items.findIndex((i) => !i.done && !i.cancelled)
  const inProgressIndex =
    explicitInProgressIndex >= 0
      ? explicitInProgressIndex
      : isRunning && firstPendingIndex >= 0
        ? firstPendingIndex
        : -1
  const withProgress = items.map((item, idx) => ({
    ...item,
    inProgress:
      idx === inProgressIndex &&
      !item.done &&
      !item.cancelled,
  }))
  const currentIndex = inProgressIndex >= 0 ? inProgressIndex + 1 : completedCount
  return { items: withProgress, currentIndex, total }
}

/** Current or first pending todo (for collapsed summary, Roo-style). */
function getMostImportantTodo(items: TodoItem[]): TodoItem | null {
  const inProgress = items.find((i) => i.inProgress)
  if (inProgress) return inProgress
  return items.find((i) => !i.done && !i.cancelled) ?? null
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

function ListIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="6" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <line x1="9" y1="6" x2="20" y2="6" />
      <line x1="9" y1="12" x2="20" y2="12" />
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

function CancelledIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 8l8 8M16 8l-8 8" />
    </svg>
  )
}

interface Props {
  todo: string
  isRunning: boolean
  /** Optional header (ignored; title is always "To-dos N"). */
  header?: string
}

export function ProgressTodoBlock({ todo, isRunning, header }: Props) {
  const listRef = useRef<HTMLUListElement>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const { items, currentIndex, total } = useTodoWithProgress(todo, isRunning)
  const completedCount = items.filter((i) => i.done).length
  const allCompleted = total > 0 && completedCount === total
  const [open, setOpen] = useState(() => !allCompleted)
  const previouslyCompleted = useRef(allCompleted)
  const mostImportant = useMemo(() => getMostImportantTodo(items), [items])
  const scrollIndex = items.findIndex((i) => i.inProgress) >= 0 ? items.findIndex((i) => i.inProgress) : items.findIndex((i) => !i.done)

  useEffect(() => {
    if (!open || scrollIndex < 0 || !listRef.current) return
    const el = itemRefs.current[scrollIndex]
    if (el && listRef.current) {
      const list = listRef.current
      const targetTop = el.offsetTop - list.offsetTop
      const targetHeight = el.offsetHeight
      const listHeight = list.clientHeight
      list.scrollTop = Math.max(0, targetTop - (listHeight / 2 - targetHeight / 2))
    }
  }, [open, items, scrollIndex])

  useBrowserLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent(NEXUS_CHAT_LAYOUT_EVENT))
  }, [open, items.length])

  useEffect(() => {
    if (!previouslyCompleted.current && allCompleted && !isRunning) {
      setOpen(false)
    }
    previouslyCompleted.current = allCompleted
  }, [allCompleted, isRunning])

  if (items.length === 0) return null
  // OpenClaude clears the live todo state once every item is complete. Hide
  // legacy/restored snapshots that predate that lifecycle rule as well; the
  // completed TodoWrite event remains available in the transcript.
  if (allCompleted && !isRunning) return null

  return (
    <div
      data-todo-list
      className="flex-shrink-0 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] overflow-hidden"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Enter" && setOpen((o) => !o)}
        className={`flex items-center gap-2 px-4 py-2 cursor-pointer select-none text-xs hover:bg-[var(--vscode-list-hoverBackground)] ${
          mostImportant?.inProgress && !open ? "text-[var(--vscode-charts-yellow)]" : "text-[var(--vscode-foreground)]"
        }`}
      >
        <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-[var(--vscode-descriptionForeground)]">
          <ListIcon className="w-4 h-4" />
        </span>
        <span className="flex-1 min-w-0 truncate">
          {allCompleted
            ? `To-dos ${completedCount}/${total} completed`
            : `To-dos ${total}`}
        </span>
        <span
          className="flex-shrink-0 text-[var(--vscode-descriptionForeground)] transition-transform"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
        >
          ▼
        </span>
      </div>
      {open && (
        <ul ref={listRef} className="list-none max-h-[300px] overflow-y-auto mt-0 py-2 px-4 border-t border-[var(--vscode-panel-border)] space-y-1.5">
          {items.map((item, idx) => (
            <div
              key={item.id}
              ref={(el) => { itemRefs.current[idx] = el }}
              className={`flex items-center gap-2 text-xs min-h-[20px] leading-normal ${
                item.inProgress ? "text-[var(--vscode-charts-yellow)]" : ""
              } ${!item.done && !item.inProgress ? "opacity-70" : ""}`}
            >
              <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                {item.done && (
                  <span className="text-green-500 flex items-center justify-center">
                    <CheckIcon className="w-3.5 h-3.5" />
                  </span>
                )}
                {item.inProgress && (
                  <span className="text-[var(--vscode-charts-yellow)] flex items-center justify-center">
                    <SpinnerIcon className="w-4 h-4" />
                  </span>
                )}
                {item.cancelled && (
                  <span className="text-[var(--vscode-descriptionForeground)] flex items-center justify-center">
                    <CancelledIcon className="w-4 h-4" />
                  </span>
                )}
                {!item.done && !item.cancelled && !item.inProgress && (
                  <span className="text-[var(--vscode-descriptionForeground)]">
                    <CircleIcon className="w-4 h-4" />
                  </span>
                )}
              </span>
              <span
                className={
                  item.done
                    ? "text-[var(--vscode-descriptionForeground)] line-through flex-1 min-w-0 truncate"
                    : item.cancelled
                      ? "text-[var(--vscode-descriptionForeground)] line-through flex-1 min-w-0 truncate"
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
        </ul>
      )}
    </div>
  )
}
