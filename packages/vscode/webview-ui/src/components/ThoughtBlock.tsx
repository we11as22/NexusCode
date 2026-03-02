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

  const preview = reasoningText.length > 400 ? reasoningText.slice(-400) : reasoningText

  return (
    <div className="nexus-thought-block flex-shrink-0 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="px-3 py-2.5 flex items-start gap-2 rounded-lg border border-[var(--vscode-panel-border)] mx-2 my-1.5 bg-[var(--nexus-assistant-bubble)]">
        <span className="text-[10px] font-semibold text-[var(--vscode-descriptionForeground)] flex-shrink-0 uppercase tracking-wide">
          {startTime != null ? `Thought for ${elapsed}s` : "Thinking…"}
        </span>
        <div className="flex-1 min-w-0 text-xs text-[var(--vscode-foreground)] whitespace-pre-wrap break-words line-clamp-3">
          {preview}
        </div>
      </div>
    </div>
  )
}
