import React, { useRef, useEffect, useState } from "react"
import { useChatStore } from "../stores/chat.js"

/** Bookmark icon (Cline-style checkpoint indicator) */
function BookmarkIcon({ className, checkedOut }: { className?: string; checkedOut?: boolean }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

export interface CheckpointEntry {
  hash: string
  ts: number
  description?: string
  messageId?: string
}

export function CheckpointStrip() {
  const store = useChatStore()
  const entries = store.checkpointEntries
  const checkpointEnabled = store.checkpointEnabled
  const [openHash, setOpenHash] = useState<string | null>(null)
  const [showMoreOptions, setShowMoreOptions] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openHash) {
      setShowMoreOptions(false)
      return
    }
    const close = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpenHash(null)
      }
    }
    document.addEventListener("click", close, true)
    return () => document.removeEventListener("click", close, true)
  }, [openHash])

  if (!checkpointEnabled) return null

  if (entries.length === 0) {
    return (
      <div className="nexus-checkpoint-strip nexus-checkpoint-strip-cline">
        <div className="nexus-checkpoint-strip-inner">
          <BookmarkIcon className="nexus-checkpoint-icon" checkedOut={false} />
          <div className="nexus-checkpoint-dotted" aria-hidden />
          <span className="nexus-checkpoint-label">Checkpoints</span>
          <div className="nexus-checkpoint-dotted" aria-hidden />
          <span className="nexus-checkpoint-empty-hint">No checkpoints yet (saved when a task completes)</span>
        </div>
      </div>
    )
  }

  const label = (entry: CheckpointEntry) =>
    entry.description
      ? (entry.description.length > 20 ? entry.description.slice(0, 20) + "…" : entry.description)
      : entry.hash.slice(0, 7)

  return (
    <div className="nexus-checkpoint-strip nexus-checkpoint-strip-cline">
      <div className="nexus-checkpoint-strip-inner">
        <BookmarkIcon className="nexus-checkpoint-icon" checkedOut={false} />
        <div className="nexus-checkpoint-dotted" aria-hidden />
        <span className="nexus-checkpoint-label">Checkpoints</span>
        <div className="nexus-checkpoint-dotted" aria-hidden />
        <div className="nexus-checkpoint-entries">
          {entries.map((entry) => (
            <div key={entry.hash} className="nexus-checkpoint-entry-wrap">
              <div className="nexus-checkpoint-entry">
                <span className="nexus-checkpoint-entry-label" title={entry.description ?? entry.hash}>
                  {label(entry)}
                </span>
                <button
                  type="button"
                  className="nexus-checkpoint-btn nexus-checkpoint-compare"
                  onClick={(e) => {
                    e.stopPropagation()
                    store.showCheckpointDiff(entry.hash)
                  }}
                  title="Compare with current state"
                >
                  Compare
                </button>
                <div className="nexus-checkpoint-restore-wrap" ref={openHash === entry.hash ? popoverRef : undefined}>
                  <button
                    type="button"
                    className={`nexus-checkpoint-btn nexus-checkpoint-restore ${openHash === entry.hash ? "is-active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenHash(openHash === entry.hash ? null : entry.hash)
                    }}
                    aria-expanded={openHash === entry.hash}
                    aria-haspopup="dialog"
                    title="Restore"
                  >
                    Restore
                  </button>
                  {openHash === entry.hash && (
                    <div
                      className="nexus-checkpoint-tooltip"
                      role="dialog"
                      aria-label="Restore options"
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <div className="nexus-checkpoint-tooltip-primary">
                        <button
                          type="button"
                          className="nexus-checkpoint-tooltip-btn primary"
                          onClick={() => {
                            store.restoreCheckpoint(entry.hash, "taskAndWorkspace")
                            setOpenHash(null)
                          }}
                        >
                          <span className="codicon codicon-debug-restart" aria-hidden />
                          Restore Files & Task
                        </button>
                        <p>Revert files and clear messages after this point</p>
                      </div>
                      <button
                        type="button"
                        className="nexus-checkpoint-more-toggle"
                        onClick={() => setShowMoreOptions(!showMoreOptions)}
                      >
                        More options
                        <span className={`codicon codicon-chevron-${showMoreOptions ? "up" : "down"}`} aria-hidden />
                      </button>
                      {showMoreOptions && (
                        <div className="nexus-checkpoint-tooltip-more">
                          <div className="nexus-checkpoint-tooltip-option">
                            <button
                              type="button"
                              className="nexus-checkpoint-tooltip-btn secondary"
                              onClick={() => {
                                store.restoreCheckpoint(entry.hash, "workspace")
                                setOpenHash(null)
                              }}
                            >
                              <span className="codicon codicon-file-symlink-directory" aria-hidden />
                              Restore Files Only
                            </button>
                            <p>Revert files to this checkpoint</p>
                          </div>
                          <div className="nexus-checkpoint-tooltip-option">
                            <button
                              type="button"
                              className="nexus-checkpoint-tooltip-btn secondary"
                              onClick={() => {
                                store.restoreCheckpoint(entry.hash, "task")
                                setOpenHash(null)
                              }}
                            >
                              <span className="codicon codicon-comment-discussion" aria-hidden />
                              Restore Task Only
                            </button>
                            <p>Clear messages after this point</p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
