import React, { useState } from "react"
import { useChatStore } from "../stores/chat.js"

/** File icon (document) for context panel */
function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  )
}

const CODE_WRITING_MODES = ["agent", "plan", "debug"] as const

/** Floating panel above input: pending approval (1 file) OR "N Files" + Undo / Keep All / Review. */
export function InputContextPanel() {
  const store = useChatStore()
  const { pendingApproval, resolveApproval, mode, sessionUnacceptedEdits, openSessionEditDiff, undoSessionEdits, keepAllSessionEdits, revertSessionEditFile, acceptSessionEditFile } = store
  const [expanded, setExpanded] = useState(true)

  const showSessionEditsPanel =
    CODE_WRITING_MODES.includes(mode as (typeof CODE_WRITING_MODES)[number]) &&
    (sessionUnacceptedEdits?.length ?? 0) > 0 &&
    !pendingApproval

  // Pending approval: single file awaiting Allow/Deny
  if (pendingApproval) {
    const { action } = pendingApproval
    const fileLabel =
      action.type === "write"
        ? (action.description?.split(/[/\\]/).pop() ?? action.description ?? "File")
        : action.description?.slice(0, 40) ?? "Change"
    const diffStats = action.diffStats
    const hasDiff = diffStats != null && (diffStats.added > 0 || diffStats.removed > 0)

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
              <span>1 File</span>
            </button>
            <div className="nexus-input-context-actions">
              <button
                type="button"
                className="nexus-input-context-btn"
                onClick={() => resolveApproval(false)}
              >
                Undo
              </button>
              <button
                type="button"
                className="nexus-input-context-btn"
                onClick={() => resolveApproval(true)}
              >
                Keep
              </button>
              <button
                type="button"
                className="nexus-input-context-btn nexus-input-context-btn-active"
                title="Review the change above"
              >
                Review
              </button>
            </div>
          </div>
          {expanded && (
            <div className="nexus-input-context-file-row">
              <FileIcon className="nexus-input-context-file-icon" />
              <span className="nexus-input-context-file-name" title={action.description}>
                {fileLabel}
                {hasDiff && (
                  <span className="nexus-input-context-file-diff">
                    {diffStats.added > 0 && <span className="text-green-500">+{diffStats.added}</span>}
                    {diffStats.removed > 0 && <span className="text-red-400">-{diffStats.removed}</span>}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="nexus-input-context-file-btn nexus-input-context-file-dismiss"
                onClick={() => resolveApproval(false)}
                title="Deny"
                aria-label="Deny"
              >
                ✕
              </button>
              <button
                type="button"
                className="nexus-input-context-file-btn nexus-input-context-file-allow"
                onClick={() => resolveApproval(true)}
                title="Allow"
                aria-label="Allow"
              >
                ✓
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Session unaccepted edits: N files, Undo All / Keep All / Review
  if (showSessionEditsPanel && sessionUnacceptedEdits && sessionUnacceptedEdits.length > 0) {
    const n = sessionUnacceptedEdits.length
    const fileLabel = n === 1 ? "1 File" : `${n} Files`

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
              <span>{fileLabel}</span>
            </button>
            <div className="nexus-input-context-actions">
              <button
                type="button"
                className="nexus-input-context-btn"
                onClick={() => undoSessionEdits()}
                title="Revert all files to state before edits"
              >
                Undo All
              </button>
              <button
                type="button"
                className="nexus-input-context-btn"
                onClick={() => keepAllSessionEdits()}
                title="Accept all changes in listed files"
              >
                Keep All
              </button>
              <button
                type="button"
                className="nexus-input-context-btn nexus-input-context-btn-active"
                title="Expand to review files; click a file to open full diff in editor"
                onClick={() => setExpanded(true)}
              >
                Review
              </button>
            </div>
          </div>
          {expanded && (
            <div className="nexus-input-context-file-list">
              {sessionUnacceptedEdits.map((edit) => {
                const name = edit.path.split(/[/\\]/).pop() ?? edit.path
                const hasDiff = edit.diffStats.added > 0 || edit.diffStats.removed > 0
                return (
                  <div key={edit.path} className="nexus-input-context-file-row">
                    <button
                      type="button"
                      className="nexus-input-context-file-row-clickable nexus-input-context-file-row-main"
                      onClick={() => openSessionEditDiff(edit.path)}
                      title={`${edit.path} — click to open full diff in editor`}
                    >
                      <FileIcon className="nexus-input-context-file-icon" />
                      <span className="nexus-input-context-file-name">
                        {name}
                        {hasDiff && (
                          <span className="nexus-input-context-file-diff">
                            {edit.diffStats.added > 0 && <span className="text-green-500">+{edit.diffStats.added}</span>}
                            {edit.diffStats.removed > 0 && <span className="text-red-400">-{edit.diffStats.removed}</span>}
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="nexus-input-context-file-btn nexus-input-context-file-dismiss"
                      onClick={(e) => { e.stopPropagation(); revertSessionEditFile(edit.path) }}
                      title="Revert this file"
                      aria-label="Revert file"
                    >
                      ✕
                    </button>
                    <button
                      type="button"
                      className="nexus-input-context-file-btn nexus-input-context-file-allow"
                      onClick={(e) => { e.stopPropagation(); acceptSessionEditFile(edit.path) }}
                      title="Accept (keep changes)"
                      aria-label="Accept file"
                    >
                      ✓
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

  return null
}
