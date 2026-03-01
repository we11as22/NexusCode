import type { IndexStatusKind, Mode, NexusConfigState, SessionMessage } from "../stores/chat.js"

export interface WebviewState {
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
  contextUsedTokens: number
  contextLimitTokens: number
  contextPercent: number
}

export type ExtensionMessage =
  | { type: "stateUpdate"; state: WebviewState }
  | { type: "agentEvent"; event: Record<string, unknown> }
  | { type: "sessionList"; sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> }
  | { type: "indexStatus"; status: IndexStatusKind }
  | { type: "configLoaded"; config: NexusConfigState }
  | { type: "addToChatContent"; content: string }
