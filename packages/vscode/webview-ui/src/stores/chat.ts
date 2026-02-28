import { create } from "zustand"
import { postMessage } from "../vscode.js"

export type Mode = "agent" | "plan" | "debug" | "ask"

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
  type: "tool"; id: string; tool: string;
  status: "pending" | "running" | "completed" | "error"
  input?: Record<string, unknown>; output?: string; error?: string
  timeStart?: number; timeEnd?: number; compacted?: boolean
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
  inputValue: string

  // Actions
  setInputValue: (v: string) => void
  setMode: (mode: Mode) => void
  setMaxMode: (enabled: boolean) => void
  sendMessage: (content: string) => void
  abort: () => void
  compact: () => void
  clearChat: () => void
  forkSession: (messageId: string) => void
  handleStateUpdate: (state: Partial<ChatState>) => void
  handleAgentEvent: (event: AgentEvent) => void
}

export type AgentEvent =
  | { type: "text_delta"; delta: string; messageId: string }
  | { type: "reasoning_delta"; delta: string; messageId: string }
  | { type: "tool_start"; tool: string; partId: string; messageId: string }
  | { type: "tool_end"; tool: string; partId: string; messageId: string; success: boolean }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "index_update"; status: unknown }
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
  inputValue: "",

  setInputValue: (v) => set({ inputValue: v }),

  setMode: (mode) => {
    set({ mode })
    postMessage({ type: "setMode", mode })
  },

  setMaxMode: (enabled) => {
    set({ maxMode: enabled })
    postMessage({ type: "setMaxMode", enabled })
  },

  sendMessage: (content) => {
    const { mode, isRunning } = get()
    if (isRunning) return

    set({ inputValue: "", isRunning: true })
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
    set({ messages: [], todo: "" })
  },

  forkSession: (messageId) => {
    postMessage({ type: "forkSession", messageId })
  },

  handleStateUpdate: (state) => {
    set(prev => ({ ...prev, ...state }))
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
            const parts = updated.content as MessagePart[]
            const lastPart = parts[parts.length - 1]
            if (lastPart?.type === "text") {
              (lastPart as TextPart).text += event.delta
            } else {
              parts.push({ type: "text", text: event.delta })
            }
          }
          set({ messages: [...messages.slice(0, -1), updated] })
        } else {
          set({
            messages: [
              ...messages,
              {
                id: `msg_${Date.now()}`,
                ts: Date.now(),
                role: "assistant",
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
        const msgs = messages.map(msg => {
          if (!Array.isArray(msg.content)) return msg
          const parts = (msg.content as MessagePart[]).map(p => {
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

      case "done":
        set({ isRunning: false })
        break

      case "error":
        set({ isRunning: false })
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
