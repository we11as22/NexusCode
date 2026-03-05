import React, { useEffect, useState } from "react"

interface Props {
  reasoningText: string
  startTime: number | null
  isRunning: boolean
}

/** Live thinking_diff: expandable on click, scrollable, same height as expanded tool block (e.g. file edit). No border. */
export function ThoughtBlock({ reasoningText, startTime, isRunning }: Props) {
  const [elapsed, setElapsed] = useState(0)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!isRunning || !startTime || !reasoningText.trim()) return
    const tick = () => setElapsed(Math.floor((Date.now() - startTime) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [isRunning, startTime, reasoningText])

  if (!reasoningText.trim() || !isRunning) return null

  const preview = reasoningText.length > 800 ? reasoningText.slice(-800) : reasoningText

  return (
    <div className="nexus-thought-block flex-shrink-0 my-1.5 bg-transparent">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-list-hoverBackground)] rounded"
      >
        <span className="flex-shrink-0 transition-transform" style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}>▼</span>
        <span>Thought{startTime != null ? ` (${elapsed}s)` : "…"}</span>
        <span className="text-[9px] bg-[var(--vscode-badge-background)] px-1.5 py-0.5 rounded">Live</span>
      </button>
      {expanded && (
        <div className="px-2 py-1.5 max-h-64 overflow-y-auto text-xs text-[var(--vscode-foreground)] whitespace-pre-wrap break-words leading-relaxed font-sans bg-[var(--vscode-editor-background)] rounded">
          {preview}
        </div>
      )}
    </div>
  )
}
