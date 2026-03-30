import { create } from "zustand"
import { postMessage } from "../vscode.js"
import type { ModelsCatalogFromCore, AgentPresetFromCore, AutocompleteExtensionUiState } from "../types/messages.js"

/** Detects a new plan snapshot so the full follow-up panel re-opens. */
let planFollowupTextFingerprint: string | null = null

// --- Stream idempotency guard ---
// Some transports can replay events (reconnect, server shadow + snapshot merge). Without stable event ids,
// we dedupe the most repeat-prone events via a small rolling fingerprint set.
const RECENT_EVENT_FINGERPRINTS_MAX = 800
const recentEventFingerprints = new Set<string>()
const recentEventFingerprintQueue: string[] = []
function seenRecently(fingerprint: string): boolean {
  if (recentEventFingerprints.has(fingerprint)) return true
  recentEventFingerprints.add(fingerprint)
  recentEventFingerprintQueue.push(fingerprint)
  if (recentEventFingerprintQueue.length > RECENT_EVENT_FINGERPRINTS_MAX) {
    const oldest = recentEventFingerprintQueue.shift()
    if (oldest) recentEventFingerprints.delete(oldest)
  }
  return false
}

export type Mode = "agent" | "plan" | "ask" | "debug" | "review"
export type AppView = "chat" | "sessions" | "settings"

export type IndexStatusKind =
  | { state: "idle" }
  | { state: "stopping"; message?: string }
  | {
      state: "indexing"
      progress: number
      total: number
      chunksProcessed?: number
      chunksTotal?: number
      overallPercent?: number
      phase?: "parsing" | "embedding"
      message?: string
      watcherQueue?: boolean
      paused?: boolean
    }
  | { state: "ready"; files: number; symbols: number; chunks?: number }
  | { state: "error"; error: string }

export interface SessionMessage {
  id: string
  ts: number
  role: "user" | "assistant" | "system" | "tool"
  content: string | MessagePart[]
  summary?: boolean
  presetName?: string
}

export type MessagePart = TextPart | ToolPart | ReasoningPart
export interface TextPart { type: "text"; text: string; user_message?: string }
export interface ReasoningPart {
  type: "reasoning"
  text: string
  durationMs?: number
  reasoningId?: string
  providerMetadata?: Record<string, unknown>
}
export interface ToolPart {
  type: "tool"
  id: string
  tool: string
  status: "pending" | "running" | "completed" | "error"
  input?: Record<string, unknown>
  output?: string
  error?: string
  timeStart?: number
  timeEnd?: number
  compacted?: boolean
  /** Set from tool_end for write_to_file/replace_in_file */
  path?: string
  /** Set from tool_end for write_to_file/replace_in_file */
  diffStats?: { added: number; removed: number }
  /** Line-by-line diff for UI (red/green); set from tool_end when available */
  diffHunks?: Array<{ type: string; lineNum: number; line: string }>
  /** Edit tool: snippets that were replaced (compact preview); full +/- counts stay in diffStats */
  appliedReplacements?: Array<{ oldSnippet: string; newSnippet: string }>
  /** Subagents for SpawnAgent: filled by subagent_start/tool_start/done, shown inline under this tool card */
  subagents?: SubAgentState[]
}

export interface NexusConfigState {
  model: {
    provider: string
    id: string
    apiKey?: string
    baseUrl?: string
    temperature?: number
    reasoningEffort?: string
    contextWindow?: number
  }
  embeddings?: {
    provider: "openai" | "openai-compatible" | "ollama" | "local"
    model: string
    baseUrl?: string
    apiKey?: string
    dimensions?: number
  }
  indexing: {
    enabled: boolean
    vector: boolean
    symbolExtract: boolean
    batchSize: number
    embeddingBatchSize: number
    embeddingConcurrency: number
    maxPendingEmbedBatches?: number
    batchProcessingConcurrency?: number
    maxIndexedFiles?: number
    searchWhileIndexing?: boolean
    maxIndexingFailureRate?: number
    debounceMs: number
    excludePatterns: string[]
  }
  vectorDb?: {
    enabled: boolean
    url: string
    collection: string
    autoStart: boolean
    apiKey?: string
  }
  tools: {
    classifyToolsEnabled?: boolean
    classifyThreshold: number
    parallelReads: boolean
    maxParallelReads: number
    custom: string[]
  }
  skillClassifyEnabled?: boolean
  skillClassifyThreshold: number
  mcp: {
    servers: Array<{
      name: string
      command?: string
      args?: string[]
      env?: Record<string, string>
      url?: string
      transport?: "stdio" | "http" | "sse"
      enabled?: boolean
    }>
  }
  /** For UI: path + enabled. skills is derived (enabled only). */
  skillsConfig?: Array<{ path: string; enabled: boolean }>
  skills: string[]
  /** Remote skill registry base URLs (optional). */
  skillsUrls?: string[]
  rules: {
    files: string[]
  }
  modes: {
    agent?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    plan?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    ask?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    debug?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    review?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    [key: string]: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string } | undefined
  }
  permissions?: {
    autoApproveRead: boolean
    autoApproveWrite: boolean
    autoApproveCommand: boolean
    autoApproveMcp?: boolean
    autoApproveBrowser?: boolean
    autoApproveSkillLoad?: boolean
    autoApproveReadPatterns?: string[]
    allowedCommands?: string[]
    allowCommandPatterns?: string[]
    denyCommandPatterns?: string[]
    askCommandPatterns?: string[]
    allowedMcpTools?: string[]
  }
  /** UI preferences. showReasoningInChat: when true, text_delta shown as muted; when false, only tool text. */
  ui?: { showReasoningInChat?: boolean }
  profiles: Record<string, Partial<{ provider: string; id: string; apiKey: string; baseUrl: string; temperature: number; reasoningEffort: string; contextWindow: number }>>
}

export interface SubAgentState {
  id: string
  mode: Mode
  task: string
  status: "running" | "completed" | "error"
  currentTool?: string
  toolHistory: string[]
  toolUsesCount: number
  startedAt: number
  finishedAt?: number
  error?: string
}

function shortenSubagentValue(value: unknown, max = 52): string {
  if (typeof value !== "string") return ""
  const one = value.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

function getSubagentToolLabel(tool: string, input?: Record<string, unknown>): string {
  const path = shortenSubagentValue(input?.path ?? input?.file_path)
  const pattern = shortenSubagentValue(input?.pattern ?? input?.query)
  const command = shortenSubagentValue(input?.command, 44)
  const normalized = tool.trim()
  if (normalized === "Read" || normalized === "read_file") return path ? `Read(${path})` : "Read(file)"
  if (normalized === "List" || normalized === "list_dir") return path ? `List(${path})` : "List(.)"
  if (normalized === "Grep" || normalized === "grep") return pattern ? `Grep(${pattern})` : "Grep"
  if (normalized === "Glob" || normalized === "glob") return pattern ? `Glob(${pattern})` : "Glob"
  if (normalized === "Bash" || normalized === "execute_command") return command ? `Bash(${command})` : "Bash"
  return normalized
}

function reduceSubagentState(list: SubAgentState[], event:
  | { type: "subagent_start"; subagentId: string; mode: Mode; task: string }
  | { type: "subagent_tool_start"; subagentId: string; tool: string; input?: Record<string, unknown> }
  | { type: "subagent_tool_end"; subagentId: string; tool: string; success: boolean }
  | { type: "subagent_done"; subagentId: string; success: boolean; error?: string }): SubAgentState[] {
  switch (event.type) {
    case "subagent_start": {
      const next = list.filter((item) => item.id !== event.subagentId)
      next.push({
        id: event.subagentId,
        mode: event.mode,
        task: event.task,
        status: "running",
        currentTool: undefined,
        toolHistory: [],
        toolUsesCount: 0,
        startedAt: Date.now(),
      })
      return next
    }
    case "subagent_tool_start": {
      const label = getSubagentToolLabel(event.tool, event.input)
      return list.map((item) =>
        item.id === event.subagentId
          ? {
              ...item,
              status: "running" as const,
              currentTool: label,
              toolUsesCount: item.toolUsesCount + 1,
              toolHistory: [...item.toolHistory, label].slice(-16),
            }
          : item
      )
    }
    case "subagent_tool_end":
      return list.map((item) =>
        item.id === event.subagentId
          ? {
              ...item,
              status: (event.success ? "running" : "error") as "running" | "error",
              currentTool: event.success ? undefined : event.tool,
            }
          : item
      )
    case "subagent_done":
      return list.map((item) =>
        item.id === event.subagentId
          ? {
              ...item,
              status: (event.success ? "completed" : "error") as "completed" | "error",
              currentTool: undefined,
              finishedAt: Date.now(),
              error: event.error,
            }
          : item
      )
  }
}

function findToolPartIndexForSubagent(parts: MessagePart[], subagentId: string, parentPartId?: string | null): number {
  const byExistingSubagent = parts.findIndex(
    (part) => part.type === "tool" && (part as ToolPart).subagents?.some((subagent) => subagent.id === subagentId)
  )
  if (byExistingSubagent >= 0) return byExistingSubagent
  if (parentPartId && parentPartId.trim().length > 0) {
    return parts.findIndex((part) => part.type === "tool" && (part as ToolPart).id === parentPartId)
  }
  return -1
}

type ApprovalAction = {
  type: "write" | "execute" | "mcp" | "browser" | "read" | "doom_loop"
  tool: string
  description: string
  content?: string
  diff?: string
  diffStats?: { added: number; removed: number }
}

interface SessionPreview {
  id: string
  ts: number
  title?: string
  messageCount: number
}

interface ChatState {
  messages: SessionMessage[]
  mode: Mode
  isRunning: boolean
  awaitingApproval: boolean
  model: string
  provider: string
  sessionId: string
  todo: string
  indexReady: boolean
  indexStatus: IndexStatusKind
  /** Shown when vector DB is starting (Qdrant + indexer). Cleared on vector_db_ready or index_update. */
  vectorDbProgressMessage: string | null
  contextUsedTokens: number
  contextLimitTokens: number
  contextPercent: number
  inputValue: string
  view: AppView
  /** Images attached to the next message (base64 data, no data URL prefix). */
  attachedImages: Array<{ id: string; data: string; mimeType: string }>
  /** Queued messages to send one by one when agent finishes. */
  queuedMessages: Array<{ id: string; text: string }>
  sessions: SessionPreview[]
  /** True while session list is being fetched (e.g. from server). */
  sessionsLoading: boolean
  /** Optimistic deletions: hide sessions until a fresh list confirms removal or the tombstone expires. */
  pendingDeletedSessionIds: Record<string, number>
  config: NexusConfigState | null
  /** Compaction: none | compacting (inline in chat list, Thought-style). */
  compactionUi: "none" | "compacting"
  /** When automatic compaction started (for duration). */
  compactionStartTime: number | null
  /** Completed compaction rows (chronological, like collapsed Thought). */
  compactionLog: Array<{ id: string; durationSec: number }>
  subagents: SubAgentState[]
  /** partId of the last tool_start(SpawnAgent); used to attach subagent_start to that part */
  lastSpawnAgentPartId: string | null
  selectedProfile: string
  projectDir: string
  /** When the current reasoning block started (for "Thought for Xs" display) */
  reasoningStartTime: number | null
  /** Active reasoning stream identity, used to match start/delta/end robustly across snapshots. */
  activeReasoning: { messageId: string; reasoningId: string } | null
  /** NexusCode server URL (nexuscode.serverUrl). When set, extension uses server for sessions and runs. */
  serverUrl: string
  /** When using server: connection state for UI (connecting/streaming/error). */
  connectionState: "idle" | "connecting" | "streaming" | "error"
  /** When connectionState === "error": message to show; user can retry by sending again. */
  serverConnectionError: string | null
  /** MCP server test results: name -> status (ok/error) and optional error message */
  mcpStatus: Array<{ name: string; status: "ok" | "error"; error?: string }>
  /** When set, show in-webview approval bar (Allow / Deny) instead of only VS Code notification */
  pendingApproval: { partId: string; action: { type: string; tool: string; description: string; content?: string; diff?: string; diffStats?: { added: number; removed: number } } } | null

  /** Checkpoint entries for rollback (Cline-style). */
  checkpointEntries: Array<{ hash: string; ts: number; description?: string; messageId?: string }>
  /** Whether checkpoints are enabled (from config or current run). */
  checkpointEnabled: boolean

  /** Plan mode: plan_exit was called; show New session / Continue / Dismiss (Kilocode-style). */
  planCompleted: boolean
  /** Plan text for "New session" option. */
  planFollowupText: string | null
  /** When true, show a one-line plan strip instead of the full follow-up UI (e.g. while plan is being revised). */
  planPanelCollapsed: boolean
  pendingQuestionRequest: {
    requestId: string
    title?: string
    submitLabel?: string
    customOptionLabel?: string
    questions: Array<{ id: string; question: string; options: Array<{ id: string; label: string }>; allowCustom?: boolean }>
  } | null
  /**
   * Request id the user just dismissed/submitted locally; ignore same id in following stateUpdate
   * so a debounced extension state post cannot flash the questionnaire again.
   */
  suppressedQuestionRequestId: string | null

  /** Server session: there are older messages above the loaded window; show "Load older". */
  hasOlderMessages: boolean
  /** True while older messages are being fetched. */
  loadingOlderMessages: boolean

  /** Session unaccepted edits for "N Files" panel (Undo All / Keep All / Review). */
  sessionUnacceptedEdits: Array<{ path: string; diffStats: { added: number; removed: number }; isNewFile?: boolean }>

  /** Models catalog from models.dev (for Select model in Settings). Same shape as core ModelsCatalog. */
  modelsCatalog: ModelsCatalogFromCore | null
  modelsCatalogLoading: boolean
  requestModelsCatalog: () => void
  handleModelsCatalog: (catalog: ModelsCatalogFromCore) => void

  /** Agent presets from .nexus/agent-configs.json. */
  agentPresets: AgentPresetFromCore[]
  requestAgentPresets: () => void
  handleAgentPresets: (presets: AgentPresetFromCore[]) => void

  /** Active preset for the next user message (does NOT modify saved config). */
  activePresetName: string
  setActivePresetName: (name: string) => void

  /** Options for creating a preset (skills, MCP, rules) — loaded when opening create modal. */
  agentPresetOptions: { skills: string[]; mcpServers: string[]; rulesFiles: string[] } | null
  requestAgentPresetOptions: () => void
  handleAgentPresetOptions: (options: { skills: string[]; mcpServers: string[]; rulesFiles: string[] } | null) => void

  /** Loaded skill definitions (name, path, summary) for Settings → Skills list. */
  skillDefinitions: Array<{ name: string; path: string; summary: string }>
  handleSkillDefinitions: (definitions: Array<{ name: string; path: string; summary: string }>) => void

  /** True after first stateUpdate received — prevents flash during initial load. */
  isInitialized: boolean
  /** Last applied stateUpdateSeq (monotonic); used to ignore stale snapshots. */
  lastStateUpdateSeq: number

  /** VS Code nexuscode.autocomplete.* (Editor inline completion). */
  autocompleteExtension: AutocompleteExtensionUiState | null

  /** When opening Settings from a slash command, open this tab (cleared after applied). */
  initialSettingsTab: "llm" | "embeddings" | "index" | "tools" | "integrations" | "presets" | null
  /** When opening Settings → Integrations, open this sub-tab (cleared after applied). */
  initialSettingsIntegTab: "marketplace" | "rules-skills" | "mcp" | "rules-instructions" | null
  clearInitialSettingsTab: () => void

  // Actions
  setView: (view: AppView, options?: { settingsTab?: "llm" | "embeddings" | "index" | "tools" | "integrations" | "presets"; settingsIntegTab?: "marketplace" | "rules-skills" | "mcp" | "rules-instructions" }) => void
  setInputValue: (v: string) => void
  appendToInput: (v: string) => void
  addAttachedImage: (data: string, mimeType: string) => void
  removeAttachedImage: (id: string) => void
  addToQueue: (text: string) => void
  removeFromQueue: (id: string) => void
  addToQueueFront: (text: string) => void
  editQueuedToInput: (id: string) => void
  sendQueuedImmediately: (id: string) => void
  setMode: (mode: Mode) => void
  setProfile: (profileName: string) => void
  sendMessage: (content: string, options?: { displayText?: string }) => void
  abort: () => void
  compact: () => void
  clearChat: () => void
  forkSession: (messageId: string) => void
  switchSession: (sessionId: string) => void
  createNewSession: () => void
  deleteSession: (sessionId: string) => void
  reindex: () => void
  clearIndex: () => void
  saveConfig: (patch: Record<string, unknown>) => void
  restoreCheckpoint: (hash: string, restoreType: "task" | "workspace" | "taskAndWorkspace") => void
  showCheckpointDiff: (fromHash: string, toHash?: string) => void
  openSessionEditDiff: (path: string) => void
  undoSessionEdits: () => void
  keepAllSessionEdits: () => void
  revertSessionEditFile: (path: string) => void
  acceptSessionEditFile: (path: string) => void
  handleStateUpdate: (state: Partial<ChatState>) => void
  handleConfigLoaded: (config: NexusConfigState) => void
  handleAgentEvent: (event: AgentEvent) => void
  handleIndexStatus: (status: IndexStatusKind) => void
  handleMcpServerStatus: (results: Array<{ name: string; status: "ok" | "error"; error?: string }>) => void
  handlePendingApproval: (partId: string, action: { type: string; tool: string; description: string; content?: string }) => void
  resolveApproval: (approved: boolean, alwaysApprove?: boolean, addToAllowedCommand?: string, skipAll?: boolean, whatToDoInstead?: string) => void
  clearPendingQuestionRequest: () => void
  /** Collapse the plan follow-up block (user submitted dismiss/revise/implement or minimized). */
  collapsePlanPanel: () => void
  expandPlanPanel: () => void
  handleSessionList: (sessions: SessionPreview[]) => void
  handleSessionListLoading: (loading: boolean) => void
}

export type AgentEvent =
  | { type: "assistant_message_started"; messageId: string }
  | { type: "assistant_content_complete"; messageId: string }
  | { type: "text_delta"; delta: string; messageId: string; user_message_delta?: string }
  | { type: "reasoning_start"; messageId: string; reasoningId: string; providerMetadata?: Record<string, unknown> }
  | { type: "reasoning_delta"; delta: string; messageId: string; reasoningId?: string; providerMetadata?: Record<string, unknown> }
  | { type: "reasoning_end"; messageId: string; reasoningId?: string; providerMetadata?: Record<string, unknown> }
  | { type: "tool_start"; tool: string; partId: string; messageId: string; input?: Record<string, unknown> }
  | { type: "tool_end"; tool: string; partId: string; messageId: string; success: boolean; output?: string; error?: string; compacted?: boolean; path?: string; diffStats?: { added: number; removed: number }; diffHunks?: Array<{ type: string; lineNum: number; line: string }>; appliedReplacements?: Array<{ oldSnippet: string; newSnippet: string }> }
  | { type: "subagent_start"; subagentId: string; mode: Mode; task: string; parentPartId?: string }
  | { type: "subagent_tool_start"; subagentId: string; tool: string; input?: Record<string, unknown>; parentPartId?: string }
  | { type: "subagent_tool_end"; subagentId: string; tool: string; success: boolean; parentPartId?: string }
  | { type: "subagent_done"; subagentId: string; success: boolean; outputPreview?: string; error?: string; parentPartId?: string }
  | { type: "tool_approval_needed"; action: ApprovalAction; partId: string }
  | { type: "question_request"; request: { requestId: string; title?: string; submitLabel?: string; customOptionLabel?: string; questions: Array<{ id: string; question: string; options: Array<{ id: string; label: string }>; allowCustom?: boolean }> }; partId?: string }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "index_update"; status: IndexStatusKind }
  | { type: "vector_db_progress"; message?: string }
  | { type: "vector_db_ready" }
  | { type: "context_usage"; usedTokens: number; limitTokens: number; percent: number }
  | { type: "error"; error: string; fatal?: boolean }
  | { type: "done"; messageId: string }
  | { type: "todo_updated"; todo: string }
  | { type: "doom_loop_detected"; tool: string }

const THOUGHT_PLACEHOLDER = "Model reasoning is active, but the provider has not streamed visible reasoning text yet."

/** Index from the end of `parts` of the open reasoning segment for `reasoningId` (no durationMs yet). */
function findOpenReasoningReverseIndex(parts: MessagePart[], reasoningId: string): number {
  return [...parts].reverse().findIndex(
    (p) =>
      p.type === "reasoning" &&
      (p as ReasoningPart).durationMs == null &&
      ((p as ReasoningPart).reasoningId ?? "reasoning-0") === reasoningId
  )
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  mode: "agent",
  isRunning: false,
  awaitingApproval: false,
  model: "claude-sonnet-4-5",
  provider: "anthropic",
  sessionId: "",
  todo: "",
  indexReady: false,
  indexStatus: { state: "idle" },
  vectorDbProgressMessage: null,
  contextUsedTokens: 0,
  contextLimitTokens: 128000,
  contextPercent: 0,
  inputValue: "",
  view: "chat",
  attachedImages: [],
  queuedMessages: [],
  sessions: [],
  sessionsLoading: false,
  pendingDeletedSessionIds: {},
  config: null,
  compactionUi: "none",
  compactionStartTime: null,
  compactionLog: [],
  subagents: [],
  lastSpawnAgentPartId: null,
  selectedProfile: "",
  projectDir: "",
  reasoningStartTime: null,
  activeReasoning: null,
  serverUrl: "",
  connectionState: "idle",
  serverConnectionError: null,
  mcpStatus: [],
  pendingApproval: null,

  isInitialized: false,
  lastStateUpdateSeq: 0,
  autocompleteExtension: null,
  initialSettingsTab: null,
  initialSettingsIntegTab: null,
  modelsCatalog: null,
  modelsCatalogLoading: false,
  checkpointEntries: [],
  checkpointEnabled: false,
  planCompleted: false,
  planFollowupText: null,
  planPanelCollapsed: false,
  pendingQuestionRequest: null,
  suppressedQuestionRequestId: null,
  hasOlderMessages: false,
  loadingOlderMessages: false,
  sessionUnacceptedEdits: [],
  requestModelsCatalog: () => {
    set({ modelsCatalogLoading: true })
    postMessage({ type: "getModelsCatalog" })
  },
  handleModelsCatalog: (catalog: ModelsCatalogFromCore) => {
    set({ modelsCatalog: catalog, modelsCatalogLoading: false })
  },

  agentPresets: [],
  requestAgentPresets: () => {
    postMessage({ type: "getAgentPresets" })
  },
  handleAgentPresets: (presets: AgentPresetFromCore[]) => {
    set({ agentPresets: presets })
  },

  activePresetName: "Default",
  setActivePresetName: (name: string) => {
    const trimmed = (name ?? "").trim() || "Default"
    set({ activePresetName: trimmed })
    postMessage({ type: "setChatPreset", presetName: trimmed })
  },

  agentPresetOptions: null,
  requestAgentPresetOptions: () => {
    postMessage({ type: "getAgentPresetOptions" })
  },
  handleAgentPresetOptions: (options: { skills: string[]; mcpServers: string[]; rulesFiles: string[] } | null) => {
    set({ agentPresetOptions: options })
  },

  skillDefinitions: [],
  handleSkillDefinitions: (definitions: Array<{ name: string; path: string; summary: string }>) => {
    set({ skillDefinitions: definitions })
  },

  clearInitialSettingsTab: () => set({ initialSettingsTab: null, initialSettingsIntegTab: null }),
  setView: (view, options) => {
    set((prev) => {
      const next: Partial<ChatState> = { view }
      if (view === "sessions") postMessage({ type: "getState" })
      if (view === "settings" && options?.settingsTab) next.initialSettingsTab = options.settingsTab
      if (view === "settings" && options?.settingsIntegTab) next.initialSettingsIntegTab = options.settingsIntegTab
      return next
    })
  },
  setInputValue: (v) => set({ inputValue: v }),

  addAttachedImage: (data, mimeType) => set((prev) => ({
    attachedImages: [...prev.attachedImages, { id: `img_${Date.now()}_${Math.random().toString(36).slice(2)}`, data, mimeType }],
  })),
  removeAttachedImage: (id) => set((prev) => ({
    attachedImages: prev.attachedImages.filter((img) => img.id !== id),
  })),

  addToQueue: (text) => set((prev) => {
    const trimmed = text.trim()
    if (!trimmed) return prev
    return {
      queuedMessages: [
        ...prev.queuedMessages,
        { id: `q_${Date.now()}_${Math.random().toString(36).slice(2)}`, text: trimmed },
      ],
    }
  }),
  removeFromQueue: (id) => set((prev) => ({
    queuedMessages: prev.queuedMessages.filter((q) => q.id !== id),
  })),
  addToQueueFront: (text) => set((prev) => {
    const trimmed = text.trim()
    if (!trimmed) return prev
    return {
      queuedMessages: [
        { id: `q_${Date.now()}_${Math.random().toString(36).slice(2)}`, text: trimmed },
        ...prev.queuedMessages,
      ],
    }
  }),
  editQueuedToInput: (id) => {
    const item = get().queuedMessages.find((q) => q.id === id)
    if (item) {
      set((prev) => ({
        inputValue: item.text,
        queuedMessages: prev.queuedMessages.filter((q) => q.id !== id),
      }))
    }
  },
  sendQueuedImmediately: (id) => {
    const item = get().queuedMessages.find((q) => q.id === id)
    if (!item) return
    const { isRunning, sendMessage, removeFromQueue, addToQueueFront } = get()
    removeFromQueue(id)
    if (isRunning) addToQueueFront(item.text)
    else sendMessage(item.text)
  },

  appendToInput: (v) => set((prev) => ({
    inputValue: prev.inputValue ? `${prev.inputValue}\n\n${v}` : v,
  })),

  setMode: (mode) => {
    set({ mode })
    postMessage({ type: "setMode", mode })
  },

  setProfile: (profileName) => {
    set({ selectedProfile: profileName })
    postMessage({ type: "setProfile", profile: profileName })
  },

  sendMessage: (content, options) => {
    const { mode, isRunning, attachedImages, compact, activePresetName } = get()
    if (isRunning) return
    const text = (typeof content === "string" ? content : "").trim()
    if (!text) return
    const displayText = (options?.displayText ?? text).trim()
    if (isSlashCommand(text, "compact")) {
      compact()
      set({ inputValue: "", attachedImages: [] })
      return
    }
    const reviewRequested = isSlashCommand(text, "review")
    const runMode: Mode = reviewRequested ? "review" : mode
    const runContent = reviewRequested ? buildReviewPromptFromSlash(text) : text
    set((prev) => ({
      inputValue: "",
      attachedImages: [],
      isRunning: true,
      view: "chat",
      messages: [
        ...prev.messages,
        {
          id: `local_user_${Date.now()}`,
          ts: Date.now(),
          role: "user",
          content: displayText || text,
          presetName: activePresetName,
        },
      ],
    }))
    postMessage({
      type: "newMessage",
      content: runContent,
      mode: runMode,
      images: attachedImages.length > 0 ? attachedImages.map((img) => ({ data: img.data, mimeType: img.mimeType })) : undefined,
      presetName: activePresetName,
    })
  },

  abort: () => {
    postMessage({ type: "abort" })
    set((s) => ({
      isRunning: false,
      ...(s.compactionUi === "compacting"
        ? { compactionUi: "none" as const, compactionStartTime: null }
        : {}),
    }))
  },

  compact: () => {
    postMessage({ type: "compact" })
  },

  clearChat: () => {
    planFollowupTextFingerprint = null
    postMessage({ type: "clearChat" })
    set({
      messages: [],
      todo: "",
      view: "chat",
      subagents: [],
      lastSpawnAgentPartId: null,
      planCompleted: false,
      planFollowupText: null,
      planPanelCollapsed: false,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      compactionUi: "none",
      compactionStartTime: null,
      compactionLog: [],
    })
  },

  forkSession: (messageId) => {
    postMessage({ type: "forkSession", messageId })
  },

  switchSession: (sessionId) => {
    postMessage({ type: "switchSession", sessionId })
    set({ view: "chat" })
  },

  createNewSession: () => {
    postMessage({ type: "createNewSession" })
    set({ view: "chat" })
  },

  deleteSession: (sessionId) => {
    postMessage({ type: "deleteSession", sessionId })
    set((prev) => ({
      sessions: prev.sessions.filter((s) => s.id !== sessionId),
      pendingDeletedSessionIds: {
        ...prev.pendingDeletedSessionIds,
        [sessionId]: Date.now(),
      },
    }))
  },

  reindex: () => {
    postMessage({ type: "reindex" })
  },

  clearIndex: () => {
    postMessage({ type: "clearIndex" })
  },

  saveConfig: (patch) => {
    postMessage({ type: "saveConfig", config: patch })
  },

  restoreCheckpoint: (hash, restoreType) => {
    postMessage({ type: "restoreCheckpoint", hash, restoreType })
  },

  showCheckpointDiff: (fromHash, toHash) => {
    postMessage({ type: "showCheckpointDiff", fromHash, toHash })
  },

  openSessionEditDiff: (path) => {
    postMessage({ type: "openSessionEditDiff", path })
  },
  undoSessionEdits: () => {
    postMessage({ type: "undoSessionEdits" })
  },
  keepAllSessionEdits: () => {
    postMessage({ type: "keepAllSessionEdits" })
  },
  revertSessionEditFile: (path) => {
    postMessage({ type: "revertSessionEditFile", path })
  },
  acceptSessionEditFile: (path) => {
    postMessage({ type: "acceptSessionEditFile", path })
  },

  handleStateUpdate: (state) => {
    set((prev) => {
      const incomingSeq = (state as { stateUpdateSeq?: unknown }).stateUpdateSeq
      if (typeof incomingSeq === "number" && Number.isFinite(incomingSeq)) {
        if (incomingSeq <= (prev.lastStateUpdateSeq ?? 0)) {
          // Stale snapshot; ignore entirely so it can't overwrite newer streamed state.
          return { ...prev, isInitialized: true }
        }
      }
      let suppressedQuestionRequestId = prev.suppressedQuestionRequestId
      const incomingPending = state.pendingQuestionRequest

      if (incomingPending !== undefined) {
        if (incomingPending === null) {
          suppressedQuestionRequestId = null
        } else if (suppressedQuestionRequestId != null && incomingPending.requestId !== suppressedQuestionRequestId) {
          suppressedQuestionRequestId = null
        }
      }

      const next = {
        ...prev,
        ...state,
        isInitialized: true,
        suppressedQuestionRequestId,
        lastStateUpdateSeq:
          typeof incomingSeq === "number" && Number.isFinite(incomingSeq)
            ? incomingSeq
            : (prev.lastStateUpdateSeq ?? 0),
      }
      if (typeof state.sessionId === "string" && state.sessionId !== prev.sessionId && prev.sessionId !== "") {
        next.compactionLog = []
        next.compactionUi = "none"
        next.compactionStartTime = null
      }
      if (state.pendingQuestionRequest !== undefined) {
        const inc = state.pendingQuestionRequest
        const hideStale =
          inc != null &&
          suppressedQuestionRequestId != null &&
          inc.requestId === suppressedQuestionRequestId
        next.pendingQuestionRequest = hideStale ? null : inc
      }
      if (
        state.messages != null &&
        Array.isArray(state.messages) &&
        (
          (typeof state.sessionId === "string" && state.sessionId === prev.sessionId) ||
          (typeof state.sessionId === "string" && !prev.sessionId) ||
          state.sessionId == null
        )
      ) {
        next.messages = mergeStateMessagesForStream(prev.messages, state.messages)
      }
      const effectivePlanDone = state.planCompleted !== undefined ? state.planCompleted : prev.planCompleted
      const effectivePlanText =
        state.planFollowupText !== undefined ? state.planFollowupText : prev.planFollowupText
      if (effectivePlanDone && typeof effectivePlanText === "string" && effectivePlanText.length > 0) {
        const fp = `${effectivePlanText.length}\0${effectivePlanText.slice(0, 220)}\0${effectivePlanText.slice(-160)}`
        if (fp !== planFollowupTextFingerprint) {
          planFollowupTextFingerprint = fp
          // New plan snapshots should open in compact-preview mode first so action buttons stay visible.
          next.planPanelCollapsed = true
        }
      }
      if (state.planCompleted === false) {
        planFollowupTextFingerprint = null
        next.planPanelCollapsed = true
      }
      return next
    })
  },

  handleConfigLoaded: (config) => {
    set({
      config,
      provider: config.model.provider,
      model: config.model.id,
    })
  },

  handleIndexStatus: (status) => {
    set((prev) => {
      // With vector indexing, core reports overallPercent = indexed / max(foundSoFar, indexed).
      // The denominator grows during discovery, so overallPercent can briefly go backwards and make the UI bar jump.
      // Clamp to a monotonic value within a single indexing run.
      let nextStatus = status
      if (
        status.state === "indexing" &&
        prev.indexStatus?.state === "indexing" &&
        typeof status.overallPercent === "number" &&
        Number.isFinite(status.overallPercent) &&
        typeof (prev.indexStatus as { overallPercent?: number }).overallPercent === "number" &&
        Number.isFinite((prev.indexStatus as { overallPercent?: number }).overallPercent)
      ) {
        const prevPct = (prev.indexStatus as { overallPercent?: number }).overallPercent as number
        const nextPct = Math.max(prevPct, status.overallPercent)
        if (nextPct !== status.overallPercent) {
          nextStatus = { ...(status as any), overallPercent: nextPct }
        }
      }

      return {
        indexStatus: nextStatus,
        indexReady: nextStatus.state === "ready",
        vectorDbProgressMessage: null,
      }
    })
  },

  handleSessionList: (sessions) => {
    set((prev) => {
      const now = Date.now()
      const nextPending: Record<string, number> = {}
      const visibleSessions = sessions.filter((session) => {
        const deletedAt = prev.pendingDeletedSessionIds[session.id]
        if (deletedAt == null) return true
        if (now - deletedAt < 1500) {
          nextPending[session.id] = deletedAt
          return false
        }
        return true
      })
      return {
        sessions: visibleSessions,
        pendingDeletedSessionIds: nextPending,
      }
    })
  },
  handleSessionListLoading: (loading) => {
    set({ sessionsLoading: loading })
  },

  handleMcpServerStatus: (results) => {
    set({ mcpStatus: results })
  },

  handlePendingApproval: (partId, action) => {
    set({ pendingApproval: { partId, action }, awaitingApproval: true })
  },

  resolveApproval: (approved: boolean, alwaysApprove?: boolean, addToAllowedCommand?: string, skipAll?: boolean, whatToDoInstead?: string) => {
    const { pendingApproval } = get()
    if (pendingApproval) {
      postMessage({
        type: "approvalResponse",
        partId: pendingApproval.partId,
        approved,
        alwaysApprove,
        addToAllowedCommand,
        skipAll,
        whatToDoInstead,
      })
      set({ pendingApproval: null, awaitingApproval: false })
    }
  },
  clearPendingQuestionRequest: () =>
    set((s) => ({
      pendingQuestionRequest: null,
      suppressedQuestionRequestId: s.pendingQuestionRequest?.requestId ?? s.suppressedQuestionRequestId,
    })),
  collapsePlanPanel: () => set({ planPanelCollapsed: true }),
  expandPlanPanel: () => set({ planPanelCollapsed: false }),

  handleAgentEvent: (event) => {
    const { messages } = get()

    // Best-effort deduplication for repeated events (replay/stale merge).
    // This is intentionally coarse: it targets the event types that create new rows/blocks.
    const et = (event as { type?: string }).type
    if (typeof et === "string") {
      const e = event as any
      let fp: string | null = null
      switch (et) {
        case "assistant_message_started":
        case "assistant_content_complete":
          fp = `${et}|${String(e.messageId ?? "")}`
          break
        case "text_delta": {
          const d = typeof e.delta === "string" ? e.delta : ""
          fp = `${et}|${String(e.messageId ?? "")}|${d.slice(0, 160)}|${d.length}`
          break
        }
        case "reasoning_delta": {
          const d = typeof e.delta === "string" ? e.delta : ""
          fp = `${et}|${String(e.messageId ?? "")}|${String(e.reasoningId ?? "")}|${d.slice(0, 160)}|${d.length}`
          break
        }
        case "tool_start":
        case "tool_end":
        case "tool_approval_needed":
          fp = `${et}|${String(e.messageId ?? "")}|${String(e.partId ?? "")}|${String(e.tool ?? "")}`
          break
        case "subagent_start":
        case "subagent_tool_start":
        case "subagent_tool_end":
        case "subagent_done":
          fp = `${et}|${String(e.subagentId ?? "")}|${String(e.parentPartId ?? "")}|${String(e.tool ?? "")}|${String(e.success ?? "")}`
          break
        case "question_request":
          fp = `${et}|${String(e.request?.requestId ?? "")}`
          break
        case "todo_updated":
          fp = `${et}|${String((e.todo ?? "").length)}`
          break
        case "error":
        case "done":
          fp = `${et}|${String(e.error ?? "")}`
          break
        default:
          fp = null
      }
      if (fp && seenRecently(fp)) return
    }

    switch (event.type) {
      case "assistant_message_started": {
        const { list, index } = ensureAssistantMessage(messages, event.messageId)
        set({ messages: list })
        break
      }

      case "text_delta": {
        const { list: baseList, index } = ensureAssistantMessage(messages, event.messageId)
        const target = baseList[index]
        if (!target) break
        const updated = { ...target }
        const umDelta = (event as { user_message_delta?: string }).user_message_delta
        if (typeof updated.content === "string") {
          const newText = sanitizeAssistantText(updated.content + event.delta)
          if (umDelta != null) {
            updated.content = [{ type: "text", text: newText, user_message: umDelta }]
          } else {
            updated.content = newText
          }
        } else {
          const parts = [...(updated.content as MessagePart[])]
          const lastPart = parts[parts.length - 1]
          if (lastPart?.type === "text") {
            parts[parts.length - 1] = {
              ...lastPart,
              text: sanitizeAssistantText(lastPart.text + event.delta),
              ...(umDelta != null ? { user_message: umDelta } : {}),
            } as TextPart
          } else {
            const cleaned = sanitizeAssistantText(event.delta)
            if (cleaned) {
              const startTime = get().reasoningStartTime
              if (lastPart?.type === "reasoning" && startTime != null) {
                parts[parts.length - 1] = { ...lastPart, durationMs: Date.now() - startTime } as ReasoningPart
                set((s) => ({ ...s, reasoningStartTime: null, activeReasoning: null }))
              }
              parts.push({ type: "text", text: cleaned, ...(umDelta != null ? { user_message: umDelta } : {}) })
            }
          }
          updated.content = parts
        }
        set({
          messages: [
            ...baseList.slice(0, index),
            updated,
            ...baseList.slice(index + 1),
          ],
        })
        break
      }

      case "assistant_content_complete": {
        const { list: baseList, index } = ensureAssistantMessage(messages, event.messageId)
        const target = baseList[index]
        if (!target || !Array.isArray(target.content)) break
        const parts = [...(target.content as MessagePart[])]
        const lastPart = parts[parts.length - 1]
        const startTime = get().reasoningStartTime
        if (lastPart?.type !== "reasoning" || startTime == null) break
        parts[parts.length - 1] = { ...lastPart, durationMs: Date.now() - startTime } as ReasoningPart
        set({
          messages: [
            ...baseList.slice(0, index),
            { ...target, content: parts },
            ...baseList.slice(index + 1),
          ],
          reasoningStartTime: null,
          activeReasoning: null,
        })
        break
      }

      case "tool_start": {
        const ev = event as { input?: Record<string, unknown>; tool?: string }
        if (ev.tool === "SpawnAgent" || ev.tool === "SpawnAgents" || ev.tool === "SpawnAgentsParallel") {
          set({ lastSpawnAgentPartId: event.partId })
        } else if (ev.tool === "Parallel" || ev.tool === "parallel") {
          // Track Parallel as spawn parent when all tool_uses are SpawnAgent calls
          const toolUses = (ev.input?.tool_uses as Array<{ recipient_name?: string }> | undefined) ?? []
          const allSpawn = toolUses.length > 0 && toolUses.every((u) => {
            const name = (u.recipient_name ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "")
            return name === "spawnagent" || name === "spawnagents"
          })
          if (allSpawn) set({ lastSpawnAgentPartId: event.partId })
        }
        const { list: baseList, index } = ensureAssistantMessage(messages, event.messageId)
        const target = baseList[index]
        if (!target) break
        const parts = Array.isArray(target.content)
          ? [...(target.content as MessagePart[])]
          : [{ type: "text" as const, text: target.content as string }]
        // Some transports can replay tool_start on reconnect / snapshot merge.
        // Avoid duplicating the same tool row when partId matches.
        const existingToolIdx = parts.findIndex((p) => p.type === "tool" && (p as ToolPart).id === event.partId)
        const lastPart = parts[parts.length - 1]
        const startTime = get().reasoningStartTime
        if (lastPart?.type === "reasoning" && startTime != null) {
          parts[parts.length - 1] = { ...lastPart, durationMs: Date.now() - startTime } as ReasoningPart
          set((s) => ({ ...s, reasoningStartTime: null, activeReasoning: null }))
        }
        if (existingToolIdx >= 0) {
          const existing = parts[existingToolIdx] as ToolPart
          parts[existingToolIdx] = {
            ...existing,
            tool: existing.tool || event.tool,
            status: existing.status === "completed" || existing.status === "error" ? existing.status : "running",
            input: existing.input ?? ev.input,
            timeStart: existing.timeStart ?? Date.now(),
          } as ToolPart
        } else {
          parts.push({
            type: "tool",
            id: event.partId,
            tool: event.tool,
            status: "running",
            input: ev.input,
            timeStart: Date.now(),
          } as ToolPart)
        }
        baseList[index] = { ...target, content: parts }
        set({ messages: baseList })
        break
      }

      case "tool_end": {
        const ev = event as {
          output?: string
          error?: string
          compacted?: boolean
          path?: string
          diffStats?: { added: number; removed: number }
          diffHunks?: Array<{ type: string; lineNum: number; line: string }>
          appliedReplacements?: Array<{ oldSnippet: string; newSnippet: string }>
        }
        if (event.tool === "SpawnAgent" || event.tool === "SpawnAgents" || event.tool === "SpawnAgentsParallel") set({ lastSpawnAgentPartId: null })
        set((s) => ({ ...s, pendingApproval: null, awaitingApproval: false }))
        const msgs = messages.map((msg) => {
          if (!Array.isArray(msg.content)) return msg
          const parts = (msg.content as MessagePart[]).map((p) => {
            if (p.type === "tool" && (p as ToolPart).id === event.partId) {
              return {
                ...(p as ToolPart),
                status: event.success ? "completed" : "error",
                timeEnd: Date.now(),
                output: ev.output,
                error: ev.error,
                compacted: ev.compacted,
                ...(ev.path != null ? { path: ev.path } : {}),
                ...(ev.diffStats != null ? { diffStats: ev.diffStats } : {}),
                ...(Array.isArray(ev.diffHunks) ? { diffHunks: ev.diffHunks } : {}),
                ...(Array.isArray(ev.appliedReplacements) && ev.appliedReplacements.length > 0
                  ? { appliedReplacements: ev.appliedReplacements }
                  : {}),
              } as ToolPart
            }
            return p
          })
          return { ...msg, content: parts }
        })
        set({ messages: msgs, awaitingApproval: false })
        break
      }

      case "todo_updated":
        set({ todo: (event as { type: "todo_updated"; todo: string }).todo ?? "" })
        break

      case "tool_approval_needed":
        set({ awaitingApproval: true })
        break

      case "subagent_start": {
        const partId = (event as { parentPartId?: string }).parentPartId ?? get().lastSpawnAgentPartId
        if (!partId) break
        const msgs = get().messages
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue
          const parts = msg.content as MessagePart[]
          const idx = parts.findIndex((p) => p.type === "tool" && (p as ToolPart).id === partId)
          if (idx === -1) continue
          const part = parts[idx] as ToolPart
          const nextSubagents = reduceSubagentState(part.subagents ?? [], {
            type: "subagent_start",
            subagentId: event.subagentId,
            mode: event.mode,
            task: event.task,
          })
          const nextParts = [...parts]
          nextParts[idx] = { ...part, subagents: nextSubagents }
          set({ messages: [...msgs.slice(0, i), { ...msg, content: nextParts }, ...msgs.slice(i + 1)] })
          break
        }
        break
      }

      case "subagent_tool_start": {
        const msgs = get().messages
        const fallbackPartId = (event as { parentPartId?: string }).parentPartId ?? get().lastSpawnAgentPartId
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue
          const parts = msg.content as MessagePart[]
          const partIdx = findToolPartIndexForSubagent(parts, event.subagentId, fallbackPartId)
          if (partIdx === -1) continue
          const part = parts[partIdx] as ToolPart
          let subagents = part.subagents ?? []
          if (!subagents.some((item) => item.id === event.subagentId) && typeof part.input?.description === "string") {
            subagents = reduceSubagentState(subagents, {
              type: "subagent_start",
              subagentId: event.subagentId,
              mode: "ask",
              task: part.input.description.trim(),
            })
          }
          subagents = reduceSubagentState(subagents, {
            type: "subagent_tool_start",
            subagentId: event.subagentId,
            tool: event.tool,
            input: (event as { input?: Record<string, unknown> }).input,
          })
          const nextParts = [...parts]
          nextParts[partIdx] = { ...part, subagents }
          set({ messages: [...msgs.slice(0, i), { ...msg, content: nextParts }, ...msgs.slice(i + 1)] })
          break
        }
        break
      }

      case "subagent_tool_end": {
        const msgs = get().messages
        const fallbackPartId = (event as { parentPartId?: string }).parentPartId ?? get().lastSpawnAgentPartId
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue
          const parts = msg.content as MessagePart[]
          const partIdx = findToolPartIndexForSubagent(parts, event.subagentId, fallbackPartId)
          if (partIdx === -1) continue
          const part = parts[partIdx] as ToolPart
          let subagents = part.subagents ?? []
          if (!subagents.some((item) => item.id === event.subagentId) && typeof part.input?.description === "string") {
            subagents = reduceSubagentState(subagents, {
              type: "subagent_start",
              subagentId: event.subagentId,
              mode: "ask",
              task: part.input.description.trim(),
            })
          }
          subagents = reduceSubagentState(subagents, {
            type: "subagent_tool_end",
            subagentId: event.subagentId,
            tool: event.tool,
            success: event.success,
          })
          const nextParts = [...parts]
          nextParts[partIdx] = { ...part, subagents }
          set({ messages: [...msgs.slice(0, i), { ...msg, content: nextParts }, ...msgs.slice(i + 1)] })
          break
        }
        break
      }

      case "subagent_done": {
        const msgs = get().messages
        const fallbackPartId = (event as { parentPartId?: string }).parentPartId ?? get().lastSpawnAgentPartId
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue
          const parts = msg.content as MessagePart[]
          const partIdx = findToolPartIndexForSubagent(parts, event.subagentId, fallbackPartId)
          if (partIdx === -1) continue
          const part = parts[partIdx] as ToolPart
          let subagents = part.subagents ?? []
          if (!subagents.some((item) => item.id === event.subagentId) && typeof part.input?.description === "string") {
            subagents = reduceSubagentState(subagents, {
              type: "subagent_start",
              subagentId: event.subagentId,
              mode: "ask",
              task: part.input.description.trim(),
            })
          }
          subagents = reduceSubagentState(subagents, {
            type: "subagent_done",
            subagentId: event.subagentId,
            success: event.success,
            error: event.error,
          })
          const nextParts = [...parts]
          nextParts[partIdx] = { ...part, subagents }
          set({ messages: [...msgs.slice(0, i), { ...msg, content: nextParts }, ...msgs.slice(i + 1)] })
          break
        }
        break
      }

      case "reasoning_delta": {
        // Built-in agent-loop reflection: provider streams reasoning between tool calls; no tool, stored as type "reasoning" and shown as Thought block.
        const { list: baseList, index } = ensureAssistantMessage(messages, event.messageId)
        const target = baseList[index]
        if (!target) break
        const reasoningId = typeof event.reasoningId === "string" && event.reasoningId.trim().length > 0 ? event.reasoningId : "reasoning-0"
        set((s) => ({
          ...s,
          reasoningStartTime: s.reasoningStartTime ?? Date.now(),
          activeReasoning: s.activeReasoning ?? { messageId: event.messageId, reasoningId },
        }))
        const delta = typeof event.delta === "string" ? event.delta : ""
        const updated = { ...target }
        const parts = Array.isArray(updated.content)
          ? [...(updated.content as MessagePart[])]
          : (typeof updated.content === "string" && updated.content.length > 0 ? [{ type: "text" as const, text: updated.content }] : [])
        const revIdx = findOpenReasoningReverseIndex(parts, reasoningId)
        const partIndex = revIdx >= 0 ? parts.length - 1 - revIdx : -1
        if (partIndex >= 0) {
          const reasoningPart = parts[partIndex] as ReasoningPart
          const previousText = (reasoningPart.text ?? "").trim() === THOUGHT_PLACEHOLDER ? "" : reasoningPart.text
          parts[partIndex] = {
            ...reasoningPart,
            reasoningId,
            providerMetadata: event.providerMetadata ?? reasoningPart.providerMetadata,
            text: `${previousText}${delta}` || THOUGHT_PLACEHOLDER,
          } as ReasoningPart
        } else {
          parts.push({
            type: "reasoning",
            reasoningId,
            providerMetadata: event.providerMetadata,
            text: delta || THOUGHT_PLACEHOLDER,
          } as ReasoningPart)
        }
        updated.content = parts
        set({
          messages: [
            ...baseList.slice(0, index),
            updated,
            ...baseList.slice(index + 1),
          ],
        })
        break
      }

      case "reasoning_start": {
        const { list: baseList, index } = ensureAssistantMessage(messages, event.messageId)
        const target = baseList[index]
        if (!target) break
        const reasoningId = typeof event.reasoningId === "string" && event.reasoningId.trim().length > 0 ? event.reasoningId : "reasoning-0"
        const updated = { ...target }
        const parts = Array.isArray(updated.content)
          ? [...(updated.content as MessagePart[])]
          : (typeof updated.content === "string" && updated.content.length > 0 ? [{ type: "text" as const, text: updated.content }] : [])
        const revIdx = findOpenReasoningReverseIndex(parts, reasoningId)
        if (revIdx < 0) {
          parts.push({
            type: "reasoning",
            reasoningId,
            providerMetadata: event.providerMetadata,
            text: THOUGHT_PLACEHOLDER,
          } as ReasoningPart)
        }
        updated.content = parts
        set((s) => ({
          ...s,
          messages: [...baseList.slice(0, index), updated, ...baseList.slice(index + 1)],
          reasoningStartTime: s.reasoningStartTime ?? Date.now(),
          activeReasoning: { messageId: event.messageId, reasoningId },
        }))
        break
      }

      case "reasoning_end": {
        const { list: baseList, index } = ensureAssistantMessage(messages, event.messageId)
        const target = baseList[index]
        const startTime = get().reasoningStartTime
        const reasoningId = typeof event.reasoningId === "string" && event.reasoningId.trim().length > 0 ? event.reasoningId : undefined
        if (!target || startTime == null || !Array.isArray(target.content)) {
          set((s) => ({ ...s, reasoningStartTime: null, activeReasoning: null }))
          break
        }
        const updated = { ...target }
        const parts = [...(updated.content as MessagePart[])]
        const reasoningRevIndex = [...parts].reverse().findIndex((p) =>
          p.type === "reasoning" &&
          (p as ReasoningPart).durationMs == null &&
          (reasoningId == null || ((p as ReasoningPart).reasoningId ?? "reasoning-0") === reasoningId)
        )
        if (reasoningRevIndex >= 0) {
          const reasoningIndex = parts.length - 1 - reasoningRevIndex
          const reasoningPart = parts[reasoningIndex] as ReasoningPart
          parts[reasoningIndex] = {
            ...reasoningPart,
            reasoningId: reasoningPart.reasoningId ?? reasoningId,
            providerMetadata: event.providerMetadata ?? reasoningPart.providerMetadata,
            durationMs: Date.now() - startTime,
          } as ReasoningPart
          updated.content = parts
          set({
            messages: [
              ...baseList.slice(0, index),
              updated,
              ...baseList.slice(index + 1),
            ],
            reasoningStartTime: null,
            activeReasoning: null,
          })
          break
        }
        set((s) => ({ ...s, reasoningStartTime: null, activeReasoning: null }))
        break
      }

      case "compaction_start":
        set({ compactionUi: "compacting", compactionStartTime: Date.now() })
        break

      case "compaction_end":
        set((s) => {
          if (s.compactionUi !== "compacting" || s.compactionStartTime == null) {
            return { compactionStartTime: null }
          }
          const durationMs = Date.now() - s.compactionStartTime
          const durationSec = Math.max(1, Math.round(durationMs / 1000))
          return {
            compactionUi: "none",
            compactionStartTime: null,
            compactionLog: [
              ...s.compactionLog,
              { id: `compaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, durationSec },
            ],
          }
        })
        break

      case "doom_loop_detected":
        set({
          messages: [
            ...messages,
            {
              id: `doom_${Date.now()}`,
              ts: Date.now(),
              role: "system" as const,
              content: `Loop detected (tool: ${event.tool}). Stop or continue in the dialog.`,
            },
          ],
        })
        break

      case "question_request":
        set({
          pendingQuestionRequest: (event as {
            request: {
              requestId: string
              title?: string
              submitLabel?: string
              customOptionLabel?: string
              questions: Array<{ id: string; question: string; options: Array<{ id: string; label: string }>; allowCustom?: boolean }>
            }
          }).request,
          suppressedQuestionRequestId: null,
        })
        break

      case "index_update": {
        const status = event.status as IndexStatusKind
        set({
          indexStatus: status,
          indexReady: status.state === "ready",
          vectorDbProgressMessage: null,
        })
        break
      }

      case "vector_db_progress": {
        const message = (event as { message?: string }).message
        set({ vectorDbProgressMessage: typeof message === "string" ? message : "Starting vector DB…" })
        break
      }

      case "vector_db_ready": {
        set({ vectorDbProgressMessage: null })
        break
      }

      case "context_usage":
        set({
          contextUsedTokens: event.usedTokens,
          contextLimitTokens: event.limitTokens,
          contextPercent: event.percent,
        })
        break

      case "done":
        set((state) => {
          const msgs = [...state.messages]
          const last = msgs[msgs.length - 1]
          if (last?.role === "assistant") {
            if (typeof last.content === "string") {
              msgs[msgs.length - 1] = { ...last, content: stripToolCallMarkup(last.content) }
            } else if (Array.isArray(last.content)) {
              const cleanedParts = (last.content as MessagePart[])
                .filter(
                  (p) =>
                    (p.type !== "text" ||
                      stripToolCallMarkup((p as TextPart).text).length > 0 ||
                      ((p as TextPart).user_message?.trim()?.length ?? 0) > 0) &&
                    (p.type !== "reasoning" ||
                      ((p as ReasoningPart).text?.trim().length ?? 0) > 0 &&
                      (p as ReasoningPart).text !== THOUGHT_PLACEHOLDER)
                )
                .map((p) => (p.type === "text" ? { ...p, text: stripToolCallMarkup((p as TextPart).text) } : p))
              msgs[msgs.length - 1] = { ...last, content: cleanedParts }
            }
          }

          const latestAssistant = msgs[msgs.length - 1]
          const hasAssistantText =
            latestAssistant?.role === "assistant" &&
            hasRenderableAssistantContent(latestAssistant.content)

          // Always provide a text response when needed: add assistant fallback if model produced no final text
          if (!hasAssistantText && state.messages.length > 0) {
            const fallbackText = buildFallbackSummary(msgs)
            msgs.push({
              id: `assistant_fallback_${Date.now()}`,
              ts: Date.now(),
              role: "assistant",
              content: fallbackText,
            })
          }

          return {
            messages: msgs,
            isRunning: false,
            awaitingApproval: false,
            pendingApproval: null,
            subagents: [],
            lastSpawnAgentPartId: null,
            reasoningStartTime: null,
            activeReasoning: null,
          }
        })
        // Send next queued message when agent has finished
        const state = get()
        if (state.queuedMessages.length > 0) {
          const first = state.queuedMessages[0]
          state.removeFromQueue(first!.id)
          state.sendMessage(first!.text)
        }
        break

      case "error":
        set((state) => ({
          ...state,
          isRunning: false,
          awaitingApproval: false,
          pendingApproval: null,
          reasoningStartTime: null,
          activeReasoning: null,
          subagents: [],
          lastSpawnAgentPartId: null,
        }))
        if (event.error) {
          const msgs = [
            ...messages,
            {
              id: `error_${Date.now()}`,
              ts: Date.now(),
              role: "system" as const,
              content: `Error: ${event.error}`,
            },
          ]
          set({ messages: msgs })
        }
        break
    }
  },
}))

function ensureAssistantMessage(messages: SessionMessage[], messageId?: string): { list: SessionMessage[]; index: number } {
  const id = messageId || `msg_${Date.now()}`
  const idx = messages.findIndex((m) => m.id === id && m.role === "assistant")
  if (idx >= 0) {
    return { list: [...messages], index: idx }
  }

  const lastIdx = messages.length - 1
  if (lastIdx >= 0 && messages[lastIdx]?.role === "assistant") {
    const existing = messages[lastIdx]!
    if (existing.id !== id) {
      return {
        list: [...messages.slice(0, lastIdx), { ...existing, id }],
        index: lastIdx,
      }
    }
    return { list: [...messages], index: lastIdx }
  }

  const list: SessionMessage[] = [
    ...messages,
    {
      id,
      ts: Date.now(),
      role: "assistant",
      content: "",
    },
  ]
  return { list, index: list.length - 1 }
}

function mergeAssistantContent(
  previous: string | MessagePart[],
  incoming: string | MessagePart[],
): string | MessagePart[] {
  if (!hasAssistantContent(incoming) && hasAssistantContent(previous)) {
    return previous
  }
  if (!Array.isArray(previous) || !Array.isArray(incoming)) {
    return incoming
  }

  const previousParts = previous as MessagePart[]
  const incomingParts = incoming as MessagePart[]
  const previousReasoning = previousParts.filter((p): p is ReasoningPart => p.type === "reasoning")
  const incomingReasoning = incomingParts.filter((p): p is ReasoningPart => p.type === "reasoning")

  if (previousReasoning.length === 0) return incoming
  if (incomingReasoning.length === 0) {
    return dedupeAssistantParts([...previousReasoning, ...incomingParts])
  }

  const prevText = previousReasoning.map((r) => r.text ?? "").join("").trim()
  const inText = incomingReasoning.map((r) => r.text ?? "").join("").trim()
  const incomingHasOnlyPlaceholder =
    inText.length > 0 &&
    inText === THOUGHT_PLACEHOLDER &&
    prevText.length > 0 &&
    prevText !== THOUGHT_PLACEHOLDER

  if (incomingHasOnlyPlaceholder) {
    const withoutIncomingReasoning = incomingParts.filter((p) => p.type !== "reasoning")
    const incomingHasVisibleText = withoutIncomingReasoning.some(
      (p) =>
        p.type === "text" &&
        ((((p as TextPart).text ?? "").trim().length > 0 && (p as TextPart).text !== THOUGHT_PLACEHOLDER) ||
          (((p as TextPart).user_message ?? "").trim().length > 0))
    )
    if (incomingHasVisibleText) {
      return dedupeAssistantParts([...previousReasoning, ...withoutIncomingReasoning])
    }
    // Keep richer previous text if snapshot only has placeholder reasoning; keep non-text parts from incoming snapshot.
    const previousVisibleTextParts = previousParts.filter(
      (p) =>
        p.type === "text" &&
        ((((p as TextPart).text ?? "").trim().length > 0 && (p as TextPart).text !== THOUGHT_PLACEHOLDER) ||
          (((p as TextPart).user_message ?? "").trim().length > 0))
    )
    const incomingNonText = withoutIncomingReasoning.filter((p) => p.type !== "text")
    return dedupeAssistantParts([...previousReasoning, ...previousVisibleTextParts, ...incomingNonText])
  }

  return dedupeAssistantParts(incoming)
}

function mergeStateMessagesForStream(previous: SessionMessage[], incoming: SessionMessage[]): SessionMessage[] {
  // Server may briefly send [] while optimistic local_user_* rows exist — keep previous to avoid flash.
  if (incoming.length === 0) {
    return previous
  }
  if (previous.length === 0) {
    return incoming
  }

  const merged = mergeOptimisticUserMessages(previous, incoming)
  const lastIncoming = merged[merged.length - 1]
  const lastPrevious = previous[previous.length - 1]

  if (lastIncoming?.role === "assistant" && lastPrevious?.role === "assistant" && lastIncoming.id === lastPrevious.id) {
    const mergedContent = mergeAssistantContent(lastPrevious.content, lastIncoming.content)
    if (mergedContent !== lastIncoming.content) {
      merged[merged.length - 1] = { ...lastIncoming, content: mergedContent }
    }
  } else if (
    lastIncoming?.role === "assistant" &&
    lastPrevious?.role === "assistant" &&
    !hasAssistantContent(lastIncoming.content) &&
    hasAssistantContent(lastPrevious.content)
  ) {
    merged[merged.length - 1] = { ...lastIncoming, content: lastPrevious.content }
  }

  if (incoming.length < previous.length) {
    const isIncomingPrefix = incoming.every((message, index) => previous[index]?.id === message.id)
    if (isIncomingPrefix) {
      const trailingPrevious = previous.slice(incoming.length)
      const hasVisibleTail = trailingPrevious.some((message) => {
        if (message.role === "assistant") return hasAssistantContent(message.content)
        if (message.role === "user") return message.id.startsWith("local_user_")
        return true
      })
      if (hasVisibleTail) {
        return [...merged, ...trailingPrevious]
      }
    }
  }

  const optimisticUsersToKeep = previous.filter(
    (message) =>
      message.role === "user" &&
      message.id.startsWith("local_user_") &&
      !merged.some(
        (incomingMessage) =>
          incomingMessage.role === "user" &&
          messageTextContent(incomingMessage) === messageTextContent(message)
      )
  )
  if (optimisticUsersToKeep.length > 0) {
    return collapseAdjacentDuplicateMessages([...merged, ...optimisticUsersToKeep])
  }

  return collapseAdjacentDuplicateMessages(merged)
}

function mergeOptimisticUserMessages(previous: SessionMessage[], incoming: SessionMessage[]): SessionMessage[] {
  const merged = [...incoming]
  return merged.map((message) => {
    if (message.role !== "user") return message
    const text = messageTextContent(message)
    const optimistic = previous.find(
      (candidate) =>
        candidate.role === "user" &&
        candidate.id.startsWith("local_user_") &&
        messageTextContent(candidate) === text
    )
    if (!optimistic) return message
    return {
      ...message,
      id: optimistic.id,
      ts: optimistic.ts,
      content: optimistic.content,
    }
  })
}

function messageTextContent(message: SessionMessage): string {
  if (typeof message.content === "string") return message.content.trim()
  return (
    (message.content as MessagePart[])
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => `${part.text ?? ""}\n${part.user_message ?? ""}`)
      .join("\n")
      .trim()
  )
}

function hasAssistantContent(content: string | MessagePart[]): boolean {
  if (typeof content === "string") return content.trim().length > 0
  const parts = content as MessagePart[]
  return parts.some(
    (p) =>
      (p.type === "text" && (((p as TextPart).text?.trim().length ?? 0) > 0 || ((p as TextPart).user_message?.trim().length ?? 0) > 0)) ||
      (p.type === "reasoning" &&
        ((p as ReasoningPart).text?.trim().length ?? 0) > 0 &&
        (p as ReasoningPart).text !== THOUGHT_PLACEHOLDER) ||
      p.type === "tool"
  )
}

function collapseAdjacentDuplicateMessages(messages: SessionMessage[]): SessionMessage[] {
  const collapsed: SessionMessage[] = []
  for (const message of messages) {
    const previous = collapsed[collapsed.length - 1]
    if (
      previous &&
      previous.role === "assistant" &&
      message.role === "assistant" &&
      assistantMessageSignature(previous) === assistantMessageSignature(message)
    ) {
      collapsed[collapsed.length - 1] = {
        ...message,
        id: message.id,
        ts: Math.max(previous.ts, message.ts),
      }
      continue
    }
    collapsed.push(message)
  }
  return collapsed
}

/**
 * Drop later reasoning parts whose trimmed text exactly matches an earlier block.
 * Fixes duplicate "Thought" rows after stream + session snapshot merge (e.g. LLM error / reconnect).
 */
function dedupeGlobalDuplicateReasoningText(parts: MessagePart[]): MessagePart[] {
  const seen = new Set<string>()
  const out: MessagePart[] = []
  for (const part of parts) {
    if (part.type !== "reasoning") {
      out.push(part)
      continue
    }
    const r = part as ReasoningPart
    const t = (r.text ?? "").trim()
    if (t === "" || t === THOUGHT_PLACEHOLDER) {
      out.push(part)
      continue
    }
    if (seen.has(t)) continue
    seen.add(t)
    out.push(part)
  }
  return out
}

function dedupeAssistantParts(parts: MessagePart[]): MessagePart[] {
  const deduped: MessagePart[] = []
  for (const part of parts) {
    const previous = deduped[deduped.length - 1]

    // Consecutive reasoning with identical visible text but different reasoningId/metadata (merge).
    if (part.type === "reasoning" && previous?.type === "reasoning") {
      const a = previous as ReasoningPart
      const b = part as ReasoningPart
      const at = (a.text ?? "").trim()
      const bt = (b.text ?? "").trim()
      if (at !== "" && at !== THOUGHT_PLACEHOLDER && at === bt) {
        deduped[deduped.length - 1] = {
          ...a,
          ...b,
          text: bt || at,
          reasoningId: a.reasoningId || b.reasoningId,
          durationMs: b.durationMs ?? a.durationMs,
          providerMetadata: b.providerMetadata ?? a.providerMetadata,
        } as ReasoningPart
        continue
      }
    }

    if (previous && assistantPartSignature(previous) === assistantPartSignature(part)) {
      deduped[deduped.length - 1] = part
      continue
    }
    deduped.push(part)
  }
  return dedupeGlobalDuplicateReasoningText(deduped)
}

function assistantPartSignature(part: MessagePart): string {
  if (part.type === "text") {
    const textPart = part as TextPart
    return JSON.stringify({
      type: "text",
      text: textPart.text ?? "",
      user_message: textPart.user_message ?? "",
    })
  }
  if (part.type === "reasoning") {
    const reasoning = part as ReasoningPart
    return JSON.stringify({
      type: "reasoning",
      text: reasoning.text ?? "",
      reasoningId: reasoning.reasoningId ?? "",
    })
  }
  const tool = part as ToolPart
  return JSON.stringify({
    type: "tool",
    id: tool.id,
    tool: tool.tool,
    status: tool.status,
    path: tool.path ?? "",
    input: tool.input ?? null,
    output: tool.output ?? "",
    error: tool.error ?? "",
    diffStats: tool.diffStats ?? null,
  })
}

function assistantMessageSignature(message: SessionMessage): string {
  if (typeof message.content === "string") return `assistant:string:${message.content.trim()}`
  return JSON.stringify(
    (message.content as MessagePart[]).map((part) => {
      if (part.type === "text") {
        const textPart = part as TextPart
        return {
          type: "text",
          text: textPart.text ?? "",
          user_message: textPart.user_message ?? "",
        }
      }
      if (part.type === "reasoning") {
        const reasoning = part as ReasoningPart
        return {
          type: "reasoning",
          text: reasoning.text ?? "",
          durationMs: reasoning.durationMs ?? 0,
          reasoningId: reasoning.reasoningId ?? "",
        }
      }
      const tool = part as ToolPart
      return {
        type: "tool",
        id: tool.id,
        tool: tool.tool,
        status: tool.status,
        input: tool.input ?? null,
        output: tool.output ?? "",
        error: tool.error ?? "",
        subagents:
          tool.subagents?.map((subagent) => ({
            id: subagent.id,
            task: subagent.task,
            status: subagent.status,
            currentTool: subagent.currentTool ?? "",
            toolUsesCount: subagent.toolUsesCount,
          })) ?? [],
      }
    })
  )
}

function hasRenderableAssistantContent(content: string | MessagePart[]): boolean {
  if (typeof content === "string") return content.trim().length > 0
  const parts = content as MessagePart[]
  return parts.some((p) => {
    if (p.type === "text") {
      return (
        ((p as TextPart).text?.trim().length ?? 0) > 0 ||
        ((p as TextPart).user_message?.trim().length ?? 0) > 0
      )
    }
    if (p.type === "reasoning") {
      return (
        ((p as ReasoningPart).text?.trim().length ?? 0) > 0 &&
        (p as ReasoningPart).text !== THOUGHT_PLACEHOLDER
      )
    }
    return false
  })
}

function isSlashCommand(text: string, command: string): boolean {
  return new RegExp(`^/${command}(\\s|$)`, "i").test(text.trim())
}

function buildReviewPromptFromSlash(raw: string): string {
  const args = raw.replace(/^\/review\s*/i, "").trim()
  if (args.length > 0) return args
  return `Run a local code review of uncommitted changes in this repository.

Use git diff against HEAD and inspect changed files.
Focus on bugs, regressions, security, and missing tests.

Return in this format:
## Local Review
### Summary
### Issues Found
### Detailed Findings
### Recommendation`
}

function stripToolCallMarkup(value: string): string {
  if (!value) return value
  return value
    .replace(/<tool_call>\s*[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function=[^>]+>/gi, "")
    .replace(/<\/function>/gi, "")
    .replace(/<parameter=[^>]+>/gi, "")
    .replace(/<\/parameter>/gi, "")
    .trim()
}

/** Build fallback assistant text when the model produced no final message (so user always sees a text response). */
function buildFallbackSummary(messages: SessionMessage[]): string {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
  if (!lastAssistant || typeof lastAssistant.content !== "object" || !Array.isArray(lastAssistant.content)) {
    return "The agent completed without a final message. You can rephrase your request or switch mode and try again."
  }
  const parts = lastAssistant.content as MessagePart[]
  const toolNames = parts
    .filter((p): p is ToolPart => p.type === "tool")
    .map((p) => p.tool)
  if (toolNames.length === 0) {
    return "The agent completed without a final message. You can rephrase your request or switch mode and try again."
  }
  const unique = [...new Set(toolNames)]
  const list = unique.slice(0, 15).join(", ") + (unique.length > 15 ? ` (+${unique.length - 15} more)` : "")
  return `The agent completed without a final text summary. Actions performed: ${list}. You can ask a follow-up or rephrase your request.`
}

function sanitizeAssistantText(value: string): string {
  return stripToolCallMarkup(value)
    .replace(/<tool_call[^>]*>/gi, "")
    .replace(/<\/tool_call>/gi, "")
    .replace(/<function=[^>]*>/gi, "")
    .replace(/<\/function>/gi, "")
    .replace(/<parameter=[^>]*>/gi, "")
    .replace(/<\/parameter>/gi, "")
    .split("\n")
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      if (t === "<" || t === ">" || t === "</" || t === "/>") return false
      if (t.startsWith("<") && /(tool_call|function|parameter)/i.test(t)) return false
      return true
    })
    .join("\n")
    .trim()
}
