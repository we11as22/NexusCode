import React from "react"
import { useChatStore, type Mode } from "../stores/chat.js"

const MODES: Array<{ id: Mode; label: string; icon: string; description: string }> = [
  { id: "agent", label: "Agent", icon: "A", description: "Full autonomous coding agent" },
  { id: "plan",  label: "Plan",  icon: "P", description: "Plan without modifying code" },
  { id: "ask",   label: "Ask",   icon: "Q", description: "Q&A without modifications" },
]

export function ModeSelector() {
  const { mode, isRunning, setMode } = useChatStore()

  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <div className="flex bg-[var(--vscode-editor-background)] rounded-lg border border-[var(--vscode-panel-border)] overflow-hidden">
        {MODES.map(m => (
          <button
            key={m.id}
            onClick={() => !isRunning && setMode(m.id)}
            title={m.description}
            disabled={isRunning}
            className={`
              flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold transition-colors
              ${mode === m.id
                ? "bg-[var(--nexus-accent)] text-white"
                : "text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-list-hoverBackground)] hover:text-[var(--vscode-foreground)]"
              }
              disabled:opacity-50 disabled:cursor-not-allowed
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
