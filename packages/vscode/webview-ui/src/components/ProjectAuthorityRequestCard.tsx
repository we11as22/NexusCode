import React from "react"

export interface ProjectAuthorityRequestCardProps {
  readonly kind: string
  readonly payload: unknown
  readonly fingerprint: string
  readonly onApprove: (fingerprint: string) => void
}

const MAX_DETAIL_CHARS = 240

/**
 * Human-facing approval content. The fingerprint remains the exact internal
 * approval key but is intentionally not rendered as product UI.
 */
export function ProjectAuthorityRequestCard({
  kind,
  payload,
  fingerprint,
  onApprove,
}: ProjectAuthorityRequestCardProps) {
  const detail = JSON.stringify(payload)
  const visibleDetail =
    detail.length <= MAX_DETAIL_CHARS
      ? detail
      : `${detail.slice(0, MAX_DETAIL_CHARS - 1)}…`

  return (
    <div className="rounded border border-[var(--vscode-panel-border)] p-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">{kind}</div>
          <div
            className="text-[10px] font-mono break-all text-[var(--vscode-descriptionForeground)]"
            title={detail}
          >
            {visibleDetail}
          </div>
        </div>
        <button
          type="button"
          className="nexus-btn nexus-btn-primary text-xs py-1 px-2 flex-shrink-0"
          onClick={() => onApprove(fingerprint)}
        >
          Approve exact request
        </button>
      </div>
    </div>
  )
}
