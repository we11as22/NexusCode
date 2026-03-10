import { create } from "zustand"
import { postMessage } from "../vscode.js"
import type { ModelsCatalogFromCore, AgentPresetFromCore } from "../types/messages.js"

export type Mode = "agent" | "plan" | "ask" | "debug"
export type AppView = "chat" | "sessions" | "settings"

export type IndexStatusKind =
  | { state: "idle" }
  | { state: "indexing"; progress: number; total: number; chunksProcessed?: number; chunksTotal?: number }
  | { state: "ready"; files: number; symbols: number; chunks?: number }
  | { state: "error"; error: string }

export interface SessionMessage {
  id: string
  ts: number
  role: "user" | "assistant" | "system" | "tool"
  content: string | MessagePart[]
  summary?: boolean
}

export type MessagePart = TextPart | ToolPart | ReasoningPart
export interface TextPart { type: "text"; text: string; user_message?: string }
export interface ReasoningPart { type: "reasoning"; text: string; durationMs?: number }
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
  /** Subagents for SpawnAgents: filled by subagent_start/tool_start/done, shown inline under this tool card */
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
    debounceMs: number
    excludePatterns: string[]
  }
  vectorDb?: {
    enabled: boolean
    url: string
    collection: string
    autoStart: boolean
  }
  tools: {
    classifyThreshold: number
    parallelReads: boolean
    maxParallelReads: number
    custom: string[]
  }
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
  rules: {
    files: string[]
  }
  modes: {
    agent?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    plan?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    ask?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    debug?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    [key: string]: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string } | undefined
  }
  permissions?: {
    autoApproveRead: boolean
    autoApproveWrite: boolean
    autoApproveCommand: boolean
    autoApproveMcp?: boolean
    autoApproveBrowser?: boolean
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
  startedAt: number
  finishedAt?: number
  error?: string
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
  config: NexusConfigState | null
  isCompacting: boolean
  subagents: SubAgentState[]
  /** partId of the last tool_start(SpawnAgents); used to attach subagent_start to that part */
  lastSpawnAgentPartId: string | null
  selectedProfile: string
  projectDir: string
  /** When the current reasoning block started (for "Thought for Xs" display) */
  reasoningStartTime: number | null
  /** NexusCode server URL (nexuscode.serverUrl). When set, extension uses server for sessions and runs. */
  serverUrl: string
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

  /** Options for creating a preset (skills, MCP, rules) — loaded when opening create modal. */
  agentPresetOptions: { skills: string[]; mcpServers: string[]; rulesFiles: string[] } | null
  requestAgentPresetOptions: () => void
  handleAgentPresetOptions: (options: { skills: string[]; mcpServers: string[]; rulesFiles: string[] }) => void

  /** Loaded skill definitions (name, path, summary) for Settings → Skills list. */
  skillDefinitions: Array<{ name: string; path: string; summary: string }>
  handleSkillDefinitions: (definitions: Array<{ name: string; path: string; summary: string }>) => void

  // Actions
  setView: (view: AppView) => void
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
  sendMessage: (content: string) => void
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
  handleSessionList: (sessions: SessionPreview[]) => void
  handleSessionListLoading: (loading: boolean) => void
}

export type AgentEvent =
  | { type: "assistant_message_started"; messageId: string }
  | { type: "text_delta"; delta: string; messageId: string; user_message_delta?: string }
  | { type: "reasoning_delta"; delta: string; messageId: string }
  | { type: "tool_start"; tool: string; partId: string; messageId: string; input?: Record<string, unknown> }
  | { type: "tool_end"; tool: string; partId: string; messageId: string; success: boolean; output?: string; error?: string; compacted?: boolean; path?: string; diffStats?: { added: number; removed: number }; diffHunks?: Array<{ type: string; lineNum: number; line: string }> }
  | { type: "subagent_start"; subagentId: string; mode: Mode; task: string }
  | { type: "subagent_tool_start"; subagentId: string; tool: string }
  | { type: "subagent_tool_end"; subagentId: string; tool: string; success: boolean }
  | { type: "subagent_done"; subagentId: string; success: boolean; outputPreview?: string; error?: string }
  | { type: "tool_approval_needed"; action: ApprovalAction; partId: string }
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
  config: null,
  isCompacting: false,
  subagents: [],
  lastSpawnAgentPartId: null,
  selectedProfile: "",
  projectDir: "",
  reasoningStartTime: null,
  serverUrl: "",
  mcpStatus: [],
  pendingApproval: null,

  modelsCatalog: null,
  modelsCatalogLoading: false,
  checkpointEntries: [],
  checkpointEnabled: false,
  planCompleted: false,
  planFollowupText: null,
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

  agentPresetOptions: null,
  requestAgentPresetOptions: () => {
    postMessage({ type: "getAgentPresetOptions" })
  },
  handleAgentPresetOptions: (options: { skills: string[]; mcpServers: string[]; rulesFiles: string[] }) => {
    set({ agentPresetOptions: options })
  },

  skillDefinitions: [],
  handleSkillDefinitions: (definitions: Array<{ name: string; path: string; summary: string }>) => {
    set({ skillDefinitions: definitions })
  },

  setView: (view) => {
    set({ view })
    if (view === "sessions") postMessage({ type: "getState" })
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

  sendMessage: (content) => {
    const { mode, isRunning, attachedImages } = get()
    if (isRunning) return
    const text = (typeof content === "string" ? content : "").trim()
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
          content: text,
        },
      ],
    }))
    postMessage({
      type: "newMessage",
      content: text,
      mode,
      images: attachedImages.length > 0 ? attachedImages.map((img) => ({ data: img.data, mimeType: img.mimeType })) : undefined,
    })
  },

  abort: () => {
    postMessage({ type: "abort" })
    set({ isRunning: false })
  },

  compact: () => {
    postMessage({ type: "compact" })
  },

  clearChat: () => {
    postMessage({ type: "clearChat" })
    set({ messages: [], todo: "", view: "chat", subagents: [], lastSpawnAgentPartId: null, planCompleted: false, planFollowupText: null, hasOlderMessages: false, loadingOlderMessages: false })
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
      const next = { ...prev, ...state }
      // Keep streamed assistant content: if incoming messages have an empty last assistant message
      // but we have a richer one (from streaming), keep ours so the reply does not disappear.
      if (state.messages != null && Array.isArray(state.messages) && prev.messages.length > 0 && state.messages.length > 0) {
        const lastIn = state.messages[state.messages.length - 1]
        const lastPrev = prev.messages[prev.messages.length - 1]
        if (lastIn?.role === "assistant" && lastPrev?.role === "assistant" && !hasAssistantContent(lastIn.content) && hasAssistantContent(lastPrev.content)) {
          next.messages = [
            ...state.messages.slice(0, -1),
            { ...lastIn, content: lastPrev.content },
          ]
        }
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
    set({
      indexStatus: status,
      indexReady: status.state === "ready",
      vectorDbProgressMessage: null,
    })
  },

  handleSessionList: (sessions) => {
    set({ sessions })
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

  handleAgentEvent: (event) => {
    const { messages } = get()

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
                set((s) => ({ ...s, reasoningStartTime: null }))
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

      case "tool_start": {
        const ev = event as { input?: Record<string, unknown>; tool?: string }
        if (ev.tool === "SpawnAgents") set({ lastSpawnAgentPartId: event.partId })
        const { list: baseList, index } = ensureAssistantMessage(messages, event.messageId)
        const target = baseList[index]
        if (!target) break
        const parts = Array.isArray(target.content)
          ? [...(target.content as MessagePart[])]
          : [{ type: "text" as const, text: target.content as string }]
        const lastPart = parts[parts.length - 1]
        const startTime = get().reasoningStartTime
        if (lastPart?.type === "reasoning" && startTime != null) {
          parts[parts.length - 1] = { ...lastPart, durationMs: Date.now() - startTime } as ReasoningPart
          set((s) => ({ ...s, reasoningStartTime: null }))
        }
        parts.push({
          type: "tool",
          id: event.partId,
          tool: event.tool,
          status: "running",
          input: ev.input,
          timeStart: Date.now(),
        } as ToolPart)
        baseList[index] = { ...target, content: parts }
        set({ messages: baseList })
        break
      }

      case "tool_end": {
        const ev = event as { output?: string; error?: string; compacted?: boolean; path?: string; diffStats?: { added: number; removed: number }; diffHunks?: Array<{ type: string; lineNum: number; line: string }> }
        if (event.tool === "SpawnAgents") set({ lastSpawnAgentPartId: null })
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
        const partId = get().lastSpawnAgentPartId
        if (!partId) break
        const msgs = get().messages
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue
          const parts = msg.content as MessagePart[]
          const idx = parts.findIndex((p) => p.type === "tool" && (p as ToolPart).id === partId)
          if (idx === -1) continue
          const part = parts[idx] as ToolPart
          const nextSubagents = [...(part.subagents ?? []), { id: event.subagentId, mode: event.mode, task: event.task, status: "running" as const, startedAt: Date.now() }]
          const nextParts = [...parts]
          nextParts[idx] = { ...part, subagents: nextSubagents }
          set({ messages: [...msgs.slice(0, i), { ...msg, content: nextParts }, ...msgs.slice(i + 1)] })
          break
        }
        break
      }

      case "subagent_tool_start": {
        const msgs = get().messages
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue
          const parts = msg.content as MessagePart[]
          const partIdx = parts.findIndex((p) => p.type === "tool" && (p as ToolPart).subagents?.some((s) => s.id === event.subagentId))
          if (partIdx === -1) continue
          const part = parts[partIdx] as ToolPart
          const subagents = (part.subagents ?? []).map((a) => (a.id === event.subagentId ? { ...a, status: "running" as const, currentTool: event.tool } : a))
          const nextParts = [...parts]
          nextParts[partIdx] = { ...part, subagents }
          set({ messages: [...msgs.slice(0, i), { ...msg, content: nextParts }, ...msgs.slice(i + 1)] })
          break
        }
        break
      }

      case "subagent_tool_end": {
        const msgs = get().messages
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue
          const parts = msg.content as MessagePart[]
          const partIdx = parts.findIndex((p) => p.type === "tool" && (p as ToolPart).subagents?.some((s) => s.id === event.subagentId))
          if (partIdx === -1) continue
          const part = parts[partIdx] as ToolPart
          const subagents = (part.subagents ?? []).map((a) =>
            a.id === event.subagentId ? { ...a, status: (event.success ? "running" : "error") as "running" | "error", currentTool: event.success ? undefined : event.tool } : a
          )
          const nextParts = [...parts]
          nextParts[partIdx] = { ...part, subagents }
          set({ messages: [...msgs.slice(0, i), { ...msg, content: nextParts }, ...msgs.slice(i + 1)] })
          break
        }
        break
      }

      case "subagent_done": {
        const msgs = get().messages
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue
          const parts = msg.content as MessagePart[]
          const partIdx = parts.findIndex((p) => p.type === "tool" && (p as ToolPart).subagents?.some((s) => s.id === event.subagentId))
          if (partIdx === -1) continue
          const part = parts[partIdx] as ToolPart
          const subagents = (part.subagents ?? []).map((a) =>
            a.id === event.subagentId
              ? { ...a, status: (event.success ? "completed" : "error") as "completed" | "error", currentTool: undefined, finishedAt: Date.now(), error: event.error }
              : a
          )
          const nextParts = [...parts]
          nextParts[partIdx] = { ...part, subagents }
          set({ messages: [...msgs.slice(0, i), { ...msg, content: nextParts }, ...msgs.slice(i + 1)] })
          break
        }
        break
      }

      case "reasoning_delta": {
        // Built-in agent-loop reflection: provider streams reasoning between tool calls; no tool, stored as type "reasoning" and shown as Thought in Explored block.
        const { list: baseList, index } = ensureAssistantMessage(messages, event.messageId)
        const target = baseList[index]
        if (!target) break
        set((s) => ({ ...s, reasoningStartTime: s.reasoningStartTime ?? Date.now() }))
        const updated = { ...target }
        const parts = Array.isArray(updated.content)
          ? [...(updated.content as MessagePart[])]
          : (typeof updated.content === "string" && updated.content.length > 0 ? [{ type: "text" as const, text: updated.content }] : [])
        const lastPart = parts[parts.length - 1]
        if (lastPart?.type === "reasoning") {
          parts[parts.length - 1] = { ...lastPart, text: lastPart.text + event.delta } as ReasoningPart
        } else {
          parts.push({ type: "reasoning", text: event.delta })
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

      case "compaction_start":
        set({ isCompacting: true })
        break

      case "compaction_end":
        set({ isCompacting: false })
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
                    p.type !== "text" ||
                    stripToolCallMarkup((p as TextPart).text).length > 0 ||
                    ((p as TextPart).user_message?.trim()?.length ?? 0) > 0
                )
                .map((p) => (p.type === "text" ? { ...p, text: stripToolCallMarkup((p as TextPart).text) } : p))
              msgs[msgs.length - 1] = { ...last, content: cleanedParts }
            }
          }

          const latestAssistant = msgs[msgs.length - 1]
          const hasAssistantText =
            latestAssistant?.role === "assistant"
            && (
              typeof latestAssistant.content === "string"
                ? latestAssistant.content.trim().length > 0
                : (() => {
                    const parts = latestAssistant.content as MessagePart[]
                    const hasTextOrUserMessage = parts.some(
                      (p) =>
                        p.type === "text" &&
                        (((p as TextPart).text?.trim().length ?? 0) > 0 || ((p as TextPart).user_message?.trim()?.length ?? 0) > 0)
                    )
                    return hasTextOrUserMessage
                  })()
            )

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

function hasAssistantContent(content: string | MessagePart[]): boolean {
  if (typeof content === "string") return content.trim().length > 0
  const parts = content as MessagePart[]
  return parts.some(
    (p) => p.type === "text" && (((p as TextPart).text?.trim().length ?? 0) > 0 || ((p as TextPart).user_message?.trim().length ?? 0) > 0)
  )
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
