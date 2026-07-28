import React, { useMemo, useState } from "react"
import { useChatStore } from "../stores/chat.js"
import { postMessage } from "../vscode.js"

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

/** Floating panel above input: proposed changes or applied changes awaiting keep/revert. */
export function InputContextPanel() {
  const store = useChatStore()
  const { pendingApproval, resolveApproval, mode, sessionUnacceptedEdits, openSessionEditDiff, undoSessionEdits, keepAllSessionEdits, revertSessionEditFile, acceptSessionEditFile } = store
  const [expanded, setExpanded] = useState(true)

  const sessionEditsForPanel = useMemo(
    () =>
      (sessionUnacceptedEdits ?? []).filter(
        (e) => !e.path.replace(/\\/g, "/").includes(".nexus/plans"),
      ),
    [sessionUnacceptedEdits],
  )

  const showSessionEditsPanel =
    CODE_WRITING_MODES.includes(mode as (typeof CODE_WRITING_MODES)[number]) &&
    sessionEditsForPanel.length > 0 &&
    !pendingApproval

  // Pending approval
  if (pendingApproval) {
    const { action } = pendingApproval

    if (action.type !== "write") {
      const approvalLabel =
        action.type === "execute"
          ? "Command approval"
          : action.type === "browser"
            ? "Network approval"
            : action.type === "mcp"
              ? "MCP tool approval"
              : action.type === "plugin"
                ? "Plugin approval"
                : action.type === "doom_loop"
                  ? "Loop safety check"
                  : `${action.tool} approval`
      const detail = action.shortDescription?.trim() || action.description

      return (
        <div className={`nexus-input-context-panel ${!expanded ? "nexus-input-context-panel-collapsed" : ""}`}>
          <div className="nexus-input-context-panel-inner">
            <div className="nexus-input-context-top-row">
              <button
                type="button"
                className="nexus-input-context-files-toggle"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
              >
                <span className="nexus-input-context-chevron">{expanded ? "▼" : "▶"}</span>
                <span>{approvalLabel}</span>
              </button>
              <div className="nexus-input-context-actions">
                <button
                  type="button"
                  className="nexus-input-context-btn"
                  onClick={() => resolveApproval(false)}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="nexus-input-context-btn nexus-input-context-btn-active"
                  onClick={() => resolveApproval(true)}
                >
                  Allow
                </button>
              </div>
            </div>
            {expanded && (
              <div className="px-3 pb-2 text-xs text-[var(--vscode-descriptionForeground)]">
                <div className="break-words text-[var(--vscode-foreground)]" title={action.description}>
                  {detail}
                </div>
                {action.content && action.content !== detail && (
                  <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--vscode-textCodeBlock-background)] px-2 py-1 font-mono text-[11px]">
                    {action.content}
                  </pre>
                )}
                {action.warning && (
                  <div className="mt-1 text-[var(--vscode-editorWarning-foreground)]">
                    {action.warning}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )
    }

    // Pending file approval
    const pendingPath = extractPathFromApprovalDescription(action.description)
    const fileLabel =
      action.description?.split(/[/\\]/).pop() ?? action.description ?? "File"
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
                Reject
              </button>
              <button
                type="button"
                className="nexus-input-context-btn"
                onClick={() => resolveApproval(true)}
              >
                Apply
              </button>
              <button
                type="button"
                className="nexus-input-context-btn nexus-input-context-btn-active"
                title="Review the proposed diff"
                onClick={() => {
                  if (pendingPath) postMessage({ type: "showDiff", path: pendingPath })
                }}
                disabled={!pendingPath}
              >
                Review Diff
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
                    {diffStats.added > 0 && <span className="text-[var(--vscode-gitDecoration-addedResourceForeground)]">+{diffStats.added}</span>}
                    {diffStats.removed > 0 && <span className="text-[var(--vscode-gitDecoration-deletedResourceForeground)]">-{diffStats.removed}</span>}
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

  // Applied session edits: N files, Revert All / Keep All / Review Diff
  if (showSessionEditsPanel && sessionEditsForPanel.length > 0) {
    const n = sessionEditsForPanel.length
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
                Revert All
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
                Review Diffs
              </button>
            </div>
          </div>
          {expanded && (
            <div className="nexus-input-context-file-list">
              {sessionEditsForPanel.map((edit) => {
                const name = edit.path.split(/[/\\]/).pop() ?? edit.path
                const hasDiff = edit.diffStats.added > 0 || edit.diffStats.removed > 0
                const groupedChange =
                  typeof edit.changeSetId === "string" &&
                  (edit.changeSetFileCount ?? 1) > 1
                const groupedCount = edit.changeSetFileCount ?? 1
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

function extractPathFromApprovalDescription(description: string | undefined): string | null {
  if (!description) return null
  const trimmed = description.trim()
  if (!trimmed) return null
  const prefixed = trimmed.match(/^(?:Write to|Edit|Edit file:|Write file:)\s+(.+)$/i)
  if (prefixed?.[1]) return prefixed[1].trim()
  // Fallback: description can include path at the end.
  const pathLike = trimmed.match(/((?:\.{0,2}\/)?[A-Za-z0-9_.\-\/\\]+\.[A-Za-z0-9]+)$/)
  if (pathLike?.[1]) return pathLike[1].trim()
  return null
}
