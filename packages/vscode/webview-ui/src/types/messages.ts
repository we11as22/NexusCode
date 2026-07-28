import type { IndexStatusKind, Mode, NexusConfigState, SessionMessage } from "../stores/chat.js"
import type { MarketplaceItem, MarketplaceInstalledMetadata } from "./marketplace.js"
import type { ApprovalActionView } from "./approval.js"

/** Same shape as @nexuscode/core ModelsCatalog (used by extension host) */
export interface ModelsCatalogFromCore {
  providers: Array<{
    id: string
    name: string
    baseUrl: string
    models: Array<{
      id: string
      name: string
      free: boolean
      contextWindow?: number
      recommendedIndex?: number
    }>
  }>
  recommended: Array<{
    providerId: string
    modelId: string
    name: string
    free: boolean
    contextWindow?: number
  }>
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

/** Server connection state for UI indicator and retry. */
export type ServerConnectionState = "idle" | "connecting" | "streaming" | "error"

export interface AutocompleteExtensionUiState {
  enableAutoTrigger: boolean
  useSeparateModel: boolean
  modelProvider: string
  modelId: string
  modelApiKey: string
  hasModelApiKey: boolean
  modelBaseUrl: string
  modelTemperature: string
  modelReasoningEffort: string
  modelContextWindow: string
}

export interface SlashCommandCatalogItem {
  name: string
  description: string
  kind: "custom" | "mcp"
  argumentHint?: string
}

export interface ToolContributionDiagnosticView {
  level: "warning" | "error"
  code: string
  source: string
  message: string
  toolName?: string
}

export interface WebviewState {
  /** Monotonically increasing sequence number for stateUpdate snapshots (ignore stale seq). */
  stateUpdateSeq?: number
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
  /** When using server: connection state for UI (connecting/streaming/error). */
  connectionState?: ServerConnectionState
  /** When connectionState === "error": message to show; user can retry by sending again. */
  serverConnectionError?: string
  /** Persistent fail-closed workspace configuration error. */
  configurationError?: string | null
  /** Non-fatal diagnostics from the exact local custom/plugin tool generation. */
  toolContributionDiagnostics?: ToolContributionDiagnosticView[]
  /** When true, server session has more messages above; show "Load older". */
  hasOlderMessages?: boolean
  /** True while older messages are being fetched. */
  loadingOlderMessages?: boolean
  /** Session unaccepted edits: path + diffStats for "N Files" panel. */
  sessionUnacceptedEdits?: Array<{
    path: string
    diffStats: { added: number; removed: number }
    isNewFile?: boolean
    changeSetId: string
    changeSetFileCount?: number
  }>
  pendingQuestionRequest?: {
    requestId: string
    title?: string
    submitLabel?: string
    customOptionLabel?: string
    questions: Array<{ id: string; question: string; options: Array<{ id: string; label: string }>; allowCustom?: boolean }>
  } | null
  /** Active preset name for chat (per-message). */
  activePresetName?: string
  autocompleteExtension: AutocompleteExtensionUiState
}

export type ExtensionMessage = (
  | { type: "stateUpdate"; state: WebviewState }
  | {
      type: "messageSubmissionResult"
      clientMessageId: string
      accepted: boolean
    }
  | { type: "agentEvent"; event: Record<string, unknown> }
  | { type: "sessionList"; sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> }
  | { type: "sessionListLoading"; loading: boolean }
  | { type: "indexStatus"; status: IndexStatusKind }
  | { type: "configLoaded"; config: NexusConfigState }
  | { type: "addToChatContent"; content: string }
  | { type: "action"; action: "switchView"; view: "chat" | "sessions" | "settings"; settingsTab?: "llm" | "embeddings" | "index" | "tools" | "integrations" | "presets"; settingsIntegTab?: "marketplace" | "rules-skills" | "mcp" | "rules-instructions" }
  | { type: "mcpServerStatus"; results: Array<{ name: string; status: "ok" | "error"; error?: string }> }
  | { type: "slashCommandCatalog"; commands: SlashCommandCatalogItem[] }
  | { type: "pendingApproval"; partId: string; action: ApprovalActionView }
  | { type: "confirmResult"; id: string; ok: boolean }
  | { type: "modelsCatalog"; catalog: ModelsCatalogFromCore }
  | { type: "agentPresets"; presets: AgentPresetFromCore[] }
  | { type: "agentPresetOptions"; options: { skills: string[]; mcpServers: string[]; rulesFiles: string[] } }
  | { type: "skillDefinitions"; definitions: Array<{ name: string; path: string; summary: string }> }
  | {
      type: "marketplaceData"
      marketplaceItems: MarketplaceItem[]
      marketplaceInstalledMetadata: MarketplaceInstalledMetadata
      errors?: string[]
      skillSearchMeta?: { query: string; mode: string; total: number; limit: number; page: number }
    }
  | { type: "marketplaceInstallResult"; slug: string; success: boolean; error?: string }
  | { type: "marketplaceRemoveResult"; slug: string; success: boolean; error?: string }
) & { seq?: number }
