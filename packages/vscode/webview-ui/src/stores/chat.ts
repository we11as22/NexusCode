import { create } from "zustand"
import { postMessage } from "../vscode.js"

export type Mode = "agent" | "plan" | "debug" | "ask"
export type AppView = "chat" | "sessions" | "settings"

export type IndexStatusKind =
  | { state: "idle" }
  | { state: "indexing"; progress: number; total: number }
  | { state: "ready"; files: number; symbols: number }
  | { state: "error"; error: string }

export interface SessionMessage {
  id: string
  ts: number
  role: "user" | "assistant" | "system" | "tool"
  content: string | MessagePart[]
  summary?: boolean
}

export type MessagePart = TextPart | ToolPart | ReasoningPart
export interface TextPart { type: "text"; text: string }
export interface ReasoningPart { type: "reasoning"; text: string }
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
}

export interface NexusConfigState {
  model: {
    provider: string
    id: string
    apiKey?: string
    baseUrl?: string
    temperature?: number
  }
  maxMode: {
    enabled: boolean
    tokenBudgetMultiplier: number
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
    fts: boolean
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
    }>
  }
  skills: string[]
  rules: {
    files: string[]
  }
  modes: {
    agent?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    plan?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    debug?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    ask?: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string }
    [key: string]: { autoApprove?: string[]; systemPrompt?: string; customInstructions?: string } | undefined
  }
  profiles: Record<string, Partial<{ provider: string; id: string; apiKey: string; baseUrl: string; temperature: number }>>
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

interface SessionPreview {
  id: string
  ts: number
  title?: string
  messageCount: number
}

interface ChatState {
  messages: SessionMessage[]
  mode: Mode
  maxMode: boolean
  isRunning: boolean
  model: string
  provider: string
  sessionId: string
  todo: string
  indexReady: boolean
  indexStatus: IndexStatusKind
  inputValue: string
  view: AppView
  sessions: SessionPreview[]
  config: NexusConfigState | null
  isCompacting: boolean
  subagents: SubAgentState[]
  selectedProfile: string

  // Actions
  setView: (view: AppView) => void
  setInputValue: (v: string) => void
  appendToInput: (v: string) => void
  setMode: (mode: Mode) => void
  setMaxMode: (enabled: boolean) => void
  setProfile: (profileName: string) => void
  sendMessage: (content: string) => void
  abort: () => void
  compact: () => void
  clearChat: () => void
  forkSession: (messageId: string) => void
  switchSession: (sessionId: string) => void
  reindex: () => void
  clearIndex: () => void
  saveConfig: (patch: Record<string, unknown>) => void
  handleStateUpdate: (state: Partial<ChatState>) => void
  handleConfigLoaded: (config: NexusConfigState) => void
  handleAgentEvent: (event: AgentEvent) => void
  handleIndexStatus: (status: IndexStatusKind) => void
  handleSessionList: (sessions: SessionPreview[]) => void
}

export type AgentEvent =
  | { type: "text_delta"; delta: string; messageId: string }
  | { type: "reasoning_delta"; delta: string; messageId: string }
  | { type: "tool_start"; tool: string; partId: string; messageId: string }
  | { type: "tool_end"; tool: string; partId: string; messageId: string; success: boolean }
  | { type: "subagent_start"; subagentId: string; mode: Mode; task: string }
  | { type: "subagent_tool_start"; subagentId: string; tool: string }
  | { type: "subagent_tool_end"; subagentId: string; tool: string; success: boolean }
  | { type: "subagent_done"; subagentId: string; success: boolean; outputPreview?: string; error?: string }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "index_update"; status: IndexStatusKind }
  | { type: "error"; error: string; fatal?: boolean }
  | { type: "done"; messageId: string }
  | { type: "doom_loop_detected"; tool: string }

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  mode: "agent",
  maxMode: false,
  isRunning: false,
  model: "claude-sonnet-4-5",
  provider: "anthropic",
  sessionId: "",
  todo: "",
  indexReady: false,
  indexStatus: { state: "idle" },
  inputValue: "",
  view: "chat",
  sessions: [],
  config: null,
  isCompacting: false,
  subagents: [],
  selectedProfile: "",

  setView: (view) => set({ view }),
  setInputValue: (v) => set({ inputValue: v }),

  appendToInput: (v) => set((prev) => ({
    inputValue: prev.inputValue ? `${prev.inputValue}\n\n${v}` : v,
  })),

  setMode: (mode) => {
    set({ mode })
    postMessage({ type: "setMode", mode })
  },

  setMaxMode: (enabled) => {
    set({ maxMode: enabled })
    postMessage({ type: "setMaxMode", enabled })
  },
  setProfile: (profileName) => {
    set({ selectedProfile: profileName })
    postMessage({ type: "setProfile", profile: profileName })
  },

  sendMessage: (content) => {
    const { mode, isRunning } = get()
    if (isRunning) return
    set({ inputValue: "", isRunning: true, view: "chat" })
    postMessage({ type: "newMessage", content, mode })
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
    set({ messages: [], todo: "", view: "chat", subagents: [] })
  },

  forkSession: (messageId) => {
    postMessage({ type: "forkSession", messageId })
  },

  switchSession: (sessionId) => {
    postMessage({ type: "switchSession", sessionId })
    set({ view: "chat" })
  },

  reindex: () => {
    postMessage({ type: "reindex" })
    set({ indexStatus: { state: "indexing", progress: 0, total: 0 } })
  },

  clearIndex: () => {
    postMessage({ type: "clearIndex" })
    set({ indexStatus: { state: "indexing", progress: 0, total: 0 } })
  },

  saveConfig: (patch) => {
    postMessage({ type: "saveConfig", config: patch })
  },

  handleStateUpdate: (state) => {
    set((prev) => ({ ...prev, ...state }))
  },

  handleConfigLoaded: (config) => {
    set({
      config,
      maxMode: config.maxMode.enabled,
      provider: config.model.provider,
      model: config.model.id,
    })
  },

  handleIndexStatus: (status) => {
    set({
      indexStatus: status,
      indexReady: status.state === "ready",
    })
  },

  handleSessionList: (sessions) => {
    set({ sessions })
  },

  handleAgentEvent: (event) => {
    const { messages } = get()

    switch (event.type) {
      case "text_delta": {
        const lastMsg = messages[messages.length - 1]
        if (lastMsg?.role === "assistant") {
          const updated = { ...lastMsg }
          if (typeof updated.content === "string") {
            updated.content += event.delta
          } else {
            const parts = [...(updated.content as MessagePart[])]
            const lastPart = parts[parts.length - 1]
            if (lastPart?.type === "text") {
              parts[parts.length - 1] = { ...lastPart, text: lastPart.text + event.delta } as TextPart
            } else {
              parts.push({ type: "text", text: event.delta })
            }
            updated.content = parts
          }
          set({ messages: [...messages.slice(0, -1), updated] })
        } else {
          set({
            messages: [
              ...messages,
              {
                id: `msg_${Date.now()}`,
                ts: Date.now(),
                role: "assistant" as const,
                content: event.delta,
              },
            ],
          })
        }
        break
      }

      case "tool_start": {
        const msgs = [...messages]
        const lastMsg = msgs[msgs.length - 1]
        if (lastMsg?.role === "assistant") {
          const parts = Array.isArray(lastMsg.content)
            ? [...(lastMsg.content as MessagePart[])]
            : [{ type: "text" as const, text: lastMsg.content as string }]
          parts.push({
            type: "tool",
            id: event.partId,
            tool: event.tool,
            status: "running",
            timeStart: Date.now(),
          } as ToolPart)
          msgs[msgs.length - 1] = { ...lastMsg, content: parts }
          set({ messages: msgs })
        }
        break
      }

      case "tool_end": {
        const msgs = messages.map((msg) => {
          if (!Array.isArray(msg.content)) return msg
          const parts = (msg.content as MessagePart[]).map((p) => {
            if (p.type === "tool" && (p as ToolPart).id === event.partId) {
              return {
                ...(p as ToolPart),
                status: event.success ? "completed" : "error",
                timeEnd: Date.now(),
              } as ToolPart
            }
            return p
          })
          return { ...msg, content: parts }
        })
        set({ messages: msgs })
        break
      }

      case "subagent_start": {
        const prev = get().subagents.filter((a) => a.id !== event.subagentId)
        prev.push({
          id: event.subagentId,
          mode: event.mode,
          task: event.task,
          status: "running",
          startedAt: Date.now(),
        })
        set({ subagents: prev.slice(-12) })
        break
      }

      case "subagent_tool_start": {
        const subagents: SubAgentState[] = get().subagents.map((a) =>
          a.id === event.subagentId
            ? { ...a, status: "running" as const, currentTool: event.tool }
            : a
        )
        set({ subagents })
        break
      }

      case "subagent_tool_end": {
        const subagents: SubAgentState[] = get().subagents.map((a) =>
          a.id === event.subagentId
            ? {
                ...a,
                status: (event.success ? "running" : "error") as "running" | "error",
                currentTool: event.success ? undefined : event.tool,
              }
            : a
        )
        set({ subagents })
        break
      }

      case "subagent_done": {
        const subagents: SubAgentState[] = get().subagents.map((a) =>
          a.id === event.subagentId
            ? {
                ...a,
                status: (event.success ? "completed" : "error") as "completed" | "error",
                currentTool: undefined,
                finishedAt: Date.now(),
                error: event.error,
              }
            : a
        )
        set({ subagents })
        break
      }

      case "reasoning_delta": {
        const lastMsg = messages[messages.length - 1]
        if (lastMsg?.role === "assistant") {
          const updated = { ...lastMsg }
          const parts = Array.isArray(updated.content)
            ? [...(updated.content as MessagePart[])]
            : [{ type: "text" as const, text: updated.content as string }]
          const lastPart = parts[parts.length - 1]
          if (lastPart?.type === "reasoning") {
            parts[parts.length - 1] = { ...lastPart, text: lastPart.text + event.delta } as ReasoningPart
          } else {
            parts.push({ type: "reasoning", text: event.delta })
          }
          updated.content = parts
          set({ messages: [...messages.slice(0, -1), updated] })
        }
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
        })
        break
      }

      case "done":
        set((state) => ({
          isRunning: false,
          subagents: state.subagents.filter((a) => a.status === "running"),
        }))
        break

      case "error":
        set((state) => ({
          isRunning: false,
          subagents: state.subagents.map((a) =>
            a.status === "running"
              ? { ...a, status: "error", finishedAt: Date.now(), error: "Parent agent failed" }
              : a
          ),
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
