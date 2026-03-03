import React from "react"
import { useChatStore } from "../stores/chat.js"

const LABELS: Record<string, string> = {
  autoApproveRead: "Read",
  autoApproveWrite: "Write",
  autoApproveCommand: "Execute",
}

export function AutoApproveDropdown() {
  const { config, saveConfig } = useChatStore()

  const perms = config?.permissions ?? {
    autoApproveRead: true,
    autoApproveWrite: false,
    autoApproveCommand: false,
  }

  const count = [perms.autoApproveRead, perms.autoApproveWrite, perms.autoApproveCommand].filter(Boolean).length
  const label = count === 0 ? "Off" : count === 3 ? "All" : `${count} on`

  const handleToggle = (key: "autoApproveRead" | "autoApproveWrite" | "autoApproveCommand") => {
    const next = { ...perms, [key]: !perms[key] }
    saveConfig({ permissions: next })
  }

  return (
    <details className="flex-shrink-0 relative">
      <summary className="list-none cursor-pointer text-[10px] text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] py-1 px-1.5 rounded hover:bg-[var(--vscode-list-hoverBackground)]">
        Auto-approve: {label}
      </summary>
      <div className="absolute bottom-full left-0 mb-1 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-lg py-1.5 px-2 min-w-[160px] z-10">
        <div className="text-[10px] font-medium text-[var(--vscode-foreground)] mb-1.5 px-1">Auto-approve</div>
        {(["autoApproveRead", "autoApproveWrite", "autoApproveCommand"] as const).map((key) => (
          <label
            key={key}
            className="flex items-center gap-2 py-1 px-1 rounded hover:bg-[var(--vscode-list-hoverBackground)] cursor-pointer text-[11px] text-[var(--vscode-foreground)]"
          >
            <input
              type="checkbox"
              checked={!!perms[key]}
              onChange={() => handleToggle(key)}
              className="rounded border-[var(--vscode-checkbox-border)]"
            />
            {LABELS[key]}
          </label>
        ))}
      </div>
    </details>
  )
}
