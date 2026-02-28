import React, { useEffect } from "react"
import { useChatStore } from "./stores/chat.js"
import { MessageList } from "./components/MessageList.js"
import { InputBar } from "./components/InputBar.js"
import { ModeSelector } from "./components/ModeSelector.js"
import { postMessage } from "./vscode.js"
import type { ExtensionMessage } from "../../src/provider.js"

export function App() {
  const store = useChatStore()

  // Listen for messages from the extension
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionMessage
      if (!msg?.type) return

      switch (msg.type) {
        case "stateUpdate":
          store.handleStateUpdate(msg.state)
          break
        case "agentEvent":
          store.handleAgentEvent(msg.event as any)
          break
        case "indexStatus":
          store.handleIndexStatus(msg.status as any)
          break
        case "sessionList":
          // TODO: expose session list in UI
          break
        case "configLoaded":
          // Config loaded — could expose settings UI
          break
      }
    }

    window.addEventListener("message", handler)
    postMessage({ type: "getState" })

    return () => window.removeEventListener("message", handler)
  }, [])

  const indexStatus = store.indexStatus

  return (
    <div className="flex flex-col h-screen bg-[var(--vscode-sideBar-background)] overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--vscode-panel-border)] flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-bold text-[var(--vscode-foreground)]">⚡ NexusCode</span>
          <IndexBadge status={indexStatus} />
        </div>

        <div className="flex items-center gap-1">
          {/* Compact button */}
          <button
            onClick={store.compact}
            title="Compact conversation history (Ctrl+S in CLI)"
            disabled={store.isRunning || store.messages.length === 0}
            className="text-[9px] px-1.5 py-0.5 rounded text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] disabled:opacity-30 transition-colors"
          >
            ⚡ Compact
          </button>

          {/* Re-index button */}
          <button
            onClick={store.reindex}
            title="Re-index codebase"
            disabled={indexStatus.state === "indexing"}
            className="text-[9px] px-1.5 py-0.5 rounded text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] disabled:opacity-30 transition-colors"
          >
            ↺
          </button>

          {/* Clear index button */}
          <button
            onClick={() => {
              if (window.confirm("Clear the entire codebase index and rebuild from scratch?")) {
                store.clearIndex()
              }
            }}
            title="Clear index and rebuild"
            disabled={indexStatus.state === "indexing"}
            className="text-[9px] px-1.5 py-0.5 rounded text-[var(--vscode-descriptionForeground)] hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30 transition-colors"
          >
            ✕
          </button>

          {/* Clear chat button */}
          <button
            onClick={store.clearChat}
            title="Clear chat"
            disabled={store.isRunning}
            className="text-[9px] px-1.5 py-0.5 rounded text-[var(--vscode-descriptionForeground)] hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* ── Mode selector ──────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-[var(--vscode-panel-border)]">
        <ModeSelector />
      </div>

      {/* ── Index progress bar ─────────────────────────────────────────────── */}
      {indexStatus.state === "indexing" && (
        <IndexProgress progress={indexStatus.progress} total={indexStatus.total} />
      )}

      {/* ── Todo list ──────────────────────────────────────────────────────── */}
      {store.todo && (
        <div className="flex-shrink-0 border-b border-[var(--vscode-panel-border)] px-3 py-1.5">
          <div className="text-[9px] text-[var(--vscode-descriptionForeground)] uppercase mb-0.5 font-semibold tracking-wide">Progress</div>
          <div className="text-xs text-[var(--vscode-foreground)] whitespace-pre-wrap font-mono leading-relaxed">
            {store.todo.split("\n").map((line, i) => {
              const isDone = line.trim().startsWith("- [x]")
              const isPending = line.trim().startsWith("- [ ]")
              return (
                <div key={i} className={isDone ? "text-[var(--vscode-descriptionForeground)] line-through" : isPending ? "" : "font-medium"}>
                  {line}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Message list ───────────────────────────────────────────────────── */}
      <MessageList messages={store.messages} />

      {/* ── Status bar ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-2 py-0.5 border-t border-[var(--vscode-panel-border)] flex items-center justify-between">
        <div className="text-[9px] text-[var(--vscode-descriptionForeground)]">
          {store.provider}/{store.model}
        </div>
        {store.isRunning && (
          <div className="flex items-center gap-1 text-[9px] text-blue-400">
            <svg className="animate-spin h-2.5 w-2.5" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            thinking...
          </div>
        )}
      </div>

      {/* ── Input ──────────────────────────────────────────────────────────── */}
      <InputBar />
    </div>
  )
}

// ── Index badge ──────────────────────────────────────────────────────────────

function IndexBadge({ status }: { status: ReturnType<typeof useChatStore>["indexStatus"] }) {
  if (status.state === "idle") return null

  if (status.state === "indexing") {
    const pct = status.total > 0 ? Math.round((status.progress / status.total) * 100) : 0
    return (
      <span className="flex items-center gap-0.5 text-[9px] text-blue-400 bg-blue-500/10 rounded px-1 py-0.5">
        <svg className="animate-spin h-2 w-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
        </svg>
        {pct > 0 ? `${pct}%` : "indexing"}
      </span>
    )
  }

  if (status.state === "ready") {
    return (
      <span
        title={`${status.files} files · ${status.symbols} symbols indexed`}
        className="text-[9px] text-green-400 bg-green-500/10 rounded px-1 py-0.5 cursor-default"
      >
        ✓ {status.files}f {status.symbols}s
      </span>
    )
  }

  if (status.state === "error") {
    return (
      <span title={status.error} className="text-[9px] text-red-400 bg-red-500/10 rounded px-1 py-0.5">
        ✗ index error
      </span>
    )
  }

  return null
}

// ── Index progress bar ────────────────────────────────────────────────────────

function IndexProgress({ progress, total }: { progress: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((progress / total) * 100)) : 0
  const label = total > 0
    ? `Indexing… ${progress}/${total} files (${pct}%)`
    : "Indexing codebase…"

  return (
    <div className="flex-shrink-0 px-3 py-1 border-b border-[var(--vscode-panel-border)] bg-blue-500/5">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[9px] text-blue-400">{label}</span>
      </div>
      <div className="h-0.5 w-full bg-[var(--vscode-editor-background)] rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-400 rounded-full transition-all duration-300"
          style={{ width: `${total > 0 ? pct : 0}%` }}
        />
      </div>
    </div>
  )
}
