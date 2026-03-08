import React, { useState } from "react"
import { useChatStore } from "../stores/chat.js"

const MAX_PREVIEW_LEN = 80

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  )
}

function ArrowUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </svg>
  )
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  )
}

/** Panel above input: "N Queued" with list of planned messages and Edit / Send now / Delete. */
export function QueuedMessagesPanel() {
  const store = useChatStore()
  const { queuedMessages, removeFromQueue, editQueuedToInput, sendQueuedImmediately } = store
  const [expanded, setExpanded] = useState(true)

  if (queuedMessages.length === 0) return null

  return (
    <div className={`nexus-input-context-panel ${!expanded ? "nexus-input-context-panel-collapsed" : ""}`}>
      <div className="nexus-input-context-panel-inner">
        <div className="nexus-input-context-top-row">
          <button
            type="button"
            className="nexus-input-context-files-toggle"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
          >
            <span className="nexus-input-context-chevron">{expanded ? "▼" : "▶"}</span>
            <span>{queuedMessages.length} Queued</span>
          </button>
        </div>
        {expanded && (
          <div className="flex flex-col gap-1 mt-1">
            {queuedMessages.map((item) => {
              const preview =
                item.text.length <= MAX_PREVIEW_LEN
                  ? item.text
                  : item.text.slice(0, MAX_PREVIEW_LEN) + "…"
              return (
                <div
                  key={item.id}
                  className="nexus-input-context-file-row"
                  title={item.text}
                >
                  <span className="nexus-queued-circle w-3 h-3 rounded-full border border-[var(--vscode-foreground)] opacity-60 flex-shrink-0" aria-hidden />
                  <span className="nexus-input-context-file-name truncate flex-1 min-w-0">
                    {preview}
                  </span>
                  <button
                    type="button"
                    className="nexus-input-context-file-btn p-1 rounded"
                    onClick={() => editQueuedToInput(item.id)}
                    title="Edit (move to input)"
                    aria-label="Edit"
                  >
                    <PencilIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="nexus-input-context-file-btn p-1 rounded"
                    onClick={() => sendQueuedImmediately(item.id)}
                    title="Send now"
                    aria-label="Send now"
                  >
                    <ArrowUpIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    className="nexus-input-context-file-btn nexus-input-context-file-dismiss p-1 rounded"
                    onClick={() => removeFromQueue(item.id)}
                    title="Delete"
                    aria-label="Delete"
                  >
                    <TrashIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
