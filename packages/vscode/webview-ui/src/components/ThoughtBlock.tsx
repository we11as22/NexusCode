import React, { useEffect, useState } from "react"

interface Props {
  reasoningText: string
  startTime: number | null
  isRunning: boolean
}

export function ThoughtBlock({ reasoningText, startTime, isRunning }: Props) {
  const [elapsed, setElapsed] = useState(0)

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
    <div className="nexus-thought-block flex-shrink-0 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="nexus-reasoning-block rounded-lg border border-[var(--vscode-panel-border)] mx-2 my-1.5 bg-[var(--vscode-editor-background)] overflow-hidden">
        <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--vscode-panel-border)] bg-[var(--nexus-assistant-bubble)]">
          <span className="text-[10px] font-semibold text-[var(--vscode-descriptionForeground)] uppercase tracking-wide">
            {startTime != null ? `Thought for ${elapsed}s` : "Thinking…"}
          </span>
          <span className="text-[9px] text-[var(--vscode-descriptionForeground)] bg-[var(--vscode-badge-background)] px-1.5 py-0.5 rounded">
            Live
          </span>
        </div>
        <div className="px-2.5 py-2 max-h-40 overflow-y-auto text-xs text-[var(--vscode-foreground)] whitespace-pre-wrap break-words leading-relaxed">
          {preview}
        </div>
      </div>
    </div>
  )
}
