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
    if (!isRunning || !startTime) return
    const tick = () => setElapsed(Math.floor((Date.now() - startTime) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [isRunning, startTime])

  if (!isRunning) return null

  const label = startTime != null ? `Thought for ${Math.max(elapsed, 1)}s` : "Thought"

  return (
    <div className="nexus-thought-block flex-shrink-0 my-1">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-1.5 px-0 py-0.5 text-left text-xs text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]"
      >
        <span className="flex-shrink-0 transition-transform text-[10px]" style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}>▼</span>
        <span>{label}</span>
      </button>
      {expanded && (
        <div className="mt-1 px-2 py-2 max-h-64 overflow-y-auto text-xs text-[var(--vscode-foreground)] whitespace-pre-wrap break-words leading-relaxed font-sans border border-[var(--vscode-panel-border)] rounded bg-[var(--vscode-editor-background)]">
          {reasoningText.trim() || "Thinking…"}
        </div>
      )}
    </div>
  )
}
