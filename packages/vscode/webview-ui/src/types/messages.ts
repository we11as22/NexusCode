import type { IndexStatusKind, Mode, NexusConfigState, SessionMessage } from "../stores/chat.js"

/** Same shape as @nexuscode/core ModelsCatalog (used by extension host) */
export interface ModelsCatalogFromCore {
  providers: Array<{
    id: string
    name: string
    baseUrl: string
    models: Array<{ id: string; name: string; free: boolean; recommendedIndex?: number }>
  }>
  recommended: Array<{ providerId: string; modelId: string; name: string; free: boolean }>
}

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
  /** Checkpoint entries for rollback (Cline-style). */
  checkpointEntries?: Array<{ hash: string; ts: number; description?: string; messageId?: string }>
}

export type ExtensionMessage =
  | { type: "stateUpdate"; state: WebviewState }
  | { type: "agentEvent"; event: Record<string, unknown> }
  | { type: "sessionList"; sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> }
  | { type: "sessionListLoading"; loading: boolean }
  | { type: "indexStatus"; status: IndexStatusKind }
  | { type: "configLoaded"; config: NexusConfigState }
  | { type: "addToChatContent"; content: string }
  | { type: "action"; action: "switchView"; view: "chat" | "sessions" | "settings" }
  | { type: "mcpServerStatus"; results: Array<{ name: string; status: "ok" | "error"; error?: string }> }
  | { type: "pendingApproval"; partId: string; action: { type: string; tool: string; description: string; content?: string } }
  | { type: "confirmResult"; id: string; ok: boolean }
  | { type: "modelsCatalog"; catalog: ModelsCatalogFromCore }
