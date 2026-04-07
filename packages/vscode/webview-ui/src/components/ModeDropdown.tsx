import React, { useState, useRef, useEffect } from "react"
import { createPortal } from "react-dom"
import { useChatStore, type Mode } from "../stores/chat.js"

const MODES: Array<{
  id: Mode
  label: string
  icon: React.ReactNode
  description: string
}> = [
  {
    id: "agent",
    label: "Agent",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83M19.07 4.93l-2.83 2.83M7.76 16.24l-2.83 2.83" />
      </svg>
    ),
    description: "Read/write, shell, search, web, MCP, tasks, teams, plugins — full execution",
  },
  {
    id: "plan",
    label: "Plan",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
    ),
    description: "Research + plan files in .nexus/plans only; no shell; PlanExit when ready",
  },
  {
    id: "ask",
    label: "Ask",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    description: "Read/search/MCP + read-only delegation; no files, shell, or memory writes",
  },
  {
    id: "debug",
    label: "Debug",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v4M8 6a4 4 0 108 0M5 10v6a3 3 0 003 3h8a3 3 0 003-3v-6M9 14h6" />
      </svg>
    ),
    description: "Same tools as agent; diagnose first, then minimal fixes",
  },
  {
    id: "review",
    label: "Review",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
      </svg>
    ),
    description: "Audit changes (git + read); no edits or new tasks",
  },
]

export function ModeDropdown() {
  const { mode, isRunning, setMode } = useChatStore()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})

  const current = MODES.find((m) => m.id === mode) ?? MODES[0]

  useEffect(() => {
    if (!open || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    setMenuStyle({
      position: "fixed",
      left: rect.left,
      top: rect.top - 4,
      transform: "translateY(-100%)",
      zIndex: 100000,
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onOutside = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement
        if (!target.closest?.("[data-nexus-mode-menu]")) setOpen(false)
      }
    }
    document.addEventListener("mousedown", onOutside)
    return () => document.removeEventListener("mousedown", onOutside)
  }, [open])

  const menuEl = open ? (
    <div
      data-nexus-mode-menu
      className="rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-xl py-1 min-w-[180px]"
      style={menuStyle}
    >
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => {
            setMode(m.id)
            setOpen(false)
          }}
          title={m.description}
          className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
        >
          <span className="flex items-center justify-center w-5 h-5 text-[var(--vscode-descriptionForeground)] flex-shrink-0">
            {m.icon}
          </span>
          <span className="flex-1">{m.label}</span>
          {mode === m.id && (
            <span className="text-[var(--nexus-accent)] flex-shrink-0" aria-hidden>✓</span>
          )}
        </button>
      ))}
    </div>
  ) : null

  return (
    <div className="flex-shrink-0 relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={current.description}
        className="nexus-mode-pill flex items-center gap-1.5"
      >
        <span className="flex items-center justify-center w-4 h-4 text-[var(--vscode-foreground)]">
          {current.icon}
        </span>
        <span>{current.label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-70 flex-shrink-0">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {typeof document !== "undefined" && menuEl && createPortal(menuEl, document.body)}
    </div>
  )
}
