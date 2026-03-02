import React, { useEffect, useMemo, useState } from "react"
import { useChatStore, type NexusConfigState } from "./stores/chat.js"
import type { MessagePart } from "./stores/chat.js"
import { MessageList } from "./components/MessageList.js"
import { InputBar } from "./components/InputBar.js"
import { ModeSelector } from "./components/ModeSelector.js"
import { ProgressTodoBlock } from "./components/ProgressTodoBlock.js"
import { ThoughtBlock } from "./components/ThoughtBlock.js"
import { postMessage } from "./vscode.js"
import type { ExtensionMessage } from "./types/messages.js"

const ICON_CLASS = "w-4 h-4 flex-shrink-0"
const BTN_CLASS =
  "p-1.5 rounded-md text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
const MODEL_PROVIDER_OPTIONS = ["anthropic", "openai", "google", "openai-compatible", "openrouter", "ollama", "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras", "cohere", "togetherai", "perplexity"]
const EMB_PROVIDER_OPTIONS = ["openai", "openai-compatible", "ollama", "local"]

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
        case "addToChatContent":
          store.appendToInput(msg.content)
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
      <header className="nexus-header">
        <div className="flex items-center gap-2 min-w-0">
          <span className="nexus-logo-dot" />
          <span className="text-sm font-semibold text-[var(--vscode-foreground)] truncate">NexusCode</span>
          <IndexBadge status={store.indexStatus} />
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={store.clearChat}
            title="New chat"
            disabled={store.isRunning}
            className={BTN_CLASS}
          >
            <PlusIcon className={ICON_CLASS} />
          </button>
          <button
            type="button"
            onClick={store.compact}
            title="Compact history"
            disabled={store.isRunning || store.messages.length === 0}
            className={BTN_CLASS}
          >
            <CompactIcon className={ICON_CLASS} />
          </button>
          <button
            type="button"
            onClick={store.reindex}
            title="Re-index codebase"
            disabled={store.indexStatus.state === "indexing"}
            className={BTN_CLASS}
          >
            <RefreshIcon className={ICON_CLASS} />
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Clear the entire codebase index and rebuild from scratch?")) {
                store.clearIndex()
              }
            }}
            title="Clear index and rebuild"
            disabled={store.indexStatus.state === "indexing"}
            className={`${BTN_CLASS} hover:text-red-400 hover:bg-red-500/10`}
          >
            <DatabaseOffIcon className={ICON_CLASS} />
          </button>
          <button
            type="button"
            onClick={() => store.setView("settings")}
            title="Agent settings"
            className={BTN_CLASS}
          >
            <GearIcon className={ICON_CLASS} />
          </button>
        </div>
      </header>

      <div className="nexus-nav">
        <TabButton active={store.view === "chat"} onClick={() => store.setView("chat")} label="Chat" />
        <TabButton active={store.view === "sessions"} onClick={() => store.setView("sessions")} label="Sessions" />
        <TabButton active={store.view === "settings"} onClick={() => store.setView("settings")} label="Settings" />
      </div>

      {store.indexStatus.state === "indexing" && (
        <IndexProgress status={store.indexStatus} />
      )}

      {store.view === "chat" && <ChatView />}
      {store.view === "sessions" && <SessionsView />}
      {store.view === "settings" && <SettingsView />}
    </div>
  )
}

function ChatView() {
  const store = useChatStore()
  const contextColor =
    store.contextPercent >= 90
      ? "text-red-400"
      : store.contextPercent >= 75
        ? "text-yellow-300"
        : "text-emerald-300"

  const lastReasoningText = useMemo(() => {
    const msgs = store.messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.role !== "assistant") continue
      const parts = Array.isArray(m.content) ? (m.content as MessagePart[]) : []
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j]
        if (p?.type === "reasoning") return (p as { text: string }).text
      }
    }
    return ""
  }, [store.messages])

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

  const referencedFiles = useMemo(() => {
    const paths = new Set<string>()
    for (const msg of store.messages) {
      if (!Array.isArray(msg.content)) continue
      for (const p of msg.content as MessagePart[]) {
        if (p.type === "tool" && (p as { input?: Record<string, unknown> }).input?.path) {
          paths.add(String((p as { input: { path?: string } }).input.path))
        }
      }
    }
    return Array.from(paths)
  }, [store.messages])

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

      {store.awaitingApproval && (
        <div className="nexus-approval-banner">
          <span className="nexus-approval-icon">⚠</span>
          <span>Action awaiting your approval — check the VS Code notification (Allow / Allow Always / Deny).</span>
        </div>
      )}

      {store.todo && (
        <ProgressTodoBlock todo={store.todo} isRunning={store.isRunning} header={todoHeader} />
      )}

      <ThoughtBlock
        reasoningText={lastReasoningText}
        startTime={store.reasoningStartTime}
        isRunning={store.isRunning}
      />

      <div className="chat-view">
        {store.subagents.length > 0 && <SubagentStrip />}

        <div className="chat-messages-wrapper">
          <div className="chat-messages">
            <MessageList messages={store.messages} />
          </div>
        </div>

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
          {store.isRunning && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--vscode-badge-foreground)] bg-[var(--vscode-badge-background)] px-1.5 py-0.5 rounded">
              <SpinnerIcon className="w-3 h-3" />
              Running
            </span>
          )}
        </div>

        <div className="chat-input">
          <ChatBottomBar referencedFiles={referencedFiles} />
        </div>
      </div>
    </>
  )
}

function ChatBottomBar({ referencedFiles }: { referencedFiles: string[] }) {
  const store = useChatStore()
  const [filesOpen, setFilesOpen] = useState(false)
  const fileCount = referencedFiles.length

  return (
    <div className="chat-bottom-bar">
      <div className="flex items-center gap-2 flex-shrink-0 min-w-0">
        {fileCount > 0 && (
          <details
            open={filesOpen}
            onToggle={(e) => setFilesOpen((e.target as HTMLDetailsElement).open)}
            className="flex-shrink-0 relative"
          >
            <summary className="list-none cursor-pointer text-[10px] text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] py-1 px-1.5 rounded hover:bg-[var(--vscode-list-hoverBackground)]">
              &gt; {fileCount} Files
            </summary>
            <div className="absolute bottom-full left-0 mb-1 max-h-48 overflow-y-auto rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] shadow-lg py-1 min-w-[200px] z-10">
              {referencedFiles.slice(0, 50).map((path, i) => (
                <div key={i} className="px-2 py-1 text-[10px] font-mono truncate text-[var(--vscode-foreground)]">
                  {path}
                </div>
              ))}
              {referencedFiles.length > 50 && (
                <div className="px-2 py-1 text-[10px] text-[var(--vscode-descriptionForeground)]">
                  +{referencedFiles.length - 50} more
                </div>
              )}
            </div>
          </details>
        )}
        <div className="hidden sm:flex items-center gap-1 flex-shrink-0">
          <ModeSelector />
        </div>
      </div>
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <InputBar />
        <button
          type="button"
          onClick={() => store.setView("settings")}
          title="Settings"
          className={BTN_CLASS}
        >
          <GearIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

function SessionsView() {
  const { sessions, sessionId, switchSession, sessionsLoading } = useChatStore()

  return (
    <div className="nexus-pane">
      <div className="nexus-pane-title">Session History</div>
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
          const date = new Date(s.ts).toLocaleString()
          return (
            <button
              key={s.id}
              className={`nexus-session-item ${isActive ? "nexus-session-item-active" : ""}`}
              onClick={() => switchSession(s.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] truncate">{s.id}</span>
                <span className="text-[10px] nexus-muted flex-shrink-0">{s.messageCount} msgs</span>
              </div>
              <div className="text-[10px] nexus-muted mt-0.5 truncate">{s.title ?? "Untitled session"}</div>
              <div className="text-[10px] nexus-muted mt-0.5">{date}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SubagentStrip() {
  const subagents = useChatStore((s) => s.subagents)
  return (
    <div className="nexus-subagent-strip">
      {subagents.map((a) => (
        <div
          key={a.id}
          className={`nexus-subagent-card ${
            a.status === "completed" ? "nexus-subagent-card-ok" : a.status === "error" ? "nexus-subagent-card-err" : ""
          }`}
        >
          <div className="nexus-subagent-head">
            <span className="font-mono text-[10px]">{a.id.slice(0, 12)}</span>
            <span className="text-[10px] uppercase">{a.mode}</span>
          </div>
          <div className="nexus-subagent-tool">Task</div>
          <div className="nexus-subagent-task">{a.task}</div>
          <div className="nexus-subagent-tool">
            {a.currentTool
              ? `Tool: ${a.currentTool}`
              : a.status === "completed"
                ? "Tool: completed"
                : a.status === "error"
                  ? "Tool: failed"
                  : "Tool: waiting"}
          </div>
          {a.error && <div className="nexus-subagent-error">{a.error}</div>}
        </div>
      ))}
    </div>
  )
}

interface SettingsDraft {
  modelProvider: string
  modelId: string
  modelApiKey: string
  modelBaseUrl: string
  modelTemperature: string
  maxEnabled: boolean
  maxTokenBudgetMultiplier: string
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
  mcpServersJson: string
  skillsText: string
  rulesFilesText: string
  claudeMdPath: string
  agentInstructions: string
  planInstructions: string
  askInstructions: string
  profilesJson: string
}

function SettingsView() {
  const { config, provider, model, saveConfig, serverUrl } = useChatStore()
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [serverUrlLocal, setServerUrlLocal] = useState(serverUrl)
  const [tab, setTab] = useState<"llm" | "embeddings" | "index" | "tools" | "integrations" | "profiles">("llm")

  useEffect(() => {
    setServerUrlLocal(serverUrl)
  }, [serverUrl])
  useEffect(() => {
    if (!config) return
    setDraft(toDraft(config, provider, model))
  }, [config, provider, model])

  const canSave = Boolean(draft)
  const vectorHint = useMemo(() => {
    if (!draft) return ""
    if (!draft.indexingVector || !draft.vectorDbEnabled) return "Vector search is disabled."
    if (!draft.embModel.trim()) return "Set embeddings model to enable semantic index."
    return "Vector search enabled (Qdrant-compatible)."
  }, [draft])

  if (!draft) {
    return (
      <div className="nexus-pane">
        <div className="nexus-pane-title">Settings</div>
        <div className="nexus-muted text-xs">Configuration is loading...</div>
      </div>
    )
  }

  return (
    <div className="nexus-pane">
      <div className="nexus-pane-title">Agent Settings</div>

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
        <TabPill id="integrations" tab={tab} setTab={setTab} label="MCP/Rules" />
        <TabPill id="profiles" tab={tab} setTab={setTab} label="Profiles" />
      </div>

      {tab === "llm" && (
        <>
          <section className="nexus-section">
            <h3 className="nexus-section-title">LLM</h3>
            <SettingsSelect
              label="Provider"
              value={draft.modelProvider}
              onChange={(v) => setDraft({ ...draft, modelProvider: v })}
              options={MODEL_PROVIDER_OPTIONS}
            />
            <SettingsInput label="Model" value={draft.modelId} onChange={(v) => setDraft({ ...draft, modelId: v })} />
            <SettingsInput label="Temperature (0-2)" value={draft.modelTemperature} onChange={(v) => setDraft({ ...draft, modelTemperature: v })} />
            <SettingsInput type="password" label="API Key" value={draft.modelApiKey} onChange={(v) => setDraft({ ...draft, modelApiKey: v })} />
            <SettingsInput label="Base URL" value={draft.modelBaseUrl} onChange={(v) => setDraft({ ...draft, modelBaseUrl: v })} />
            <div className="nexus-muted text-[10px]">Default context window fallback: 128k tokens.</div>
          </section>

          <section className="nexus-section">
            <h3 className="nexus-section-title">Max Mode</h3>
            <SettingsToggle
              label="Enable max mode"
              checked={draft.maxEnabled}
              onChange={(checked) => setDraft({ ...draft, maxEnabled: checked })}
            />
            <SettingsInput
              label="Token budget multiplier (1-6)"
              value={draft.maxTokenBudgetMultiplier}
              onChange={(v) => setDraft({ ...draft, maxTokenBudgetMultiplier: v })}
            />
            <div className="nexus-muted text-[10px]">Uses the same model/provider as LLM section, only increases depth and context budget.</div>
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
      <section className="nexus-section">
        <h3 className="nexus-section-title">Index & Vector DB</h3>
        <SettingsToggle
          label="Indexing enabled"
          checked={draft.indexingEnabled}
          onChange={(checked) => setDraft({ ...draft, indexingEnabled: checked })}
        />
        <SettingsToggle
          label="Vector index enabled"
          checked={draft.indexingVector}
          onChange={(checked) => setDraft({ ...draft, indexingVector: checked })}
        />
        <SettingsInput
          label="Embedding batch size"
          value={draft.embeddingBatchSize}
          onChange={(v) => setDraft({ ...draft, embeddingBatchSize: v })}
        />
        <SettingsInput
          label="Embedding concurrency"
          value={draft.embeddingConcurrency}
          onChange={(v) => setDraft({ ...draft, embeddingConcurrency: v })}
        />
        <SettingsToggle
          label="Vector DB enabled"
          checked={draft.vectorDbEnabled}
          onChange={(checked) => setDraft({ ...draft, vectorDbEnabled: checked })}
        />
        <SettingsToggle
          label="Vector DB auto-start"
          checked={draft.vectorDbAutoStart}
          onChange={(checked) => setDraft({ ...draft, vectorDbAutoStart: checked })}
        />
        <SettingsInput label="Vector DB URL" value={draft.vectorDbUrl} onChange={(v) => setDraft({ ...draft, vectorDbUrl: v })} />
        <div className="nexus-muted text-[10px]">{vectorHint}</div>
      </section>
      )}

      {tab === "tools" && (
      <section className="nexus-section">
        <h3 className="nexus-section-title">Tools & Skills Filtering</h3>
        <SettingsToggle
          label="Filter tools when list is large"
          checked={draft.filterTools}
          onChange={(checked) => setDraft({ ...draft, filterTools: checked })}
        />
        <SettingsInput
          label="Tool threshold"
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
      </section>
      )}

      {tab === "integrations" && (
      <section className="nexus-section">
        <h3 className="nexus-section-title">MCP, Skills, Rules & Instructions</h3>
        <SettingsTextarea
          label="MCP servers (JSON array)"
          value={draft.mcpServersJson}
          onChange={(v) => setDraft({ ...draft, mcpServersJson: v })}
          rows={4}
        />
        <SettingsTextarea
          label="Skills paths (one per line)"
          value={draft.skillsText}
          onChange={(v) => setDraft({ ...draft, skillsText: v })}
          rows={3}
        />
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
      </section>
      )}

      {tab === "profiles" && (
      <section className="nexus-section">
        <h3 className="nexus-section-title">Agent Profiles</h3>
        <SettingsTextarea
          label='Profiles JSON object (saved in project config; global presets are loaded from ~/.nexus/nexus.yaml)'
          value={draft.profilesJson}
          onChange={(v) => setDraft({ ...draft, profilesJson: v })}
          rows={5}
        />
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

function TabPill({
  id,
  tab,
  setTab,
  label,
}: {
  id: "llm" | "embeddings" | "index" | "tools" | "integrations" | "profiles"
  tab: "llm" | "embeddings" | "index" | "tools" | "integrations" | "profiles"
  setTab: (tab: "llm" | "embeddings" | "index" | "tools" | "integrations" | "profiles") => void
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
    maxEnabled: Boolean(config.maxMode.enabled),
    maxTokenBudgetMultiplier: toInputNumber(config.maxMode.tokenBudgetMultiplier ?? 2),
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
    filterTools: (config.tools.classifyThreshold ?? 15) < 9000,
    toolClassifyThreshold: String(config.tools.classifyThreshold ?? 15),
    filterSkills: (config.skillClassifyThreshold ?? 8) < 9000,
    skillClassifyThreshold: String(config.skillClassifyThreshold ?? 8),
    parallelReads: Boolean(config.tools.parallelReads),
    maxParallelReads: String(config.tools.maxParallelReads ?? 5),
    mcpServersJson: JSON.stringify(config.mcp?.servers ?? [], null, 2),
    skillsText: (config.skills ?? []).join("\n"),
    rulesFilesText: (config.rules?.files ?? []).filter((f) => !/CLAUDE\.md$/i.test(f)).join("\n"),
    claudeMdPath: (config.rules?.files ?? []).find((f) => /CLAUDE\.md$/i.test(f)) ?? "CLAUDE.md",
    agentInstructions: config.modes?.agent?.customInstructions ?? "",
    planInstructions: config.modes?.plan?.customInstructions ?? "",
    askInstructions: config.modes?.ask?.customInstructions ?? "",
    profilesJson: JSON.stringify(config.profiles ?? {}, null, 2),
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
  const maxTokenBudgetMultiplier = parseMaxMultiplier(draft.maxTokenBudgetMultiplier)
  const embDimensions = parseIntOrUndefined(draft.embDimensions)
  const embProviderRaw = draft.embProvider.trim() || "openai"
  const embProvider = embProviderRaw === "openrouter" ? "openai-compatible" : embProviderRaw
  const embBaseUrlRaw = draft.embBaseUrl.trim()
  const embBaseUrl = embProvider === "openai-compatible"
    ? (isLikelyHttpUrl(embBaseUrlRaw) ? embBaseUrlRaw : "https://openrouter.ai/api/v1")
    : (embBaseUrlRaw || undefined)
  const toolThresholdRaw = parsePositiveInt(draft.toolClassifyThreshold, 15)
  const skillThresholdRaw = parsePositiveInt(draft.skillClassifyThreshold, 8)
  const mcpServers = parseJsonArray(draft.mcpServersJson)
  const skills = linesToList(draft.skillsText)
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
    },
    maxMode: {
      enabled: draft.maxEnabled,
      tokenBudgetMultiplier: maxTokenBudgetMultiplier,
    },
    embeddings: draft.embModel.trim()
      ? {
          provider: embProvider as "openai" | "openai-compatible" | "ollama" | "local",
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
      classifyThreshold: draft.filterTools ? toolThresholdRaw : 9999,
      parallelReads: draft.parallelReads,
      maxParallelReads: parsePositiveInt(draft.maxParallelReads, 5),
      custom: [],
    },
    skillClassifyThreshold: draft.filterSkills ? skillThresholdRaw : 9999,
    mcp: {
      servers: mcpServers,
    },
    skills,
    rules: {
      files: [...(claudePath ? [claudePath] : []), ...ruleFiles],
    },
    modes: {
      agent: { customInstructions: draft.agentInstructions.trim() || undefined },
      plan: { customInstructions: draft.planInstructions.trim() || undefined },
      ask: { customInstructions: draft.askInstructions.trim() || undefined },
    },
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

function parseMaxMultiplier(value: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 2
  return Math.max(1, Math.min(6, n))
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
  options: string[]
}) {
  return (
    <label className="nexus-field">
      <span className="nexus-field-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="nexus-input">
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
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
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.floor((progress / total) * 100))) : 0
  return (
    <div className="px-3 py-1 border-b border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)]">
      <div className="flex items-center justify-between text-[10px] text-[var(--vscode-descriptionForeground)] mb-1">
        <span>Indexing codebase...</span>
        <span>{progress}/{total}</span>
      </div>
      {typeof status.chunksProcessed === "number" && typeof status.chunksTotal === "number" && (
        <div className="text-[10px] text-[var(--vscode-descriptionForeground)] mb-1">
          Chunks: {status.chunksProcessed}/{status.chunksTotal}
        </div>
      )}
      <div className="w-full h-1 rounded-full bg-[var(--vscode-progressBar-background)]/30 overflow-hidden">
        <div
          className="h-full bg-[var(--nexus-accent)] transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
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
