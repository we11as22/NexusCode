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

/** Agent preset (vector + skills + MCP + rules from .nexus/agent-configs.json). */
export interface AgentPresetFromCore {
  name: string
  vector: boolean
  skills: string[]
  mcpServers: string[]
  rulesFiles: string[]
  modelProvider?: string
  modelId?: string
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
  /** When true, server session has more messages above; show "Load older". */
  hasOlderMessages?: boolean
  /** True while older messages are being fetched. */
  loadingOlderMessages?: boolean
  /** Session unaccepted edits: path + diffStats for "N Files" panel. */
  sessionUnacceptedEdits?: Array<{ path: string; diffStats: { added: number; removed: number }; isNewFile?: boolean }>
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
  | { type: "pendingApproval"; partId: string; action: { type: string; tool: string; description: string; content?: string; diff?: string; diffStats?: { added: number; removed: number } } }
  | { type: "confirmResult"; id: string; ok: boolean }
  | { type: "modelsCatalog"; catalog: ModelsCatalogFromCore }
  | { type: "agentPresets"; presets: AgentPresetFromCore[] }
  | { type: "agentPresetOptions"; options: { skills: string[]; mcpServers: string[]; rulesFiles: string[] } }
  | { type: "skillDefinitions"; definitions: Array<{ name: string; path: string; summary: string }> }
