import React, { useRef, useEffect, useState } from "react"
import { useChatStore } from "../stores/chat.js"

/** Bookmark icon (Cline-style checkpoint indicator) */
function BookmarkIcon({ className }: { className?: string }) {
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
  const [openHash, setOpenHash] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openHash) return
    const close = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpenHash(null)
      }
    }
    document.addEventListener("click", close, true)
    return () => document.removeEventListener("click", close, true)
  }, [openHash])

  if (entries.length === 0) return null

  const label = (entry: CheckpointEntry) =>
    entry.description
      ? (entry.description.length > 28 ? entry.description.slice(0, 28) + "…" : entry.description)
      : entry.hash.slice(0, 7)

  return (
    <div className="nexus-checkpoint-strip">
      <div className="nexus-checkpoint-strip-inner">
        <BookmarkIcon className="nexus-checkpoint-icon" />
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
                  className="nexus-checkpoint-restore-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setOpenHash(openHash === entry.hash ? null : entry.hash)
                  }}
                  aria-expanded={openHash === entry.hash}
                  aria-haspopup="dialog"
                >
                  Restore
                </button>
              </div>
              {openHash === entry.hash && (
                <div
                  ref={popoverRef}
                  className="nexus-checkpoint-popover"
                  role="dialog"
                  aria-label="Restore checkpoint"
                >
                  <p className="nexus-checkpoint-popover-desc">
                    Restore workspace files to this snapshot. Open tabs will reload from disk.
                  </p>
                  <div className="nexus-checkpoint-popover-actions">
                    <button
                      type="button"
                      className="nexus-checkpoint-popover-cancel"
                      onClick={() => setOpenHash(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="nexus-checkpoint-popover-confirm"
                      onClick={() => {
                        store.restoreCheckpoint(entry.hash)
                        setOpenHash(null)
                      }}
                    >
                      Restore
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
