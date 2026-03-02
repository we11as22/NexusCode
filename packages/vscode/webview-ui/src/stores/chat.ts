import { create } from "zustand"
import { postMessage } from "../vscode.js"

export type Mode = "agent" | "plan" | "ask"
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
  isRunning: boolean
  awaitingApproval: boolean
  model: string
  provider: string
  sessionId: string
  todo: string
  indexReady: boolean
  indexStatus: IndexStatusKind
  contextUsedTokens: number
  contextLimitTokens: number
  contextPercent: number
  inputValue: string
  view: AppView
  sessions: SessionPreview[]
  /** True while session list is being fetched (e.g. from server). */
  sessionsLoading: boolean
  config: NexusConfigState | null
  isCompacting: boolean
  subagents: SubAgentState[]
  selectedProfile: string
  projectDir: string
  /** When the current reasoning block started (for "Thought for Xs" display) */
  reasoningStartTime: number | null
  /** NexusCode server URL (nexuscode.serverUrl). When set, extension uses server for sessions and runs. */
  serverUrl: string

  // Actions
  setView: (view: AppView) => void
  setInputValue: (v: string) => void
  appendToInput: (v: string) => void
  setMode: (mode: Mode) => void
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
  handleSessionListLoading: (loading: boolean) => void
}

export type AgentEvent =
  | { type: "text_delta"; delta: string; messageId: string }
  | { type: "reasoning_delta"; delta: string; messageId: string }
  | { type: "tool_start"; tool: string; partId: string; messageId: string; input?: Record<string, unknown> }
  | { type: "tool_end"; tool: string; partId: string; messageId: string; success: boolean; output?: string; error?: string; compacted?: boolean }
  | { type: "subagent_start"; subagentId: string; mode: Mode; task: string }
  | { type: "subagent_tool_start"; subagentId: string; tool: string }
  | { type: "subagent_tool_end"; subagentId: string; tool: string; success: boolean }
  | { type: "subagent_done"; subagentId: string; success: boolean; outputPreview?: string; error?: string }
  | { type: "tool_approval_needed"; action: ApprovalAction; partId: string }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "index_update"; status: IndexStatusKind }
  | { type: "context_usage"; usedTokens: number; limitTokens: number; percent: number }
  | { type: "error"; error: string; fatal?: boolean }
  | { type: "done"; messageId: string }
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
  contextUsedTokens: 0,
  contextLimitTokens: 128000,
  contextPercent: 0,
  inputValue: "",
  view: "chat",
  sessions: [],
  sessionsLoading: false,
  config: null,
  isCompacting: false,
  subagents: [],
  selectedProfile: "",
  projectDir: "",
  reasoningStartTime: null,
  serverUrl: "",

  setView: (view) => {
    set({ view })
    if (view === "sessions") postMessage({ type: "getState" })
  },
  setInputValue: (v) => set({ inputValue: v }),

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
    const { mode, isRunning } = get()
    if (isRunning) return
    set((prev) => ({
      inputValue: "",
      isRunning: true,
      view: "chat",
      messages: [
        ...prev.messages,
        {
          id: `local_user_${Date.now()}`,
          ts: Date.now(),
          role: "user",
          content,
        },
      ],
    }))
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
  },

  clearIndex: () => {
    postMessage({ type: "clearIndex" })
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
  handleSessionListLoading: (loading) => {
    set({ sessionsLoading: loading })
  },

  handleAgentEvent: (event) => {
    const { messages } = get()

    switch (event.type) {
      case "text_delta": {
        const { list: baseList, index } = ensureAssistantMessage(messages, event.messageId)
        const target = baseList[index]
        if (!target) break
        const updated = { ...target }
        if (typeof updated.content === "string") {
          updated.content = sanitizeAssistantText(updated.content + event.delta)
        } else {
          const parts = [...(updated.content as MessagePart[])]
          const lastPart = parts[parts.length - 1]
          if (lastPart?.type === "text") {
            parts[parts.length - 1] = { ...lastPart, text: sanitizeAssistantText(lastPart.text + event.delta) } as TextPart
          } else {
            const cleaned = sanitizeAssistantText(event.delta)
            if (cleaned) {
              parts.push({ type: "text", text: cleaned })
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
        const ev = event as { input?: Record<string, unknown> }
        const { list: baseList, index } = ensureAssistantMessage(messages, event.messageId)
        const target = baseList[index]
        if (!target) break
        const parts = Array.isArray(target.content)
          ? [...(target.content as MessagePart[])]
          : [{ type: "text" as const, text: target.content as string }]
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
        const ev = event as { output?: string; error?: string; compacted?: boolean }
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
              } as ToolPart
            }
            return p
          })
          return { ...msg, content: parts }
        })
        set({ messages: msgs, awaitingApproval: false })
        break
      }

      case "tool_approval_needed":
        set({ awaitingApproval: true })
        break

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
        const { list: baseList, index } = ensureAssistantMessage(messages, event.messageId)
        const target = baseList[index]
        if (!target) break
        set((s) => ({ ...s, reasoningStartTime: s.reasoningStartTime ?? Date.now() }))
        const updated = { ...target }
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
        })
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
                .filter((p) => p.type !== "text" || stripToolCallMarkup((p as TextPart).text).length > 0)
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
                : (latestAssistant.content as MessagePart[]).some((p) => p.type === "text" && p.text.trim().length > 0)
            )

          if (!hasAssistantText && state.messages.length > 0) {
            msgs.push({
              id: `system_done_${Date.now()}`,
              ts: Date.now(),
              role: "system",
              content: "No final text response was produced. Retry with a narrower prompt or switch mode.",
            })
          }

          return {
            messages: msgs,
            isRunning: false,
            awaitingApproval: false,
            subagents: state.subagents.filter((a) => a.status === "running"),
            reasoningStartTime: null,
          }
        })
        break

      case "error":
        set((state) => ({
          ...state,
          isRunning: false,
          awaitingApproval: false,
          reasoningStartTime: null,
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
