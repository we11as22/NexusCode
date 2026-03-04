import React, { useState, useRef, useEffect } from "react"
import { createPortal } from "react-dom"
import { useChatStore } from "../stores/chat.js"

export function ProfileDropdown() {
  const { config, selectedProfile, setProfile } = useChatStore()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})

  const profileNames = Object.keys(config?.profiles ?? {})

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
        if (!target.closest?.("[data-nexus-profile-menu]")) setOpen(false)
      }
    }
    document.addEventListener("mousedown", onOutside)
    return () => document.removeEventListener("mousedown", onOutside)
  }, [open])

  const label = selectedProfile || "Default"

  const menuEl = open ? (
    <div
      data-nexus-profile-menu
      className="rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-xl py-1 min-w-[160px]"
      style={menuStyle}
    >
      <button
        type="button"
        onClick={() => {
          setProfile("")
          setOpen(false)
        }}
        title="Use default model from config"
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
      >
        <span className="flex-1">Default</span>
        {!selectedProfile && (
          <span className="text-[var(--nexus-accent)] flex-shrink-0" aria-hidden>✓</span>
        )}
      </button>
      {profileNames.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => {
            setProfile(name)
            setOpen(false)
          }}
          className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
        >
          <span className="flex-1">{name}</span>
          {selectedProfile === name && (
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
        title="Configuration profile"
        className="nexus-profile-pill flex items-center gap-1.5"
      >
        <span className="truncate max-w-[100px]">{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-70 flex-shrink-0">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {typeof document !== "undefined" && menuEl && createPortal(menuEl, document.body)}
    </div>
  )
}
