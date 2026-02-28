import React, { useRef, useEffect, useState } from "react"
import { useChatStore } from "../stores/chat.js"

const AT_MENTION_SUGGESTIONS = [
  { value: "@file:", label: "@file — attach a file" },
  { value: "@folder:", label: "@folder — attach a folder" },
  { value: "@url:", label: "@url — fetch a URL" },
  { value: "@problems", label: "@problems — workspace diagnostics" },
  { value: "@git", label: "@git — git status/diff" },
]

export function InputBar() {
  const { inputValue, isRunning, setInputValue, sendMessage, abort } = useChatStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestions, setSuggestions] = useState(AT_MENTION_SUGGESTIONS)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (!isRunning && inputValue.trim()) {
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

    // Auto-resize
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
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

  return (
    <div className="relative border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-sideBar-background)]">
      {/* @ mention suggestions */}
      {showSuggestions && (
        <div className="absolute bottom-full left-0 right-0 bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] rounded-t-lg overflow-hidden shadow-lg z-10">
          {suggestions.map(s => (
            <button
              key={s.value}
              onClick={() => insertSuggestion(s.value)}
              className="w-full text-left px-3 py-1.5 text-xs text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] transition-colors"
            >
              <span className="font-mono text-[#4ec9b0]">{s.value}</span>
              <span className="ml-2 text-[var(--vscode-descriptionForeground)]">{s.label.split("—")[1]}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-1.5 px-2 py-2">
        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={isRunning ? "Agent is running... (Esc to abort)" : "Message NexusCode... (@ to mention, Enter to send, Shift+Enter for newline)"}
          disabled={false}
          rows={1}
          className={`
            flex-1 resize-none rounded border text-sm
            bg-[var(--vscode-input-background,#3c3c3c)]
            border-[var(--vscode-input-border,transparent)]
            text-[var(--vscode-input-foreground,#cccccc)]
            placeholder:text-[var(--vscode-input-placeholderForeground,#6a6a6a)]
            focus:outline-none focus:border-[var(--vscode-focusBorder,#007acc)]
            px-2.5 py-1.5 min-h-[32px] max-h-[200px]
            transition-colors
            ${isRunning ? "opacity-60" : ""}
          `}
          style={{ height: "32px" }}
        />

        <div className="flex gap-1 flex-shrink-0">
          {isRunning ? (
            <button
              onClick={abort}
              title="Abort (Esc)"
              className="w-7 h-7 flex items-center justify-center rounded bg-red-600 hover:bg-red-500 text-white transition-colors"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              onClick={() => inputValue.trim() && sendMessage(inputValue.trim())}
              disabled={!inputValue.trim()}
              title="Send (Enter)"
              className="w-7 h-7 flex items-center justify-center rounded bg-[var(--vscode-button-background)] hover:bg-[var(--vscode-button-hoverBackground)] text-[var(--vscode-button-foreground)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  )
}
