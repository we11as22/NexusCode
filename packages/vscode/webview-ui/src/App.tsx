import React, { useEffect, useMemo, useState } from "react"
import { useChatStore, type NexusConfigState } from "./stores/chat.js"
import type { MessagePart } from "./stores/chat.js"
import { MessageList } from "./components/MessageList.js"
import { InputBar } from "./components/InputBar.js"
import { ImageIcon } from "./components/AttachedImagesStrip.js"
import { InputContextPanel } from "./components/InputContextPanel.js"
import { QueuedMessagesPanel } from "./components/QueuedMessagesPanel.js"
import { ModeDropdown } from "./components/ModeDropdown.js"
import { AgentPresetDropdown } from "./components/AgentPresetDropdown.js"
import { ProgressTodoBlock } from "./components/ProgressTodoBlock.js"
import type { ExtensionMessage } from "./types/messages.js"
import { confirmAsync, resolveConfirm, postMessage } from "./vscode.js"

const ICON_CLASS = "w-4 h-4 flex-shrink-0"
const BTN_CLASS =
  "p-1.5 rounded-md text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
const BTN_SM_CLASS =
  "p-1 rounded text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
const MODEL_PROVIDER_OPTIONS = ["anthropic", "openai", "google", "openai-compatible", "openrouter", "ollama", "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras", "cohere", "togetherai", "perplexity"]
const EMB_PROVIDER_OPTIONS = [
  "openai",
  "openai-compatible",
  "openrouter",
  "ollama",
  "google",
  "mistral",
  "bedrock",
  "local",
]
const REASONING_EFFORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "(auto)" },
  { value: "none", label: "none" },
  { value: "minimal", label: "minimal" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "max", label: "max" },
]

export function App() {
  const store = useChatStore()

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
          store.handleSessionList(msg.sessions)
          break
        case "sessionListLoading":
          store.handleSessionListLoading(msg.loading)
          break
        case "configLoaded":
          store.handleConfigLoaded(msg.config)
          break
        case "mcpServerStatus":
          if ("results" in msg) store.handleMcpServerStatus(msg.results)
          break
        case "pendingApproval":
          if ("partId" in msg && "action" in msg) store.handlePendingApproval(msg.partId, msg.action)
          break
        case "confirmResult":
          if ("id" in msg && "ok" in msg) resolveConfirm(msg.id, msg.ok)
          break
        case "addToChatContent":
          store.appendToInput(msg.content)
          break
        case "modelsCatalog":
          if ("catalog" in msg) store.handleModelsCatalog(msg.catalog as import("./types/messages.js").ModelsCatalogFromCore)
          break
        case "agentPresets":
          if ("presets" in msg) store.handleAgentPresets(msg.presets as import("./types/messages.js").AgentPresetFromCore[])
          break
        case "agentPresetOptions":
          if ("options" in msg) store.handleAgentPresetOptions(msg.options as { skills: string[]; mcpServers: string[]; rulesFiles: string[] })
          break
        case "skillDefinitions":
          if ("definitions" in msg) store.handleSkillDefinitions(msg.definitions as Array<{ name: string; path: string; summary: string }>)
          break
        case "action":
          if (msg.action === "switchView" && msg.view) {
            store.setView(msg.view)
          }
          break
      }
    }

    window.addEventListener("message", handler)
    postMessage({ type: "getState" })
    postMessage({ type: "webviewDidLaunch" })
    return () => window.removeEventListener("message", handler)
  }, [])

  return (
    <div className="container">
      {/* Roo-Code style: view switched via sidebar title icons; optional in-webview nav for quick switch */}
      <div className="nexus-nav nexus-nav-minimal">
        <TabButton active={store.view === "chat"} onClick={() => store.setView("chat")} label="Chat" />
        <TabButton active={store.view === "sessions"} onClick={() => store.setView("sessions")} label="Sessions" />
        <TabButton active={store.view === "settings"} onClick={() => store.setView("settings")} label="Settings" />
      </div>

      {store.indexStatus.state === "indexing" && (
        <IndexProgress status={store.indexStatus} />
      )}

      {store.vectorDbProgressMessage && (
        <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-badge-background)] text-[11px] text-[var(--vscode-descriptionForeground)]">
          {store.vectorDbProgressMessage}
        </div>
      )}

      <div className="nexus-main flex-1 min-h-0 overflow-hidden flex flex-col">
      {store.view === "chat" && <ChatView />}
      {store.view === "sessions" && <SessionsView />}
      {store.view === "settings" && <SettingsView />}
      </div>
    </div>
  )
}

function ChatView() {
  const store = useChatStore()

  // Must be called before any conditional return (Rules of Hooks)
  const todoHeader = useMemo(() => {
    const user = [...store.messages].reverse().find((m) => m.role === "user")
    const content = user?.content
    if (typeof content === "string") return content.slice(0, 120)
    if (Array.isArray(content)) {
      const text = (content as MessagePart[]).filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("")
      return text.slice(0, 120)
    }
    return ""
  }, [store.messages])

  // Prevent flash: don't render content until initial stateUpdate has been received
  if (!store.isInitialized) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-[11px] text-[var(--vscode-descriptionForeground)] opacity-50">Loading…</span>
      </div>
    )
  }

  const contextColor =
    store.contextPercent >= 90
      ? "text-red-400"
      : store.contextPercent >= 75
        ? "text-yellow-300"
        : "text-emerald-300"

  return (
    <>
      {store.isCompacting && (
        <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-badge-background)] text-[10px] text-[var(--vscode-descriptionForeground)]">
          Compacting conversation...
        </div>
      )}

      {store.isCompacting === false && store.messages.some((m) => m.summary) && (
        <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--vscode-panel-border)] text-[10px] text-[var(--vscode-descriptionForeground)]">
          Summarized Chat context summarized.
        </div>
      )}

      {store.awaitingApproval && !store.pendingApproval && (
        <div className="nexus-approval-banner">
          <span className="nexus-approval-icon">⚠</span>
          <span>Action awaiting your approval — use notification or chat buttons: Allow once / Always allow / Deny / Allow all (session) / Say what to do instead.</span>
        </div>
      )}

      <div className="chat-view">
        <SessionTabBar />
        <div className="nexus-status">
          <span className="text-[10px] text-[var(--vscode-descriptionForeground)] truncate">
            {store.provider}/{store.model}
          </span>
          <span className="text-[10px] text-[var(--vscode-descriptionForeground)] truncate">
            session {store.sessionId.slice(0, 8)}
          </span>
          <span className={`text-[10px] ${contextColor} truncate`}>
            ctx {formatTokens(store.contextUsedTokens)}/{formatTokens(store.contextLimitTokens)} ({store.contextPercent}%)
          </span>
        </div>
        <div className="chat-messages-wrapper">
          <div className="chat-messages">
            <MessageList
              messages={store.messages}
              isRunning={store.isRunning}
              hasOlderMessages={store.hasOlderMessages}
              loadingOlderMessages={store.loadingOlderMessages}
            />
          </div>
        </div>

        {((store.todo && store.todo.trim()) || store.isRunning) && (
          <div className="flex-shrink-0 border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] nexus-todo-panel">
            {store.todo && store.todo.trim() && (
              <ProgressTodoBlock todo={store.todo} isRunning={store.isRunning} header={todoHeader} />
            )}
          </div>
        )}

        {store.mode === "plan" && store.planCompleted && !store.isRunning && (
          <PlanActionsBar
            planFollowupText={store.planFollowupText}
            onChoice={(choice, planText) => postMessage({ type: "planFollowupChoice", choice, planText: planText ?? undefined })}
          />
        )}

        <div className="chat-input">
          <QueuedMessagesPanel />
          <InputContextPanel />
          <RetryMessageBar />
          <ChatBottomBar />
        </div>
      </div>
    </>
  )
}

function RetryMessageBar() {
  const store = useChatStore()
  const msgs = store.messages
  const last = msgs[msgs.length - 1]
  const isLlmError =
    last?.role === "system" &&
    typeof last.content === "string" &&
    last.content.startsWith("Error:")
  if (!isLlmError || msgs.length < 2) return null
  const lastUser = [...msgs].reverse().find((m) => m.role === "user")
  const lastUserContent =
    lastUser && typeof lastUser.content === "string"
      ? lastUser.content
      : (lastUser?.content as Array<{ type: string; text?: string }>)?.find((p) => p.type === "text")?.text ?? ""
  if (!lastUserContent.trim()) return null
  return (
    <div className="nexus-retry-bar">
      <button
        type="button"
        onClick={() => store.sendMessage(lastUserContent)}
        className="nexus-retry-btn"
      >
        Retry (LLM error)
      </button>
    </div>
  )
}

function ChatBottomBar() {
  const store = useChatStore()
  const [imagePickerTrigger, setImagePickerTrigger] = useState<(() => void) | null>(null)
  const registerImagePickerTrigger = React.useCallback((trigger: () => void) => {
    setImagePickerTrigger(() => trigger)
  }, [])
  const canSend = !store.isRunning && !store.awaitingApproval && (store.inputValue.trim().length > 0 || store.attachedImages.length > 0)
  const contextPercent = store.contextPercent

  return (
    <div className="chat-input-inner">
        <div className="chat-input-area">
          <InputBar registerImagePickerTrigger={registerImagePickerTrigger} />
        </div>
        <div className="chat-control-row">
          <div className="chat-bottom-bar-left">
            <ModeDropdown />
            <AgentPresetDropdown />
          </div>
          <div className="chat-bottom-bar-input-wrap">
          {store.isRunning && (
            <span className="flex items-center justify-center w-8 h-8 flex-shrink-0" title="Running">
              <SpinnerIcon className="w-5 h-5 text-[var(--vscode-descriptionForeground)]" />
            </span>
          )}
          <button
            type="button"
            className="nexus-context-ring-btn"
            title={contextPercent != null ? `${Math.round(contextPercent)}% context used` : "Context"}
            aria-label="Context"
          >
            <ContextRingIcon className="w-4 h-4" percent={contextPercent} />
          </button>
          <button
            type="button"
            className="nexus-image-pick-btn"
            onClick={() => imagePickerTrigger?.()}
            title="Attach image"
            aria-label="Attach image"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
          {store.isRunning || store.awaitingApproval ? (
            <button
              type="button"
              onClick={store.abort}
              title="Stop (Esc)"
              className="nexus-send-btn nexus-send-btn-stop"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => canSend && store.sendMessage(store.inputValue.trim())}
              disabled={!canSend}
              title="Send (Enter)"
              className={`nexus-send-btn ${canSend ? "nexus-send-btn-primary" : ""}`}
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SessionsView() {
  const { sessions, sessionId, switchSession, createNewSession, deleteSession, sessionsLoading } = useChatStore()

  const handleDelete = async (e: React.MouseEvent, s: { id: string; title?: string }) => {
    e.stopPropagation()
    const label = s.title?.trim() || s.id.slice(0, 12)
    if (!(await confirmAsync(`Delete session "${label}"? This cannot be undone.`))) return
    deleteSession(s.id)
  }

  return (
    <div className="nexus-pane">
      <div className="nexus-pane-title">Session History</div>
      <button
        type="button"
        className="nexus-primary-btn mt-2 flex items-center gap-2"
        onClick={() => createNewSession()}
      >
        <PlusIcon className="w-3.5 h-3.5" />
        New session
      </button>
      {sessionsLoading && (
        <div className="nexus-loading-dots flex items-center gap-2 py-4 text-[var(--vscode-descriptionForeground)] text-sm">
          <span className="nexus-dot" />
          <span className="nexus-dot" />
          <span className="nexus-dot" />
          <span className="ml-1">Loading...</span>
        </div>
      )}
      {!sessionsLoading && sessions.length === 0 && (
        <div className="nexus-muted text-xs">No saved sessions yet.</div>
      )}

      <div className="flex flex-col gap-2 mt-2">
        {sessions.map((s) => {
          const isActive = s.id === sessionId
          const date = new Date(s.ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
          const title = (s.title?.trim() || "Untitled session").slice(0, 80)
          return (
            <div
              key={s.id}
              className={`nexus-session-item ${isActive ? "nexus-session-item-active" : ""}`}
            >
              <button
                type="button"
                className="nexus-session-item-btn"
                onClick={() => switchSession(s.id)}
              >
                <div className="nexus-session-item-title">{title}</div>
                <div className="nexus-session-item-meta">
                  <span className="text-[10px] nexus-muted">{date}</span>
                  <span className="text-[10px] nexus-muted">{s.messageCount} messages</span>
                </div>
                <div className="font-mono text-[10px] nexus-muted truncate mt-0.5" title={s.id}>
                  {s.id}
                </div>
              </button>
              <button
                type="button"
                className="nexus-session-delete"
                onClick={(e) => handleDelete(e, s)}
                title="Delete session"
                aria-label="Delete session"
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Horizontal session tab bar: scrollable tabs, each with close (X), + new session, dropdown of all sessions. */
function SessionTabBar() {
  const store = useChatStore()
  const { sessions, sessionId, switchSession, createNewSession, deleteSession, setView, sessionsLoading } = store
  const [dropdownOpen, setDropdownOpen] = React.useState(false)
  const dropdownRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!dropdownOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setDropdownOpen(false)
    }
    document.addEventListener("click", onDocClick)
    return () => document.removeEventListener("click", onDocClick)
  }, [dropdownOpen])

  const hasCurrentInList = sessions.some((s) => s.id === sessionId)
  const displaySessions = hasCurrentInList
    ? sessions
    : [{ id: sessionId, ts: Date.now(), title: "New chat", messageCount: 0 }, ...sessions]

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const s = sessions.find((x) => x.id === id)
    const label = s?.title?.trim() || id.slice(0, 12)
    if (!(await confirmAsync(`Delete session "${label}"? This cannot be undone.`))) return
    deleteSession(id)
  }

  return (
    <div className="nexus-session-tab-bar">
      <div className="nexus-session-tab-bar-scroll" role="tablist">
        {displaySessions.map((s) => {
          const isActive = s.id === sessionId
          const title = (s.title?.trim() || "Untitled session").slice(0, 40)
          return (
            <div
              key={s.id}
              role="tab"
              aria-selected={isActive}
              className={`nexus-session-tab ${isActive ? "nexus-session-tab-active" : ""}`}
            >
              <button
                type="button"
                className="nexus-session-tab-btn"
                onClick={() => switchSession(s.id)}
              >
                {title}
              </button>
              <button
                type="button"
                className="nexus-session-tab-close"
                onClick={(e) => handleDelete(e, s.id)}
                title="Delete session"
                aria-label="Delete session"
              >
                <CloseIcon className="w-3 h-3" />
              </button>
            </div>
          )
        })}
      </div>
      <div className="nexus-session-tab-bar-actions">
        <button
          type="button"
          className="nexus-session-tab-add"
          onClick={() => createNewSession()}
          title="New session"
          aria-label="New session"
        >
          <PlusIcon className="w-3.5 h-3.5" />
        </button>
        <div className="nexus-session-tab-dropdown-wrap" ref={dropdownRef}>
          <button
            type="button"
            className="nexus-session-tab-dropdown-btn"
            onClick={() => setDropdownOpen((v) => !v)}
            title="All sessions"
            aria-label="All sessions"
            aria-expanded={dropdownOpen}
          >
            <EllipsisIcon className="w-3.5 h-3.5" />
          </button>
          {dropdownOpen && (
            <div className="nexus-session-tab-dropdown">
              <div className="nexus-session-tab-dropdown-list">
                {sessionsLoading ? (
                  <div className="nexus-muted text-xs px-2 py-1.5">Loading...</div>
                ) : sessions.length === 0 ? (
                  <div className="nexus-muted text-xs px-2 py-1.5">No sessions</div>
                ) : (
                  sessions.map((s) => {
                    const isActive = s.id === sessionId
                    const title = (s.title?.trim() || "Untitled session").slice(0, 60)
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className={`nexus-session-tab-dropdown-item ${isActive ? "nexus-session-tab-dropdown-item-active" : ""}`}
                        onClick={() => {
                          switchSession(s.id)
                          setDropdownOpen(false)
                        }}
                      >
                        {title}
                      </button>
                    )
                  })
                )}
              </div>
              <button
                type="button"
                className="nexus-session-tab-dropdown-more"
                onClick={() => {
                  setView("sessions")
                  setDropdownOpen(false)
                }}
              >
                Session history…
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Kilocode-style: plan_exit completed — New session / Continue / Dismiss (above input). */
function PlanActionsBar({
  planFollowupText,
  onChoice,
}: {
  planFollowupText: string | null
  onChoice: (choice: "new_session" | "continue" | "dismiss", planText?: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<"continue" | "dismiss">("continue")
  const fullText = (planFollowupText ?? "").trim()
  const lines = fullText.split(/\r?\n/)
  const needsClamp = lines.length > 48 || fullText.length > 3600
  const renderedText = !needsClamp || expanded ? fullText : `${lines.slice(0, 48).join("\n")}\n\n…`

  return (
    <div className="nexus-plan-followup-wrap">
      <div className="nexus-plan-followup-card">
        <div className="nexus-plan-followup-header">
          <span className="nexus-plan-followup-title">Plan</span>
          <div className="nexus-plan-followup-actions">
            {needsClamp ? (
              <button
                type="button"
                className="nexus-plan-mini-btn"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "Collapse" : "Expand"}
              </button>
            ) : null}
            <button
              type="button"
              className="nexus-plan-mini-btn"
              onClick={() => onChoice("new_session", planFollowupText ?? undefined)}
            >
              Open in new session
            </button>
          </div>
        </div>
        <pre className="nexus-plan-followup-text">{renderedText || "Plan saved to .nexus/plans/."}</pre>
      </div>

      <div className="nexus-plan-followup-question">Implement this plan?</div>
      <div className="nexus-plan-followup-options">
        <button
          type="button"
          className={`nexus-plan-option ${selected === "continue" ? "nexus-plan-option-active" : ""}`}
          onClick={() => setSelected("continue")}
        >
          1. Yes, implement this plan
        </button>
        <button
          type="button"
          className={`nexus-plan-option ${selected === "dismiss" ? "nexus-plan-option-active" : ""}`}
          onClick={() => setSelected("dismiss")}
        >
          2. No, and tell Codex what to do differently
        </button>
      </div>
      <div className="nexus-plan-followup-submit-row">
        <button
          type="button"
          className="nexus-secondary-btn text-xs"
          onClick={() => onChoice("dismiss")}
        >
          Dismiss
        </button>
        <button
          type="button"
          className="nexus-primary-btn text-xs"
          onClick={() =>
            onChoice(
              selected === "continue" ? "continue" : "dismiss",
              selected === "continue" ? (planFollowupText ?? undefined) : undefined
            )
          }
        >
          Submit
        </button>
      </div>
    </div>
  )
}

/** Modal for selecting model. Same as Kilo: one list grouped by provider, Recommended first, Free tag, search. */
function ModelPickerModal({
  catalog,
  loading,
  query,
  onQueryChange,
  onSelect,
  onClose,
}: {
  catalog: import("./types/messages.js").ModelsCatalogFromCore | null
  loading: boolean
  query: string
  onQueryChange: (q: string) => void
  onSelect: (providerId: string, modelId: string, baseUrl: string) => void
  onClose: () => void
}) {
  const options = useMemo(() => {
    if (!catalog) return []
    const q = query.trim().toLowerCase()
    const recommendedKeys = new Set(catalog.recommended.map((r) => `${r.providerId}:${r.modelId}`))
    const list: Array<{ providerId: string; modelId: string; name: string; free: boolean; category: string }> = []
    for (const r of catalog.recommended) {
      list.push({
        ...r,
        category: r.providerId === "nexus" ? "Recommended" : catalog.providers.find((p) => p.id === r.providerId)?.name ?? r.providerId,
      })
    }
    for (const prov of catalog.providers) {
      for (const m of prov.models) {
        if (recommendedKeys.has(`${prov.id}:${m.id}`)) continue
        list.push({
          providerId: prov.id,
          modelId: m.id,
          name: m.name,
          free: m.free,
          category: prov.name,
        })
      }
    }
    list.sort((a, b) => {
      if (a.category === "Recommended" && b.category !== "Recommended") return -1
      if (a.category !== "Recommended" && b.category === "Recommended") return 1
      if (a.free !== b.free) return a.free ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    if (!q) return list
    return list.filter((o) => o.name.toLowerCase().includes(q) || o.modelId.toLowerCase().includes(q) || o.category.toLowerCase().includes(q))
  }, [catalog, query])

  const displayName = (name: string) => {
    return name.replace(/\s*\(\s*free\s*\)\s*/gi, "").trim()
  }

  const provById = useMemo(() => {
    const m = new Map<string, { baseUrl: string }>()
    if (catalog) for (const p of catalog.providers) m.set(p.id, { baseUrl: p.baseUrl })
    return m
  }, [catalog])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-label="Select model"
    >
      <div
        className="bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] rounded-lg shadow-xl max-w-lg w-full max-h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--vscode-panel-border)]">
          <h3 className="text-sm font-semibold text-[var(--vscode-foreground)]">Select model</h3>
          <button type="button" onClick={onClose} className={BTN_CLASS} aria-label="Close">
            ×
          </button>
        </div>
        <p className="px-3 py-1.5 text-[10px] text-[var(--vscode-descriptionForeground)] border-b border-[var(--vscode-panel-border)]">
          Same as CLI: models.dev + Nexus Gateway. Recommended first, then free. Search by name or provider.
        </p>
        <div className="p-2 border-b border-[var(--vscode-panel-border)]">
          <input
            type="text"
            placeholder="Search models..."
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            className="nexus-input w-full text-sm"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-2 min-h-0">
          {loading && <div className="nexus-muted text-xs py-2">Loading catalog…</div>}
          {!loading && !catalog && <div className="nexus-muted text-xs py-2">Could not load catalog.</div>}
          {!loading && catalog && (
            <>
              {options.length === 0 && <div className="nexus-muted text-xs py-2">No models match.</div>}
              {options.slice(0, 80).map((opt) => {
                const baseUrl = provById.get(opt.providerId)?.baseUrl ?? "https://openrouter.ai/api/v1"
                return (
                  <button
                    key={`${opt.providerId}/${opt.modelId}`}
                    type="button"
                    className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-[var(--vscode-list-hoverBackground)] flex items-center justify-between gap-2 flex-wrap"
                    onClick={() => onSelect(opt.providerId, opt.modelId, baseUrl)}
                  >
                    <span className="truncate text-[var(--vscode-foreground)] flex items-center gap-1.5">
                      {displayName(opt.name)}
                      {opt.free && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)]">
                          Free
                        </span>
                      )}
                    </span>
                    <span className="text-[10px] text-[var(--vscode-descriptionForeground)] flex-shrink-0">{opt.category}</span>
                  </button>
                )
              })}
              {options.length > 80 && <div className="nexus-muted text-[10px] py-1">… and {options.length - 80} more. Narrow search.</div>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface SettingsDraft {
  modelProvider: string
  modelId: string
  modelApiKey: string
  modelBaseUrl: string
  modelTemperature: string
  modelReasoningEffort: string
  modelContextWindow: string
  embProvider: string
  embModel: string
  embApiKey: string
  embBaseUrl: string
  embDimensions: string
  indexingEnabled: boolean
  indexingVector: boolean
  embeddingBatchSize: string
  embeddingConcurrency: string
  vectorDbEnabled: boolean
  vectorDbUrl: string
  vectorDbAutoStart: boolean
  filterTools: boolean
  toolClassifyThreshold: string
  filterSkills: boolean
  skillClassifyThreshold: string
  parallelReads: boolean
  maxParallelReads: string
  autoApproveRead: boolean
  autoApproveWrite: boolean
  autoApproveCommand: boolean
  autoApproveMcp: boolean
  autoApproveBrowser: boolean
  autoApproveReadPatternsText: string
  allowedCommandsText: string
  allowCommandPatternsText: string
  askCommandPatternsText: string
  denyCommandPatternsText: string
  allowedMcpToolsText: string
  mcpServersJson: string
  /** For Rules & Skills panel: path + enabled. skillsText is derived for raw edit. */
  skillsConfig?: Array<{ path: string; enabled: boolean }>
  skillsText: string
  rulesFilesText: string
  claudeMdPath: string
  agentInstructions: string
  planInstructions: string
  askInstructions: string
  debugInstructions: string
  reviewInstructions: string
  profilesJson: string
  /** When true, streamed text_delta is shown in chat as muted reasoning; when false, only tool-written text. */
  showReasoningInChat: boolean
}

function SettingsView() {
  const { config, provider, model, saveConfig, serverUrl, modelsCatalog, modelsCatalogLoading, requestModelsCatalog, agentPresets, requestAgentPresets, agentPresetOptions, requestAgentPresetOptions, handleAgentPresetOptions } = useChatStore()
  const [draft, setDraft] = useState<SettingsDraft>(() => getDefaultDraft())
  const [serverUrlLocal, setServerUrlLocal] = useState(serverUrl)
  const [tab, setTab] = useState<"llm" | "embeddings" | "index" | "tools" | "integrations" | "presets">("llm")
  const [integTab, setIntegTab] = useState<"rules-skills" | "mcp" | "rules-instructions">("rules-skills")
  const [rulesFilter, setRulesFilter] = useState<"all" | "user" | "projects">("all")
  const [includeThirdParty, setIncludeThirdParty] = useState(true)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelPickerQuery, setModelPickerQuery] = useState("")
  const [presetCreateOpen, setPresetCreateOpen] = useState(false)
  const [presetCreateName, setPresetCreateName] = useState("")
  const [presetCreateVector, setPresetCreateVector] = useState(false)
  const [presetCreateSkills, setPresetCreateSkills] = useState<Set<string>>(new Set())
  const [presetCreateMcp, setPresetCreateMcp] = useState<Set<string>>(new Set())
  const [presetCreateRules, setPresetCreateRules] = useState<Set<string>>(new Set())

  useEffect(() => {
    setServerUrlLocal(serverUrl)
  }, [serverUrl])
  useEffect(() => {
    if (config) setDraft(toDraft(config, provider, model))
  }, [config, provider, model])
  useEffect(() => {
    requestModelsCatalog()
  }, [requestModelsCatalog])
  useEffect(() => {
    if (tab === "presets") requestAgentPresets()
  }, [tab, requestAgentPresets])
  const openPresetCreateModal = () => {
    setPresetCreateName(`preset-${new Date().toISOString().slice(0, 10)}`)
    setPresetCreateVector(Boolean(config?.indexing?.vector))
    setPresetCreateSkills(new Set(config?.skills ?? []))
    setPresetCreateMcp(new Set((config?.mcp?.servers ?? []).map((s) => s.name).filter(Boolean)))
    setPresetCreateRules(new Set(config?.rules?.files ?? ["AGENTS.md", "CLAUDE.md"]))
    handleAgentPresetOptions(null)
    setPresetCreateOpen(true)
    requestAgentPresetOptions()
  }

  const canSave = Boolean(config && draft)
  const vectorHint = useMemo(() => {
    if (!draft) return ""
    if (!draft.indexingVector || !draft.vectorDbEnabled) return "Vector search is disabled."
    if (!draft.embModel.trim()) return "Set embeddings model to enable semantic index."
    return "Vector search enabled (Qdrant-compatible)."
  }, [draft])

  return (
    <div className="nexus-pane">
      {!config && (
        <div className="nexus-muted text-xs mb-2 flex items-center gap-2">
          <span className="nexus-loading-dots flex items-center gap-1">
            <span className="nexus-dot" />
            <span className="nexus-dot" />
            <span className="nexus-dot" />
          </span>
          Configuration is loading…
        </div>
      )}
      <div className="nexus-pane-title">Agent Settings</div>

      <div className="nexus-settings-config-bar">
        <span className="nexus-settings-config-label">Config:</span>
        <button
          type="button"
          className="nexus-settings-config-link"
          onClick={() => postMessage({ type: "openNexusConfigFolder", scope: "project" })}
        >
          Open project .nexus
        </button>
      </div>

      <section className="nexus-section mt-2">
        <h3 className="nexus-section-title">NexusCode Server</h3>
        <p className="nexus-muted text-[10px] mb-2">
          When set, the extension uses this server for sessions and agent runs (DB-backed, paginated). Leave empty to run in-process.
        </p>
        <SettingsInput
          label="Server URL (e.g. http://127.0.0.1:4097)"
          value={serverUrlLocal}
          onChange={(v) => {
            setServerUrlLocal(v)
            postMessage({ type: "setServerUrl", url: v })
          }}
        />
      </section>

      <div className="flex flex-wrap gap-1.5 mt-2 mb-2">
        <TabPill id="llm" tab={tab} setTab={setTab} label="LLM" />
        <TabPill id="embeddings" tab={tab} setTab={setTab} label="Embeddings" />
        <TabPill id="index" tab={tab} setTab={setTab} label="Index" />
        <TabPill id="tools" tab={tab} setTab={setTab} label="Tools" />
        <TabPill id="integrations" tab={tab} setTab={setTab} label="MCP &amp; Skills" />
        <TabPill id="presets" tab={tab} setTab={setTab} label="Agent presets" />
      </div>

      {tab === "llm" && (
        <>
          <section className="nexus-section">
            <h3 className="nexus-section-title">LLM</h3>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <button
                type="button"
                className="nexus-secondary-btn text-xs"
                onClick={() => {
                  setModelPickerOpen(true)
                  setModelPickerQuery("")
                  if (!modelsCatalog) requestModelsCatalog()
                }}
              >
                Select model (same as CLI — models.dev + Nexus Gateway)
              </button>
              <span className="text-[10px] text-[var(--vscode-descriptionForeground)]">
                Same catalog as CLI: Recommended first, Free tag. Search by name or provider.
              </span>
            </div>
            {modelPickerOpen && (
              <ModelPickerModal
                catalog={modelsCatalog}
                loading={modelsCatalogLoading}
                query={modelPickerQuery}
                onQueryChange={setModelPickerQuery}
                onSelect={(providerId, modelId, baseUrl) => {
                  if (draft) {
                    setDraft({
                      ...draft,
                      modelProvider: "openrouter",
                      modelId,
                      modelBaseUrl: baseUrl || "https://openrouter.ai/api/v1",
                    })
                  }
                  setModelPickerOpen(false)
                }}
                onClose={() => setModelPickerOpen(false)}
              />
            )}
            <SettingsSelect
              label="Provider"
              value={draft.modelProvider}
              onChange={(v) => setDraft({ ...draft, modelProvider: v })}
              options={MODEL_PROVIDER_OPTIONS}
            />
            <SettingsInput label="Model" value={draft.modelId} onChange={(v) => setDraft({ ...draft, modelId: v })} />
            <SettingsInput label="Temperature (0-2)" value={draft.modelTemperature} onChange={(v) => setDraft({ ...draft, modelTemperature: v })} />
            <SettingsSelect
              label="Reasoning effort"
              value={draft.modelReasoningEffort}
              onChange={(v) => setDraft({ ...draft, modelReasoningEffort: v })}
              options={REASONING_EFFORT_OPTIONS}
            />
            <SettingsInput
              label="Context window (tokens, optional override)"
              value={draft.modelContextWindow}
              onChange={(v) => setDraft({ ...draft, modelContextWindow: v })}
            />
            <SettingsInput type="password" label="API Key" value={draft.modelApiKey} onChange={(v) => setDraft({ ...draft, modelApiKey: v })} />
            <SettingsInput label="Base URL" value={draft.modelBaseUrl} onChange={(v) => setDraft({ ...draft, modelBaseUrl: v })} />
            <div className="nexus-muted text-[10px]">Default context window fallback: 128k tokens.</div>
          </section>
        </>
      )}

      {tab === "embeddings" && (
      <section className="nexus-section">
        <h3 className="nexus-section-title">Embeddings</h3>
        <SettingsSelect
          label="Provider"
          value={draft.embProvider}
          onChange={(v) => setDraft({ ...draft, embProvider: v })}
          options={EMB_PROVIDER_OPTIONS}
        />
        <SettingsInput label="Model" value={draft.embModel} onChange={(v) => setDraft({ ...draft, embModel: v })} />
        <SettingsInput type="password" label="API Key" value={draft.embApiKey} onChange={(v) => setDraft({ ...draft, embApiKey: v })} />
        <SettingsInput label="Base URL" value={draft.embBaseUrl} onChange={(v) => setDraft({ ...draft, embBaseUrl: v })} />
        <SettingsInput label="Dimensions" value={draft.embDimensions} onChange={(v) => setDraft({ ...draft, embDimensions: v })} />
      </section>
      )}

      {tab === "index" && (
      <IndexingAndDocsView
        draft={draft}
        setDraft={setDraft}
        onReindex={() => postMessage({ type: "reindex" })}
        onDeleteIndex={async () => {
          if (await confirmAsync("Delete the codebase index? You can re-sync later.")) {
            postMessage({ type: "clearIndex" })
          }
        }}
        onOpenCursorignore={() => postMessage({ type: "openCursorignore" })}
        onOpenNexusignore={() => postMessage({ type: "openNexusignore" })}
      />
      )}

      {tab === "tools" && (
      <section className="nexus-section">
        <h3 className="nexus-section-title">Chat</h3>
        <SettingsToggle
          label="Show reasoning in chat (streamed model text as muted; when off, only tool messages are shown)"
          checked={draft.showReasoningInChat}
          onChange={(checked) => setDraft({ ...draft, showReasoningInChat: checked })}
        />
        <h3 className="nexus-section-title mt-4">Tools & Skills Filtering</h3>
        <SettingsToggle
          label="Filter MCP servers when list is large"
          checked={draft.filterTools}
          onChange={(checked) => setDraft({ ...draft, filterTools: checked })}
        />
        <SettingsInput
          label="MCP server threshold"
          value={draft.toolClassifyThreshold}
          onChange={(v) => setDraft({ ...draft, toolClassifyThreshold: v })}
        />
        <SettingsToggle
          label="Filter skills when list is large"
          checked={draft.filterSkills}
          onChange={(checked) => setDraft({ ...draft, filterSkills: checked })}
        />
        <SettingsInput
          label="Skill threshold"
          value={draft.skillClassifyThreshold}
          onChange={(v) => setDraft({ ...draft, skillClassifyThreshold: v })}
        />
        <SettingsToggle
          label="Parallel read tools"
          checked={draft.parallelReads}
          onChange={(checked) => setDraft({ ...draft, parallelReads: checked })}
        />
        <SettingsInput
          label="Max parallel reads"
          value={draft.maxParallelReads}
          onChange={(v) => setDraft({ ...draft, maxParallelReads: v })}
        />
        <h3 className="nexus-section-title mt-4">Approvals</h3>
        <SettingsToggle
          label="Auto-approve Read"
          checked={draft.autoApproveRead}
          onChange={(checked) => setDraft({ ...draft, autoApproveRead: checked })}
        />
        <SettingsToggle
          label="Auto-approve Write/Edit"
          checked={draft.autoApproveWrite}
          onChange={(checked) => setDraft({ ...draft, autoApproveWrite: checked })}
        />
        <SettingsToggle
          label="Auto-approve Execute command"
          checked={draft.autoApproveCommand}
          onChange={(checked) => setDraft({ ...draft, autoApproveCommand: checked })}
        />
        <SettingsToggle
          label="Auto-approve MCP"
          checked={draft.autoApproveMcp}
          onChange={(checked) => setDraft({ ...draft, autoApproveMcp: checked })}
        />
        <SettingsToggle
          label="Auto-approve Browser"
          checked={draft.autoApproveBrowser}
          onChange={(checked) => setDraft({ ...draft, autoApproveBrowser: checked })}
        />
        <SettingsTextarea
          label="Auto-approve Read path patterns (one per line)"
          value={draft.autoApproveReadPatternsText}
          onChange={(v) => setDraft({ ...draft, autoApproveReadPatternsText: v })}
          rows={3}
        />
        <SettingsTextarea
          label="Allowed command patterns (no approval; one per line)"
          value={draft.allowCommandPatternsText}
          onChange={(v) => setDraft({ ...draft, allowCommandPatternsText: v })}
          rows={3}
        />
        <SettingsTextarea
          label="Ask command patterns (always ask; one per line)"
          value={draft.askCommandPatternsText}
          onChange={(v) => setDraft({ ...draft, askCommandPatternsText: v })}
          rows={2}
        />
        <SettingsTextarea
          label="Deny command patterns (always deny; one per line)"
          value={draft.denyCommandPatternsText}
          onChange={(v) => setDraft({ ...draft, denyCommandPatternsText: v })}
          rows={2}
        />
        <SettingsTextarea
          label="Allowed exact commands (one per line)"
          value={draft.allowedCommandsText}
          onChange={(v) => setDraft({ ...draft, allowedCommandsText: v })}
          rows={2}
        />
        <SettingsTextarea
          label="Allowed MCP tools (one per line)"
          value={draft.allowedMcpToolsText}
          onChange={(v) => setDraft({ ...draft, allowedMcpToolsText: v })}
          rows={2}
        />
      </section>
      )}

      {tab === "integrations" && (
      <section className="nexus-section">
        <div className="flex flex-wrap gap-1.5 mb-2">
          <button
            type="button"
            className={`nexus-tab-btn ${integTab === "rules-skills" ? "nexus-tab-btn-active" : ""}`}
            onClick={() => setIntegTab("rules-skills")}
          >
            Skills
          </button>
          <button
            type="button"
            className={`nexus-tab-btn ${integTab === "mcp" ? "nexus-tab-btn-active" : ""}`}
            onClick={() => setIntegTab("mcp")}
          >
            MCP Servers
          </button>
          <button
            type="button"
            className={`nexus-tab-btn ${integTab === "rules-instructions" ? "nexus-tab-btn-active" : ""}`}
            onClick={() => setIntegTab("rules-instructions")}
          >
            Instructions
          </button>
        </div>

        {integTab === "rules-skills" && (
          <RulesSkillsSubagentsView
            draft={draft}
            setDraft={setDraft}
            rulesFilter={rulesFilter}
            setRulesFilter={setRulesFilter}
            includeThirdParty={includeThirdParty}
            setIncludeThirdParty={setIncludeThirdParty}
            onOpenRulesInstructions={() => setIntegTab("rules-instructions")}
          />
        )}
        {integTab === "mcp" && (
          <IntegrationsMcpView
            draft={draft}
            setDraft={setDraft}
          />
        )}
        {integTab === "rules-instructions" && (
          <>
            <SettingsInput
              label="CLAUDE.md path in rules (empty = disabled)"
              value={draft.claudeMdPath}
              onChange={(v) => setDraft({ ...draft, claudeMdPath: v })}
            />
            <SettingsTextarea
              label="Additional rules files (one per line)"
              value={draft.rulesFilesText}
              onChange={(v) => setDraft({ ...draft, rulesFilesText: v })}
              rows={3}
            />
            <SettingsTextarea
              label="Agent custom instructions"
              value={draft.agentInstructions}
              onChange={(v) => setDraft({ ...draft, agentInstructions: v })}
              rows={3}
            />
            <SettingsTextarea
              label="Plan custom instructions"
              value={draft.planInstructions}
              onChange={(v) => setDraft({ ...draft, planInstructions: v })}
              rows={3}
            />
            <SettingsTextarea
              label="Ask custom instructions"
              value={draft.askInstructions}
              onChange={(v) => setDraft({ ...draft, askInstructions: v })}
              rows={3}
            />
            <SettingsTextarea
              label="Debug custom instructions"
              value={draft.debugInstructions}
              onChange={(v) => setDraft({ ...draft, debugInstructions: v })}
              rows={3}
            />
            <SettingsTextarea
              label="Review custom instructions"
              value={draft.reviewInstructions}
              onChange={(v) => setDraft({ ...draft, reviewInstructions: v })}
              rows={3}
            />
          </>
        )}
      </section>
      )}

      {tab === "presets" && (
      <section className="nexus-section">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="nexus-section-title">Agent configs</h3>
          <button
            type="button"
            className="nexus-secondary-btn text-xs flex items-center gap-1"
            onClick={openPresetCreateModal}
            title="Create new preset (skills + MCP + rules)"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            New preset
          </button>
        </div>
        <p className="nexus-muted text-[10px] mb-2">
          Presets bundle vector search, skills, MCP servers, and rules. Create with the list below; apply to switch instantly. Saved in .nexus/agent-configs.json.
        </p>
        {agentPresets.length === 0 ? (
          <p className="nexus-muted text-xs">No presets yet. Click &quot;New preset&quot; to create one from the list of skills, MCP servers, and rules.</p>
        ) : (
          <ul className="space-y-2">
            {agentPresets.map((preset) => (
              <li key={preset.name} className="flex items-center justify-between gap-2 rounded-md border border-[var(--vscode-panel-border)] p-2 bg-[var(--vscode-editor-inactiveSelectionBackground)]">
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-[var(--vscode-foreground)]">{preset.name}</span>
                  <div className="text-[10px] text-[var(--vscode-descriptionForeground)] mt-0.5">
                    vector: {preset.vector ? "on" : "off"} · skills: {preset.skills.length} · MCP: {preset.mcpServers.length} · rules: {preset.rulesFiles.length}
                    {preset.modelProvider && preset.modelId && ` · ${preset.modelProvider}/${preset.modelId}`}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    className="nexus-secondary-btn text-xs"
                    onClick={() => postMessage({ type: "applyAgentPreset", presetName: preset.name })}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="p-1.5 rounded text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-errorForeground)] hover:bg-[var(--vscode-list-hoverBackground)]"
                    onClick={async () => {
                      if (await confirmAsync(`Delete preset "${preset.name}"?`)) {
                        postMessage({ type: "deleteAgentPreset", presetName: preset.name })
                      }
                    }}
                    title="Delete preset"
                    aria-label="Delete preset"
                  >
                    <TrashIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {presetCreateOpen && (
          <AgentPresetCreateModal
            name={presetCreateName}
            setName={setPresetCreateName}
            vector={presetCreateVector}
            setVector={setPresetCreateVector}
            options={agentPresetOptions}
            selectedSkills={presetCreateSkills}
            setSelectedSkills={setPresetCreateSkills}
            selectedMcp={presetCreateMcp}
            setSelectedMcp={setPresetCreateMcp}
            selectedRules={presetCreateRules}
            setSelectedRules={setPresetCreateRules}
            onSave={() => {
              const name = presetCreateName.trim()
              if (!name) return
              postMessage({
                type: "createAgentPreset",
                preset: {
                  name,
                  vector: presetCreateVector,
                  skills: Array.from(presetCreateSkills),
                  mcpServers: Array.from(presetCreateMcp),
                  rulesFiles: Array.from(presetCreateRules),
                  modelProvider: provider,
                  modelId: model,
                },
              })
              setPresetCreateOpen(false)
              requestAgentPresets()
            }}
            onClose={() => setPresetCreateOpen(false)}
          />
        )}
      </section>
      )}

      <div className="flex items-center gap-2 mt-3">
        <button
          className="nexus-primary-btn"
          disabled={!canSave}
          onClick={() => {
            if (!draft) return
            saveConfig(fromDraft(draft))
          }}
        >
          Apply Settings
        </button>
        <button
          className="nexus-secondary-btn"
          onClick={() => config && setDraft(toDraft(config, provider, model))}
        >
          Reset
        </button>
        <span className="text-[10px] text-[var(--vscode-descriptionForeground)] ml-2">
          Saved to .nexus/nexus.yaml in project root.
        </span>
      </div>
    </div>
  )
}

/** Indexing panel (codebase index, ignore files, vector/advanced). */
function IndexingAndDocsView({
  draft,
  setDraft,
  onReindex,
  onDeleteIndex,
  onOpenCursorignore,
  onOpenNexusignore,
}: {
  draft: SettingsDraft
  setDraft: React.Dispatch<React.SetStateAction<SettingsDraft>>
  onReindex: () => void
  onDeleteIndex: () => void
  onOpenCursorignore: () => void
  onOpenNexusignore: () => void
}) {
  const indexStatus = useChatStore((s) => s.indexStatus)
  const vectorDbProgressMessage = useChatStore((s) => s.vectorDbProgressMessage)
  const filesTotal = indexStatus.state === "indexing" ? indexStatus.total : 0
  const filesDone = indexStatus.state === "indexing" ? indexStatus.progress : 0
  const chunksTotal = indexStatus.state === "indexing" && typeof indexStatus.chunksTotal === "number" ? indexStatus.chunksTotal : 0
  const chunksDone = indexStatus.state === "indexing" && typeof indexStatus.chunksProcessed === "number" ? indexStatus.chunksProcessed : 0
  const filesPct = filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0
  const chunksPct = chunksTotal > 0 ? Math.round((chunksDone / chunksTotal) * 100) : 0
  const progressPct =
    indexStatus.state === "ready"
      ? 100
      : indexStatus.state === "indexing" && filesTotal > 0
        ? filesPct
        : 0
  const fileCount = indexStatus.state === "ready" ? indexStatus.files : 0
  const chunkCount = indexStatus.state === "ready" && typeof indexStatus.chunks === "number" ? indexStatus.chunks : 0

  return (
    <div className="nexus-section">
      <h3 className="nexus-section-title">Indexing</h3>

      <div className="nexus-panel-block">
        <h4 className="nexus-panel-section-title">
          Codebase Indexing
          <span className="nexus-info-icon" title="Embed codebase for context">ⓘ</span>
        </h4>
        <p className="nexus-panel-section-desc">
          Embed codebase for improved contextual understanding. Embeddings and metadata are stored locally (or in vector DB when enabled).
        </p>
        <div className="nexus-index-progress-wrap">
          {indexStatus.state === "indexing" && (
            <>
              <div className="flex items-center justify-between text-[11px] text-[var(--vscode-descriptionForeground)] mb-1">
                <span>Files scanned</span>
                <span>{filesDone.toLocaleString()} / {filesTotal > 0 ? filesTotal.toLocaleString() : "…"} ({filesPct}%)</span>
              </div>
              <div className="nexus-index-progress-bar">
                <div className="nexus-index-progress-fill" style={{ width: `${filesTotal > 0 ? filesPct : 0}%` }} />
              </div>
              {chunksTotal > 0 && (
                <>
                  <div className="flex items-center justify-between text-[11px] text-[var(--vscode-descriptionForeground)] mb-1 mt-2">
                    <span>Chunks indexed</span>
                    <span>{chunksDone.toLocaleString()} / {chunksTotal.toLocaleString()} ({chunksPct}%)</span>
                  </div>
                  <div className="nexus-index-progress-bar">
                    <div className="nexus-index-progress-fill nexus-index-progress-fill-chunks" style={{ width: `${chunksPct}%` }} />
                  </div>
                </>
              )}
            </>
          )}
          {(indexStatus.state === "idle" || indexStatus.state === "ready" || indexStatus.state === "error") && (
            <>
              <div className="nexus-index-progress-bar">
                <div className="nexus-index-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="nexus-muted text-[11px] mt-1">
                {indexStatus.state === "ready"
                  ? `${fileCount.toLocaleString()} files${chunkCount > 0 ? `, ${chunkCount.toLocaleString()} chunks` : ""} indexed`
                  : indexStatus.state === "error"
                    ? `Error: ${indexStatus.error ?? "unknown"}`
                    : "No index. Click Sync to build."}
              </div>
            </>
          )}
        </div>
        <div className="nexus-index-actions">
          <button type="button" className="nexus-secondary-btn text-xs" onClick={onReindex}>
            Sync
          </button>
          <button type="button" className="nexus-secondary-btn text-xs" onClick={onDeleteIndex}>
            Delete Index
          </button>
        </div>
      </div>

      <div className="nexus-panel-block mt-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h4 className="nexus-panel-section-title">Index new folders</h4>
            <p className="nexus-panel-section-desc">Automatically index new folders with fewer than 50,000 files.</p>
          </div>
          <SettingsToggle
            label=""
            checked={draft.indexingEnabled}
            onChange={(checked) => setDraft({ ...draft, indexingEnabled: checked })}
          />
        </div>
      </div>

      <div className="nexus-panel-block mt-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h4 className="nexus-panel-section-title">Ignore files (.cursorignore and .nexusignore)</h4>
            <p className="nexus-panel-section-desc">Files to exclude from indexing in addition to .gitignore. <button type="button" className="text-[var(--vscode-textLink-foreground)] hover:underline" onClick={onOpenCursorignore}>Edit .cursorignore</button> · <button type="button" className="text-[var(--vscode-textLink-foreground)] hover:underline" onClick={onOpenNexusignore}>Edit .nexusignore</button></p>
          </div>
          <div className="flex gap-1">
            <button type="button" className="nexus-secondary-btn text-xs" onClick={onOpenCursorignore}>
              .cursorignore
            </button>
            <button type="button" className="nexus-secondary-btn text-xs" onClick={onOpenNexusignore}>
              .nexusignore
            </button>
          </div>
        </div>
      </div>

      <details className="mt-3">
        <summary className="nexus-muted text-xs cursor-pointer">Vector DB &amp; advanced</summary>
        <div className="mt-2 space-y-2">
          {vectorDbProgressMessage ? (
            <p className="text-[11px] text-[var(--vscode-descriptionForeground)]">{vectorDbProgressMessage}</p>
          ) : null}
          <SettingsToggle label="Vector index (semantic search)" checked={draft.indexingVector} onChange={(checked) => setDraft({ ...draft, indexingVector: checked })} />
          <SettingsInput label="Vector DB URL (Qdrant)" value={draft.vectorDbUrl} onChange={(v) => setDraft({ ...draft, vectorDbUrl: v })} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="nexus-secondary-btn text-xs"
              onClick={() => postMessage({ type: "startOrConnectVectorDb", url: draft.vectorDbUrl.trim() || "http://127.0.0.1:6333", autoStart: true })}
            >
              Connect / Start Qdrant
            </button>
            <span className="text-[11px] text-[var(--vscode-descriptionForeground)]">Connect to existing or auto-start (binary/Docker)</span>
          </div>
          <SettingsToggle label="Vector DB enabled (use for indexer)" checked={draft.vectorDbEnabled} onChange={(checked) => setDraft({ ...draft, vectorDbEnabled: checked })} />
          <SettingsInput label="Embedding batch size" value={draft.embeddingBatchSize} onChange={(v) => setDraft({ ...draft, embeddingBatchSize: v })} />
        </div>
      </details>
    </div>
  )
}

/** Rules, Skills, Subagents panel (reference layout). */
function RulesSkillsSubagentsView({
  draft,
  setDraft,
  rulesFilter,
  setRulesFilter,
  includeThirdParty,
  setIncludeThirdParty,
  onOpenRulesInstructions,
}: {
  draft: SettingsDraft
  setDraft: React.Dispatch<React.SetStateAction<SettingsDraft>>
  rulesFilter: "all" | "user" | "projects"
  setRulesFilter: (f: "all" | "user" | "projects") => void
  includeThirdParty: boolean
  setIncludeThirdParty: (v: boolean) => void
  onOpenRulesInstructions?: () => void
}) {
  const skillDefinitions = useChatStore((s) => s.skillDefinitions)
  const setInputValue = useChatStore((s) => s.setInputValue)
  const setView = useChatStore((s) => s.setView)

  const rulesFiles = useMemo(() => {
    const fromClaude = draft.claudeMdPath.trim() ? [draft.claudeMdPath.trim()] : []
    const fromText = draft.rulesFilesText.split("\n").map((s) => s.trim()).filter(Boolean)
    return [...fromClaude, ...fromText]
  }, [draft.claudeMdPath, draft.rulesFilesText])

  const skillsList = useMemo(
    () => draft.skillsConfig ?? draft.skillsText.split("\n").map((s) => s.trim()).filter(Boolean).map((p) => ({ path: p, enabled: true })),
    [draft.skillsConfig, draft.skillsText]
  )

  const removeRule = (index: number) => {
    if (index === 0 && draft.claudeMdPath.trim()) {
      setDraft({ ...draft, claudeMdPath: "" })
      return
    }
    const fileIndex = index - (draft.claudeMdPath.trim() ? 1 : 0)
    const lines = draft.rulesFilesText.split("\n").filter((s) => s.trim())
    lines.splice(fileIndex, 1)
    setDraft({ ...draft, rulesFilesText: lines.join("\n") })
  }

  /** Merged list: config paths + discovered from ~/.nexus/skills and .nexus/skills (skillDefinitions not in config). */
  const skillsDisplayList = useMemo(() => {
    const list = skillsList.map((s) => ({ path: typeof s === "string" ? s : s.path, enabled: typeof s === "string" ? true : s.enabled }))
    const pathsSet = new Set(list.map((s) => s.path))
    for (const def of skillDefinitions) {
      if (!pathsSet.has(def.path)) {
        list.push({ path: def.path, enabled: true })
        pathsSet.add(def.path)
      }
    }
    return list
  }, [skillsList, skillDefinitions])

  const removeSkill = (index: number) => {
    const next = skillsDisplayList.filter((_, i) => i !== index)
    setDraft({
      ...draft,
      skillsConfig: next,
      skillsText: next.map((s) => s.path).join("\n"),
    })
  }

  const setSkillEnabled = (index: number, enabled: boolean) => {
    const next = skillsDisplayList.map((s, i) => (i === index ? { ...s, enabled } : s))
    setDraft({
      ...draft,
      skillsConfig: next,
      skillsText: next.map((s) => s.path).join("\n"),
    })
  }

  const addRule = () => {
    const lines = draft.rulesFilesText.split("\n").filter((s) => s.trim())
    setDraft({ ...draft, rulesFilesText: [...lines, ""].join("\n") })
  }

  const addSkill = () => {
    const next = [...skillsList, { path: "", enabled: true }]
    setDraft({
      ...draft,
      skillsConfig: next,
      skillsText: next.map((s) => (typeof s === "string" ? s : s.path)).join("\n"),
    })
  }

  const startCreateSkill = () => {
    setInputValue("/create-skill ")
    setView("chat")
  }

  const RULES_SHOW = 5
  const rulesVisible = rulesFilter === "all" ? rulesFiles : rulesFiles.slice(0, RULES_SHOW)
  const rulesMore = rulesFiles.length - RULES_SHOW
  const skillPath = (s: string | { path: string; enabled: boolean }) => (typeof s === "string" ? s : s.path)
  const skillEnabled = (s: string | { path: string; enabled: boolean }) => (typeof s === "string" ? true : s.enabled)
  const getSkillDef = (path: string) => skillDefinitions.find((d) => d.path === path)

  return (
    <div className="nexus-integrations-block">
      <h3 className="nexus-section-title text-base font-semibold">Skills</h3>
      <p className="nexus-panel-section-desc">Provide domain-specific knowledge and workflows for the agent.</p>

      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <p className="text-xs font-medium">Include third-party Plugins, Skills, and other configs</p>
          <p className="nexus-muted text-[10px]">Automatically import agent configs from other tools.</p>
        </div>
        <label className="nexus-toggle flex-shrink-0">
          <input
            type="checkbox"
            checked={includeThirdParty}
            onChange={(e) => setIncludeThirdParty(e.target.checked)}
          />
          <span />
        </label>
      </div>

      <div className="nexus-panel-block mt-3">
        <div className="nexus-panel-section-title">
          Skills
          <button type="button" className="nexus-secondary-btn text-xs" onClick={startCreateSkill} title="Open chat with /create-skill to describe the new skill">
            + New
          </button>
        </div>
        <p className="nexus-panel-section-desc">
          Skills are specialized capabilities that help the agent accomplish specific tasks. Skills will be invoked when relevant or can be triggered manually with / in chat. Use &quot;+ New&quot; to create a skill in chat via /create-skill.
        </p>
        <div className="flex flex-col gap-1.5">
          {skillsDisplayList.length === 0 ? (
            <div className="nexus-muted text-xs">No skills configured. Add paths in MCP &amp; Skills or edit raw list in Instructions. Use &quot;+ New&quot; to create a skill in chat.</div>
          ) : (
            skillsDisplayList.map((item, i) => {
              const path = skillPath(item)
              const def = getSkillDef(path)
              const name = def?.name ?? path.split("/").filter(Boolean).pop() ?? path
              const summary = def?.summary ?? ""
              const enabled = skillEnabled(item)
              return (
                <div
                  key={i}
                  className="flex items-center gap-2 flex-wrap rounded border border-[var(--vscode-panel-border)] px-2 py-1.5 bg-[var(--vscode-editor-inactiveSelectionBackground)]/20"
                >
                  <label className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => setSkillEnabled(i, e.target.checked)}
                      className="flex-shrink-0"
                    />
                    <div
                      className="min-w-0 flex-1 truncate"
                      onClick={() => postMessage({ type: "openSkillFolder", path })}
                      title="Open folder"
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && postMessage({ type: "openSkillFolder", path })}
                    >
                      <div className="text-xs font-medium truncate">{name}</div>
                      {summary ? (
                        <div className="text-[10px] text-[var(--vscode-descriptionForeground)] line-clamp-2" title={summary}>
                          {summary}
                        </div>
                      ) : (
                        <div className="text-[10px] text-[var(--vscode-descriptionForeground)] truncate">{path}</div>
                      )}
                    </div>
                  </label>
                  <button type="button" className="p-1 text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] flex-shrink-0" onClick={() => removeSkill(i)} title="Remove" aria-label="Remove">
                    <TrashIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

/** MCP server list + marketplace (Cline-style: Marketplace | Remote Servers | Configure). */
function IntegrationsMcpView({
  draft,
  setDraft,
}: {
  draft: SettingsDraft
  setDraft: React.Dispatch<React.SetStateAction<SettingsDraft>>
}) {
  const mcpStatus = useChatStore((s) => s.mcpStatus)
  const [showRaw, setShowRaw] = useState(false)
  const [testing, setTesting] = useState(false)
  const [mcpTab, setMcpTab] = useState<"marketplace" | "remote" | "configure">("marketplace")
  const servers = parseJsonArray(draft.mcpServersJson)
  const statusByName = Object.fromEntries(mcpStatus.map((r) => [r.name, r]))

  // Remote server form state (Cline-style)
  const [remoteName, setRemoteName] = useState("")
  const [remoteUrl, setRemoteUrl] = useState("")
  const [remoteTransport, setRemoteTransport] = useState<"sse" | "http">("sse")
  const [remoteError, setRemoteError] = useState("")

  const updateServers = (next: Array<Record<string, unknown>>) => {
    setDraft((d) => ({ ...d, mcpServersJson: JSON.stringify(next, null, 2) }))
  }

  const removeAt = (index: number) => {
    const next = servers.filter((_, i) => i !== index)
    updateServers(next)
  }

  const setEnabled = (index: number, enabled: boolean) => {
    const next = servers.map((s, i) => (i === index ? { ...s, enabled } : s))
    updateServers(next)
  }

  const addServer = () => {
    updateServers([...servers, { name: "New server", command: "", enabled: true }])
  }

  const addRemoteServer = () => {
    setRemoteError("")
    const name = remoteName.trim()
    const url = remoteUrl.trim()
    if (!name) {
      setRemoteError("Server name is required")
      return
    }
    if (!url) {
      setRemoteError("Server URL is required")
      return
    }
    try {
      new URL(url)
    } catch {
      setRemoteError("Invalid URL format")
      return
    }
    const entry: Record<string, unknown> = {
      name,
      url,
      transport: remoteTransport,
      enabled: true,
    }
    updateServers([...servers, entry])
    setRemoteName("")
    setRemoteUrl("")
    setMcpTab("configure")
  }

  const serverName = (s: Record<string, unknown>) =>
    (s.name as string) || (s.command as string) || "Unnamed"
  const serverCommand = (s: Record<string, unknown>) =>
    [s.command, (s.args as string[])?.join(" ")].filter(Boolean).join(" ") ||
    (s.url as string) ||
    "—"

  return (
    <div className="nexus-integrations-block">
      <div className="flex gap-1 border-b border-[var(--vscode-panel-border)] mb-3 pb-0" style={{ marginBottom: "-1px" }}>
        <button
          type="button"
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${mcpTab === "marketplace" ? "border-[var(--vscode-foreground)] text-[var(--vscode-foreground)]" : "border-transparent text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]"}`}
          onClick={() => setMcpTab("marketplace")}
        >
          Marketplace
        </button>
        <button
          type="button"
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${mcpTab === "remote" ? "border-[var(--vscode-foreground)] text-[var(--vscode-foreground)]" : "border-transparent text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]"}`}
          onClick={() => setMcpTab("remote")}
        >
          Remote Servers
        </button>
        <button
          type="button"
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${mcpTab === "configure" ? "border-[var(--vscode-foreground)] text-[var(--vscode-foreground)]" : "border-transparent text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]"}`}
          onClick={() => setMcpTab("configure")}
        >
          Configure
        </button>
      </div>

      {/* Marketplace (Cline-style) */}
      {mcpTab === "marketplace" && (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-[var(--vscode-descriptionForeground)]">
            Browse and add MCP servers from official and community sources.
          </p>
          <div className="flex flex-col gap-2">
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); postMessage({ type: "openExternal", url: "https://github.com/modelcontextprotocol/servers" }) }}
              className="block px-4 py-3 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-inactiveSelectionBackground)]/30 hover:bg-[var(--vscode-list-hoverBackground)] no-underline text-inherit"
            >
              <span className="font-semibold text-[13px] text-[var(--vscode-foreground)]">GitHub — MCP Servers</span>
              <span className="block text-[12px] text-[var(--vscode-descriptionForeground)] mt-1">Browse community servers</span>
            </a>
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); postMessage({ type: "openExternal", url: "https://registry.modelcontextprotocol.io" }) }}
              className="block px-4 py-3 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-inactiveSelectionBackground)]/30 hover:bg-[var(--vscode-list-hoverBackground)] no-underline text-inherit"
            >
              <span className="font-semibold text-[13px] text-[var(--vscode-foreground)]">MCP Registry</span>
              <span className="block text-[12px] text-[var(--vscode-descriptionForeground)] mt-1">Official registry</span>
            </a>
          </div>
          {/* Submit MCP Server card (Cline-style) */}
          <div
            className="flex flex-col items-center gap-3 py-4 px-4 rounded-md text-center"
            style={{ backgroundColor: "var(--vscode-textBlockQuote-background)" }}
          >
            <i className="codicon codicon-add text-[18px]" />
            <div className="flex flex-col items-center gap-1 max-w-[480px]">
              <h3 className="m-0 text-sm font-semibold text-[var(--vscode-foreground)]">Submit MCP Server</h3>
              <p className="text-[13px] m-0 text-[var(--vscode-descriptionForeground)]">
                Help others discover great MCP servers by submitting an issue to{" "}
                <button
                  type="button"
                  className="text-[var(--vscode-textLink-foreground)] hover:underline bg-transparent border-none cursor-pointer p-0"
                  onClick={() => postMessage({ type: "openExternal", url: "https://github.com/modelcontextprotocol/servers" })}
                >
                  github.com/modelcontextprotocol/servers
                </button>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Remote Servers (Cline-style form) */}
      {mcpTab === "remote" && (
        <div className="p-4 px-5">
          <p className="text-[13px] text-[var(--vscode-foreground)] mb-3">
            Add a remote MCP server by providing a name and its URL endpoint. Learn more{" "}
            <button
              type="button"
              className="text-[var(--vscode-textLink-foreground)] hover:underline bg-transparent border-none cursor-pointer p-0"
              onClick={() => postMessage({ type: "openExternal", url: "https://modelcontextprotocol.io" })}
            >
              here
            </button>
            .
          </p>
          <div className="flex flex-col gap-2 mb-3">
            <label className="text-xs font-medium text-[var(--vscode-foreground)]">Server Name</label>
            <input
              type="text"
              className="nexus-input w-full text-xs"
              placeholder="mcp-server"
              value={remoteName}
              onChange={(e) => { setRemoteName(e.target.value); setRemoteError("") }}
            />
          </div>
          <div className="flex flex-col gap-2 mb-3">
            <label className="text-xs font-medium text-[var(--vscode-foreground)]">Server URL</label>
            <input
              type="text"
              className="nexus-input w-full text-xs"
              placeholder="https://example.com/mcp-server"
              value={remoteUrl}
              onChange={(e) => { setRemoteUrl(e.target.value); setRemoteError("") }}
            />
          </div>
          <div className="flex flex-col gap-2 mb-3">
            <span className="text-xs font-medium text-[var(--vscode-foreground)]">Transport Type</span>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="remoteTransport"
                  checked={remoteTransport === "sse"}
                  onChange={() => setRemoteTransport("sse")}
                  className="rounded-full"
                />
                <span className="text-xs">SSE</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="remoteTransport"
                  checked={remoteTransport === "http"}
                  onChange={() => setRemoteTransport("http")}
                  className="rounded-full"
                />
                <span className="text-xs">HTTP</span>
              </label>
            </div>
          </div>
          {remoteError && (
            <div className="mb-3 text-xs text-[var(--vscode-errorForeground)]">{remoteError}</div>
          )}
          <button type="button" className="nexus-btn nexus-btn-primary w-full text-xs py-2" onClick={addRemoteServer}>
            Add Server
          </button>
          <button
            type="button"
            className="nexus-secondary-btn w-full text-xs py-2 mt-3"
            onClick={() => setMcpTab("configure")}
          >
            Configure MCP Servers
          </button>
        </div>
      )}

      {/* Configure (Cline-style description + server list + test) */}
      {mcpTab === "configure" && (
        <>
          <p className="text-[13px] text-[var(--vscode-foreground)] mb-4 leading-relaxed">
            The{" "}
            <button
              type="button"
              className="text-[var(--vscode-textLink-foreground)] hover:underline bg-transparent border-none cursor-pointer p-0"
              onClick={() => postMessage({ type: "openExternal", url: "https://modelcontextprotocol.io" })}
            >
              Model Context Protocol
            </button>{" "}
            enables communication with locally running MCP servers that provide additional tools and resources to extend
            the agent&apos;s capabilities. You can use{" "}
            <button
              type="button"
              className="text-[var(--vscode-textLink-foreground)] hover:underline bg-transparent border-none cursor-pointer p-0"
              onClick={() => postMessage({ type: "openExternal", url: "https://github.com/modelcontextprotocol/servers" })}
            >
              community-made servers
            </button>{" "}
            or ask the agent to create new tools specific to your workflow (e.g. &quot;add a tool that gets the latest npm docs&quot;).
          </p>

          <div className="flex flex-wrap gap-2 mb-3">
            <button
              type="button"
              className="nexus-btn nexus-btn-primary text-xs py-1.5 px-3"
              onClick={() => postMessage({ type: "openMcpConfig" })}
              title="Open .nexus/mcp-servers.json in editor"
            >
              <span className="codicon codicon-server mr-1.5" />
              Configure MCP Servers
            </button>
            <button
              type="button"
              className="nexus-secondary-btn text-xs py-1.5 px-3"
              disabled={testing || servers.length === 0}
              onClick={() => {
                setTesting(true)
                postMessage({ type: "testMcpServers" })
                setTimeout(() => setTesting(false), 8000)
              }}
              title="Test connectivity of each server"
            >
              <span className="codicon codicon-debug-restart mr-1.5" />
              {testing ? "Testing…" : "Test servers"}
            </button>
          </div>

          <div className="flex flex-col gap-2 mb-3">
            {servers.length === 0 ? (
              <div className="text-xs text-[var(--vscode-descriptionForeground)] py-4 text-center">
                No MCP servers configured. Add entries above or open .nexus/mcp-servers.json. Use the checkbox to enable or disable each server (all its tools).
              </div>
            ) : (
              servers.map((s, i) => {
                const name = serverName(s)
                const status = statusByName[name]
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 flex-wrap rounded border border-[var(--vscode-panel-border)] p-2 bg-[var(--vscode-editor-inactiveSelectionBackground)]/30"
                  >
                    <label className="flex items-center gap-1.5 flex-shrink-0 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(s as Record<string, unknown>).enabled !== false}
                        onChange={(e) => setEnabled(i, e.target.checked)}
                      />
                      <span className="text-xs font-medium truncate max-w-[140px]" title={name}>
                        {name}
                      </span>
                    </label>
                    {status && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${status.status === "ok" ? "bg-green-500/20 text-green-600 dark:text-green-400" : "bg-red-500/20 text-red-600 dark:text-red-400"}`}
                        title={status.error}
                      >
                        {status.status === "ok" ? "OK" : "Error"}
                      </span>
                    )}
                    <span className="text-[10px] font-mono text-[var(--vscode-descriptionForeground)] truncate flex-1 min-w-0" title={serverCommand(s)}>
                      {serverCommand(s)}
                    </span>
                    <button
                      type="button"
                      className="nexus-secondary-btn text-xs py-0.5 px-1.5 flex-shrink-0"
                      onClick={() => removeAt(i)}
                      title="Remove server"
                    >
                      Remove
                    </button>
                  </div>
                )
              })
            )}
          </div>
          <div className="flex flex-wrap gap-2 mb-2">
            <button type="button" className="nexus-secondary-btn text-xs py-1 px-2" onClick={addServer}>
              Add server
            </button>
          </div>
          <div className="mt-4 pt-2 border-t border-[var(--vscode-panel-border)]">
            <button
              type="button"
              className="text-xs text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] bg-transparent border-none cursor-pointer p-0"
              onClick={() => setShowRaw((r) => !r)}
            >
              {showRaw ? "Hide" : "Edit"} raw JSON
            </button>
            {showRaw && (
              <textarea
                value={draft.mcpServersJson}
                rows={6}
                onChange={(e) => setDraft((d) => ({ ...d, mcpServersJson: e.target.value }))}
                className="nexus-input mt-2 w-full font-mono text-[10px] block"
                style={{ fontFamily: "var(--vscode-editor-font-family)" }}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** Skills list + browse link (Cline-style integrations sub-tab). */
function IntegrationsSkillsView({
  draft,
  setDraft,
}: {
  draft: SettingsDraft
  setDraft: React.Dispatch<React.SetStateAction<SettingsDraft>>
}) {
  const skills = draft.skillsText.split("\n")
  const [showRaw, setShowRaw] = useState(false)

  const updateSkills = (lines: string[]) => {
    setDraft((d) => ({ ...d, skillsText: lines.join("\n") }))
  }

  const removeAt = (index: number) => {
    updateSkills(skills.filter((_, i) => i !== index))
  }

  const addPath = () => {
    updateSkills([...skills, ""])
  }

  const setLine = (index: number, value: string) => {
    const next = [...skills]
    next[index] = value
    updateSkills(next)
  }

  return (
    <div className="nexus-integrations-block">
      <p className="nexus-muted text-[10px] mb-2">
        Skills are loaded from paths (files or directories). One path per line.
      </p>
      <div className="flex flex-col gap-2 mb-2">
        {skills.length === 0 ? (
          <div className="nexus-muted text-xs">No skill paths.</div>
        ) : (
          skills.map((path, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded border border-[var(--vscode-panel-border)] p-2 bg-[var(--vscode-editor-inactiveSelectionBackground)]/30"
            >
              <input
                type="text"
                value={path}
                onChange={(e) => setLine(i, e.target.value)}
                placeholder="Path to skill (e.g. .cursor/skills/foo/SKILL.md)"
                className="nexus-input flex-1 min-w-0 text-xs font-mono"
              />
              <button
                type="button"
                className="nexus-secondary-btn text-xs py-0.5 px-1.5 flex-shrink-0"
                onClick={() => removeAt(i)}
                title="Remove"
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
      <div className="flex flex-wrap gap-2 mb-2">
        <button type="button" className="nexus-secondary-btn text-xs" onClick={addPath}>
          Add skill path
        </button>
        <a
          href="https://cursor.com/docs/context/skills"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[var(--vscode-textLink-foreground)] hover:underline"
        >
          Browse skills documentation
        </a>
      </div>
      <label className="nexus-field">
        <span
          className="text-xs cursor-pointer text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]"
          onClick={() => setShowRaw((r) => !r)}
        >
          {showRaw ? "Hide" : "Edit"} raw list
        </span>
        {showRaw && (
          <SettingsTextarea
            label=""
            value={draft.skillsText}
            onChange={(v) => setDraft((d) => ({ ...d, skillsText: v }))}
            rows={4}
          />
        )}
      </label>
    </div>
  )
}

function TabPill({
  id,
  tab,
  setTab,
  label,
}: {
  id: "llm" | "embeddings" | "index" | "tools" | "integrations" | "presets"
  tab: "llm" | "embeddings" | "index" | "tools" | "integrations" | "presets"
  setTab: (tab: "llm" | "embeddings" | "index" | "tools" | "integrations" | "presets") => void
  label: string
}) {
  const active = tab === id
  return (
    <button
      type="button"
      className={`nexus-tab-btn ${active ? "nexus-tab-btn-active" : ""}`}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  )
}

function toDraft(config: NexusConfigState, fallbackProvider: string, fallbackModel: string): SettingsDraft {
  const provider = config.model.provider ?? fallbackProvider
  const baseUrl = config.model.baseUrl ?? ""
  const isOpenRouter = baseUrl.includes("openrouter.ai")
  return {
    modelProvider: isOpenRouter ? "openrouter" : provider,
    modelId: config.model.id ?? fallbackModel,
    modelApiKey: config.model.apiKey ?? "",
    modelBaseUrl: isOpenRouter && baseUrl ? baseUrl : (config.model.baseUrl ?? ""),
    modelTemperature: toInputNumber(config.model.temperature),
    modelReasoningEffort: config.model.reasoningEffort ?? "",
    modelContextWindow: toInputNumber(config.model.contextWindow),
    embProvider: config.embeddings?.provider ?? "openai",
    embModel: config.embeddings?.model ?? "",
    embApiKey: config.embeddings?.apiKey ?? "",
    embBaseUrl: config.embeddings?.baseUrl ?? "",
    embDimensions: toInputNumber(config.embeddings?.dimensions),
    indexingEnabled: Boolean(config.indexing.enabled),
    indexingVector: Boolean(config.indexing.vector),
    embeddingBatchSize: String(config.indexing.embeddingBatchSize ?? 60),
    embeddingConcurrency: String(config.indexing.embeddingConcurrency ?? 2),
    vectorDbEnabled: Boolean(config.vectorDb?.enabled),
    vectorDbUrl: config.vectorDb?.url ?? "http://127.0.0.1:6333",
    vectorDbAutoStart: config.vectorDb?.autoStart ?? true,
    filterTools: config.tools.classifyToolsEnabled === true,
    toolClassifyThreshold: String(
      config.tools.classifyThreshold === 9999 ? 20 : (config.tools.classifyThreshold ?? 20)
    ),
    filterSkills: config.skillClassifyEnabled === true,
    skillClassifyThreshold: String(
      config.skillClassifyThreshold === 9999 ? 20 : (config.skillClassifyThreshold ?? 20)
    ),
    parallelReads: Boolean(config.tools.parallelReads),
    maxParallelReads: String(config.tools.maxParallelReads ?? 5),
    autoApproveRead: config.permissions?.autoApproveRead ?? true,
    autoApproveWrite: config.permissions?.autoApproveWrite ?? false,
    autoApproveCommand: config.permissions?.autoApproveCommand ?? false,
    autoApproveMcp: config.permissions?.autoApproveMcp ?? false,
    autoApproveBrowser: config.permissions?.autoApproveBrowser ?? false,
    autoApproveReadPatternsText: (config.permissions?.autoApproveReadPatterns ?? []).join("\n"),
    allowedCommandsText: (config.permissions?.allowedCommands ?? []).join("\n"),
    allowCommandPatternsText: (config.permissions?.allowCommandPatterns ?? []).join("\n"),
    askCommandPatternsText: (config.permissions?.askCommandPatterns ?? []).join("\n"),
    denyCommandPatternsText: (config.permissions?.denyCommandPatterns ?? []).join("\n"),
    allowedMcpToolsText: (config.permissions?.allowedMcpTools ?? []).join("\n"),
    mcpServersJson: JSON.stringify(config.mcp?.servers ?? [], null, 2),
    skillsConfig: config.skillsConfig ?? (config.skills ?? []).map((p) => ({ path: p, enabled: true })),
    skillsText: (config.skillsConfig ?? (config.skills ?? []).map((p) => ({ path: p, enabled: true }))).map((s) => s.path).join("\n"),
    rulesFilesText: (config.rules?.files ?? []).filter((f) => !/CLAUDE\.md$/i.test(f)).join("\n"),
    claudeMdPath: (config.rules?.files ?? []).find((f) => /CLAUDE\.md$/i.test(f)) ?? "CLAUDE.md",
    agentInstructions: config.modes?.agent?.customInstructions ?? "",
    planInstructions: config.modes?.plan?.customInstructions ?? "",
    askInstructions: config.modes?.ask?.customInstructions ?? "",
    debugInstructions: config.modes?.debug?.customInstructions ?? "",
    reviewInstructions: config.modes?.review?.customInstructions ?? "",
    profilesJson: JSON.stringify(config.profiles ?? {}, null, 2),
    showReasoningInChat: config.ui?.showReasoningInChat ?? false,
  }
}

function getDefaultDraft(): SettingsDraft {
  return {
    modelProvider: "openrouter",
    modelId: "",
    modelApiKey: "",
    modelBaseUrl: "https://openrouter.ai/api/v1",
    modelTemperature: "0.7",
    modelReasoningEffort: "",
    modelContextWindow: "",
    embProvider: "openai",
    embModel: "",
    embApiKey: "",
    embBaseUrl: "",
    embDimensions: "",
    indexingEnabled: true,
    indexingVector: false,
    embeddingBatchSize: "60",
    embeddingConcurrency: "2",
    vectorDbEnabled: false,
    vectorDbUrl: "http://127.0.0.1:6333",
    vectorDbAutoStart: true,
    filterTools: false,
    toolClassifyThreshold: "20",
    filterSkills: false,
    skillClassifyThreshold: "20",
    parallelReads: true,
    maxParallelReads: "5",
    autoApproveRead: true,
    autoApproveWrite: false,
    autoApproveCommand: false,
    autoApproveMcp: false,
    autoApproveBrowser: false,
    autoApproveReadPatternsText: ".nexus/tool-output/**",
    allowedCommandsText: "",
    allowCommandPatternsText: "",
    askCommandPatternsText: "",
    denyCommandPatternsText: "",
    allowedMcpToolsText: "",
    mcpServersJson: "[]",
    skillsText: "",
    rulesFilesText: "",
    claudeMdPath: "CLAUDE.md",
    agentInstructions: "",
    planInstructions: "",
    askInstructions: "",
    debugInstructions: "",
    reviewInstructions: "",
    profilesJson: "{}",
    showReasoningInChat: false,
  }
}

function fromDraft(draft: SettingsDraft): Record<string, unknown> {
  const modelProviderRaw = draft.modelProvider.trim() || "anthropic"
  const modelProvider = modelProviderRaw === "openrouter" ? "openai-compatible" : modelProviderRaw
  const modelBaseUrl = draft.modelBaseUrl.trim()
  const normalizedBaseUrl =
    modelProviderRaw === "openrouter"
      ? (modelBaseUrl || "https://openrouter.ai/api/v1")
      : (modelBaseUrl || undefined)
  const modelTemperature = parseNumber(draft.modelTemperature)
  const modelReasoningEffort = draft.modelReasoningEffort.trim() || undefined
  const modelContextWindow = parseIntOrUndefined(draft.modelContextWindow)
  const embDimensions = parseIntOrUndefined(draft.embDimensions)
  const embProviderRaw = draft.embProvider.trim() || "openai"
  const embProvider = embProviderRaw
  const embBaseUrlRaw = draft.embBaseUrl.trim()
  const embBaseUrl =
    embProvider === "openrouter"
      ? (isLikelyHttpUrl(embBaseUrlRaw) ? embBaseUrlRaw : "https://openrouter.ai/api/v1")
      : embProvider === "openai-compatible"
        ? (isLikelyHttpUrl(embBaseUrlRaw) ? embBaseUrlRaw : undefined)
        : (embBaseUrlRaw || undefined)
  const toolThresholdRaw = parsePositiveInt(draft.toolClassifyThreshold, 20)
  const skillThresholdRaw = parsePositiveInt(draft.skillClassifyThreshold, 20)
  const mcpServers = parseJsonArray(draft.mcpServersJson)
  const skillsConfig = draft.skillsConfig ?? linesToList(draft.skillsText).map((p) => ({ path: p, enabled: true }))
  const skills = skillsConfig.filter((s) => s.enabled).map((s) => s.path)
  const ruleFiles = linesToList(draft.rulesFilesText)
  const claudePath = draft.claudeMdPath.trim()
  const parsedProfiles = parseJsonObject(draft.profilesJson)

  return {
    model: {
      provider: modelProvider,
      id: draft.modelId.trim() || "claude-sonnet-4-5",
      apiKey: draft.modelApiKey.trim() || undefined,
      baseUrl: normalizedBaseUrl,
      temperature: modelTemperature,
      reasoningEffort: modelReasoningEffort,
      contextWindow: modelContextWindow,
    },
    embeddings: draft.embModel.trim()
      ? {
          provider: embProvider as "openai" | "openai-compatible" | "openrouter" | "ollama" | "google" | "mistral" | "bedrock" | "local",
          model: draft.embModel.trim(),
          apiKey: draft.embApiKey.trim() || undefined,
          baseUrl: embBaseUrl,
          dimensions: embDimensions,
        }
      : undefined,
    indexing: {
      enabled: draft.indexingEnabled,
      vector: draft.indexingVector,
      embeddingBatchSize: parsePositiveInt(draft.embeddingBatchSize, 60),
      embeddingConcurrency: parsePositiveInt(draft.embeddingConcurrency, 2),
    },
    vectorDb: {
      enabled: draft.vectorDbEnabled,
      url: draft.vectorDbUrl.trim() || "http://127.0.0.1:6333",
      collection: "nexus",
      autoStart: draft.vectorDbAutoStart,
    },
    tools: {
      classifyToolsEnabled: draft.filterTools,
      classifyThreshold: draft.filterTools ? toolThresholdRaw : 9999,
      parallelReads: draft.parallelReads,
      maxParallelReads: parsePositiveInt(draft.maxParallelReads, 5),
      custom: [],
    },
    permissions: {
      autoApproveRead: draft.autoApproveRead,
      autoApproveWrite: draft.autoApproveWrite,
      autoApproveCommand: draft.autoApproveCommand,
      autoApproveMcp: draft.autoApproveMcp,
      autoApproveBrowser: draft.autoApproveBrowser,
      autoApproveReadPatterns: linesToList(draft.autoApproveReadPatternsText),
      allowedCommands: linesToList(draft.allowedCommandsText),
      allowCommandPatterns: linesToList(draft.allowCommandPatternsText),
      askCommandPatterns: linesToList(draft.askCommandPatternsText),
      denyCommandPatterns: linesToList(draft.denyCommandPatternsText),
      allowedMcpTools: linesToList(draft.allowedMcpToolsText),
    },
    skillClassifyEnabled: draft.filterSkills,
    skillClassifyThreshold: draft.filterSkills ? skillThresholdRaw : 9999,
    mcp: {
      servers: mcpServers,
    },
    skillsConfig,
    skills,
    rules: {
      files: [...(claudePath ? [claudePath] : []), ...ruleFiles],
    },
    modes: {
      agent: { customInstructions: draft.agentInstructions.trim() || undefined },
      plan: { customInstructions: draft.planInstructions.trim() || undefined },
      ask: { customInstructions: draft.askInstructions.trim() || undefined },
      debug: { customInstructions: draft.debugInstructions.trim() || undefined },
      review: { customInstructions: draft.reviewInstructions.trim() || undefined },
    },
    ui: { showReasoningInChat: draft.showReasoningInChat },
    profiles: parsedProfiles,
  }
}

function parseJsonArray(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value || "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v) => v && typeof v === "object") as Array<Record<string, unknown>>
  } catch {
    return []
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function linesToList(value: string): string[] {
  return value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function isLikelyHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function parseNumber(value: string): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return Math.max(0, Math.min(2, n))
}

function parseIntOrUndefined(value: string): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

function parsePositiveInt(value: string, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function toInputNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : ""
}

function SettingsInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: "text" | "password"
}) {
  return (
    <label className="nexus-field">
      <span className="nexus-field-label">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="nexus-input"
      />
    </label>
  )
}

function SettingsSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<string | { value: string; label: string }>
}) {
  return (
    <label className="nexus-field">
      <span className="nexus-field-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="nexus-input">
        {options.map((opt) => {
          const value = typeof opt === "string" ? opt : opt.value
          const label = typeof opt === "string" ? opt : opt.label
          return <option key={value || "__empty__"} value={value}>{label}</option>
        })}
      </select>
    </label>
  )
}

function SettingsTextarea({
  label,
  value,
  onChange,
  rows = 4,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  rows?: number
}) {
  return (
    <label className="nexus-field">
      <span className="nexus-field-label">{label}</span>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="nexus-input"
        style={{ fontFamily: "var(--vscode-editor-font-family, var(--vscode-font-family))" }}
      />
    </label>
  )
}

function SettingsToggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="nexus-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      className={`nexus-tab-btn ${active ? "nexus-tab-btn-active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function IndexProgress({
  status,
}: {
  status: { progress: number; total: number; chunksProcessed?: number; chunksTotal?: number }
}) {
  const progress = status.progress
  const total = status.total
  const filesPct = total > 0 ? Math.max(0, Math.min(100, Math.floor((progress / total) * 100))) : 0
  const chunksTotal = typeof status.chunksTotal === "number" ? status.chunksTotal : 0
  const chunksDone = typeof status.chunksProcessed === "number" ? status.chunksProcessed : 0
  const chunksPct = chunksTotal > 0 ? Math.max(0, Math.min(100, Math.floor((chunksDone / chunksTotal) * 100))) : 0
  return (
    <div className="px-3 py-1 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="flex items-center justify-between text-[10px] text-[var(--vscode-descriptionForeground)] mb-1">
        <span>Files scanned</span>
        <span>{progress}/{total} ({filesPct}%)</span>
      </div>
      <div className="w-full h-1 rounded-full bg-[var(--vscode-progressBar-background)]/30 overflow-hidden">
        <div
          className="h-full bg-[var(--nexus-accent)] transition-all duration-200"
          style={{ width: `${filesPct}%` }}
        />
      </div>
      {chunksTotal > 0 && (
        <>
          <div className="flex items-center justify-between text-[10px] text-[var(--vscode-descriptionForeground)] mt-1 mb-1">
            <span>Chunks indexed</span>
            <span>{chunksDone}/{chunksTotal} ({chunksPct}%)</span>
          </div>
          <div className="w-full h-1 rounded-full bg-[var(--vscode-progressBar-background)]/30 overflow-hidden">
            <div
              className="h-full transition-all duration-200"
              style={{ width: `${chunksPct}%`, background: "var(--vscode-charts-green, #89d185)" }}
            />
          </div>
        </>
      )}
    </div>
  )
}

function IndexBadge({ status }: { status: { state: string } }) {
  if (status.state === "ready") {
    return <span className="nexus-badge nexus-badge-ok">indexed</span>
  }
  if (status.state === "indexing") {
    return <span className="nexus-badge nexus-badge-warn">indexing</span>
  }
  if (status.state === "error") {
    return <span className="nexus-badge nexus-badge-err">index error</span>
  }
  return <span className="nexus-badge">index off</span>
}

function formatTokens(value: number): string {
  const n = Math.max(0, Math.floor(value))
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function AgentPresetCreateModal({
  name,
  setName,
  vector,
  setVector,
  options,
  selectedSkills,
  setSelectedSkills,
  selectedMcp,
  setSelectedMcp,
  selectedRules,
  setSelectedRules,
  onSave,
  onClose,
}: {
  name: string
  setName: (v: string) => void
  vector: boolean
  setVector: (v: boolean) => void
  options: { skills: string[]; mcpServers: string[]; rulesFiles: string[] } | null
  selectedSkills: Set<string>
  setSelectedSkills: (s: Set<string>) => void
  selectedMcp: Set<string>
  setSelectedMcp: (s: Set<string>) => void
  selectedRules: Set<string>
  setSelectedRules: (s: Set<string>) => void
  onSave: () => void
  onClose: () => void
}) {
  const toggleSkill = (item: string) => {
    const next = new Set(selectedSkills)
    if (next.has(item)) next.delete(item)
    else next.add(item)
    setSelectedSkills(next)
  }
  const toggleMcp = (item: string) => {
    const next = new Set(selectedMcp)
    if (next.has(item)) next.delete(item)
    else next.add(item)
    setSelectedMcp(next)
  }
  const toggleRule = (item: string) => {
    const next = new Set(selectedRules)
    if (next.has(item)) next.delete(item)
    else next.add(item)
    setSelectedRules(next)
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-label="Create agent preset"
    >
      <div
        className="bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] rounded-lg shadow-xl max-w-xl w-full max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--vscode-panel-border)]">
          <h3 className="text-sm font-semibold text-[var(--vscode-foreground)]">New agent preset</h3>
          <button type="button" onClick={onClose} className={BTN_CLASS} aria-label="Close">×</button>
        </div>
        <div className="p-3 space-y-3 overflow-y-auto min-h-0 flex-1">
          <label className="nexus-field block">
            <span className="nexus-field-label">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="preset-name"
              className="nexus-input w-full text-sm"
            />
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={vector} onChange={(e) => setVector(e.target.checked)} />
            <span className="text-xs text-[var(--vscode-foreground)]">Vector search on</span>
          </label>
          {!options ? (
            <p className="nexus-muted text-xs">Loading skills, MCP servers, and rules…</p>
          ) : (
            <>
              <div>
                <h4 className="text-xs font-semibold text-[var(--vscode-foreground)] mb-1.5">Skills</h4>
                <div className="max-h-32 overflow-y-auto rounded border border-[var(--vscode-panel-border)] p-1.5 space-y-1">
                  {options.skills.length === 0 ? (
                    <p className="nexus-muted text-[10px]">No skills discovered.</p>
                  ) : (
                    options.skills.map((item) => (
                      <label key={item} className="flex items-center gap-2 cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)] rounded px-1.5 py-0.5">
                        <input type="checkbox" checked={selectedSkills.has(item)} onChange={() => toggleSkill(item)} />
                        <span className="text-[11px] font-mono truncate text-[var(--vscode-foreground)]" title={item}>{item}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-[var(--vscode-foreground)] mb-1.5">MCP servers</h4>
                <div className="max-h-24 overflow-y-auto rounded border border-[var(--vscode-panel-border)] p-1.5 space-y-1">
                  {options.mcpServers.length === 0 ? (
                    <p className="nexus-muted text-[10px]">No MCP servers in config.</p>
                  ) : (
                    options.mcpServers.map((item) => (
                      <label key={item} className="flex items-center gap-2 cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)] rounded px-1.5 py-0.5">
                        <input type="checkbox" checked={selectedMcp.has(item)} onChange={() => toggleMcp(item)} />
                        <span className="text-[11px] truncate text-[var(--vscode-foreground)]" title={item}>{item}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-[var(--vscode-foreground)] mb-1.5">Rules (AGENTS.md, CLAUDE.md, …)</h4>
                <div className="max-h-24 overflow-y-auto rounded border border-[var(--vscode-panel-border)] p-1.5 space-y-1">
                  {options.rulesFiles.length === 0 ? (
                    <p className="nexus-muted text-[10px]">No rule files.</p>
                  ) : (
                    options.rulesFiles.map((item) => (
                      <label key={item} className="flex items-center gap-2 cursor-pointer hover:bg-[var(--vscode-list-hoverBackground)] rounded px-1.5 py-0.5">
                        <input type="checkbox" checked={selectedRules.has(item)} onChange={() => toggleRule(item)} />
                        <span className="text-[11px] font-mono truncate text-[var(--vscode-foreground)]" title={item}>{item}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[var(--vscode-panel-border)]">
          <button type="button" className="nexus-secondary-btn text-xs" onClick={onClose}>Cancel</button>
          <button type="button" className="nexus-primary-btn text-xs" onClick={onSave} disabled={!name.trim() || !options}>Save preset</button>
        </div>
      </div>
    </div>
  )
}

function CompactIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  )
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 01-9 9 9.75 9.75 0 01-6.74-2.74L3 16" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 009 9 9.75 9.75 0 006.74-2.74L21 8" />
      <path d="M21 21v-5h-5" />
    </svg>
  )
}

function DatabaseOffIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0018 0V5" />
      <path d="M3 12a9 3 0 006 2.25 9 3 0 006-2.25" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  )
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  )
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function EllipsisIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="6" cy="12" r="1.5" />
      <circle cx="18" cy="12" r="1.5" />
    </svg>
  )
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  )
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  )
}

/** Ring that fills from 0 to 100% with context usage (progress). */
function ContextRingIcon({ className, percent = 0 }: { className?: string; percent?: number }) {
  const r = 9
  const circumference = 2 * Math.PI * r
  const clamped = Math.min(100, Math.max(0, Number(percent)))
  const offset = circumference * (1 - clamped / 100)
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle
        cx="12"
        cy="12"
        r={r}
        className="nexus-context-ring-bg"
        strokeDasharray={circumference}
        strokeDashoffset={0}
        transform="rotate(-90 12 12)"
      />
      <circle
        cx="12"
        cy="12"
        r={r}
        className="nexus-context-ring-fill"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 12 12)"
      />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  )
}
