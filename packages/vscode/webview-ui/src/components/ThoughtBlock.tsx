import React, { useEffect, useState } from "react"

interface Props {
  reasoningText: string
  startTime: number | null
  isRunning: boolean
}

/** Live thinking block: shows "Thinking…" with shimmer wave while model is reasoning. Expandable on click. */
export function ThoughtBlock({ reasoningText, isRunning }: Props) {
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"))
    })
    return () => window.cancelAnimationFrame(raf)
  }, [expanded])

  if (!isRunning) return null

  return (
    <div className="nexus-thought-block flex-shrink-0">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-1.5 px-0 py-1 text-left text-xs hover:text-[var(--vscode-foreground)]"
      >
        <span className="flex-shrink-0 transition-transform text-[10px] text-[var(--vscode-descriptionForeground)]" style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}>▼</span>
        <span className="nexus-thinking-wave-text">Thinking…</span>
      </button>
      {expanded && (
        <div className="px-2 pb-1">
          <div className="px-2 py-2 max-h-64 overflow-y-auto text-xs text-[var(--vscode-foreground)] whitespace-pre-wrap break-words leading-relaxed font-sans border border-[var(--vscode-panel-border)] rounded bg-[var(--vscode-editor-background)]">
          {reasoningText.trim() || "Thinking…"}
          </div>
        </div>
      )}
    </div>
  )
}
