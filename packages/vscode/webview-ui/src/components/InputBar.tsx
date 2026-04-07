import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from "react"
import { createPortal } from "react-dom"
import { useChatStore } from "../stores/chat.js"
import { AttachedImagesStripWithPicker } from "./AttachedImagesStrip.js"
import { postMessage } from "../vscode.js"

const AT_MENTION_SUGGESTIONS = [
  { value: "@file:", label: "@file — attach a file" },
  { value: "@folder:", label: "@folder — attach a folder" },
  { value: "@url:", label: "@url — fetch a URL" },
  { value: "@problems", label: "@problems — workspace diagnostics" },
  { value: "@git", label: "@git — git status/diff" },
]

type SlashSection = "SETTINGS" | "SESSION" | "CREATE" | "AGENT"

interface SlashCommandItem {
  name: string
  description: string
  section: SlashSection
  icon: string
  /** When true, post a message to the extension instead of inserting into input */
  isAction?: boolean
}

const SLASH_COMMANDS: SlashCommandItem[] = [
  // SETTINGS section
  { name: "mode",       description: "Switch agent mode (agent / plan / ask / debug / review)",  section: "SETTINGS", icon: "⚙", isAction: true },
  { name: "llm",        description: "LLM model & provider settings",                   section: "SETTINGS", icon: "🤖", isAction: true },
  { name: "embeddings", description: "Embeddings model settings",                       section: "SETTINGS", icon: "🔍", isAction: true },
  { name: "index",      description: "Codebase indexer status and controls",            section: "SETTINGS", icon: "📑", isAction: true },
  { name: "mcp",        description: "Manage MCP servers (project or global)",          section: "SETTINGS", icon: "🔌", isAction: true },
  // SESSION section
  { name: "sessions", description: "Open session manager",                    section: "SESSION", icon: "📂", isAction: true },
  { name: "compact",  description: "Compress conversation context to summary", section: "SESSION", icon: "🗜", isAction: true },
  { name: "diff",     description: "Show session file changes (lines added/removed)", section: "SESSION", icon: "📊", isAction: true },
  { name: "clear",    description: "Clear the current conversation",           section: "SESSION", icon: "🗑", isAction: true },
  // CREATE section
  { name: "create-skill", description: "Create a new skill file",  section: "CREATE", icon: "✨", isAction: true },
  { name: "create-rule",  description: "Create a new rules file",  section: "CREATE", icon: "📋", isAction: true },
  // AGENT section
  { name: "review", description: "Ask agent to review recent code changes", section: "AGENT", icon: "🔎" },
]

export function InputBar({ registerImagePickerTrigger }: { registerImagePickerTrigger?: (trigger: () => void) => void }) {
  const { inputValue, isRunning, awaitingApproval, setInputValue, sendMessage, abort, addAttachedImage, attachedImages } = useChatStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestions, setSuggestions] = useState(AT_MENTION_SUGGESTIONS)
  // Slash command palette state
  const [showSlashPalette, setShowSlashPalette] = useState(false)
  const [slashQuery, setSlashQuery] = useState("")
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const paletteListRef = useRef<HTMLDivElement>(null)
  const selectedItemRef = useRef<HTMLButtonElement>(null)
  const [paletteBounds, setPaletteBounds] = useState<DOMRect | null>(null)
  const [pasteBlocks, setPasteBlocks] = useState<Array<{
    id: string
    token: string
    text: string
    lines: number
    terminal: boolean
  }>>([])

  const getLineCount = (text: string) => text.split(/\r?\n/).length
  const isLargePaste = (text: string) => getLineCount(text) >= 4
  const looksLikeTerminalPaste = (text: string) => {
    const head = text.split(/\r?\n/).slice(0, 6).join("\n")
    return /(^|\n)\s*(\$|>|#|PS\s|C:\\|\/root\/)/.test(head)
  }
  const createPasteToken = (_id: string, lines: number, terminal: boolean) =>
    `[📋 ${terminal ? "bash" : "text"} (1-${lines})]`

  const autosize = () => {
    if (!textareaRef.current || !containerRef.current) return
    const initialHeight = 44
    const areaMax = 280 /* allow multiline to expand */
    textareaRef.current.style.height = "auto"
    const h = Math.min(textareaRef.current.scrollHeight, areaMax)
    textareaRef.current.style.height = `${Math.max(initialHeight, h)}px`
    scrollCaretIntoView()
  }

  const scrollCaretIntoView = () => {
    const ta = textareaRef.current
    if (!ta) return
    requestAnimationFrame(() => {
      const lineHeight = parseInt(getComputedStyle(ta).lineHeight, 10) || 20
      const lines = ta.value.slice(0, ta.selectionStart).split("\n").length
      const scrollTop = Math.max(0, lines * lineHeight - ta.clientHeight + lineHeight)
      ta.scrollTop = Math.min(scrollTop, ta.scrollHeight - ta.clientHeight)
    })
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => autosize())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const getFilteredSlashCommands = useCallback((query: string): SlashCommandItem[] => {
    if (!query) return SLASH_COMMANDS
    const q = query.toLowerCase()
    return SLASH_COMMANDS.filter(
      cmd => cmd.name.toLowerCase().includes(q) || cmd.description.toLowerCase().includes(q)
    )
  }, [])

  // Measure container position for portal overlay
  const updatePaletteBounds = useCallback(() => {
    if (containerRef.current) {
      setPaletteBounds(containerRef.current.getBoundingClientRect())
    }
  }, [])

  const anyOverlayOpen = showSlashPalette || showSuggestions

  useLayoutEffect(() => {
    if (anyOverlayOpen) updatePaletteBounds()
    else setPaletteBounds(null)
  }, [anyOverlayOpen, updatePaletteBounds])

  // Re-measure on resize/scroll while any overlay is open
  useEffect(() => {
    if (!anyOverlayOpen) return
    window.addEventListener("resize", updatePaletteBounds)
    window.addEventListener("scroll", updatePaletteBounds, true)
    return () => {
      window.removeEventListener("resize", updatePaletteBounds)
      window.removeEventListener("scroll", updatePaletteBounds, true)
    }
  }, [anyOverlayOpen, updatePaletteBounds])

  // Keep selected item visible when navigating with arrow keys
  useEffect(() => {
    if (showSlashPalette && selectedItemRef.current) {
      selectedItemRef.current.scrollIntoView({ block: "nearest" })
    }
  }, [showSlashPalette, slashSelectedIndex])

  const selectSlashCommand = useCallback((cmd: SlashCommandItem) => {
    setShowSlashPalette(false)
    setSlashQuery("")
    setSlashSelectedIndex(0)
    if (cmd.isAction) {
      // Post action to extension instead of inserting into input
      postMessage({ type: "slashCommand", command: cmd.name })
      setInputValue("")
    } else {
      const newValue = "/" + cmd.name + " "
      setInputValue(newValue)
      // Focus back and move cursor to end
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus()
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = newValue.length
        }
      })
    }
  }, [setInputValue])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle slash palette navigation
    if (showSlashPalette) {
      const filtered = getFilteredSlashCommands(slashQuery)
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSlashSelectedIndex(prev => (prev + 1) % Math.max(1, filtered.length))
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setSlashSelectedIndex(prev => (prev <= 0 ? Math.max(0, filtered.length - 1) : prev - 1))
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const cmd = filtered[slashSelectedIndex]
        if (cmd) selectSlashCommand(cmd)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setShowSlashPalette(false)
        setSlashQuery("")
        setSlashSelectedIndex(0)
        setInputValue("")
        return
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (!isRunning && !awaitingApproval && (inputValue.trim() || attachedImages.length > 0)) {
        let expanded = inputValue
        for (const block of pasteBlocks) {
          expanded = expanded.split(block.token).join(block.text)
        }
        sendMessage(expanded.trim(), { displayText: expanded.trim() })
        setPasteBlocks([])
      }
      return
    }
    if (e.key === "@") {
      setShowSuggestions(true)
    }
    if (e.key === "Escape") {
      setShowSuggestions(false)
      if (showSlashPalette) {
        setShowSlashPalette(false)
        setSlashQuery("")
        setInputValue("")
      } else if (isRunning) {
        abort()
      }
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInputValue(value)
    setPasteBlocks((prev) => prev.filter((b) => value.includes(b.token)))

    autosize()

    // Slash command palette: open when user types '/' at start of empty input
    if (value === "/") {
      setShowSlashPalette(true)
      setSlashQuery("")
      setSlashSelectedIndex(0)
      setShowSuggestions(false)
      return
    }
    if (showSlashPalette && value.startsWith("/")) {
      const query = value.slice(1)
      setSlashQuery(query)
      setSlashSelectedIndex(0)
      return
    }
    if (showSlashPalette && !value.startsWith("/")) {
      setShowSlashPalette(false)
      setSlashQuery("")
    }

    // Update @ suggestions
    const atIdx = value.lastIndexOf("@")
    if (atIdx > -1 && !value.slice(atIdx).includes(" ")) {
      const search = value.slice(atIdx + 1).toLowerCase()
      const filtered = AT_MENTION_SUGGESTIONS.filter(s =>
        s.label.toLowerCase().includes(search)
      )
      setSuggestions(filtered)
      setShowSuggestions(filtered.length > 0)
    } else {
      setShowSuggestions(false)
    }
  }

  const insertSuggestion = (value: string) => {
    const atIdx = inputValue.lastIndexOf("@")
    const newValue = inputValue.slice(0, atIdx) + value
    setInputValue(newValue)
    setShowSuggestions(false)
    textareaRef.current?.focus()
  }

  useEffect(() => {
    if (!isRunning) {
      textareaRef.current?.focus()
    }
  }, [isRunning])

  useEffect(() => {
    if (!inputValue.trim()) setPasteBlocks([])
  }, [inputValue])

  useLayoutEffect(() => {
    autosize()
  }, [inputValue, attachedImages.length])

  const handlePaste = async (e: React.ClipboardEvent) => {
    const dt = e.clipboardData
    if (!dt) return

    const readFileAsBase64 = (file: File): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          resolve(result.includes(",") ? result.split(",")[1]! : result)
        }
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })

    let added = 0

    // clipboardData.items — скриншоты (Ctrl+V после копирования экрана) часто приходят сюда
    const itemList = dt.items
    if (itemList) {
      for (let i = 0; i < itemList.length; i++) {
        const item = itemList[i]
        if (!item || item.kind !== "file" || !item.type.startsWith("image/")) continue
        const file = item.getAsFile()
        if (!file) continue
        try {
          const data = await readFileAsBase64(file)
          addAttachedImage(data, file.type || "image/png")
          added++
        } catch {
          // ignore
        }
      }
    }

    // clipboardData.files — вставка через «Вставить файл» или перетаскивание
    if (added === 0 && dt.files?.length) {
      for (let i = 0; i < dt.files.length; i++) {
        const file = dt.files[i]!
        if (!file.type.startsWith("image/")) continue
        try {
          const data = await readFileAsBase64(file)
          addAttachedImage(data, file.type || "image/png")
          added++
        } catch {
          // ignore
        }
      }
    }

    if (added > 0) {
      e.preventDefault()
      return
    }

    const text = dt.getData("text/plain")
    if (!text) return

    // Handle text paste ourselves so multiline terminal pastes keep exact formatting.
    e.preventDefault()
    const ta = textareaRef.current
    if (!ta) {
      setInputValue((inputValue ?? "") + text)
      return
    }
    const start = ta.selectionStart ?? inputValue.length
    const end = ta.selectionEnd ?? inputValue.length
    let inserted = text
    if (isLargePaste(text)) {
      const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const lines = getLineCount(text)
      const terminal = looksLikeTerminalPaste(text)
      const token = createPasteToken(id, lines, terminal)
      inserted = ` ${token} `
      setPasteBlocks((prev) => [...prev, { id, token, text, lines, terminal }])
    }
    const next = inputValue.slice(0, start) + inserted + inputValue.slice(end)
    setInputValue(next)
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + inserted.length
      autosize()
    })
  }

  // Portal: slash palette rendered in document.body to escape overflow:hidden parents
  const slashPalettePortal = showSlashPalette && paletteBounds ? createPortal(
    (() => {
      const filtered = getFilteredSlashCommands(slashQuery)
      let lastSection: string | null = null
      const GAP = 6
      const bottomPx = window.innerHeight - paletteBounds.top + GAP
      return (
        <div
          ref={paletteListRef}
          style={{
            position: "fixed",
            bottom: `${bottomPx}px`,
            left: `${paletteBounds.left}px`,
            width: `${paletteBounds.width}px`,
            zIndex: 99999,
          }}
          className="flex flex-col bg-[var(--vscode-editorWidget-background,var(--vscode-editor-background))] border border-[var(--vscode-panel-border)] rounded-xl shadow-2xl overflow-hidden"
        >
          {/* Header row: "/" query display */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background,transparent)]">
            <span className="text-[var(--nexus-accent,var(--vscode-textLink-foreground))] font-mono text-sm font-bold leading-none">/</span>
            <span className="font-mono text-xs text-[var(--vscode-foreground)] min-w-0 flex-1">{slashQuery || <span className="opacity-40">command…</span>}</span>
            <span className="text-[9px] text-[var(--vscode-descriptionForeground)] opacity-50 flex-shrink-0">↑↓ navigate · ↵ select · Esc close</span>
          </div>

          {/* Scrollable list — max ~10 items (~32px each) */}
          <div className="overflow-y-auto" style={{ maxHeight: "320px" }}>
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-xs text-[var(--vscode-descriptionForeground)] text-center opacity-60">No commands found</div>
            ) : (
              filtered.map((cmd, idx) => {
                const showHeader = cmd.section !== lastSection
                lastSection = cmd.section
                const isSelected = idx === slashSelectedIndex
                return (
                  <React.Fragment key={cmd.name}>
                    {showHeader && (
                      <div className="px-3 pt-2 pb-0.5 text-[9px] font-semibold tracking-widest text-[var(--vscode-descriptionForeground)] uppercase opacity-50 select-none">
                        {cmd.section}
                      </div>
                    )}
                    <button
                      ref={isSelected ? selectedItemRef : undefined}
                      onClick={() => selectSlashCommand(cmd)}
                      onMouseEnter={() => setSlashSelectedIndex(idx)}
                      className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2.5 ${
                        isSelected
                          ? "bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]"
                          : "text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                      }`}
                    >
                      <span className="text-sm leading-none flex-shrink-0 w-4 text-center">{cmd.icon}</span>
                      <span className="font-mono font-semibold flex-shrink-0 text-[var(--nexus-accent,var(--vscode-textLink-foreground))]">/{cmd.name}</span>
                      <span className={`text-[10px] truncate min-w-0 ${isSelected ? "opacity-90" : "text-[var(--vscode-descriptionForeground)]"}`}>
                        {cmd.description}
                      </span>
                    </button>
                  </React.Fragment>
                )
              })
            )}
          </div>
        </div>
      )
    })(),
    document.body
  ) : null

  // Portal: @ suggestions rendered in document.body
  const atSuggestionsPortal = showSuggestions && paletteBounds ? createPortal(
    (() => {
      const GAP = 6
      const bottomPx = window.innerHeight - paletteBounds.top + GAP
      return (
        <div
          style={{
            position: "fixed",
            bottom: `${bottomPx}px`,
            left: `${paletteBounds.left}px`,
            width: `${paletteBounds.width}px`,
            zIndex: 99999,
          }}
          className="bg-[var(--vscode-editorWidget-background,var(--vscode-editor-background))] border border-[var(--vscode-panel-border)] rounded-xl overflow-hidden shadow-2xl"
        >
          {suggestions.map(s => (
            <button
              key={s.value}
              onClick={() => insertSuggestion(s.value)}
              className="w-full text-left px-3 py-2 text-xs text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] transition-colors flex items-center gap-2"
            >
              <span className="font-mono font-semibold text-[var(--nexus-accent,var(--vscode-textLink-foreground))]">{s.value}</span>
              <span className="text-[var(--vscode-descriptionForeground)] truncate">{s.label.split("—")[1]?.trim()}</span>
            </button>
          ))}
        </div>
      )
    })(),
    document.body
  ) : null

  return (
    <>
      {slashPalettePortal}
      {atSuggestionsPortal}
      <div ref={containerRef} className="relative min-w-0 flex flex-col">
        <AttachedImagesStripWithPicker registerImagePickerTrigger={registerImagePickerTrigger} />
        <div className="prompt-input-container min-h-0 min-w-0 flex flex-col">
          <div className="prompt-input-wrapper">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                awaitingApproval
                  ? "Awaiting your approval (check VS Code notification)…"
                  : isRunning
                    ? "Running… (Esc to abort)"
                    : "Add a follow-up"
              }
              disabled={false}
              rows={1}
              className={`prompt-input min-w-0 w-full ${isRunning || awaitingApproval ? "opacity-70" : ""}`}
              style={{ minHeight: "44px" }}
              onSelect={scrollCaretIntoView}
              onKeyUp={scrollCaretIntoView}
            />
          </div>
        </div>
      </div>
    </>
  )
}
