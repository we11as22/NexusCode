import React, { useRef, useEffect, useLayoutEffect, useState } from "react"
import { useChatStore } from "../stores/chat.js"

const AT_MENTION_SUGGESTIONS = [
  { value: "@file:", label: "@file — attach a file" },
  { value: "@folder:", label: "@folder — attach a folder" },
  { value: "@url:", label: "@url — fetch a URL" },
  { value: "@problems", label: "@problems — workspace diagnostics" },
  { value: "@git", label: "@git — git status/diff" },
]

export function InputBar() {
  const { inputValue, isRunning, awaitingApproval, setInputValue, sendMessage, abort } = useChatStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestions, setSuggestions] = useState(AT_MENTION_SUGGESTIONS)

  const autosize = () => {
    if (!textareaRef.current) return
    const base = 54
    const max = 240
    textareaRef.current.style.height = "auto"
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, max)}px`
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (!isRunning && !awaitingApproval && inputValue.trim()) {
        sendMessage(inputValue.trim())
      }
      return
    }
    if (e.key === "@") {
      setShowSuggestions(true)
    }
    if (e.key === "Escape") {
      setShowSuggestions(false)
      if (isRunning) abort()
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInputValue(value)

    autosize()

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

  useLayoutEffect(() => {
    autosize()
  }, [inputValue])

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0 flex flex-col overflow-hidden">
      {showSuggestions && (
        <div className="absolute bottom-full left-0 right-0 bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] rounded-t-xl overflow-hidden shadow-lg z-10">
          {suggestions.map(s => (
            <button
              key={s.value}
              onClick={() => insertSuggestion(s.value)}
              className="w-full text-left px-3 py-2 text-xs text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
            >
              <span className="font-mono text-[var(--nexus-accent)]">{s.value}</span>
              <span className="ml-2 text-[var(--vscode-descriptionForeground)]">{s.label.split("—")[1]}</span>
            </button>
          ))}
        </div>
      )}

      <div className="prompt-input-container flex-1 min-h-0 min-w-0 flex flex-col">
        <div className="prompt-input-wrapper">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
          placeholder={
            awaitingApproval
              ? "Awaiting your approval (check VS Code notification)…"
              : isRunning
                ? "Running… (Esc to abort)"
                : ""
          }
          disabled={false}
          rows={1}
          className={`prompt-input flex-1 min-w-0 w-full ${isRunning || awaitingApproval ? "opacity-70" : ""}`}
          style={{ minHeight: "44px" }}
          onSelect={scrollCaretIntoView}
          onKeyUp={scrollCaretIntoView}
          />
        </div>
      </div>
    </div>
  )
}
