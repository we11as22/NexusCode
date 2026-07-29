import React, { useMemo, useState } from "react"
import { useChatStore } from "../stores/chat.js"
import {
  appliedFileLabel,
  inputContextPanelKind,
  reviewActionForFileCount,
  uniqueEditedFileCount,
} from "./input-context-panel-policy.js"

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

/** Floating panel above input: proposed changes or applied changes awaiting keep/revert. */
export function InputContextPanel() {
  const store = useChatStore()
  const { pendingApproval, mode, sessionUnacceptedEdits, openSessionEditDiff, undoSessionEdits, keepAllSessionEdits, revertSessionEditFile, acceptSessionEditFile } = store
  const [expanded, setExpanded] = useState(false)

  const sessionEditsForPanel = useMemo(
    () =>
      (sessionUnacceptedEdits ?? []).filter(
        (e) => !e.path.replace(/\\/g, "/").includes(".nexus/plans"),
      ),
    [sessionUnacceptedEdits],
  )

  const panelKind = inputContextPanelKind({
    hasPendingApproval: Boolean(pendingApproval),
    mode,
    appliedEditCount: sessionEditsForPanel.length,
  })

  // Applied session edits: compact Cursor-style Undo / Keep / Review strip.
  if (panelKind === "applied-changes") {
    const n = uniqueEditedFileCount(sessionEditsForPanel)
    const fileLabel = appliedFileLabel(sessionEditsForPanel)

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
                Undo
              </button>
              <button
                type="button"
                className="nexus-input-context-btn"
                onClick={() => keepAllSessionEdits()}
                title="Accept all changes in listed files"
              >
                Keep
              </button>
              <button
                type="button"
                className="nexus-input-context-btn nexus-input-context-btn-active"
                title={n === 1 ? "Open the file diff" : "Expand the file list to review diffs"}
                onClick={() => {
                  if (reviewActionForFileCount(n) === "open-single") {
                    openSessionEditDiff(sessionEditsForPanel[0]!.path)
                  } else {
                    setExpanded(true)
                  }
                }}
              >
                Review
              </button>
            </div>
          </div>
          {expanded && (
            <div className="nexus-input-context-file-list">
              {sessionEditsForPanel.map((edit, index) => {
                const name = edit.path.split(/[/\\]/).pop() ?? edit.path
                const hasDiff = edit.diffStats.added > 0 || edit.diffStats.removed > 0
                const groupedChange =
                  typeof edit.changeSetId === "string" &&
                  (edit.changeSetFileCount ?? 1) > 1
                const groupedCount = edit.changeSetFileCount ?? 1
                return (
                  <div
                    key={`${edit.changeSetId ?? "legacy"}:${edit.path}:${index}`}
                    className="nexus-input-context-file-row"
                  >
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
                            {edit.diffStats.added > 0 && <span className="text-[var(--vscode-gitDecoration-addedResourceForeground)]">+{edit.diffStats.added}</span>}
                            {edit.diffStats.removed > 0 && <span className="text-[var(--vscode-gitDecoration-deletedResourceForeground)]">-{edit.diffStats.removed}</span>}
                          </span>
                        )}
                        {groupedChange && (
                          <span
                            className="nexus-input-context-file-diff"
                            title={`This file belongs to one atomic ${groupedCount}-file patch`}
                          >
                            patch&nbsp;{groupedCount}
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="nexus-input-context-file-btn nexus-input-context-file-dismiss"
                      onClick={(e) => { e.stopPropagation(); revertSessionEditFile(edit.path) }}
                      title={groupedChange ? `Revert the entire ${groupedCount}-file patch` : "Revert this file"}
                      aria-label={groupedChange ? "Revert entire patch" : "Revert file"}
                    >
                      ✕
                    </button>
                    <button
                      type="button"
                      className="nexus-input-context-file-btn nexus-input-context-file-allow"
                      onClick={(e) => { e.stopPropagation(); acceptSessionEditFile(edit.path) }}
                      title={groupedChange ? `Accept the entire ${groupedCount}-file patch` : "Accept (keep changes)"}
                      aria-label={groupedChange ? "Accept entire patch" : "Accept file"}
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
