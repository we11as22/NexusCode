import React from "react"
import { useChatStore } from "../stores/chat.js"
import type { UserSelectableMode } from "./user-mode-policy.js"

const MODES: Array<{ id: UserSelectableMode; label: string; icon: string; description: string }> = [
  { id: "agent", label: "Agent", icon: "A", description: "Full execution: files, shell, orchestration" },
  { id: "plan", label: "Plan", icon: "P", description: "Plan files only under .nexus/plans; no shell" },
  { id: "ask", label: "Ask", icon: "Q", description: "Read-only Q&A + safe delegation" },
  { id: "debug", label: "Debug", icon: "D", description: "Like agent; diagnose then fix" },
]

export function ModeSelector() {
  const { mode, isRunning, setMode } = useChatStore()

  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <div className="flex bg-[var(--vscode-editor-background)] rounded-lg border border-[var(--vscode-panel-border)] overflow-hidden">
        {MODES.map(m => (
          <button
            key={m.id}
            onClick={() => {
              if (!isRunning) setMode(m.id)
            }}
            disabled={isRunning}
            title={isRunning ? "Mode can be changed after this turn." : m.description}
            className={`
              flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold transition-colors
              disabled:cursor-not-allowed disabled:opacity-60
              ${mode === m.id
                ? "bg-[var(--nexus-accent)] text-white"
                : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-list-hoverBackground)] hover:text-[var(--vscode-foreground)]"
              }
            `}
          >
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-current/30 text-[10px]">{m.icon}</span>
            <span>{m.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
