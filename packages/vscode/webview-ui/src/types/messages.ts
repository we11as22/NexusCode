import type { IndexStatusKind, Mode, NexusConfigState, SessionMessage } from "../stores/chat.js"

export interface WebviewState {
  messages: SessionMessage[]
  mode: Mode
  isRunning: boolean
  model: string
  provider: string
  sessionId: string
  projectDir?: string
  todo: string
  indexReady: boolean
  indexStatus: IndexStatusKind
  contextUsedTokens: number
  contextLimitTokens: number
  contextPercent: number
  /** NexusCode server URL (from nexuscode.serverUrl). When set, extension uses server for sessions and runs. */
  serverUrl?: string
}

export type ExtensionMessage =
  | { type: "stateUpdate"; state: WebviewState }
  | { type: "agentEvent"; event: Record<string, unknown> }
  | { type: "sessionList"; sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> }
  | { type: "sessionListLoading"; loading: boolean }
  | { type: "indexStatus"; status: IndexStatusKind }
  | { type: "configLoaded"; config: NexusConfigState }
  | { type: "addToChatContent"; content: string }
