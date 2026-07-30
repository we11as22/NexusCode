import React, { useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  useChatStore,
  type AgentEvent,
  type IndexStatusKind,
  type NexusConfigState,
  type MessagePart,
} from "./stores/chat.js"
import { MessageList } from "./components/MessageList.js"
import { InputBar } from "./components/InputBar.js"
import { ImageIcon } from "./components/AttachedImagesStrip.js"
import { InputContextPanel } from "./components/InputContextPanel.js"
import { QueuedMessagesPanel } from "./components/QueuedMessagesPanel.js"
import { ModeDropdown } from "./components/ModeDropdown.js"
import { AgentPresetDropdown } from "./components/AgentPresetDropdown.js"
import { ProgressTodoBlock } from "./components/ProgressTodoBlock.js"
import { RuntimeActivityPanel } from "./components/RuntimeActivityPanel.js"
import { Questionnaire } from "./components/questionnaire/Questionnaire.js"
import type { AutocompleteExtensionUiState, ExtensionMessage } from "./types/messages.js"
import { confirmAsync, resolveConfirm, postMessage } from "./vscode.js"
import { MarketplacePanel } from "./components/marketplace/MarketplacePanel.js"
import { createExtensionMessageBuffer } from "./bridge/message-buffer.js"
import {
  visibleSessionTabs,
} from "./components/session-tab-policy.js"
import {
  SESSION_HISTORY_PAGE_SIZE,
  visibleSessionHistory,
} from "./components/session-history-policy.js"
import { planKeyboardAction } from "./components/plan-keyboard-policy.js"
import {
  planFollowupAction,
  PLAN_FOLLOWUP_OPTIONS,
} from "./components/plan-followup-policy.js"
import { ProjectAuthorityRequestCard } from "./components/ProjectAuthorityRequestCard.js"
import { sessionDisplayTitle } from "./utils/session-label.js"

const ICON_CLASS = "w-4 h-4 flex-shrink-0"
const BTN_CLASS =
  "p-1.5 rounded-md text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
const BTN_SM_CLASS =
  "p-1 rounded text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
const MODEL_PROVIDER_OPTIONS = ["anthropic", "openai", "google", "openai-compatible", "openrouter", "ollama", "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras", "cohere", "togetherai", "perplexity", "minimax"]

const DEFAULT_AUTOCOMPLETE_UI: AutocompleteExtensionUiState = {
  enableAutoTrigger: true,
  useSeparateModel: false,
  modelProvider: "",
  modelId: "",
  modelApiKey: "",
  hasModelApiKey: false,
  modelBaseUrl: "",
  modelTemperature: "0.2",
  modelReasoningEffort: "",
  modelContextWindow: "",
}
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
  const messageBufferRef = useRef<ReturnType<typeof createExtensionMessageBuffer> | null>(null)

  useEffect(() => {
    const messageBuffer = createExtensionMessageBuffer(store)
    messageBufferRef.current = messageBuffer

    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionMessage
      if (!msg?.type) return

      switch (msg.type) {
        case "agentEvent": {
          const ev = msg.event as AgentEvent
          if (ev.type === "index_update" && ev && typeof (ev as { status?: unknown }).status === "object") {
            messageBuffer.enqueue({
              ...(msg as ExtensionMessage),
              type: "indexStatus",
              status: (ev as { status: IndexStatusKind }).status,
            } as ExtensionMessage)
            return
          }
          break
        }
        case "pendingApproval":
          if ("partId" in msg && "action" in msg) store.handlePendingApproval(msg.partId, msg.action)
          return
        case "confirmResult":
          if ("id" in msg && "ok" in msg) resolveConfirm(msg.id, msg.ok)
          return
        default:
          break
      }
      messageBuffer.enqueue(msg)
    }

    window.addEventListener("message", handler)
    postMessage({ type: "getState" })
    postMessage({ type: "webviewDidLaunch" })
    return () => {
      window.removeEventListener("message", handler)
      messageBuffer.dispose()
      messageBufferRef.current = null
    }
  }, [])

  return (
    <div className="container">
      <SessionTabBar />

      {store.vectorDbProgressMessage && (
        <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-badge-background)] text-[11px] text-[var(--vscode-descriptionForeground)]">
          {store.vectorDbProgressMessage}
        </div>
      )}

      {store.configurationError && (
        <div className="flex-shrink-0 px-3 py-2 border-b border-[var(--vscode-errorForeground)] bg-[var(--vscode-inputValidation-errorBackground)] text-[11px] text-[var(--vscode-errorForeground)]">
          <div className="whitespace-pre-wrap break-words">
            {store.configurationError}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="px-2 py-1 rounded border border-current hover:bg-[var(--vscode-list-hoverBackground)]"
              disabled={store.isRunning}
              onClick={() => postMessage({ type: "reloadConfiguration" })}
            >
              Reload configuration
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded border border-current hover:bg-[var(--vscode-list-hoverBackground)]"
              onClick={() => postMessage({ type: "openNexusConfigFolder", scope: "project" })}
            >
              Open project config
            </button>
            <button
              type="button"
              className="px-2 py-1 rounded border border-current hover:bg-[var(--vscode-list-hoverBackground)]"
              onClick={() => postMessage({ type: "openNexusConfigFolder", scope: "global" })}
            >
              Open global config
            </button>
          </div>
        </div>
      )}

      {store.toolContributionDiagnostics.length > 0 && (
        <details className="flex-shrink-0 px-3 py-2 border-b border-[var(--vscode-inputValidation-warningBorder)] bg-[var(--vscode-inputValidation-warningBackground)] text-[11px] text-[var(--vscode-foreground)]">
          <summary className="cursor-pointer select-none">
            Custom/plugin tools: {store.toolContributionDiagnostics.length} diagnostic
            {store.toolContributionDiagnostics.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-1.5 space-y-1">
            {store.toolContributionDiagnostics.map((diagnostic, index) => (
              <div
                key={`${diagnostic.code}:${diagnostic.source}:${diagnostic.toolName ?? ""}:${index}`}
                className="whitespace-pre-wrap break-words"
              >
                [{diagnostic.level}] {diagnostic.code} · {diagnostic.source}
                {diagnostic.toolName ? ` · ${diagnostic.toolName}` : ""}:{" "}
                {diagnostic.message}
              </div>
            ))}
          </div>
        </details>
      )}

      {store.connectionState !== "idle" && store.serverUrl && (
        <div
          className={`flex-shrink-0 px-3 py-1.5 border-b text-[11px] ${
            store.connectionState === "error"
              ? "border-[var(--vscode-errorForeground)] bg-[var(--vscode-inputValidation-errorBackground)] text-[var(--vscode-errorForeground)]"
              : "border-[var(--vscode-panel-border)] bg-[var(--vscode-badge-background)] text-[var(--vscode-descriptionForeground)]"
          }`}
        >
          {store.connectionState === "connecting" && "Connecting to server…"}
          {store.connectionState === "streaming" && "Streaming…"}
          {store.connectionState === "error" && (store.serverConnectionError ?? "Connection error. Send again to retry.")}
        </div>
      )}

      <div className="nexus-main flex-1 min-h-0 overflow-hidden flex flex-col">
      {store.view === "chat" && <ChatView />}
      {store.view === "sessions" && <SessionsView />}
      {store.view === "settings" && (
        <SettingsView
          initialTab={store.initialSettingsTab}
          initialIntegTab={store.initialSettingsIntegTab}
          onInitialTabApplied={store.clearInitialSettingsTab}
        />
      )}
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

  return (
    <>
      {store.awaitingApproval && !store.pendingApproval && (
        <div className="nexus-approval-banner">
          <span className="nexus-approval-icon">⚠</span>
          <span>Action awaiting your approval — use notification or chat buttons: Allow once / Always allow / Deny / Allow all (session) / Say what to do instead.</span>
        </div>
      )}

      <div className="chat-view">
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
        <RuntimeActivityPanel tasks={store.runtimeTasks} />

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
  const pendingQuestion = store.pendingQuestionRequest
  const planText = (store.planFollowupText ?? "").trim()
  const showPlanFollowupSlot =
    store.mode === "plan" &&
    store.planCompleted &&
    planText.length > 0
  const hideChatInput = Boolean(pendingQuestion || showPlanFollowupSlot)
  const canSend =
    !store.configurationError &&
    !store.isRunning &&
    !store.awaitingApproval &&
    (store.inputValue.trim().length > 0 || store.attachedImages.length > 0)
  const canQueue =
    !store.configurationError &&
    store.isRunning &&
    !store.awaitingApproval &&
    (store.inputValue.trim().length > 0 || store.attachedImages.length > 0)
  const contextPercent = store.contextPercent
  const contextSourceLabel =
    store.contextSource === "provider"
      ? "provider measured"
      : store.contextSource === "hybrid"
        ? "provider measured + estimated pending turn"
        : "estimated"
  const contextTitle =
    store.contextLimitTokens > 0
      ? `${formatTokens(store.contextUsedTokens)}/${formatTokens(store.contextLimitTokens)} tokens (${Math.round(contextPercent)}%) · ${contextSourceLabel}`
      : `${formatTokens(store.contextUsedTokens)}/— tokens · model context window unknown · ${contextSourceLabel}`

  const planChoice = (
    choice: "implement" | "revise" | "abandon",
    planTextArg?: string,
    instruction?: string,
    newSession?: boolean,
  ) => {
    store.collapsePlanPanel()
    postMessage({
      type: "planFollowupChoice",
      choice,
      planText: planTextArg ?? undefined,
      instruction: instruction ?? undefined,
      ...(newSession ? { newSession: true } : {}),
    })
  }

  return (
    <div className="chat-input-inner">
      {pendingQuestion ? (
        <div className="chat-input-area nexus-questionnaire-input-area">
          <Questionnaire
            request={pendingQuestion}
            onDismiss={() => {
              postMessage({ type: "dismissQuestionnaire", requestId: pendingQuestion.requestId })
              store.clearPendingQuestionRequest()
            }}
            onSubmit={(answers) => {
              postMessage({ type: "questionnaireResponse", requestId: pendingQuestion.requestId, answers })
              store.clearPendingQuestionRequest()
            }}
          />
        </div>
      ) : showPlanFollowupSlot ? (
        <div className="chat-input-area nexus-plan-panel-input-area">
          <PlanActionsBar
            planFollowupText={store.planFollowupText}
            collapsed={store.planPanelCollapsed}
            onExpand={() => store.expandPlanPanel()}
            onMinimize={() => store.collapsePlanPanel()}
            onChoice={planChoice}
          />
        </div>
      ) : (
        <div className="chat-input-area">
          <InputBar registerImagePickerTrigger={registerImagePickerTrigger} />
        </div>
      )}
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
            title={contextTitle}
            aria-label={`Context: ${contextTitle}`}
          >
            <ContextRingIcon className="w-4 h-4" percent={contextPercent} />
          </button>
          {!hideChatInput ? (
            <button
              type="button"
              className="nexus-image-pick-btn"
              onClick={() => imagePickerTrigger?.()}
              title="Attach image"
              aria-label="Attach image"
            >
              <ImageIcon className="w-4 h-4" />
            </button>
          ) : null}
          {store.isRunning || store.awaitingApproval ? (
            <>
              {canQueue ? (
                <button
                  type="button"
                  onClick={() => store.addToQueue(store.inputValue)}
                  title="Queue follow-up (Enter)"
                  aria-label="Queue follow-up"
                  className="nexus-send-btn nexus-send-btn-primary"
                >
                  <SendIcon />
                </button>
              ) : null}
              <button
                type="button"
                onClick={store.abort}
                title="Stop (Esc)"
                aria-label="Stop active run"
                className="nexus-send-btn nexus-send-btn-stop"
              >
                <StopIcon />
              </button>
            </>
          ) : hideChatInput ? (
            <span className="w-8 h-8 flex-shrink-0" aria-hidden />
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
  const [query, setQuery] = useState("")
  const [visibleCount, setVisibleCount] = useState(SESSION_HISTORY_PAGE_SIZE)
  const visibleHistory = useMemo(
    () =>
      visibleSessionHistory(sessions, {
        query,
        visibleCount,
        activeSessionId: sessionId,
      }),
    [sessions, query, visibleCount, sessionId],
  )

  const handleDelete = async (e: React.MouseEvent, s: { id: string; title?: string }) => {
    e.stopPropagation()
    const label = sessionDisplayTitle(s)
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
      <label className="nexus-session-search mt-2">
        <span className="sr-only">Search sessions</span>
        <span className="codicon codicon-search nexus-session-search-icon" aria-hidden />
        <input
          type="search"
          className="nexus-input nexus-session-search-input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setVisibleCount(SESSION_HISTORY_PAGE_SIZE)
          }}
          placeholder="Search conversations…"
          autoComplete="off"
        />
      </label>
      {sessionsLoading && (
        <div className="nexus-loading-dots flex items-center gap-2 py-4 text-[var(--vscode-descriptionForeground)] text-sm">
          <span className="nexus-dot" />
          <span className="nexus-dot" />
          <span className="nexus-dot" />
          <span className="ml-1">Loading...</span>
        </div>
      )}
      {!sessionsLoading && visibleHistory.totalMatches === 0 && (
        <div className="nexus-muted text-xs mt-2">
          {query.trim() ? "No matching conversations." : "No saved sessions yet."}
        </div>
      )}

      <div className="flex flex-col gap-2 mt-2">
        {visibleHistory.sessions.map((s) => {
          const isActive = s.id === sessionId
          const date = new Date(s.ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
          const title = sessionDisplayTitle(s).slice(0, 80)
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
      {visibleHistory.hasMore && (
        <button
          type="button"
          className="nexus-secondary-btn mt-2"
          onClick={() => setVisibleCount((count) => count + SESSION_HISTORY_PAGE_SIZE)}
        >
          Show {Math.min(
            SESSION_HISTORY_PAGE_SIZE,
            visibleHistory.totalMatches - visibleCount,
          )} more
        </button>
      )}
    </div>
  )
}

/** Cursor-style open-chat strip. History and deletion remain separate concerns. */
function SessionTabBar() {
  const store = useChatStore()
  const {
    sessions,
    openSessionIds,
    sessionId,
    switchSession,
    closeSessionTab,
    createNewSession,
    setView,
    view,
  } = store
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

  const displaySessions = visibleSessionTabs(
    sessions,
    openSessionIds,
    sessionId,
  )

  const handleClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    closeSessionTab(id)
  }

  return (
    <div className="nexus-session-tab-bar">
      <div className="nexus-session-tab-bar-scroll" role="tablist">
        {displaySessions.map((s) => {
          const isActive = s.id === sessionId
          const title = sessionDisplayTitle(s).slice(0, 40)
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
                onClick={() => {
                  setView("chat")
                  switchSession(s.id)
                }}
              >
                {title}
              </button>
              <button
                type="button"
                className="nexus-session-tab-close"
                onClick={(e) => handleClose(e, s.id)}
                title="Close chat"
                aria-label={`Close ${title}`}
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
        <button
          type="button"
          className={`nexus-session-tab-add ${view === "sessions" ? "nexus-session-tab-action-active" : ""}`}
          onClick={() => setView("sessions")}
          title="Session history"
          aria-label="Session history"
        >
          <HistoryIcon className="w-3.5 h-3.5" />
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
            <div className="nexus-session-tab-dropdown nexus-session-actions-menu">
              <button
                type="button"
                className="nexus-session-tab-dropdown-item"
                onClick={() => {
                  setView("sessions")
                  setDropdownOpen(false)
                }}
              >
                Session history
              </button>
              <button
                type="button"
                className="nexus-session-tab-dropdown-item"
                onClick={() => {
                  setView("settings")
                  setDropdownOpen(false)
                }}
              >
                Settings
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** PlanExit completed: render the plan artifact and its explicit decision UI. */
export function PlanActionsBar({
  planFollowupText,
  collapsed,
  onChoice,
  onExpand,
  onMinimize,
}: {
  planFollowupText: string | null
  collapsed: boolean
  onChoice: (choice: "implement" | "revise" | "abandon", planText?: string, instruction?: string, newSession?: boolean) => void
  onExpand: () => void
  onMinimize: () => void
}) {
  const [showMore, setShowMore] = useState(false)
  const [selected, setSelected] = useState<"implement" | "revise">("implement")
  const [instruction, setInstruction] = useState("")
  const fullText = (planFollowupText ?? "").trim()
  const lines = fullText.split(/\r?\n/)
  const collapsedLineLimit = 12
  const expandedLineLimit = 220
  const collapsedNeedsClamp = lines.length > collapsedLineLimit || fullText.length > 1100
  const expandedNeedsClamp = lines.length > expandedLineLimit || fullText.length > 18000
  const renderedText = collapsed
    ? (collapsedNeedsClamp ? `${lines.slice(0, collapsedLineLimit).join("\n")}\n\n…` : fullText)
    : (!expandedNeedsClamp || showMore ? fullText : `${lines.slice(0, expandedLineLimit).join("\n")}\n\n…`)
  const mdSource = renderedText || "Plan saved to .nexus/plans/."
  const canSubmit =
    selected !== "revise" || instruction.trim().length > 0

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const action = planKeyboardAction({
        key: event.key,
        targetTag: target?.tagName,
        targetEditable: target?.isContentEditable,
        canSubmit,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      })
      if (action === "none") return
      event.preventDefault()
      if (action === "dismiss") {
        onChoice("abandon")
        return
      }
      if (typeof action === "object") {
        setSelected(action.select === 0 ? "implement" : "revise")
        return
      }
      const decision = planFollowupAction(selected, instruction)
      if (!decision) return
      onChoice(
        decision.choice,
        planFollowupText ?? undefined,
        "instruction" in decision ? decision.instruction : undefined,
        false,
      )
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [canSubmit, instruction, onChoice, planFollowupText, selected])

  return (
    <div className="nexus-plan-followup-wrap nexus-plan-followup-wrap--input-slot">
      <div className={`nexus-plan-followup-card${collapsed ? " nexus-plan-followup-card--collapsed" : ""}`}>
        <div className="nexus-plan-followup-header">
          <span className="nexus-plan-followup-title">Plan</span>
          {!collapsed ? (
            <div className="nexus-plan-followup-actions">
              <button type="button" className="nexus-plan-mini-btn" onClick={() => onMinimize()} title="Collapse plan preview">
                Collapse
              </button>
              {expandedNeedsClamp ? (
                <button
                  type="button"
                  className="nexus-plan-mini-btn"
                  onClick={() => setShowMore((v) => !v)}
                >
                  {showMore ? "Less" : "More"}
                </button>
              ) : null}
              <button
                type="button"
                className="nexus-plan-mini-btn"
                onClick={() => onChoice("implement", planFollowupText ?? undefined, undefined, true)}
              >
                Implement in new session
              </button>
            </div>
          ) : null}
        </div>
        <div className={`nexus-plan-followup-text-shell${collapsed ? " nexus-plan-followup-text-shell--collapsed" : ""}`}>
          <div className={`nexus-plan-followup-text nexus-plan-followup-markdown prose-nexus text-[11px] leading-snug overflow-y-auto overflow-x-hidden px-2 py-2${collapsed ? " nexus-plan-followup-text--collapsed" : ""}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{mdSource}</ReactMarkdown>
          </div>
          {collapsed ? (
            <div className="nexus-plan-followup-expand-row">
              <button type="button" className="nexus-plan-expand-btn" onClick={onExpand}>
                Expand plan
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="nexus-plan-followup-question">Implement this plan?</div>
      <div className="nexus-plan-followup-options">
        {PLAN_FOLLOWUP_OPTIONS.map((option, index) => (
          <button
            key={option.id}
            type="button"
            className={`nexus-plan-option ${selected === option.id ? "nexus-plan-option-active" : ""}`}
            onClick={() => setSelected(option.id)}
            aria-pressed={selected === option.id}
          >
            {index + 1}. {option.label}
          </button>
        ))}
      </div>
      {selected === "revise" ? (
        <textarea
          className="nexus-plan-followup-textarea"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Describe what should change in the plan."
        />
      ) : null}
      <div className="nexus-plan-followup-submit-row">
        <button
          type="button"
          className="nexus-plan-dismiss-btn"
          onClick={() => onChoice("abandon")}
          title="Exit Plan without implementing"
        >
          Dismiss <kbd className="nexus-kbd">Esc</kbd>
        </button>
        <button
          type="button"
          className="nexus-primary-btn text-xs"
          onClick={() => {
            const decision = planFollowupAction(selected, instruction)
            if (!decision) return
            onChoice(
              decision.choice,
              planFollowupText ?? undefined,
              "instruction" in decision ? decision.instruction : undefined,
              false,
            )
          }}
          disabled={!canSubmit}
        >
          Submit <kbd className="nexus-kbd">⏎</kbd>
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
  onSelect: (
    providerId: string,
    modelId: string,
    baseUrl: string,
    contextWindow?: number,
  ) => void
  onClose: () => void
}) {
  const options = useMemo(() => {
    if (!catalog) return []
    const q = query.trim().toLowerCase()
    const recommendedKeys = new Set(catalog.recommended.map((r) => `${r.providerId}:${r.modelId}`))
    const list: Array<{
      providerId: string
      modelId: string
      name: string
      free: boolean
      category: string
      contextWindow?: number
    }> = []
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
          contextWindow: m.contextWindow,
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
                    onClick={() =>
                      onSelect(
                        opt.providerId,
                        opt.modelId,
                        baseUrl,
                        opt.contextWindow,
                      )
                    }
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
  /** Max embed batches queued while parsing (backpressure). */
  maxPendingEmbedBatches: string
  /** Parallel embed/upsert pipelines. */
  batchProcessingConcurrency: string
  /** 0 = disable listing (Roo parity). */
  maxIndexedFiles: string
  /** Allow CodebaseSearch during indexing (partial results if vectors exist). */
  searchWhileIndexing: boolean
  /** 0–1; fraction of chunk embed failures that triggers index reset. */
  maxIndexingFailureRate: string
  vectorDbEnabled: boolean
  vectorDbUrl: string
  vectorDbApiKey: string
  vectorDbAutoStart: boolean
  deferredLoadingMode: "auto" | "always" | "never"
  deferredLoadingThresholdPercent: string
  deferredLoadingMinimumTools: string
  parallelReads: boolean
  maxParallelReads: string
  autoApproveRead: boolean
  autoApproveWrite: boolean
  autoApproveCommand: boolean
  autoApproveMcp: boolean
  autoApproveBrowser: boolean
  autoApproveSkillLoad: boolean
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
  /** Remote registries (index.json), one URL per line. */
  skillsUrlsText: string
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

type SettingsTabId = "llm" | "embeddings" | "index" | "tools" | "integrations" | "presets"
type SettingsIntegTabId = "marketplace" | "rules-skills" | "mcp" | "rules-instructions"

function SettingsView({
  initialTab,
  initialIntegTab,
  onInitialTabApplied,
}: {
  initialTab: SettingsTabId | null
  initialIntegTab: SettingsIntegTabId | null
  onInitialTabApplied: () => void
}) {
  const {
    config,
    provider,
    model,
    saveConfig,
    serverUrl,
    modelsCatalog,
    modelsCatalogLoading,
    requestModelsCatalog,
    agentPresets,
    requestAgentPresets,
    agentPresetOptions,
    requestAgentPresetOptions,
    handleAgentPresetOptions,
    autocompleteExtension,
  } = useChatStore()
  const [draft, setDraft] = useState<SettingsDraft>(() => getDefaultDraft())
  const serverSettingsFingerprintRef = useRef<string>("")
  const [serverUrlLocal, setServerUrlLocal] = useState(serverUrl)
  const [serverTokenLocal, setServerTokenLocal] = useState("")
  const [tab, setTab] = useState<SettingsTabId>("llm")
  const [integTab, setIntegTab] = useState<SettingsIntegTabId>("rules-skills")
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
  const [acPanelOpen, setAcPanelOpen] = useState(false)
  const [acModelPickerOpen, setAcModelPickerOpen] = useState(false)
  const [acModelPickerQuery, setAcModelPickerQuery] = useState("")
  const [acApiKeyDraft, setAcApiKeyDraft] = useState("")

  const ac = autocompleteExtension ?? DEFAULT_AUTOCOMPLETE_UI

  useEffect(() => {
    if (initialTab) {
      setTab(initialTab)
      if (initialIntegTab) setIntegTab(initialIntegTab)
      onInitialTabApplied()
    }
  }, [initialTab, initialIntegTab, onInitialTabApplied])

  useEffect(() => {
    setServerUrlLocal(serverUrl)
  }, [serverUrl])
  useEffect(() => {
    if (!config) {
      serverSettingsFingerprintRef.current = ""
      return
    }
    const fp = settingsConfigFingerprint(config)
    if (fp === serverSettingsFingerprintRef.current) return
    serverSettingsFingerprintRef.current = fp
    const { provider: fallbackProvider, model: fallbackModel } = useChatStore.getState()
    setDraft(toDraft(config, fallbackProvider, fallbackModel))
  }, [config])
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
  const pendingProjectAuthority = config?.pendingProjectAuthority ?? []
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

      {pendingProjectAuthority.length > 0 && (
        <section className="nexus-section mt-2 border border-[var(--vscode-inputValidation-warningBorder)]">
          <h3 className="nexus-section-title">
            Project authority requests (inactive)
          </h3>
          <p className="nexus-muted text-[10px] mb-2">
            Repository endpoints, executable integrations, and external paths
            remain inactive until this runtime host approves the exact
            normalized content for this workspace.
          </p>
          <div className="flex flex-col gap-2">
            {pendingProjectAuthority.map((request) => (
              <ProjectAuthorityRequestCard
                key={`${request.kind}:${request.fingerprint}`}
                kind={request.kind}
                payload={request.payload}
                fingerprint={request.fingerprint}
                onApprove={(fingerprint) =>
                  postMessage({
                    type: "approvePendingProjectAuthority",
                    fingerprint,
                  })}
              />
            ))}
          </div>
        </section>
      )}

      <section className="nexus-section mt-2">
        <h3 className="nexus-section-title">NexusCode Server</h3>
        <p className="nexus-muted text-[10px] mb-2">
          When set, the extension uses this server for authenticated sessions and agent runs (portable JSONL storage, paginated). Leave empty to run in-process.
        </p>
        <SettingsInput
          label="Server URL (e.g. http://127.0.0.1:4097)"
          value={serverUrlLocal}
          onChange={setServerUrlLocal}
        />
        {serverUrlLocal.trim() && !isValidOptionalNexusServerUrl(serverUrlLocal) ? (
          <p className="text-[10px] text-[var(--vscode-errorForeground)] mt-1 mb-0">
            Use HTTPS for remote servers, or HTTP(S) for loopback, without credentials, query, or fragment.
          </p>
        ) : null}
        <SettingsInput
          label="Server token (stored in VS Code Secret Storage)"
          value={serverTokenLocal}
          type="password"
          onChange={setServerTokenLocal}
        />
        <div className="flex gap-2 mt-2">
          <button
            type="button"
            className="nexus-secondary-btn text-xs"
            disabled={
              !isValidOptionalNexusServerUrl(serverUrlLocal) ||
              serverUrlLocal.trim() === serverUrl.trim()
            }
            onClick={() =>
              postMessage({
                type: "setServerUrl",
                url: serverUrlLocal.trim(),
              })}
          >
            Apply server URL
          </button>
          <button
            type="button"
            className="nexus-secondary-btn text-xs"
            disabled={!serverTokenLocal.trim()}
            onClick={() => {
              postMessage({ type: "setServerToken", token: serverTokenLocal })
              setServerTokenLocal("")
            }}
          >
            Save token
          </button>
          <button
            type="button"
            className="nexus-secondary-btn text-xs"
            onClick={() => {
              postMessage({ type: "setServerToken", token: "" })
              setServerTokenLocal("")
            }}
          >
            Remove token
          </button>
        </div>
      </section>

      <div className="nexus-settings-primary-tabs mt-2 mb-2">
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
                onSelect={(providerId, modelId, baseUrl, contextWindow) => {
                  if (draft) {
                    setDraft({
                      ...draft,
                      modelProvider: "openrouter",
                      modelId,
                      modelBaseUrl: baseUrl || "https://openrouter.ai/api/v1",
                      modelContextWindow:
                        contextWindow != null ? String(contextWindow) : "",
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
            <SettingsInput
              type="password"
              label="API Key"
              value={draft.modelApiKey}
              placeholder="Leave blank to keep the securely stored key"
              onChange={(v) => setDraft({ ...draft, modelApiKey: v })}
            />
            <button
              type="button"
              className="nexus-secondary-btn text-xs"
              onClick={async () => {
                if (await confirmAsync("Remove the securely stored API key for the base chat model?")) {
                  postMessage({ type: "removeCredential", target: "model" })
                  setDraft({ ...draft, modelApiKey: "" })
                }
              }}
            >
              Remove stored model key
            </button>
            <SettingsInput label="Base URL" value={draft.modelBaseUrl} onChange={(v) => setDraft({ ...draft, modelBaseUrl: v })} />
            {Object.keys(config?.profiles ?? {}).length > 0 ? (
              <div className="mt-2 space-y-1">
                <div className="nexus-muted text-[10px]">Stored profile credentials</div>
                {Object.keys(config?.profiles ?? {}).map((profileName) => (
                  <div key={profileName} className="flex items-center justify-between gap-2">
                    <code className="text-[10px] truncate">{profileName}</code>
                    <button
                      type="button"
                      className="nexus-secondary-btn text-xs"
                      onClick={async () => {
                        if (await confirmAsync(`Remove the securely stored key for profile "${profileName}"?`)) {
                          postMessage({
                            type: "removeCredential",
                            target: "profile",
                            profileName,
                          })
                        }
                      }}
                    >
                      Remove key
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="nexus-muted text-[10px]">
              Context windows come from provider/catalog metadata; unknown models show an unknown limit instead of a guessed value.
            </div>
          </section>

          <section className="nexus-section border-t border-[var(--vscode-widget-border)] pt-3 mt-3">
            <h3 className="nexus-section-title">Editor inline autocomplete</h3>
            <p className="nexus-muted text-[10px] mb-2">
              Gray ghost text at the cursor; Tab accepts. When off, inline suggestions are fully disabled (no provider
              registration).
            </p>
            <SettingsToggle
              label="Enable inline autocomplete in the editor"
              checked={ac.enableAutoTrigger}
              onChange={(checked) =>
                postMessage({ type: "setAutocompleteExtensionSettings", patch: { enableAutoTrigger: checked } })
              }
            />
            <button
              type="button"
              className="nexus-secondary-btn text-xs mt-2 w-full flex items-center justify-between gap-2"
              onClick={() => setAcPanelOpen((o) => !o)}
            >
              <span>LLM settings for autocomplete</span>
              <span className="text-[10px] opacity-80 shrink-0" aria-hidden>
                {acPanelOpen ? "▼" : "▶"}
              </span>
            </button>
            {acPanelOpen && (
              <div className="mt-2 pl-2 border-l-2 border-[var(--vscode-widget-border)] space-y-2">
                <SettingsToggle
                  label="Use a different model than the agent (settings above)"
                  checked={ac.useSeparateModel}
                  onChange={(checked) =>
                    postMessage({ type: "setAutocompleteExtensionSettings", patch: { useSeparateModel: checked } })
                  }
                />
                {!ac.useSeparateModel && (
                  <p className="nexus-muted text-[10px]">
                    Autocomplete uses the same provider and model as the agent (project config + overrides).
                  </p>
                )}
                {ac.useSeparateModel && (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="nexus-secondary-btn text-xs"
                        onClick={() => {
                          setAcModelPickerOpen(true)
                          setAcModelPickerQuery("")
                          if (!modelsCatalog) requestModelsCatalog()
                        }}
                      >
                        Select model (catalog)
                      </button>
                    </div>
                    {acModelPickerOpen && (
                      <ModelPickerModal
                        catalog={modelsCatalog}
                        loading={modelsCatalogLoading}
                        query={acModelPickerQuery}
                        onQueryChange={setAcModelPickerQuery}
                        onSelect={(providerId, modelId, baseUrl, contextWindow) => {
                          postMessage({
                            type: "setAutocompleteExtensionSettings",
                            patch: {
                              useSeparateModel: true,
                              modelProvider: providerId,
                              modelId,
                              modelBaseUrl: baseUrl || "",
                              modelContextWindow:
                                contextWindow != null ? String(contextWindow) : "",
                            },
                          })
                          setAcModelPickerOpen(false)
                        }}
                        onClose={() => setAcModelPickerOpen(false)}
                      />
                    )}
                    <SettingsSelect
                      label="Provider"
                      value={ac.modelProvider}
                      onChange={(v) =>
                        postMessage({ type: "setAutocompleteExtensionSettings", patch: { modelProvider: v } })
                      }
                      options={MODEL_PROVIDER_OPTIONS}
                    />
                    <SettingsInput
                      label="Model"
                      value={ac.modelId}
                      onChange={(v) => postMessage({ type: "setAutocompleteExtensionSettings", patch: { modelId: v } })}
                    />
                    <SettingsInput
                      label="Temperature (0-2)"
                      value={ac.modelTemperature}
                      onChange={(v) =>
                        postMessage({ type: "setAutocompleteExtensionSettings", patch: { modelTemperature: v } })
                      }
                    />
                    <SettingsSelect
                      label="Reasoning effort"
                      value={ac.modelReasoningEffort}
                      onChange={(v) =>
                        postMessage({ type: "setAutocompleteExtensionSettings", patch: { modelReasoningEffort: v } })
                      }
                      options={REASONING_EFFORT_OPTIONS}
                    />
                    <SettingsInput
                      label="Context window (tokens, 0 = omit)"
                      value={ac.modelContextWindow}
                      onChange={(v) =>
                        postMessage({ type: "setAutocompleteExtensionSettings", patch: { modelContextWindow: v } })
                      }
                    />
                    <SettingsInput
                      type="password"
                      label="API Key"
                      value={acApiKeyDraft}
                      placeholder={ac.hasModelApiKey ? "Stored securely — enter a replacement" : "Optional"}
                      onChange={setAcApiKeyDraft}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="nexus-secondary-btn text-xs"
                        disabled={!acApiKeyDraft.trim()}
                        onClick={() => {
                          postMessage({
                            type: "setAutocompleteExtensionSettings",
                            patch: { modelApiKey: acApiKeyDraft },
                          })
                          setAcApiKeyDraft("")
                        }}
                      >
                        Save key securely
                      </button>
                      {ac.hasModelApiKey && (
                        <button
                          type="button"
                          className="nexus-secondary-btn text-xs"
                          onClick={() =>
                            postMessage({
                              type: "setAutocompleteExtensionSettings",
                              patch: { modelApiKey: "" },
                            })
                          }
                        >
                          Remove stored key
                        </button>
                      )}
                    </div>
                    <SettingsInput
                      label="Base URL"
                      value={ac.modelBaseUrl}
                      onChange={(v) =>
                        postMessage({ type: "setAutocompleteExtensionSettings", patch: { modelBaseUrl: v } })
                      }
                    />
                  </>
                )}
              </div>
            )}
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
        <button
          type="button"
          className="nexus-secondary-btn text-xs"
          onClick={async () => {
            if (await confirmAsync("Remove the securely stored embeddings API key?")) {
              postMessage({ type: "removeCredential", target: "embeddings" })
              setDraft({ ...draft, embApiKey: "" })
            }
          }}
        >
          Remove stored embeddings key
        </button>
        <SettingsInput label="Base URL" value={draft.embBaseUrl} onChange={(v) => setDraft({ ...draft, embBaseUrl: v })} />
        <SettingsInput label="Dimensions" value={draft.embDimensions} onChange={(v) => setDraft({ ...draft, embDimensions: v })} />
      </section>
      )}

      {tab === "index" && (
      <IndexingAndDocsView
        draft={draft}
        setDraft={setDraft}
        remoteRuntime={Boolean(serverUrl.trim())}
        onReindex={() => postMessage({ type: "reindex" })}
        onDeleteIndex={async () => {
          if (
            await confirmAsync(
              "Delete the entire index for this workspace (tracker + vector data)? Nothing rebuilds automatically — press Sync when you want to index again.",
            )
          ) {
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
        <h3 className="nexus-section-title mt-4">Tool discovery</h3>
        <SettingsSelect
          label="Deferred tool loading"
          value={draft.deferredLoadingMode}
          options={[
            {
              value: "auto",
              label: "Auto — defer only a materially large catalog",
            },
            {
              value: "always",
              label: "Always — discover deferred tools with ToolSearch",
            },
            {
              value: "never",
              label: "Never — send every tool schema up front",
            },
          ]}
          onChange={(value) => setDraft({
            ...draft,
            deferredLoadingMode: value as SettingsDraft["deferredLoadingMode"],
          })}
        />
        {draft.deferredLoadingMode === "auto" && (
          <>
            <SettingsInput
              label="Minimum deferred tools"
              value={draft.deferredLoadingMinimumTools}
              onChange={(value) => setDraft({
                ...draft,
                deferredLoadingMinimumTools: value,
              })}
            />
            <SettingsInput
              label="Maximum catalog share of context (0.01–1)"
              value={draft.deferredLoadingThresholdPercent}
              onChange={(value) => setDraft({
                ...draft,
                deferredLoadingThresholdPercent: value,
              })}
            />
          </>
        )}
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
        <SettingsToggle
          label="Auto-approve Skill load (off = ask before loading each skill)"
          checked={draft.autoApproveSkillLoad}
          onChange={(checked) => setDraft({ ...draft, autoApproveSkillLoad: checked })}
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
            className={`nexus-tab-btn ${integTab === "marketplace" ? "nexus-tab-btn-active" : ""}`}
            onClick={() => setIntegTab("marketplace")}
          >
            Marketplace
          </button>
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

        {integTab === "marketplace" && <MarketplacePanel />}

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

/** Core `overallPercent`: files-only without vector; with vector, Roo-style chunk indexed / max(found, indexed). */
function indexReadinessPercent(status: IndexStatusKind): number {
  switch (status.state) {
    case "ready":
      return 100
    case "idle":
    case "error":
    case "stopping":
      return 0
    case "indexing": {
      const o = status.overallPercent
      if (typeof o === "number" && Number.isFinite(o)) return Math.max(0, Math.min(100, Math.round(o)))
      const { total, progress } = status
      if (total > 0) return Math.max(0, Math.min(100, Math.round((progress / total) * 100)))
      return 0
    }
    default:
      return 0
  }
}

function indexReadinessPhaseLabel(status: IndexStatusKind): string {
  switch (status.state) {
    case "ready":
      return "Ready for CodebaseSearch"
    case "error":
      return "Failed"
    case "idle":
      return "Not indexed"
    case "stopping":
      return "Stopping"
    case "indexing":
      return status.watcherQueue ? "Updating from disk" : status.paused ? "Paused" : "Indexing"
    default:
      return ""
  }
}

function indexReadinessDetail(status: IndexStatusKind): string {
  switch (status.state) {
    case "ready": {
      const chunks = typeof status.chunks === "number" ? status.chunks : status.symbols
      return `${status.files.toLocaleString()} files · ${chunks.toLocaleString()} chunks in index`
    }
    case "error":
      return status.error ?? "Unknown error"
    case "idle":
      return "Click Sync to build the index. With vector on, progress follows Roo-style chunk counts (indexed / chunks found so far); file totals are shown in the same line."
    case "stopping":
      return status.message?.trim() || "Stopping indexer (abort in progress)…"
    case "indexing": {
      const base = status.message?.trim() || "…"
      return status.paused ? `${base} — indexing paused (resume to continue).` : base
    }
    default:
      return ""
  }
}

/** Single gray track + green fill; % matches current phase (files or chunks) like Roo. */
function IndexReadinessBar({ status }: { status: IndexStatusKind }) {
  const pct = indexReadinessPercent(status)
  const isError = status.state === "error"
  const isStopping = status.state === "stopping"
  const fillWidth = isError || isStopping ? 0 : pct
  return (
    <div
      className="nexus-index-readiness"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Codebase index readiness"
    >
      <div className="flex items-end justify-between gap-2 mb-1">
        <div className="text-[22px] font-semibold tabular-nums leading-none text-[var(--vscode-foreground)]">
          {isError || isStopping ? "—" : pct}
          {!isError && !isStopping ? (
            <span className="text-[13px] font-normal text-[var(--vscode-descriptionForeground)]">%</span>
          ) : null}
        </div>
        <span className="text-[11px] text-[var(--vscode-descriptionForeground)] text-right max-w-[60%]">
          {indexReadinessPhaseLabel(status)}
        </span>
      </div>
      <div className="nexus-index-readiness-track">
        <div className="nexus-index-readiness-fill" style={{ width: `${fillWidth}%` }} />
      </div>
      <p
        className={`text-[11px] mt-1.5 leading-snug ${
          isError ? "text-[var(--vscode-errorForeground)]" : "text-[var(--vscode-descriptionForeground)]"
        }`}
      >
        {indexReadinessDetail(status)}
      </p>
    </div>
  )
}

/** Indexing panel (codebase index, ignore files, vector/advanced). */
function IndexingAndDocsView({
  draft,
  setDraft,
  remoteRuntime,
  onReindex,
  onDeleteIndex,
  onOpenCursorignore,
  onOpenNexusignore,
}: {
  draft: SettingsDraft
  setDraft: React.Dispatch<React.SetStateAction<SettingsDraft>>
  remoteRuntime: boolean
  onReindex: () => void
  onDeleteIndex: () => void
  onOpenCursorignore: () => void
  onOpenNexusignore: () => void
}) {
  const indexStatus = useChatStore((s) => s.indexStatus)
  const vectorDbProgressMessage = useChatStore((s) => s.vectorDbProgressMessage)

  return (
    <div className="nexus-section">
      <h3 className="nexus-section-title">Indexing</h3>

      <div className="nexus-panel-block">
        <h4 className="nexus-panel-section-title">
          Codebase Indexing
          <span className="nexus-info-icon" title="Embed codebase for context">ⓘ</span>
        </h4>
        <p className="nexus-panel-section-desc">
          One index per workspace (single tracker + one Qdrant collection). Semantic search can be scoped with CodebaseSearch <code className="text-[10px]">target_directories</code>. Sync updates incrementally; it does not wipe the index. Explorer: right-click a folder → “Delete Index for This Path” to drop only that subtree.
        </p>
        <div className="nexus-index-progress-wrap">
          <IndexReadinessBar status={indexStatus} />
        </div>
        <div className="nexus-index-actions flex flex-wrap items-center gap-2">
          <button type="button" className="nexus-secondary-btn text-xs" onClick={onReindex} title="Incremental sync / resume (no full wipe)">
            Sync
          </button>
          <button type="button" className="nexus-secondary-btn text-xs" onClick={onDeleteIndex} title="Remove all index data for this workspace; use Sync to rebuild">
            Delete Index
          </button>
          {indexStatus.state === "indexing" && !indexStatus.paused && !indexStatus.watcherQueue ? (
            <button type="button" className="nexus-secondary-btn text-xs" onClick={() => postMessage({ type: "pauseIndexing" })}>
              Pause indexing
            </button>
          ) : null}
          {indexStatus.state === "indexing" && indexStatus.paused && !indexStatus.watcherQueue ? (
            <button type="button" className="nexus-secondary-btn text-xs" onClick={() => postMessage({ type: "resumeIndexing" })}>
              Resume indexing
            </button>
          ) : null}
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
          <SettingsInput
            type="password"
            label="Qdrant API key"
            value={draft.vectorDbApiKey}
            onChange={(v) => setDraft({ ...draft, vectorDbApiKey: v })}
          />
          <button
            type="button"
            className="nexus-secondary-btn text-xs"
            onClick={async () => {
              if (await confirmAsync("Remove the securely stored Qdrant API key?")) {
                postMessage({ type: "removeCredential", target: "qdrant" })
                setDraft({ ...draft, vectorDbApiKey: "" })
              }
            }}
          >
            Remove stored Qdrant key
          </button>
          <p className="text-[10px] text-[var(--vscode-descriptionForeground)] -mt-1">
            Optional (Qdrant Cloud / secured cluster). Stored with other API keys, not in nexus.yaml. Env: <code className="text-[10px]">QDRANT_API_KEY</code>.
          </p>
          <SettingsToggle
            label="Auto-start a local Qdrant process"
            checked={draft.vectorDbAutoStart}
            onChange={(checked) =>
              setDraft({ ...draft, vectorDbAutoStart: checked })}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="nexus-secondary-btn text-xs"
              disabled={
                remoteRuntime ||
                !isValidOptionalHttpUrl(
                  draft.vectorDbUrl.trim() || "http://127.0.0.1:6333",
                )
              }
              title={
                remoteRuntime
                  ? "Qdrant lifecycle is managed by the configured NexusCode Server"
                  : undefined
              }
              onClick={() => postMessage({
                type: "startOrConnectVectorDb",
                url: draft.vectorDbUrl.trim() || "http://127.0.0.1:6333",
                autoStart: draft.vectorDbAutoStart,
              })}
            >
              {draft.vectorDbAutoStart ? "Start / Connect Qdrant" : "Connect to Qdrant"}
            </button>
            <span className="text-[11px] text-[var(--vscode-descriptionForeground)]">
              {remoteRuntime
                ? "Managed by the configured NexusCode Server"
                : draft.vectorDbAutoStart
                  ? "Local loopback only; host confirmation is required"
                  : "Connect to an existing HTTP(S) endpoint"}
            </span>
          </div>
          <SettingsToggle label="Vector DB enabled (use for indexer)" checked={draft.vectorDbEnabled} onChange={(checked) => setDraft({ ...draft, vectorDbEnabled: checked })} />
          <SettingsInput label="Embedding batch size (min segments per upsert)" value={draft.embeddingBatchSize} onChange={(v) => setDraft({ ...draft, embeddingBatchSize: v })} />
          <SettingsInput label="Embedding request concurrency" value={draft.embeddingConcurrency} onChange={(v) => setDraft({ ...draft, embeddingConcurrency: v })} />
          <SettingsInput
            label="Max pending embed batches"
            value={draft.maxPendingEmbedBatches}
            onChange={(v) => setDraft({ ...draft, maxPendingEmbedBatches: v })}
          />
          <SettingsInput
            label="Parallel embed pipelines"
            value={draft.batchProcessingConcurrency}
            onChange={(v) => setDraft({ ...draft, batchProcessingConcurrency: v })}
          />
          <SettingsInput
            label="Max indexed files (0 = no scan, Roo-style)"
            value={draft.maxIndexedFiles}
            onChange={(v) => setDraft({ ...draft, maxIndexedFiles: v })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="nexus-secondary-btn text-xs"
              onClick={async () => {
                if (
                  await confirmAsync(
                    "Wipe the index and rebuild from scratch? This clears the tracker and vector collection, then re-indexes everything.",
                  )
                ) {
                  postMessage({ type: "fullRebuildIndex" })
                }
              }}
            >
              Rebuild index from scratch
            </button>
            <span className="text-[10px] text-[var(--vscode-descriptionForeground)]">Unlike Sync, this clears all indexed data first.</span>
          </div>
          <SettingsToggle
            label="CodebaseSearch while indexing (partial results; on by default)"
            checked={draft.searchWhileIndexing}
            onChange={(checked) => setDraft({ ...draft, searchWhileIndexing: checked })}
          />
          <p className="text-[10px] text-[var(--vscode-descriptionForeground)] -mt-1">
            When on, semantic search runs as soon as Qdrant has points, even if the UI still shows indexing (e.g. final batches or metadata). Turn off to block until indexing fully completes.
          </p>
          <SettingsInput
            label="Max indexing failure rate (0–1, e.g. 0.1)"
            value={draft.maxIndexingFailureRate}
            onChange={(v) => setDraft({ ...draft, maxIndexingFailureRate: v })}
          />
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

/** MCP server list (Remote Servers | Configure). Use Integrations → Marketplace for Kilo catalog installs. */
function IntegrationsMcpView({
  draft,
  setDraft,
}: {
  draft: SettingsDraft
  setDraft: React.Dispatch<React.SetStateAction<SettingsDraft>>
}) {
  const mcpStatus = useChatStore((s) => s.mcpStatus)
  const pendingServers = useChatStore(
    (s) => s.config?.mcp.pendingProjectServers ?? [],
  )
  const [showRaw, setShowRaw] = useState(false)
  const [testing, setTesting] = useState(false)
  const [mcpTab, setMcpTab] = useState<"remote" | "configure">("configure")
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
      <p className="text-[11px] text-[var(--vscode-descriptionForeground)] mb-2">
        Browse and one-click install MCP servers from the <strong>Marketplace</strong> tab. This screen is for manual remote URLs and JSON editing.
      </p>
      <div className="flex gap-1 border-b border-[var(--vscode-panel-border)] mb-3 pb-0" style={{ marginBottom: "-1px" }}>
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

          {pendingServers.length > 0 && (
            <div className="mb-3 rounded border border-[var(--vscode-inputValidation-warningBorder)] bg-[var(--vscode-inputValidation-warningBackground)] p-3">
              <div className="text-xs font-semibold mb-1">
                Project MCP requests (inactive)
              </div>
              <div className="text-[11px] text-[var(--vscode-descriptionForeground)] mb-2">
                Repository configuration cannot start processes or contact servers until you approve the exact request into host-owned configuration.
              </div>
              <div className="flex flex-col gap-2">
                {pendingServers.map((pending) => {
                  const server = pending.config as Record<string, unknown>
                  const name = serverName(server)
                  const command = serverCommand(server)
                  return (
                    <div
                      key={`${pending.origin}:${name}`}
                      className="flex items-center gap-2 rounded border border-[var(--vscode-panel-border)] p-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate" title={name}>
                          {name}
                        </div>
                        <div className="text-[10px] font-mono text-[var(--vscode-descriptionForeground)] break-all">
                          {command}
                        </div>
                        <div className="text-[10px] text-[var(--vscode-descriptionForeground)]">
                          Source: {pending.origin}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="nexus-btn nexus-btn-primary text-xs py-1 px-2 flex-shrink-0"
                        onClick={async () => {
                          const approved = await confirmAsync(
                            `Approve project MCP server "${name}"?\n\n${command}\n\nThis exact definition will become host-owned and may execute with workspace access.`,
                          )
                          if (!approved) return
                          postMessage({
                            type: "approvePendingMcp",
                            name,
                            origin: pending.origin,
                          })
                        }}
                      >
                        Approve exact request
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

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
        Skills load from local paths below, plus standard dirs (including <code className="text-[10px]">~/.claude/skills</code> and walk-up{" "}
        <code className="text-[10px]">.claude/skills</code>), and from remote URLs if configured.
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
                placeholder="Path to skill (e.g. .nexus/skills/foo/SKILL.md)"
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
      <SettingsTextarea
        label="Remote skill registry URLs (one per line; each base URL must expose index.json — files cache under ~/.nexus/cache/skills/)"
        value={draft.skillsUrlsText}
        onChange={(v) => setDraft((d) => ({ ...d, skillsUrlsText: v }))}
        rows={3}
      />
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

/**
 * Canonical tree for fingerprinting: sort object keys so logically identical configs always match.
 * Plain JSON.stringify breaks when the host builds the same fields in different key order (duplicate
 * configLoaded would then clear unsaved toggles like indexing.enabled / indexing.vector).
 */
function stableSerializeForFingerprint(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(stableSerializeForFingerprint)
  const obj = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key]
    if (v === undefined) continue
    sorted[key] = stableSerializeForFingerprint(v)
  }
  return sorted
}

/** Stable snapshot of everything `toDraft` reads — avoids resetting the settings form when `config` is a new object reference with identical data (duplicate configLoaded / replay / unrelated host events). */
function settingsConfigFingerprint(config: NexusConfigState): string {
  try {
    return JSON.stringify(
      stableSerializeForFingerprint({
        model: config.model,
        embeddings: config.embeddings,
        indexing: config.indexing,
        vectorDb: config.vectorDb,
        tools: config.tools,
        permissions: config.permissions,
        mcp: config.mcp,
        skillsConfig: config.skillsConfig,
        skills: config.skills,
        skillsUrls: config.skillsUrls,
        rules: config.rules,
        modes: config.modes,
        profiles: config.profiles,
        pendingProjectAuthority: config.pendingProjectAuthority,
        ui: config.ui,
      })
    )
  } catch {
    return `${Date.now()}`
  }
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
    maxPendingEmbedBatches: String(config.indexing.maxPendingEmbedBatches ?? 20),
    batchProcessingConcurrency: String(config.indexing.batchProcessingConcurrency ?? 10),
    maxIndexedFiles: String(
      config.indexing.maxIndexedFiles !== undefined ? config.indexing.maxIndexedFiles : 50_000
    ),
    searchWhileIndexing: config.indexing.searchWhileIndexing !== false,
    maxIndexingFailureRate: String(
      config.indexing.maxIndexingFailureRate !== undefined ? config.indexing.maxIndexingFailureRate : 0.1
    ),
    vectorDbEnabled: Boolean(config.vectorDb?.enabled),
    vectorDbUrl: config.vectorDb?.url ?? "http://127.0.0.1:6333",
    vectorDbApiKey: config.vectorDb?.apiKey ?? "",
    vectorDbAutoStart: config.vectorDb?.autoStart ?? true,
    deferredLoadingMode: config.tools.deferredLoadingMode ?? "auto",
    deferredLoadingThresholdPercent: String(
      config.tools.deferredLoadingThresholdPercent ?? 0.1
    ),
    deferredLoadingMinimumTools: String(
      config.tools.deferredLoadingMinimumTools ?? 8
    ),
    parallelReads: Boolean(config.tools.parallelReads),
    maxParallelReads: String(config.tools.maxParallelReads ?? 5),
    autoApproveRead: config.permissions?.autoApproveRead ?? true,
    autoApproveWrite: config.permissions?.autoApproveWrite ?? false,
    autoApproveCommand: config.permissions?.autoApproveCommand ?? false,
    autoApproveMcp: config.permissions?.autoApproveMcp ?? false,
    autoApproveBrowser: config.permissions?.autoApproveBrowser ?? false,
    autoApproveSkillLoad: config.permissions?.autoApproveSkillLoad !== false,
    autoApproveReadPatternsText: (config.permissions?.autoApproveReadPatterns ?? []).join("\n"),
    allowedCommandsText: (config.permissions?.allowedCommands ?? []).join("\n"),
    allowCommandPatternsText: (config.permissions?.allowCommandPatterns ?? []).join("\n"),
    askCommandPatternsText: (config.permissions?.askCommandPatterns ?? []).join("\n"),
    denyCommandPatternsText: (config.permissions?.denyCommandPatterns ?? []).join("\n"),
    allowedMcpToolsText: (config.permissions?.allowedMcpTools ?? []).join("\n"),
    mcpServersJson: JSON.stringify(config.mcp?.servers ?? [], null, 2),
    skillsConfig: config.skillsConfig ?? (config.skills ?? []).map((p) => ({ path: p, enabled: true })),
    skillsText: (config.skillsConfig ?? (config.skills ?? []).map((p) => ({ path: p, enabled: true }))).map((s) => s.path).join("\n"),
    skillsUrlsText: (config.skillsUrls ?? []).join("\n"),
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
    maxPendingEmbedBatches: "20",
    batchProcessingConcurrency: "10",
    maxIndexedFiles: "50000",
    searchWhileIndexing: true,
    maxIndexingFailureRate: "0.1",
    vectorDbEnabled: false,
    vectorDbUrl: "http://127.0.0.1:6333",
    vectorDbApiKey: "",
    vectorDbAutoStart: true,
    deferredLoadingMode: "auto",
    deferredLoadingThresholdPercent: "0.1",
    deferredLoadingMinimumTools: "8",
    parallelReads: true,
    maxParallelReads: "5",
    autoApproveRead: true,
    autoApproveWrite: false,
    autoApproveCommand: false,
    autoApproveMcp: false,
    autoApproveBrowser: false,
    autoApproveSkillLoad: true,
    autoApproveReadPatternsText: ".nexus/tool-output/**",
    allowedCommandsText: "",
    allowCommandPatternsText: "",
    askCommandPatternsText: "",
    denyCommandPatternsText: "",
    allowedMcpToolsText: "",
    mcpServersJson: "[]",
    skillsText: "",
    skillsUrlsText: "",
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
  const deferredLoadingThresholdPercent = Math.min(
    1,
    Math.max(
      0.01,
      parseNumber(draft.deferredLoadingThresholdPercent) ?? 0.1,
    ),
  )
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
      maxPendingEmbedBatches: parsePositiveInt(draft.maxPendingEmbedBatches, 20),
      batchProcessingConcurrency: parsePositiveInt(draft.batchProcessingConcurrency, 10),
      maxIndexedFiles: parseNonNegativeInt(draft.maxIndexedFiles, 50_000),
      searchWhileIndexing: draft.searchWhileIndexing,
      maxIndexingFailureRate: parseFailureRate(draft.maxIndexingFailureRate, 0.1),
    },
    vectorDb: {
      enabled: draft.vectorDbEnabled,
      url: draft.vectorDbUrl.trim() || "http://127.0.0.1:6333",
      collection: "nexus",
      autoStart: draft.vectorDbAutoStart,
      apiKey: draft.vectorDbApiKey.trim() || undefined,
    },
    tools: {
      parallelReads: draft.parallelReads,
      maxParallelReads: parsePositiveInt(draft.maxParallelReads, 5),
      deferredLoadingMode: draft.deferredLoadingMode,
      deferredLoadingThresholdPercent,
      deferredLoadingMinimumTools: parsePositiveInt(
        draft.deferredLoadingMinimumTools,
        8,
      ),
      custom: [],
    },
    permissions: {
      autoApproveRead: draft.autoApproveRead,
      autoApproveWrite: draft.autoApproveWrite,
      autoApproveCommand: draft.autoApproveCommand,
      autoApproveMcp: draft.autoApproveMcp,
      autoApproveBrowser: draft.autoApproveBrowser,
      autoApproveSkillLoad: draft.autoApproveSkillLoad,
      autoApproveReadPatterns: linesToList(draft.autoApproveReadPatternsText),
      allowedCommands: linesToList(draft.allowedCommandsText),
      allowCommandPatterns: linesToList(draft.allowCommandPatternsText),
      askCommandPatterns: linesToList(draft.askCommandPatternsText),
      denyCommandPatterns: linesToList(draft.denyCommandPatternsText),
      allowedMcpTools: linesToList(draft.allowedMcpToolsText),
    },
    mcp: {
      servers: mcpServers,
    },
    skillsConfig,
    skills,
    skillsUrls: linesToList(draft.skillsUrlsText),
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

function isValidOptionalHttpUrl(value: string): boolean {
  const raw = value.trim()
  if (!raw) return true
  if (
    raw.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(raw)
  ) {
    return false
  }
  try {
    const url = new URL(raw)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

function isValidOptionalNexusServerUrl(value: string): boolean {
  const raw = value.trim()
  if (!raw) return true
  if (!isValidOptionalHttpUrl(raw)) return false
  const url = new URL(raw)
  if (url.search || url.hash) return false
  if (url.protocol === "https:") return true
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "")
  if (hostname === "localhost" || hostname === "::1") return true
  const match = hostname.match(
    /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u,
  )
  return Boolean(
    match &&
      match.slice(1).every((octet) => Number(octet) <= 255),
  )
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

function parseNonNegativeInt(value: string, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

function parseFailureRate(value: string, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback
  return n
}

function toInputNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : ""
}

function SettingsInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: "text" | "password"
  placeholder?: string
}) {
  return (
    <label className="nexus-field">
      <span className="nexus-field-label">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
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

function HistoryIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
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
