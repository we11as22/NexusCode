import React, { useState } from "react"

export function formatWorkedDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
}

export function CompletedWorkBlock({
  durationMs,
  children,
  onLayoutHint,
}: {
  durationMs: number
  children?: React.ReactNode
  onLayoutHint?: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="nexus-worked-block">
      <button
        type="button"
        className="nexus-worked-toggle"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((current) => !current)
          requestAnimationFrame(() => onLayoutHint?.())
        }}
      >
        <span>Worked for {formatWorkedDuration(durationMs)}</span>
        <span
          aria-hidden="true"
          className={`nexus-worked-chevron${expanded ? " nexus-worked-chevron--open" : ""}`}
        >
          ›
        </span>
      </button>
      {expanded ? (
        <div className="nexus-worked-details">{children}</div>
      ) : null}
    </div>
  )
}
