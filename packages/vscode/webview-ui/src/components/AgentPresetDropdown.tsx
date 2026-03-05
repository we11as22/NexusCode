import React, { useState, useRef, useEffect } from "react"
import { createPortal } from "react-dom"
import { useChatStore } from "../stores/chat.js"
import { postMessage } from "../vscode.js"

export function AgentPresetDropdown() {
  const { agentPresets, requestAgentPresets } = useChatStore()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    if (open) requestAgentPresets()
  }, [open, requestAgentPresets])

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
        if (!target.closest?.("[data-nexus-preset-menu]")) setOpen(false)
      }
    }
    document.addEventListener("mousedown", onOutside)
    return () => document.removeEventListener("mousedown", onOutside)
  }, [open])

  const menuEl = open ? (
    <div
      data-nexus-preset-menu
      className="rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-xl py-1 min-w-[180px] max-h-[240px] overflow-y-auto"
      style={menuStyle}
    >
      <button
        type="button"
        onClick={() => {
          postMessage({ type: "applyAgentPreset", presetName: "Default" })
          setOpen(false)
        }}
        title="Use all skills, MCP servers, and default rules from config"
        className="w-full flex flex-col items-start gap-0.5 px-3 py-2 text-left text-[12px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
      >
        <span className="font-medium truncate w-full">Default</span>
        <span className="text-[10px] text-[var(--vscode-descriptionForeground)]">
          All skills · all MCP · default rules
        </span>
      </button>
      {agentPresets.length === 0 ? (
        <div className="px-3 py-2 text-[11px] text-[var(--vscode-descriptionForeground)]">
          No other presets. Create in Settings → Agent presets.
        </div>
      ) : (
        agentPresets.map((preset) => (
          <button
            key={preset.name}
            type="button"
            onClick={() => {
              postMessage({ type: "applyAgentPreset", presetName: preset.name })
              setOpen(false)
            }}
            title={`${preset.skills.length} skills · ${preset.mcpServers.length} MCP · ${preset.rulesFiles.length} rules`}
            className="w-full flex flex-col items-start gap-0.5 px-3 py-2 text-left text-[12px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
          >
            <span className="font-medium truncate w-full">{preset.name}</span>
            <span className="text-[10px] text-[var(--vscode-descriptionForeground)]">
              skills:{preset.skills.length} · MCP:{preset.mcpServers.length} · rules:{preset.rulesFiles.length}
            </span>
          </button>
        ))
      )}
    </div>
  ) : null

  return (
    <div className="flex-shrink-0 relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Agent preset (skills + MCP + rules)"
        className="nexus-profile-pill flex items-center gap-1.5"
      >
        <span className="truncate max-w-[90px]">Preset</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-70 flex-shrink-0">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {typeof document !== "undefined" && menuEl && createPortal(menuEl, document.body)}
    </div>
  )
}
