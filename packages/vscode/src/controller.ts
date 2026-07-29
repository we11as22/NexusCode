/**
 * Controller — Cline-style single owner of task/session state and agent run.
 * Owns session, config, run state, and posts state/events to webview via postMessage.
 */

import * as vscode from "vscode"
import * as path from "path"
import * as fs from "node:fs"
import { promises as fsPromises } from "node:fs"
import * as os from "node:os"
import {
  formatQuestionnaireAnswersForAgent,
  type AgentEvent,
  type NexusConfig,
  type ProviderConfig,
  type Mode,
  type SessionMessage,
  type IndexStatus,
  type MessagePart,
  type ToolPart,
  type UserQuestionRequest,
  type UserQuestionAnswer,
  type ApprovalAction,
  type PermissionResult,
  type CheckpointEntry,
  type ChangeSetRecord,
  type McpServerConfig,
  type ToolContributionDiagnostic,
  ChangeSetService,
  exactChangeHunkDiffStats,
  exactLineDiffStats,
  reapplyRevertedChangeSets,
  revertEffectiveChangeSetsAfter,
} from "@nexuscode/core"
import {
  patchGlobalConfig,
  patchProjectConfig,
  finalizeConfigCredentials,
  getConfigEnvironment,
  persistSecretsFromConfig,
  stripSecretsFromConfig,
  NEXUS_SECRETS_STORAGE_KEY,
  Session,
  listSessions,
  deleteSession,
  getSessionMeta,
  loadSessionMessages,
  mutateSession,
  createLLMClient,
  ToolRegistry,
  loadSkills,
  loadAgentInstructionBundle,
  type McpClient,
  resolveBundledMcpServers,
  resolveConfiguredAndPluginMcpServers,
  compactSessionAndPersist,
  createCompaction,
  createSpawnAgentTool,
  createSpawnAgentOutputTool,
  createSpawnAgentStopTool,
  createSpawnAgentsParallelTool,
  createListAgentRunsTool,
  createAgentRunSnapshotTool,
  createResumeAgentTool,
  createTaskCreateBatchTool,
  createTaskResumeTool,
  createTaskSnapshotTool,
  runAgentLoop,
  DurableRunEventSink,
  CheckpointTracker,
  CodebaseIndexer,
  createCodebaseIndexer,
  buildIndexWatcherGlobPattern,
  ensureQdrantRunning,
  getModelsCatalog,
  hadPlanExit,
  getPlanContentForFollowup,
  getSessionModeForResume,
  NexusServerClient,
  canonicalizeNexusServerBaseUrl,
  UserInputPartSchema,
  getNexusServerTokenSecretKey,
  isLoopbackNexusServerDestination,
  NEXUS_SERVER_TOKEN_SECRET_KEY,
  SessionProtocolError,
  SessionTurnTerminalError,
  INDEX_FILE_WATCHER_DEBOUNCE_MS,
  canonicalProjectRoot,
  computeContextUsageMetrics,
  estimateToolsDefinitionsTokens,
  reconcilePersistedContextUsage,
  shouldUseDeferredToolLoading,
  getClaudeCompatibilityOptions,
  isDelegatedAgentParentTool,
  isDelegatedAgentParentToolEndClear,
  loadSlashCommands,
  renderSlashCommandPrompt,
  resolveSlashCommand,
  mergeModelPresetSelection,
  mergeProviderConfigSafely,
  selectProviderProfile,
  settleRuntimeDependency,
  hashWorkspaceIdentity,
} from "@nexuscode/core"
import { PendingQuestionCoordinator } from "./question-lifecycle.js"
import {
  VsCodeHost,
  resolveWebviewApproval,
  showSessionEditDiff,
  openReadonlyTextDiff,
  type WebviewApprovalResolverSlot,
} from "./host.js"
import {
  applyExplicitConfigOverrides,
  applyRepositoryAgentPreset,
  getCredentialRemovalsForConfigPatch,
  mergeConfigPatchSafely,
  partitionConfigPatchForPersistence,
} from "./config-overrides.js"
import { MarketplaceService, type MarketplaceItem } from "./services/marketplace/index.js"
import { listAbsolutePathsRipgrep } from "./services/indexing/list-absolute-paths-rg.js"
import {
  AUTOCOMPLETE_API_KEY_SECRET,
  mergeLegacyNexusSecrets,
  selectLegacySetting,
} from "./secret-settings.js"
import {
  approvePendingVsCodeProjectAuthority,
  loadVsCodeWorkspaceConfig,
} from "./workspace-authority-config.js"
import {
  VsCodeRemoteTurn,
  assertRemoteHostSelectionSupported,
  assertRemotePresetSupported,
  resumeVsCodeRemoteTurn,
} from "./remote-turn.js"
import { VsCodeRemoteWorkspaceState } from "./remote-workspace-state.js"
import { WorkspaceRunServicesRegistry } from "./workspace-run-services.js"
import {
  parseExternalHttpUrl,
  resolveVectorDbRequest,
  type WebviewMessage,
} from "./webview-protocol.js"
import {
  createVsCodeMcpClient,
  prepareVsCodeRunIntegrations,
  testVsCodeMcpServers,
} from "./local-run-context.js"
import { WebviewPathCapabilities } from "./webview-path-capabilities.js"
import {
  getMcpPromptCommandCatalog,
  getRemoteMcpPromptCommandCatalog,
  isMcpPromptCommandName,
  resolveMcpPromptCommand,
  resolveRemoteMcpPromptCommand,
} from "./mcp-prompts.js"
import {
  remoteModeTransitionFromAgentEvent,
} from "./remote-mode-transition.js"
import {
  pendingWriteApprovalPreviewFromEvent,
  type PendingWriteApprovalPreview,
} from "./pending-approval-preview.js"

export type { WebviewMessage } from "./webview-protocol.js"

const MODE_REMINDER_REGEX = /^\[You are now in [^\]]+\.\]\s*\n?\n?/i
const THOUGHT_PLACEHOLDER = "Model reasoning is active, but the provider has not streamed visible reasoning text yet."
const MAX_SLASH_COMMAND_CATALOG_ITEMS = 1_024
const MAX_SLASH_COMMAND_NAME_CHARS = 2_048

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

type PromptCommandResolution =
  | { status: "resolved"; prompt: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "not-found" }

function parseSlashPromptInvocation(
  input: string,
): { name: string; args: string } | null {
  const match = input.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/u)
  if (!match) return null
  return {
    name: match[1]!,
    args: match[2] ?? "",
  }
}

function findOpenReasoningReverseIndexShadow(parts: MessagePart[], reasoningId: string): number {
  return [...parts].reverse().findIndex(
    (part) =>
      part.type === "reasoning" &&
      (part as MessagePart & { durationMs?: number }).durationMs == null &&
      ((part as MessagePart & { reasoningId?: string }).reasoningId ?? "reasoning-0") === reasoningId
  )
}

/** Number of messages to load when opening a server session (same as server RECENT_MESSAGES_FOR_RUN for agent context). */
const INITIAL_SERVER_MESSAGES = 200
type ShadowSubAgentState = {
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

function reduceSubagentState(
  list: ShadowSubAgentState[],
  event:
    | { type: "subagent_start"; subagentId: string; mode: Mode; task: string }
    | { type: "subagent_tool_start"; subagentId: string; tool: string; input?: Record<string, unknown> }
    | { type: "subagent_tool_end"; subagentId: string; tool: string; success: boolean }
    | { type: "subagent_done"; subagentId: string; success: boolean; error?: string }
): ShadowSubAgentState[] {
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
    (part) => part.type === "tool" && (part as ToolPart & { subagents?: ShadowSubAgentState[] }).subagents?.some((subagent) => subagent.id === subagentId)
  )
  if (byExistingSubagent >= 0) return byExistingSubagent
  if (parentPartId && parentPartId.trim().length > 0) {
    return parts.findIndex((part) => part.type === "tool" && (part as ToolPart).id === parentPartId)
  }
  return -1
}

function stripModeReminderFromMessages(messages: SessionMessage[]): SessionMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user") return msg
    const content = msg.content
    if (typeof content !== "string") return msg
    const stripped = content.replace(MODE_REMINDER_REGEX, "").trimStart()
    if (stripped === content) return msg
    return { ...msg, content: stripped }
  })
}

export type ExtensionMessage = (
  | { type: "stateUpdate"; state: WebviewState }
  | {
      type: "messageSubmissionResult"
      clientMessageId: string
      accepted: boolean
    }
  | { type: "agentEvent"; event: AgentEvent }
  | { type: "sessionList"; sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> }
  | { type: "sessionListLoading"; loading: boolean }
  | { type: "indexStatus"; status: IndexStatus }
  | { type: "configLoaded"; config: NexusConfig }
  | { type: "skillDefinitions"; definitions: Array<{ name: string; path: string; summary: string }> }
  | { type: "addToChatContent"; content: string }
  | { type: "action"; action: "switchView"; view: "chat" | "sessions" | "settings"; settingsTab?: "llm" | "embeddings" | "index" | "tools" | "integrations" | "presets"; settingsIntegTab?: "rules-skills" | "mcp" | "rules-instructions" }
  | { type: "mcpServerStatus"; results: Array<{ name: string; status: "ok" | "error"; error?: string }> }
  | { type: "slashCommandCatalog"; commands: SlashCommandCatalogItem[] }
  | { type: "pendingApproval"; partId: string; action: ApprovalAction }
  | { type: "confirmResult"; id: string; ok: boolean }
  | { type: "modelsCatalog"; catalog: import("@nexuscode/core").ModelsCatalog }
  | { type: "agentPresets"; presets: Array<{ name: string; vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string }> }
  | { type: "agentPresetOptions"; options: { skills: string[]; mcpServers: string[]; rulesFiles: string[] } }
  | {
      type: "marketplaceData"
      marketplaceItems: MarketplaceItem[]
      marketplaceInstalledMetadata: { project: Record<string, { type: string }>; global: Record<string, { type: string }> }
      errors?: string[]
      skillSearchMeta?: { query: string; mode: string; total: number; limit: number; page: number }
    }
  | { type: "marketplaceInstallResult"; slug: string; success: boolean; error?: string }
  | { type: "marketplaceRemoveResult"; slug: string; success: boolean; error?: string }
) & { seq?: number }

export type ServerConnectionState = "idle" | "connecting" | "streaming" | "error"

/** Inline autocomplete UI (backed by nexuscode.autocomplete.* VS Code settings). */
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

export interface WebviewState {
  /**
   * Monotonically increasing sequence number for stateUpdate snapshots.
   * Clients should ignore snapshots with seq <= last applied seq to prevent stale snapshots
   * (captured during async getStateToPostToWebview) from overwriting newer streamed state.
   */
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
  indexStatus: IndexStatus
  contextUsedTokens: number
  contextLimitTokens: number
  contextPercent: number
  contextSource?: "provider" | "hybrid" | "estimated"
  contextProviderTokens?: number
  contextPendingTokens?: number
  serverUrl?: string
  /** When using server: connection state for UI indicator and retry. */
  connectionState?: ServerConnectionState
  /** When connectionState === "error": message to show and trigger retry. */
  serverConnectionError?: string
  /** Persistent fail-closed workspace configuration error. */
  configurationError?: string | null
  /** Non-fatal diagnostics from the exact custom/plugin tool snapshot used by the latest local run. */
  toolContributionDiagnostics?: ToolContributionDiagnosticView[]
  modelsCatalog?: import("@nexuscode/core").ModelsCatalog | null
  checkpointEnabled?: boolean
  checkpointEntries?: CheckpointEntry[]
  /** Plan mode: plan_exit was called; show New session / Continue / Dismiss. */
  planCompleted?: boolean
  /** Plan text for "New session" (optional; controller may set via async follow-up). */
  planFollowupText?: string | null
  /** Server session: there are older messages above; show "Load older" in chat. */
  hasOlderMessages?: boolean
  /** True while older messages are being fetched. */
  loadingOlderMessages?: boolean
  /** Session unaccepted edits: files changed this session not yet accepted (Undo All / Keep All). */
  sessionUnacceptedEdits?: Array<{
    path: string
    diffStats: { added: number; removed: number }
    isNewFile?: boolean
    changeSetId: string
    changeSetFileCount?: number
  }>
  pendingQuestionRequest?: UserQuestionRequest | null
  /** Active preset name for the chat (per-message scoping for skills + MCP). */
  activePresetName?: string
  /** Inline editor autocomplete: master toggle + optional separate model (VS Code settings). */
  autocompleteExtension: AutocompleteExtensionUiState
}

interface SessionUnacceptedEdit {
  path: string
  originalContent: string
  newContent: string
  diffStats: { added: number; removed: number }
  isNewFile: boolean
  changeSetId: string
  changeSetFileCount?: number
  proposalHash?: string
  contentOmitted?: boolean
}

function projectToolContributionDiagnostics(
  cwd: string,
  diagnostics: readonly ToolContributionDiagnostic[],
): ToolContributionDiagnosticView[] {
  const canonicalCwd = path.resolve(cwd)
  return diagnostics.slice(0, 100).map((diagnostic) => {
    const absoluteSource = path.resolve(diagnostic.sourcePath)
    const relativeSource = path.relative(canonicalCwd, absoluteSource)
    const isWorkspaceSource =
      relativeSource === "" ||
      (!relativeSource.startsWith("..") &&
        !path.isAbsolute(relativeSource))
    const source = (
      isWorkspaceSource
        ? relativeSource || "."
        : path.basename(absoluteSource) || "external contribution"
    ).replace(/\\/g, "/")
    return {
      level: diagnostic.level,
      code: diagnostic.code.slice(0, 128),
      source: source.slice(0, 512),
      message: diagnostic.message.slice(0, 2_048),
      ...(diagnostic.toolName
        ? { toolName: diagnostic.toolName.slice(0, 128) }
        : {}),
    }
  })
}

export class Controller {
  private disposed = false
  private session?: Session
  private config?: NexusConfig
  private configurationError?: string
  private stateUpdateSeq = 0
  private defaultModelProfile?: NexusConfig["model"]
  /** Stable profile binding replayed after every disk/config reload. */
  private activeProfileName?: string
  /** Active preset for chat messages (per-message; does not persist to config). */
  private chatPresetName: string = "Default"
  /** Snapshot of skills/mcp/rules/indexing at first config load; used for "Default" preset. */
  private initialFullConfigSnapshot?: {
    skills: string[]
    mcp: { servers: NexusConfig["mcp"]["servers"] }
    rules: { files: string[] }
    indexing: NexusConfig["indexing"]
  }
  private mode: Mode = "agent"
  /** Mode of the previous run; used to prepend a reminder when user switches mode in the same session. */
  private lastRunMode: Mode | null = null
  private isRunning = false
  private abortController?: AbortController
  private checkpoint?: CheckpointTracker
  private indexer?: CodebaseIndexer
  private mcpClient?: McpClient
  private readonly workspaceRunServices = new WorkspaceRunServicesRegistry()
  private serverSessionId?: string
  private remoteSessionCreationPromise?: Promise<{
    client: NexusServerClient
    sessionId: string
  }>
  private activeRemoteTurn?: VsCodeRemoteTurn
  /** Server-validated transition consumed only after the next remote turn is admitted. */
  private forcedRemoteModeForNextRun: Mode | null = null
  private remoteWorkspaceStateCache?: {
    serverUrl: string
    cwd: string
    state: VsCodeRemoteWorkspaceState
  }
  private observedServerUrl = ""
  private serverDestinationChangePromise?: Promise<void>
  private remoteResumePromise?: Promise<boolean>
  /** For server sessions: offset of the oldest loaded message (0 = all loaded). Used for "Load older" pagination. */
  private serverSessionOldestLoadedOffset: number | undefined = undefined
  private loadingOlderMessages = false
  /** When using server: connection state and error for UI. */
  private serverConnectionState: ServerConnectionState = "idle"
  private serverConnectionError: string | undefined = undefined
  private initialized = false
  private initPromise?: Promise<void>
  /** Started in ensureInitialized (not awaited there); runAgent awaits it so MCP is ready before first run. */
  private mcpReconnectPromise: Promise<void> | null = null
  private mcpConfigFingerprint: string | null = null
  private modelsCatalogCache: import("@nexuscode/core").ModelsCatalog | null = null
  private indexStatusUnsubscribe?: () => void
  private indexerFileWatcher?: vscode.Disposable
  /** Debounced paths for batched incremental reindex (see INDEX_FILE_WATCHER_DEBOUNCE_MS). */
  private indexerWatcherPending = new Set<string>()
  private indexerWatcherDebounceTimer: ReturnType<typeof setTimeout> | undefined
  private disposables: vscode.Disposable[] = []
  private readonly marketplaceService = new MarketplaceService()
  private readonly webviewPathCapabilities = new WebviewPathCapabilities()
  private skillDefinitionsLoadGeneration = 0
  private slashCommandCatalogGeneration = 0
  private onAutocompleteConfigReady?: () => void
  private autocompleteApiKeyConfigured = false
  private approvalResolveRef: WebviewApprovalResolverSlot = { current: null }
  /** VS Code Secret Storage for API keys (keys not stored in YAML). */
  private readonly secretsStore = {
    getSecret: async (key: string) => this.context.secrets.get(key),
    setSecret: async (key: string, value: string) => this.context.secrets.store(key, value),
  }
  /** Session unaccepted edits: full content for revert/diff; cleared on session change. */
  private sessionUnacceptedEdits: SessionUnacceptedEdit[] = []
  private changeSetReviewSessionId: string | null = null
  private changeSetReviewRefresh: Promise<void> | null = null
  /** Exact proposed single-file content owned by the current approval event. */
  private pendingWriteApprovalPreview: PendingWriteApprovalPreview | null = null
  /** Server-stream shadow state: remembers latest SpawnAgent tool so subagent events can attach even before final server snapshot arrives. */
  private streamLastSpawnAgentPartId: string | null = null
  /** Last context_usage from agent loop (includes system prompt tokens). Used in getStateToPostToWebview so stateUpdate does not overwrite with session-only count. */
  private lastContextUsage: {
    usedTokens: number
    limitTokens: number
    percent: number
    source?: "provider" | "hybrid" | "estimated"
    providerTokens?: number
    pendingTokens?: number
    modelId?: string
    sessionId: string
  } | null = null
  /** Bounded, path-redacted diagnostics for the most recently prepared local integration snapshot. */
  private toolContributionDiagnostics: ToolContributionDiagnosticView[] = []
  /** Coalesce frequent state snapshots during agent streaming to avoid UI thrash. */
  private statePostTimer: ReturnType<typeof setTimeout> | null = null
  /** True when a local session was opened as a recent-message window instead of fully loaded. */
  private localSessionWindowed = false
  /** Single owner for the pending question lifecycle and response identity. */
  private readonly pendingQuestionCoordinator = new PendingQuestionCoordinator()
  private get pendingQuestionRequest(): UserQuestionRequest | null {
    return this.pendingQuestionCoordinator.snapshot()
  }
  private set pendingQuestionRequest(request: UserQuestionRequest | null) {
    if (request) this.pendingQuestionCoordinator.publish(request)
    else this.pendingQuestionCoordinator.clear("new-run")
  }
  private cwdOverride: string | null = null

  private normalizePathKey(filePath: string, cwd: string): string {
    return this.webviewPathCapabilities
      .resolveWorkspacePath(cwd, filePath)
      .replace(/\\/g, "/")
  }

  private updatePendingWriteApprovalPreview(event: AgentEvent): void {
    if (event.type === "tool_approval_needed") {
      this.pendingWriteApprovalPreview =
        pendingWriteApprovalPreviewFromEvent(event)
      return
    }
    if (
      this.pendingWriteApprovalPreview &&
      ((event.type === "tool_end" &&
        event.partId === this.pendingWriteApprovalPreview.partId) ||
        event.type === "done" ||
        (event.type === "error" && event.fatal))
    ) {
      this.pendingWriteApprovalPreview = null
    }
  }

  private workspaceUriForAuthorizedPath(
    cwd: string,
    authorizedPath: string,
  ): vscode.Uri {
    const canonicalCwd =
      this.webviewPathCapabilities.resolveWorkspacePath(cwd, ".")
    const workspaceFolder = vscode.workspace.workspaceFolders?.find((folder) => {
      try {
        return (
          this.webviewPathCapabilities.resolveWorkspacePath(
            canonicalCwd,
            folder.uri.fsPath,
          ) === canonicalCwd
        )
      } catch {
        return false
      }
    })
    if (!workspaceFolder) return vscode.Uri.file(authorizedPath)
    const relativePath = path
      .relative(canonicalCwd, authorizedPath)
      .replace(/\\/g, "/")
    return vscode.Uri.joinPath(workspaceFolder.uri, relativePath)
  }

  private async openWorkspaceFile(cwd: string, filePath: string): Promise<void> {
    let authorizedPath: string
    try {
      authorizedPath =
        this.webviewPathCapabilities.resolveWorkspacePath(cwd, filePath)
    } catch {
      vscode.window.showErrorMessage(
        "NexusCode: Refusing to open a file outside the active workspace.",
      )
      return
    }
    const uri = this.workspaceUriForAuthorizedPath(cwd, authorizedPath)
    try {
      const doc = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Active,
        preview: false,
        preserveFocus: false,
      })
    } catch {
      vscode.window.showErrorMessage(`NexusCode: Could not open ${filePath}`)
    }
  }

  private extractUserMessagePreview(message: SessionMessage): string {
    const raw =
      typeof message.content === "string"
        ? message.content
        : (message.content.find((part) => part.type === "text") as { text?: string } | undefined)?.text ?? ""
    return raw.replace(/\s+/g, " ").trim().slice(0, 80) || "User message"
  }

  /**
   * Whether this event should trigger a full state sync to the webview.
   * We do NOT trigger for text_delta / reasoning_* — the webview already applies these via
   * handleAgentEvent, and sending full state on every chunk causes heavy serialization + postMessage
   * and makes VS Code lag during agent runs.
   */
  private eventAffectsVisibleState(event: AgentEvent): boolean {
    switch (event.type) {
      case "text_delta":
      case "reasoning_start":
      case "reasoning_delta":
      case "reasoning_end":
        return false
      case "assistant_message_started":
      case "assistant_content_complete":
      case "tool_start":
      case "tool_end":
      case "question_request":
      case "todo_updated":
      case "subagent_start":
      case "subagent_tool_start":
      case "subagent_tool_end":
      case "subagent_done":
      case "task_created":
      case "task_progress":
      case "task_updated":
      case "task_tool_start":
      case "task_tool_end":
      case "task_completed":
      case "team_updated":
      case "team_message":
      case "background_task_updated":
      case "remote_session_updated":
      case "plugin_hook":
      case "done":
      case "error":
        return true
      default:
        return false
    }
  }

  private ensureShadowAssistantMessage(messageId: string): SessionMessage | null {
    if (!this.session) return null
    const existing = this.session.messages.find((m) => m.id === messageId && m.role === "assistant")
    if (existing) return existing
    const created: SessionMessage = {
      id: messageId,
      ts: Date.now(),
      role: "assistant",
      content: "",
    }
    this.session.messages.push(created)
    this.session.invalidateTokenEstimate()
    return created
  }

  private ensureShadowAssistantParts(messageId: string): MessagePart[] {
    const msg = this.ensureShadowAssistantMessage(messageId)
    if (!msg) return []
    if (typeof msg.content === "string") {
      const parts =
        msg.content.trim().length > 0
          ? ([{ type: "text", text: msg.content }] as MessagePart[])
          : ([] as MessagePart[])
      msg.content = parts
      this.session?.invalidateTokenEstimate()
      return parts
    }
    return msg.content as MessagePart[]
  }

  private applyAgentEventToSessionShadow(event: AgentEvent): void {
    if (!this.session) return

    switch (event.type) {
      case "assistant_message_started": {
        this.ensureShadowAssistantMessage(event.messageId)
        return
      }

      case "text_delta": {
        const parts = this.ensureShadowAssistantParts(event.messageId)
        const last = parts[parts.length - 1]
        if (last?.type === "text") {
          ;(last as MessagePart & { text: string }).text += event.delta
        } else {
          parts.push({ type: "text", text: event.delta })
        }
        return
      }

      case "reasoning_start": {
        const parts = this.ensureShadowAssistantParts(event.messageId)
        const reasoningId = event.reasoningId || "reasoning-0"
        if (findOpenReasoningReverseIndexShadow(parts, reasoningId) < 0) {
          parts.push({
            type: "reasoning",
            text: THOUGHT_PLACEHOLDER,
            reasoningId,
            providerMetadata: event.providerMetadata,
          } as MessagePart)
        }
        return
      }

      case "reasoning_delta": {
        const parts = this.ensureShadowAssistantParts(event.messageId)
        const reasoningId = event.reasoningId || "reasoning-0"
        const idx = findOpenReasoningReverseIndexShadow(parts, reasoningId)
        if (idx >= 0) {
          const actualIdx = parts.length - 1 - idx
          const current = parts[actualIdx] as MessagePart & { text: string; providerMetadata?: Record<string, unknown>; reasoningId?: string }
          const prevText = current.text === THOUGHT_PLACEHOLDER ? "" : current.text
          parts[actualIdx] = {
            ...current,
            text: `${prevText}${event.delta ?? ""}` || THOUGHT_PLACEHOLDER,
            reasoningId,
            providerMetadata: event.providerMetadata ?? current.providerMetadata,
          } as MessagePart
        } else {
          parts.push({
            type: "reasoning",
            text: event.delta || THOUGHT_PLACEHOLDER,
            reasoningId,
            providerMetadata: event.providerMetadata,
          } as MessagePart)
        }
        return
      }

      case "reasoning_end": {
        const parts = this.ensureShadowAssistantParts(event.messageId)
        const reasoningId = event.reasoningId
        const idx = [...parts].reverse().findIndex(
          (part) =>
            part.type === "reasoning" &&
            (part as MessagePart & { durationMs?: number }).durationMs == null &&
            (reasoningId == null || ((part as MessagePart & { reasoningId?: string }).reasoningId ?? "reasoning-0") === reasoningId)
        )
        if (idx >= 0) {
          const actualIdx = parts.length - 1 - idx
          const current = parts[actualIdx] as MessagePart & { durationMs?: number; providerMetadata?: Record<string, unknown>; reasoningId?: string }
          parts[actualIdx] = {
            ...current,
            reasoningId: current.reasoningId ?? reasoningId,
            providerMetadata: event.providerMetadata ?? current.providerMetadata,
            durationMs: current.durationMs ?? 0,
          } as MessagePart
        }
        return
      }

      case "tool_start": {
        const parts = this.ensureShadowAssistantParts(event.messageId)
        const existingIdx = parts.findIndex((part) => part.type === "tool" && (part as ToolPart).id === event.partId)
        const nextPart = {
          type: "tool",
          id: event.partId,
          tool: event.tool,
          status: "running",
          input: event.input,
          timeStart: Date.now(),
        } as ToolPart
        if (existingIdx >= 0) {
          parts[existingIdx] = { ...(parts[existingIdx] as ToolPart), ...nextPart }
        } else {
          parts.push(nextPart)
        }
        if (isDelegatedAgentParentTool(event.tool, event.input)) {
          this.streamLastSpawnAgentPartId = event.partId
        }
        return
      }

      case "tool_end": {
        const msg = this.ensureShadowAssistantMessage(event.messageId)
        if (!msg) return
        const parts = this.ensureShadowAssistantParts(event.messageId)
        const idx = parts.findIndex((part) => part.type === "tool" && (part as ToolPart).id === event.partId)
        if (idx >= 0) {
          parts[idx] = {
            ...(parts[idx] as ToolPart),
            status: event.success ? "completed" : "error",
            output: event.output,
            error: event.error,
            compacted: event.compacted,
            path: event.path,
            diffStats: event.diffStats,
            ...(Array.isArray(event.diffHunks) ? { diffHunks: event.diffHunks } : {}),
            ...(Array.isArray(event.appliedReplacements) && event.appliedReplacements.length > 0
              ? { appliedReplacements: event.appliedReplacements }
              : {}),
            ...(typeof event.metadata?.artifactId === "string"
              ? { outputArtifactId: event.metadata.artifactId }
              : {}),
            ...(typeof event.metadata?.task_id === "string"
              ? { backgroundTaskId: event.metadata.task_id }
              : typeof event.metadata?.bash_id === "string"
                ? { backgroundTaskId: event.metadata.bash_id }
                : {}),
            ...(typeof event.metadata?.changeSetId === "string"
              ? {
                  changeSetId: event.metadata.changeSetId,
                  ...(typeof event.metadata.proposalHash === "string"
                    ? { proposalHash: event.metadata.proposalHash }
                    : {}),
                  ...(typeof event.metadata.changeSetState === "string"
                    ? {
                        changeSetState:
                          event.metadata.changeSetState as ToolPart["changeSetState"],
                      }
                    : {}),
                  ...(Array.isArray(event.metadata.changeFiles)
                    ? {
                        changeFiles:
                          event.metadata.changeFiles as ToolPart["changeFiles"],
                      }
                    : {}),
                }
              : {}),
            timeEnd: Date.now(),
          } as ToolPart
        }
        if (isDelegatedAgentParentToolEndClear(event.tool, (event as { input?: Record<string, unknown> }).input)) {
          this.streamLastSpawnAgentPartId = null
        }
        if (typeof event.metadata?.changeSetId === "string") {
          void this.refreshSessionChangeSets(true).catch((error) => {
            console.warn(
              "[nexus] Failed to refresh streamed durable changes:",
              error,
            )
          })
        }
        return
      }

      case "done": {
        if (
          typeof event.durationMs === "number" &&
          Number.isFinite(event.durationMs) &&
          event.durationMs >= 0
        ) {
          const message = this.ensureShadowAssistantMessage(event.messageId)
          if (message) message.durationMs = Math.floor(event.durationMs)
        }
        return
      }

      case "todo_updated":
        this.session.updateTodo(event.todo ?? "")
        return

      case "subagent_start":
      case "subagent_tool_start":
      case "subagent_tool_end":
      case "subagent_done": {
        const explicitParentPartId =
          "parentPartId" in event && typeof event.parentPartId === "string" && event.parentPartId.trim().length > 0
            ? event.parentPartId
            : undefined
        const partId = explicitParentPartId ?? this.streamLastSpawnAgentPartId ?? null
        if (!partId) return
        const assistantMessages = [...this.session.messages].reverse()
        for (const msg of assistantMessages) {
          if (msg.role !== "assistant") continue
          const parts = Array.isArray(msg.content)
            ? (msg.content as MessagePart[])
            : typeof msg.content === "string" && msg.content.trim().length > 0
              ? ([{ type: "text", text: msg.content }] as MessagePart[])
              : ([] as MessagePart[])
          const partIndex =
            event.type === "subagent_start"
              ? parts.findIndex((part) => part.type === "tool" && (part as ToolPart).id === partId)
              : findToolPartIndexForSubagent(parts, event.subagentId, partId)
          if (partIndex < 0) continue
          const toolPart = parts[partIndex] as ToolPart & { subagents?: ShadowSubAgentState[] }
          let currentSubagents = Array.isArray(toolPart.subagents) ? toolPart.subagents : []
          if (
            event.type !== "subagent_start" &&
            !currentSubagents.some((item) => item.id === event.subagentId) &&
            typeof toolPart.input?.description === "string"
          ) {
            currentSubagents = reduceSubagentState(currentSubagents, {
              type: "subagent_start",
              subagentId: event.subagentId,
              mode: "ask",
              task: toolPart.input.description.trim(),
            })
          }
          let nextSubagents = currentSubagents
          if (event.type === "subagent_start") {
            nextSubagents = reduceSubagentState(currentSubagents, {
              type: "subagent_start",
              subagentId: event.subagentId,
              mode: event.mode,
              task: event.task,
            })
          } else if (event.type === "subagent_tool_start") {
            nextSubagents = reduceSubagentState(currentSubagents, {
              type: "subagent_tool_start",
              subagentId: event.subagentId,
              tool: event.tool,
              input: event.input,
            })
          } else if (event.type === "subagent_tool_end") {
            nextSubagents = reduceSubagentState(currentSubagents, {
              type: "subagent_tool_end",
              subagentId: event.subagentId,
              tool: event.tool,
              success: event.success,
            })
          } else {
            nextSubagents = reduceSubagentState(currentSubagents, {
              type: "subagent_done",
              subagentId: event.subagentId,
              success: event.success,
              error: event.error,
            })
          }
          parts[partIndex] = { ...toolPart, subagents: nextSubagents } as ToolPart
          msg.content = parts
          this.session.invalidateTokenEstimate()
          return
        }
        return
      }

      default:
        return
    }
  }

  private async ensureCheckpointForCurrentSession(
    sessionId: string,
    cwd: string,
    configForRun: NexusConfig
  ): Promise<CheckpointTracker | undefined> {
    if (!configForRun.checkpoint.enabled) return undefined
    if (this.checkpoint) return this.checkpoint
    const tracker = new CheckpointTracker(sessionId, cwd)
    const ok = await tracker.init(configForRun.checkpoint.timeoutMs).catch(() => false)
    if (!ok) return undefined
    this.checkpoint = tracker
    return tracker
  }

  private async commitCheckpointForUserMessage(
    sessionId: string,
    cwd: string,
    configForRun: NexusConfig,
    userMessage: SessionMessage
  ): Promise<void> {
    const tracker = await this.ensureCheckpointForCurrentSession(sessionId, cwd, configForRun)
    if (!tracker) return
    const description = `Before: ${this.extractUserMessagePreview(userMessage)}`
    await tracker.commitForMessage(userMessage.id, description)
    this.postStateToWebview()
  }

  private async rollbackToBeforeMessage(messageId: string): Promise<void> {
    if (!this.session || !this.config) return
    if (this.isRunning) {
      vscode.window.showWarningMessage(
        "NexusCode: Stop the current run before rolling back.",
      )
      return
    }
    if (this.getServerUrl()) {
      vscode.window.showInformationMessage(
        "NexusCode: Checkpoint rollback is not supported when using NexusCode Server.",
      )
      return
    }
    const msgs = this.session.messages
    const idx = msgs.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const target = msgs[idx]!
    if (target.role !== "user") return

    const cwd = this.getCwd()
    const tracker = await this.ensureCheckpointForCurrentSession(this.session.id, cwd, this.config)
    const entries = tracker?.getEntries() ?? []
    const checkpointEntry = [...entries]
      .reverse()
      .find((entry) => entry.messageId === target.id)
    const choice = await vscode.window.showWarningMessage(
      checkpointEntry
        ? "Rewind chat and revert pending Nexus-owned edits from this message onward? Manual, accepted, ignored, and nested-repository changes will be preserved."
        : "No exact message-bound workspace checkpoint exists. Rewind chat only?",
      { modal: true },
      "Continue",
      "Cancel"
    )
    if (choice !== "Continue") return

    if (checkpointEntry) {
      let workspace
      try {
        workspace = await this.revertNexusChangesAfterCheckpoint(
          checkpointEntry,
        )
        const persisted = await this.persistCheckpointChatRewind({
          rewind: () => this.session?.rewindBeforeMessageId(target.id),
          isPersisted: () =>
            !this.session?.messages.some((message) =>
              message.id === target.id,
            ),
          service: workspace.service,
          reverted: workspace.reverted,
        })
        this.sessionUnacceptedEdits = []
        this.changeSetReviewSessionId = null
        await this.refreshSessionChangeSets(true).catch(() => undefined)
        this.postStateToWebview()
        vscode.window.showInformationMessage(
          "NexusCode: Rewound chat and reverted " +
          `${workspace.reverted.length} pending Nexus-owned change set(s). ` +
          "Unrelated and accepted changes were preserved." +
          (persisted.saveReportedError
            ? " The save call reported an error, but the durable journal confirms the rewind."
            : ""),
          { modal: false },
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(
          `NexusCode: Rollback stopped safely — ${message}`,
        )
        return
      }
      return
    }

    try {
      const persisted = await this.persistCheckpointChatRewind({
        rewind: () => this.session?.rewindBeforeMessageId(target.id),
        isPersisted: () =>
          !this.session?.messages.some((message) =>
            message.id === target.id,
          ),
      })
      this.postStateToWebview()
      vscode.window.showWarningMessage(
        "NexusCode: Chat was rewound; workspace files were preserved because no exact message-bound checkpoint existed." +
        (persisted.saveReportedError
          ? " The save call reported an error, but the durable journal confirms the rewind."
          : ""),
        { modal: false }
      )
    } catch (error) {
      vscode.window.showErrorMessage(
        `NexusCode: Chat rollback stopped safely — ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly postMessageToWebview: (msg: ExtensionMessage) => void
  ) {
    this.observedServerUrl = this.getServerUrl()
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("nexuscode")) return
        if (this.config) {
          const base: NexusConfig = {
            ...this.config,
            model: {
              ...(this.defaultModelProfile ?? this.config.model),
            },
          }
          this.applyHostSelections(base)
          this.config = base
          this.postConfigToWebview()
          this.postStateToWebview()
        }
        if (e.affectsConfiguration("nexuscode.serverUrl")) {
          void this.handleServerDestinationChange()
        }
      })
    )
  }

  getCwd(): string {
    if (this.cwdOverride) return canonicalProjectRoot(this.cwdOverride)
    const folders = vscode.workspace.workspaceFolders
    if (folders && folders.length > 0) {
      return canonicalProjectRoot(folders[0]!.uri.fsPath)
    }
    return canonicalProjectRoot(process.cwd())
  }

  private loadHostConfig(cwd = this.getCwd()): Promise<NexusConfig> {
    const remoteRuntime = Boolean(this.getServerUrl())
    return loadVsCodeWorkspaceConfig(cwd, {
      loadEnv: !remoteRuntime,
      hostAuthority: !remoteRuntime,
    })
  }

  private setConfigurationLoadError(
    error: unknown,
    cwd = this.getCwd(),
    notify = true,
  ): void {
    const detail = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 4_096)
    const message =
      `Failed to load NexusCode configuration for ${cwd}: ${detail}. ` +
      "Agent execution is disabled until the configuration is fixed and reloaded."
    const changed = this.configurationError !== message
    this.abortController?.abort()
    this.approvalResolveRef.current?.resolve({ approved: false })
    void this.abortServerTask().catch(() => undefined)
    this.configurationError = message
    this.config = undefined
    this.defaultModelProfile = undefined
    this.activeProfileName = undefined
    this.mcpReconnectPromise = Promise.resolve()
    this.mcpConfigFingerprint = null
    void this.mcpClient?.disconnectAll().catch(() => undefined)
    this.mcpClient = undefined
    this.toolContributionDiagnostics = []
    this.forcedRemoteModeForNextRun = null
    this.skillDefinitionsLoadGeneration += 1
    this.webviewPathCapabilities.replaceKnownSkillPaths([])
    this.postMessageToWebview({
      type: "skillDefinitions",
      definitions: [],
    })
    if (changed) {
      this.postMessageToWebview({
        type: "agentEvent",
        event: { type: "error", error: message },
      })
      if (notify) {
        void vscode.window.showErrorMessage(`NexusCode: ${message}`)
      }
    }
    this.postStateToWebview()
  }

  private captureInitialConfigSnapshot(config: NexusConfig): void {
    if (this.initialFullConfigSnapshot) return
    this.initialFullConfigSnapshot = {
      skills: [...(config.skills ?? [])],
      mcp: { servers: [...(config.mcp?.servers ?? [])] },
      rules: { files: [...(config.rules?.files ?? [])] },
      indexing: { ...config.indexing },
    }
  }

  private async reloadHostConfiguration(
    notifySuccess = false,
  ): Promise<boolean> {
    if (this.isRunning) {
      void vscode.window.showWarningMessage(
        "NexusCode: Wait for the current run to stop before reloading configuration.",
      )
      return false
    }
    const cwd = this.getCwd()
    let loaded: NexusConfig
    try {
      loaded = await this.loadHostConfig(cwd)
    } catch (error) {
      this.setConfigurationLoadError(error, cwd)
      return false
    }
    this.configurationError = undefined
    this.config = loaded
    this.captureInitialConfigSnapshot(loaded)
    this.applyHostSelections(loaded)
    this.postConfigToWebview()
    void this.loadAndSendSkillDefinitions()
    this.postStateToWebview()
    if (this.getServerUrl()) {
      const restored =
        this.serverSessionId
          ? false
          : await this.restoreSelectedRemoteSession(cwd)
      await this.synchronizeRuntimeMode()
      if (restored) {
        void this.resumeRemoteTurnIfActive().catch(() => undefined)
      }
    } else {
      this.mcpReconnectPromise = this.reconnectMcpServers(loaded).catch(
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error)
          this.postMessageToWebview({
            type: "agentEvent",
            event: { type: "error", error: `[mcp] ${message}` },
          })
        },
      )
      void this.initializeIndexer(cwd).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : String(error)
        this.postMessageToWebview({
          type: "agentEvent",
          event: { type: "error", error: `[indexer] ${message}` },
        })
      })
    }
    this.onAutocompleteConfigReady?.()
    if (notifySuccess) {
      void vscode.window.showInformationMessage(
        "NexusCode: Workspace configuration reloaded.",
      )
    }
    return true
  }

  private async applyHostWorkingDirectoryChange(cwd: string, _reason?: string): Promise<void> {
    this.cwdOverride = canonicalProjectRoot(cwd)
    this.forcedRemoteModeForNextRun = null
    this.checkpoint = undefined
    this.initialFullConfigSnapshot = undefined
    this.mcpConfigFingerprint = null
    let loaded: NexusConfig
    try {
      loaded = await this.loadHostConfig(this.cwdOverride)
    } catch (error) {
      this.setConfigurationLoadError(error, this.cwdOverride)
      throw error
    }
    this.configurationError = undefined
    this.captureInitialConfigSnapshot(loaded)
    this.applyHostSelections(loaded)
    this.config = loaded
    this.sendIndexStatus()
    this.postStateToWebview()
    if (this.getServerUrl()) {
      await this.synchronizeRuntimeMode()
      return
    }
    void this.reconnectMcpServers().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
    })
    void this.initializeIndexer(this.cwdOverride).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[indexer] ${message}` } })
    })
  }

  private handleServerDestinationChange(): Promise<void> {
    if (this.serverDestinationChangePromise) {
      return this.serverDestinationChangePromise.then(() =>
        this.getServerUrl() === this.observedServerUrl
          ? undefined
          : this.handleServerDestinationChange(),
      )
    }
    const nextServerUrl = this.getServerUrl()
    if (nextServerUrl === this.observedServerUrl) {
      return this.synchronizeRuntimeMode()
    }
    const previousServerUrl = this.observedServerUrl
    this.observedServerUrl = nextServerUrl
    const task = (async () => {
      const cwd = this.getCwd()
      const wasRunning = this.isRunning
      if (wasRunning) {
        this.setConfigurationLoadError(
          new Error(
            `NexusCode server destination changed from ${
              previousServerUrl || "local mode"
            } to ${nextServerUrl || "local mode"} during an active run`,
          ),
          cwd,
        )
      } else {
        this.abortController?.abort()
        this.approvalResolveRef.current?.resolve({ approved: false })
      }
      this.remoteSessionCreationPromise = undefined
      this.remoteWorkspaceStateCache = undefined
      this.serverSessionId = undefined
      this.serverSessionOldestLoadedOffset = undefined
      this.activeRemoteTurn = undefined
      this.remoteResumePromise = undefined
      this.forcedRemoteModeForNextRun = null
      this.serverConnectionState = "idle"
      this.serverConnectionError = undefined
      this.pendingQuestionRequest = null
      this.checkpoint = undefined
      this.lastRunMode = null
      this.initialFullConfigSnapshot = undefined
      this.session = undefined
      if (!nextServerUrl) {
        await this.restoreSelectedLocalSession(cwd)
      }
      if (!this.session) {
        this.session = Session.create(cwd)
      }
      if (!nextServerUrl && !(await getSessionMeta(this.session.id, cwd))) {
        await this.session.save()
        await this.setSelectedLocalSessionId(this.session.id, cwd)
      }
      this.postStateToWebview()
      void this.postSlashCommandCatalog().catch(() => undefined)
      if (!wasRunning) {
        await this.reloadHostConfiguration(false)
      }
    })()
    const managed = task.finally(() => {
      if (this.serverDestinationChangePromise === managed) {
        this.serverDestinationChangePromise = undefined
      }
    })
    this.serverDestinationChangePromise = managed
    return managed
  }

  private async synchronizeRuntimeMode(): Promise<void> {
    if (!this.initialized) return
    const cwd = this.getCwd()
    if (this.getServerUrl()) {
      this.mcpReconnectPromise = Promise.resolve()
      await this.mcpClient?.disconnectAll().catch(() => {})
      this.mcpClient = undefined
      this.mcpConfigFingerprint = null
      await this.initializeIndexer(cwd)
      void this.postSlashCommandCatalog().catch(() => undefined)
      return
    }
    this.mcpReconnectPromise = this.reconnectMcpServers().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.postMessageToWebview({
        type: "agentEvent",
        event: { type: "error", error: `[mcp] ${message}` },
      })
    })
    void this.initializeIndexer(cwd).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.postMessageToWebview({
        type: "agentEvent",
        event: { type: "error", error: `[indexer] ${message}` },
      })
    })
  }

  getServerUrl(): string {
    return vscode.workspace
      .getConfiguration("nexuscode")
      .inspect<string>("serverUrl")
      ?.globalValue?.trim() ?? ""
  }

  private async createServerClient(cwd = this.getCwd()): Promise<NexusServerClient> {
    const baseUrl = this.getServerUrl()
    const token =
      process.env.NEXUS_SERVER_TOKEN?.trim() ||
      await this.context.secrets.get(getNexusServerTokenSecretKey(baseUrl)) ||
      (isLoopbackNexusServerDestination(baseUrl)
        ? await this.context.secrets.get(NEXUS_SERVER_TOKEN_SECRET_KEY)
        : undefined)
    if (!token) {
      throw new Error(
        "NexusCode server token is missing. Set NEXUS_SERVER_TOKEN for the extension host or store nexuscode_server_token in VS Code Secret Storage.",
      )
    }
    return new NexusServerClient({
      baseUrl,
      directory: cwd,
      token,
    })
  }

  private ensureRemoteSession(): Promise<{
    client: NexusServerClient
    sessionId: string
  }> {
    if (this.disposed) {
      return Promise.reject(new Error("NexusCode controller is disposed"))
    }
    if (this.configurationError) {
      return Promise.reject(new Error(this.configurationError))
    }
    const serverUrl = this.getServerUrl()
    if (!serverUrl) {
      return Promise.reject(
        new Error("NexusCode server URL is not configured"),
      )
    }
    if (this.remoteSessionCreationPromise) {
      return this.remoteSessionCreationPromise
    }
    const cwd = this.getCwd()
    const task = (async () => {
      const client = await this.createServerClient(cwd)
      if (this.serverSessionId) {
        return { client, sessionId: this.serverSessionId }
      }
      const created = await client.createSession()
      if (
        this.disposed ||
        this.getServerUrl() !== serverUrl ||
        this.getCwd() !== cwd
      ) {
        throw new Error(
          "NexusCode server destination or workspace changed while creating the MCP prompt session",
        )
      }
      await this.getRemoteWorkspaceState(cwd)
        .setSelectedSessionId(created.id)
      this.session = new Session(created.id, cwd, [], undefined, true)
      this.serverSessionId = created.id
      this.serverSessionOldestLoadedOffset = undefined
      this.localSessionWindowed = false
      this.pendingQuestionRequest = null
      this.checkpoint = undefined
      this.postStateToWebview()
      void this.sendSessionList().catch(() => undefined)
      return { client, sessionId: created.id }
    })()
    const managed = task.finally(() => {
      if (this.remoteSessionCreationPromise === managed) {
        this.remoteSessionCreationPromise = undefined
      }
    })
    this.remoteSessionCreationPromise = managed
    return managed
  }

  private getRemoteWorkspaceState(
    cwd = this.getCwd(),
  ): VsCodeRemoteWorkspaceState {
    const serverUrl = this.getServerUrl()
    if (!serverUrl) {
      throw new Error("NexusCode server URL is not configured")
    }
    const cached = this.remoteWorkspaceStateCache
    if (
      cached &&
      cached.serverUrl === serverUrl &&
      cached.cwd === cwd
    ) {
      return cached.state
    }
    const state = new VsCodeRemoteWorkspaceState(
      this.context.workspaceState,
      serverUrl,
      cwd,
      this.context.globalStorageUri?.fsPath,
    )
    this.remoteWorkspaceStateCache = { serverUrl, cwd, state }
    return state
  }

  private async refreshRemoteSession(
    client: NexusServerClient,
    sessionId: string,
    cwd = this.getCwd(),
  ): Promise<void> {
    const meta = await client.getSession(sessionId)
    const offset = Math.max(
      0,
      meta.messageCount - INITIAL_SERVER_MESSAGES,
    )
    const messages = await client.getMessages(sessionId, {
      limit: INITIAL_SERVER_MESSAGES,
      offset,
    })
    if (this.serverSessionId !== sessionId) return
    this.session = new Session(
      sessionId,
      cwd,
      messages,
      undefined,
      true,
      null,
      0,
      null,
      meta.mode ?? null,
    )
    this.mode = getSessionModeForResume(this.session, this.mode)
    this.serverSessionOldestLoadedOffset = offset
    this.localSessionWindowed = false
  }

  private forwardServerEvent(event: AgentEvent): void {
    this.updatePendingWriteApprovalPreview(event)
    const nextMode =
      remoteModeTransitionFromAgentEvent(event)
    if (nextMode) {
      this.mode = nextMode
      this.forcedRemoteModeForNextRun = nextMode
    }
    if (event.type === "question_request") {
      this.pendingQuestionRequest = event.request
    }
    if (event.type === "context_usage") {
      this.lastContextUsage = {
        usedTokens: event.usedTokens,
        limitTokens: event.limitTokens,
        percent: event.percent,
        source: event.source,
        providerTokens: event.providerTokens,
        pendingTokens: event.pendingTokens,
        modelId: event.modelId,
        sessionId: this.session?.id ?? "",
      }
    }
    this.applyAgentEventToSessionShadow(event)
    this.postMessageToWebview({ type: "agentEvent", event })
    if (event.type === "tool_approval_needed") {
      this.postMessageToWebview({
        type: "pendingApproval",
        partId: event.partId,
        action: event.action,
      })
    }
    if (this.eventAffectsVisibleState(event)) {
      this.postStateToWebview()
    }
    // Agent diagnostics (including fatal run failures) are not transport
    // failures. Network/attach errors are handled by the surrounding remote
    // turn boundary and alone may transition the connection to "error".
  }

  private async restoreSelectedRemoteSession(
    cwd = this.getCwd(),
  ): Promise<boolean> {
    const state = this.getRemoteWorkspaceState(cwd)
    const sessionId = await state.getSelectedSessionId()
    if (!sessionId) return false

    this.serverSessionId = sessionId
    this.session = new Session(sessionId, cwd, [], undefined, true)
    try {
      await this.refreshRemoteSession(
        await this.createServerClient(cwd),
        sessionId,
        cwd,
      )
      return true
    } catch (error) {
      // Keep the exact selected id on transient startup failures so a later
      // reconnect cannot accidentally create a second server session.
      this.reportServerError(error)
      return false
    }
  }

  private localSelectedSessionKey(cwd = this.getCwd()): string {
    return `nexuscode.local.v1.${hashWorkspaceIdentity(canonicalProjectRoot(cwd))}.selectedSession`
  }

  private isPersistableSessionId(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      !/[\u0000-\u001f\u007f]/u.test(value)
    )
  }

  private async setSelectedLocalSessionId(
    sessionId: string | undefined,
    cwd = this.getCwd(),
  ): Promise<void> {
    if (sessionId !== undefined && !this.isPersistableSessionId(sessionId)) {
      throw new TypeError("Local session id is invalid")
    }
    await this.context.workspaceState.update(
      this.localSelectedSessionKey(cwd),
      sessionId,
    )
  }

  private async restoreSelectedLocalSession(
    cwd = this.getCwd(),
  ): Promise<boolean> {
    const key = this.localSelectedSessionKey(cwd)
    let sessionId = this.context.workspaceState.get<unknown>(key)
    let meta =
      this.isPersistableSessionId(sessionId)
        ? await getSessionMeta(sessionId, cwd)
        : null
    if (!meta) {
      sessionId = (await listSessions(cwd))[0]?.id
      meta =
        this.isPersistableSessionId(sessionId)
          ? await getSessionMeta(sessionId, cwd)
          : null
    }
    if (!this.isPersistableSessionId(sessionId) || !meta) {
      await this.setSelectedLocalSessionId(undefined, cwd)
      return false
    }
    const offset = Math.max(
      0,
      meta.messageCount - INITIAL_SERVER_MESSAGES,
    )
    const loaded = await Session.resumeWindow(
      sessionId,
      cwd,
      INITIAL_SERVER_MESSAGES,
      offset,
    )
    if (!loaded) {
      await this.setSelectedLocalSessionId(undefined, cwd)
      return false
    }
    this.session = loaded
    this.mode = getSessionModeForResume(loaded, this.mode)
    loaded.setMode(this.mode)
    if (meta.mode !== this.mode) {
      await mutateSession(sessionId, cwd, (stored) => ({
        ...stored,
        mode: this.mode,
        ts: stored.ts,
      }))
    }
    this.serverSessionId = undefined
    this.serverSessionOldestLoadedOffset = offset
    this.localSessionWindowed = offset > 0
    await this.setSelectedLocalSessionId(sessionId, cwd)
    return true
  }

  private resumeRemoteTurnIfActive(): Promise<boolean> {
    if (this.remoteResumePromise) return this.remoteResumePromise
    const task = this.resumeRemoteTurnIfActiveImpl()
    const managed = task.finally(() => {
      if (this.remoteResumePromise === managed) {
        this.remoteResumePromise = undefined
      }
    })
    this.remoteResumePromise = managed
    return managed
  }

  private async resumeRemoteTurnIfActiveImpl(): Promise<boolean> {
    const serverUrl = this.getServerUrl()
    const sessionId = this.serverSessionId
    if (!serverUrl || !sessionId || this.isRunning) return false

    const cwd = this.getCwd()
    const abortController = new AbortController()
    let attachedTurn: VsCodeRemoteTurn | undefined
    this.abortController = abortController
    this.isRunning = true
    this.setServerConnectionState("connecting")
    try {
      const client = await this.createServerClient(cwd)
      const attached = await resumeVsCodeRemoteTurn({
        client,
        sessionId,
        signal: abortController.signal,
        cursorStore: this.getRemoteWorkspaceState(cwd),
        onActiveExecution: (execution) => {
          this.mode = execution.mode
          this.lastRunMode = execution.mode
          this.forcedRemoteModeForNextRun = null
          this.postStateToWebview()
        },
        onRemoteTurn: (turn) => {
          if (turn) {
            attachedTurn = turn
            this.activeRemoteTurn = turn
            this.setServerConnectionState("streaming")
          } else if (this.activeRemoteTurn === attachedTurn) {
            this.activeRemoteTurn = undefined
            attachedTurn = undefined
          }
        },
        deliver: (event) => {
          if (!abortController.signal.aborted) {
            this.forwardServerEvent(event)
          }
        },
      })
      if (attached && !abortController.signal.aborted) {
        await this.refreshRemoteSession(client, sessionId, cwd).catch(
          () => undefined,
        )
      }
      return attached
    } catch (error) {
      if (!abortController.signal.aborted) {
        this.reportServerError(error)
      }
      throw error
    } finally {
      if (this.activeRemoteTurn === attachedTurn) {
        this.activeRemoteTurn = undefined
      }
      if (this.abortController === abortController) {
        this.abortController = undefined
      }
      this.pendingWriteApprovalPreview = null
      this.isRunning = false
      if (this.serverConnectionState !== "error") {
        this.serverConnectionState = "idle"
        this.serverConnectionError = undefined
      }
      this.postStateToWebview()
    }
  }

  private async abortServerTask(): Promise<void> {
    if (!this.getServerUrl() || !this.activeRemoteTurn) return
    const interrupt = this.activeRemoteTurn.interrupt("user requested stop")
    this.abortController?.abort()
    try {
      await interrupt
    } catch (error) {
      this.reportServerError(error)
    }
  }

  private readAutocompleteExtensionSettingsForWebview(): AutocompleteExtensionUiState {
    const c = vscode.workspace.getConfiguration()
    const temp = c.get<number>("nexuscode.autocomplete.temperature")
    const cw = c.get<number>("nexuscode.autocomplete.contextWindow")
    return {
      enableAutoTrigger: c.get<boolean>("nexuscode.autocomplete.enableAutoTrigger") ?? true,
      useSeparateModel: c.get<boolean>("nexuscode.autocomplete.useSeparateModel") ?? false,
      modelProvider: c.get<string>("nexuscode.autocomplete.provider") ?? "",
      modelId: c.get<string>("nexuscode.autocomplete.model") ?? "",
      modelApiKey: "",
      hasModelApiKey: this.autocompleteApiKeyConfigured,
      modelBaseUrl: c.get<string>("nexuscode.autocomplete.baseUrl") ?? "",
      modelTemperature:
        typeof temp === "number" && !Number.isNaN(temp) ? String(temp) : "0.2",
      modelReasoningEffort: c.get<string>("nexuscode.autocomplete.reasoningEffort") ?? "",
      modelContextWindow: typeof cw === "number" && cw > 0 ? String(cw) : "",
    }
  }

  getSession(): Session | undefined {
    return this.session
  }

  getConfig(): NexusConfig | undefined {
    return this.config
  }

  async resolveAutocompleteModel(): Promise<ProviderConfig | undefined> {
    if (this.getServerUrl() || this.configurationError) return undefined
    let config: NexusConfig
    try {
      config = await this.loadHostConfig()
    } catch (error) {
      this.setConfigurationLoadError(error, this.getCwd(), false)
      return undefined
    }
    this.applyVscodeOverrides(config)
    const requestedProfileName = this.activeProfileName?.trim()
    let profileName: string | undefined
    if (requestedProfileName) {
      const profile = config.profiles[requestedProfileName]
      if (profile) {
        config.model = selectProviderProfile(config.model, profile)
        profileName = requestedProfileName
      }
    }
    const runtime = await finalizeConfigCredentials(
      config as unknown as Record<string, unknown>,
      this.secretsStore,
      {
        profileName,
        environment: getConfigEnvironment(config),
      },
    ) as unknown as NexusConfig
    return runtime.model
  }

  setAutocompleteConfigReady(fn: () => void): void {
    this.onAutocompleteConfigReady = fn
  }

  getIsRunning(): boolean {
    return this.isRunning
  }

  /** Build full state for webview (Cline-style getStateToPostToWebview). */
  getStateToPostToWebview(): WebviewState {
    const status = this.indexer?.status() ?? { state: "idle" as const }
    if (!this.session || !this.config) {
      return {
        messages: [],
        mode: this.mode,
        isRunning: false,
        model: "—",
        provider: "—",
        sessionId: "",
        projectDir: this.getCwd(),
        todo: "",
        indexReady: status.state === "ready",
        indexStatus: status,
        contextUsedTokens: 0,
        contextLimitTokens: 0,
        contextPercent: 0,
        contextSource: "estimated",
        contextProviderTokens: 0,
        contextPendingTokens: 0,
        serverUrl: this.getServerUrl(),
        connectionState: this.serverConnectionState,
        serverConnectionError: this.serverConnectionError,
        configurationError: this.configurationError ?? null,
        toolContributionDiagnostics:
          this.toolContributionDiagnostics,
        modelsCatalog: this.modelsCatalogCache ?? null,
        sessionUnacceptedEdits: this.getSessionUnacceptedEditsForState(),
        pendingQuestionRequest: this.pendingQuestionRequest,
        activePresetName: this.chatPresetName,
        autocompleteExtension: this.readAutocompleteExtensionSettingsForWebview(),
      }
    }
    // Prefer live stream snapshot; else persisted session snapshot; else same formula as agent (session + tools; no system until next run).
    const sessionId = this.session.id
    if (
      this.changeSetReviewSessionId !== sessionId &&
      !this.changeSetReviewRefresh
    ) {
      void this.refreshSessionChangeSets().catch((error) => {
        console.warn("[nexus] Failed to load durable change review:", error)
      })
    }
    const useLastContext =
      this.lastContextUsage != null && this.lastContextUsage.sessionId === sessionId
    if (!useLastContext && this.lastContextUsage != null) this.lastContextUsage = null

    let contextUsedTokens: number
    let contextLimitTokens: number
    let contextPercent: number
    let contextSource: "provider" | "hybrid" | "estimated" | undefined
    let contextProviderTokens: number | undefined
    let contextPendingTokens: number | undefined
    if (useLastContext) {
      contextUsedTokens = this.lastContextUsage!.usedTokens
      contextLimitTokens = this.lastContextUsage!.limitTokens
      contextPercent = this.lastContextUsage!.percent
      contextSource = this.lastContextUsage!.source
      contextProviderTokens = this.lastContextUsage!.providerTokens
      contextPendingTokens = this.lastContextUsage!.pendingTokens
    } else {
      const snap = reconcilePersistedContextUsage(
        this.session.getLastContextUsageSnapshot(),
        this.config.model.id,
        this.config.model.contextWindow,
      )
      if (snap) {
        contextUsedTokens = snap.usedTokens
        contextLimitTokens = snap.limitTokens
        contextPercent = snap.percent
        contextSource = snap.source
        contextProviderTokens = snap.providerTokens
        contextPendingTokens = snap.pendingTokens
      } else {
        const toolRegistry = new ToolRegistry()
        const { builtin, dynamic } = toolRegistry.getForMode(this.mode)
        const visibleTools = [...builtin, ...dynamic]
        const deferredTools = visibleTools.filter(
          (tool) => tool.shouldDefer && !tool.alwaysLoad,
        )
        const initialTools = shouldUseDeferredToolLoading(
          deferredTools,
          this.config.model.id,
          this.config,
        )
          ? visibleTools.filter((tool) => !deferredTools.includes(tool))
          : visibleTools
        const toolsTok = estimateToolsDefinitionsTokens(initialTools)
        const m = computeContextUsageMetrics({
          sessionMessages: this.session.messages,
          toolsDefinitionTokens: toolsTok,
          modelId: this.config.model.id,
          configuredContextWindow: this.config.model.contextWindow,
          providerAnchor: this.session.getProviderContextAnchor(),
        })
        contextUsedTokens = m.usedTokens
        contextLimitTokens = m.limitTokens
        contextPercent = m.percent
        contextSource = m.source
        contextProviderTokens = m.providerTokens
        contextPendingTokens = m.pendingTokens
      }
    }
    const messages = stripModeReminderFromMessages(this.session.messages)
    return {
      messages,
      mode: this.mode,
      isRunning: this.isRunning,
      model: this.config.model.id,
      provider: this.config.model.provider,
      sessionId: this.session.id,
      projectDir: this.getCwd(),
      todo: this.session.getTodo(),
      indexReady: status.state === "ready",
      indexStatus: status,
      contextUsedTokens,
      contextLimitTokens,
      contextPercent,
      contextSource,
      contextProviderTokens,
      contextPendingTokens,
      serverUrl: this.getServerUrl(),
      connectionState: this.serverConnectionState,
      serverConnectionError: this.serverConnectionError,
      configurationError: this.configurationError ?? null,
      toolContributionDiagnostics:
        this.toolContributionDiagnostics,
      modelsCatalog: this.modelsCatalogCache ?? null,
      checkpointEnabled:
        !this.getServerUrl() &&
        (this.config?.checkpoint?.enabled === true || this.checkpoint != null),
      checkpointEntries: this.getServerUrl()
        ? []
        : this.checkpoint?.getEntries() ?? [],
      planCompleted:
        this.session && this.mode === "plan" && !this.isRunning && hadPlanExit(this.session),
      planFollowupText: null,
      hasOlderMessages: this.serverSessionOldestLoadedOffset != null && this.serverSessionOldestLoadedOffset > 0,
      loadingOlderMessages: this.loadingOlderMessages,
      sessionUnacceptedEdits: this.getSessionUnacceptedEditsForState(),
      pendingQuestionRequest: this.pendingQuestionRequest,
      activePresetName: this.chatPresetName,
      autocompleteExtension: this.readAutocompleteExtensionSettingsForWebview(),
    }
  }

  /** Session unaccepted edits for webview: path + diffStats only. */
  private getSessionUnacceptedEditsForState(): Array<{
    path: string
    diffStats: { added: number; removed: number }
    isNewFile?: boolean
    changeSetId: string
    changeSetFileCount?: number
  }> {
    return this.sessionUnacceptedEdits.map((e) => ({
      path: e.path,
      diffStats: e.diffStats,
      isNewFile: e.isNewFile,
      changeSetId: e.changeSetId,
      ...(e.changeSetFileCount && e.changeSetFileCount > 1
        ? { changeSetFileCount: e.changeSetFileCount }
        : {}),
    }))
  }

  private localChangeSetReview(cwd: string): {
    service: ChangeSetService
    store: NonNullable<
      ReturnType<WorkspaceRunServicesRegistry["get"]>["changeSets"]
    >["store"]
  } | undefined {
    if (this.getServerUrl()) return undefined
    const services = this.workspaceRunServices.get(cwd)
    const binding = services.changeSets
    if (!binding) return undefined
    const expectedWorkspaceId = hashWorkspaceIdentity(
      canonicalProjectRoot(cwd),
    )
    if (binding.workspaceId !== expectedWorkspaceId) {
      throw new Error(
        "Workspace change-set storage does not match the active workspace",
      )
    }
    const host = new VsCodeHost(cwd, () => {})
    return {
      store: binding.store,
      service: new ChangeSetService({
        workspaceId: binding.workspaceId,
        store: binding.store,
        files: {
          readFileState: (filePath) => host.readFileState(filePath),
          applyFileMutation: (mutation) =>
            host.applyFileMutation(mutation),
        },
      }),
    }
  }

  private async revertNexusChangesAfterCheckpoint(
    entry: CheckpointEntry,
  ): Promise<{
    service: ChangeSetService
    reverted: readonly ChangeSetRecord[]
  }> {
    if (!this.session) throw new Error("No active local session")
    if (!entry.messageId) {
      throw new Error(
        "This legacy checkpoint is preview-only because it has no exact message binding.",
      )
    }
    const review = this.localChangeSetReview(this.getCwd())
    if (!review) {
      throw new Error("Durable change ownership is unavailable")
    }
    const result = await revertEffectiveChangeSetsAfter({
      service: review.service,
      sessionId: this.session.id,
      createdAtOrAfter: entry.ts,
    })
    if (result.status === "conflicted") {
      throw new Error(
        "File ownership conflict: " +
        result.conflicts
          .map((conflict) =>
            `${conflict.paths.join(", ") || conflict.changeSetId}: ${conflict.message}`,
          )
          .join("; "),
      )
    }
    return {
      service: review.service,
      reverted: result.reverted,
    }
  }

  private async persistCheckpointChatRewind(input: {
    rewind: () => void
    isPersisted: () => boolean
    service?: ChangeSetService
    reverted?: readonly ChangeSetRecord[]
  }): Promise<{ saveReportedError: boolean }> {
    const session = this.session
    if (!session) throw new Error("No active local session")
    const recovery = session.captureRecoverySnapshot()
    input.rewind()
    try {
      await session.save()
      return { saveReportedError: false }
    } catch (saveError) {
      let persisted = false
      try {
        persisted = (await session.load()) && input.isPersisted()
      } catch {
        persisted = false
      }
      if (persisted) return { saveReportedError: true }

      session.restoreRecoverySnapshot(recovery)
      const compensation =
        input.service && (input.reverted?.length ?? 0) > 0
          ? await reapplyRevertedChangeSets({
              service: input.service,
              reverted: input.reverted!,
            })
          : { stillReverted: [], conflicts: [] }
      const compensationDetail =
        compensation.conflicts.length === 0
          ? "File changes were returned to their pre-restore state."
          : "File compensation conflicts: " +
            compensation.conflicts
              .map((conflict) =>
                `${conflict.paths.join(", ") || conflict.changeSetId}: ${conflict.message}`,
              )
              .join("; ")
      throw new Error(
        "Chat rewind could not be persisted. " +
        `${compensationDetail} Save error: ${
          saveError instanceof Error ? saveError.message : String(saveError)
        }`,
      )
    }
  }

  private async resolveDurableChange(
    changeSetId: string,
    action: "accept" | "revert",
  ): Promise<void> {
    if (this.isRunning) {
      throw new Error(
        "Wait for the active turn to finish before accepting or reverting changes.",
      )
    }
    if (this.getServerUrl()) {
      const sessionId = this.serverSessionId ?? this.session?.id
      if (!sessionId) throw new Error("No active server session")
      await (
        await this.createServerClient(this.getCwd())
      ).resolveSessionChange(sessionId, changeSetId, action)
      return
    }
    const review = this.localChangeSetReview(this.getCwd())
    if (!review) throw new Error("Durable change service is unavailable")
    const sessionId = this.session?.id
    if (!sessionId) throw new Error("No active local session")
    const recovered = await review.service.recoverInterrupted({
      sessionId,
    })
    const ambiguous = recovered.find(
      (record) => record.state === "conflicted",
    )
    if (ambiguous) {
      throw new Error(
        `Interrupted change ${ambiguous.id} has ambiguous file state and requires manual review.`,
      )
    }
    const resolved =
      action === "accept"
        ? await review.service.accept(changeSetId)
        : await review.service.revert(changeSetId)
    const expectedState = action === "accept" ? "accepted" : "reverted"
    if (resolved.state !== expectedState) {
      throw new Error(
        `Durable change ${changeSetId} recovered to ` +
        `${resolved.state} instead of ${expectedState}.`,
      )
    }
  }

  private async refreshSessionChangeSets(force = false): Promise<void> {
    const session = this.session
    if (!session) return
    if (
      !force &&
      this.changeSetReviewSessionId === session.id
    ) {
      return
    }
    if (this.changeSetReviewRefresh) {
      await this.changeSetReviewRefresh
      if (!force) return
    }
    const sessionId = session.id
    const cwd = this.getCwd()
    const refresh = (async () => {
      if (this.getServerUrl()) {
        const snapshot = await (
          await this.createServerClient(cwd)
        ).getSessionChanges(sessionId)
        if (this.session?.id !== sessionId || this.getCwd() !== cwd) return
        const fileCountByChangeSet = new Map<string, number>()
        for (const change of snapshot.changes) {
          fileCountByChangeSet.set(
            change.changeSetId,
            (fileCountByChangeSet.get(change.changeSetId) ?? 0) + 1,
          )
        }
        this.sessionUnacceptedEdits = snapshot.changes.map((change) => ({
          path: change.path,
          originalContent: change.originalContent ?? "",
          newContent: change.newContent ?? "",
          diffStats: change.diffStats,
          isNewFile: change.isNewFile,
          changeSetId: change.changeSetId,
          changeSetFileCount:
            fileCountByChangeSet.get(change.changeSetId) ?? 1,
          proposalHash: change.proposalHash,
          ...(change.contentOmitted ? { contentOmitted: true } : {}),
        }))
        this.changeSetReviewSessionId = sessionId
        this.postStateToWebview()
        return
      }
      const review = this.localChangeSetReview(cwd)
      if (!review) return
      const recovered = this.isRunning
        ? []
        : await review.service.recoverInterrupted({ sessionId })
      const ambiguous = recovered.find(
        (record) => record.state === "conflicted",
      )
      if (ambiguous) {
        throw new Error(
          `Interrupted change ${ambiguous.id} has ambiguous file state and requires manual review.`,
        )
      }
      const records = await review.service.listEffectiveApplied({
        sessionId,
      })
      const durable: SessionUnacceptedEdit[] = []
      for (const record of records) {
        for (const file of record.files) {
          if (
            file.path === ".nexus/plans" ||
            file.path.startsWith(".nexus/plans/")
          ) {
            continue
          }
          const originalContent = file.before.exists
            ? (await review.store.getBlob(file.before.blob)).toString("utf8")
            : ""
          const newContent = file.after.exists
            ? (await review.store.getBlob(file.after.blob)).toString("utf8")
            : ""
          durable.push({
            path: file.path,
            originalContent,
            newContent,
            diffStats:
              file.hunks.length > 0
                ? exactChangeHunkDiffStats(file.hunks)
                : exactLineDiffStats(originalContent, newContent),
            isNewFile: !file.before.exists,
            changeSetId: record.id,
            changeSetFileCount: record.files.length,
            proposalHash: record.proposalHash,
          })
        }
      }
      if (this.session?.id !== sessionId || this.getCwd() !== cwd) return
      this.sessionUnacceptedEdits = durable
      this.changeSetReviewSessionId = sessionId
      this.postStateToWebview()
    })()
    this.changeSetReviewRefresh = refresh
    try {
      await refresh
    } finally {
      if (this.changeSetReviewRefresh === refresh) {
        this.changeSetReviewRefresh = null
      }
    }
  }

  /** Push current state to webview (Cline-style postStateToWebview). */
  postStateToWebview(force = false): void {
    if (!force) {
      if (this.statePostTimer != null) return
      this.statePostTimer = setTimeout(() => {
        this.statePostTimer = null
        this.postStateToWebview(true)
      }, 40)
      return
    }
    if (this.statePostTimer != null) {
      clearTimeout(this.statePostTimer)
      this.statePostTimer = null
    }
    const state = this.getStateToPostToWebview()
    this.postMessageToWebview({ type: "stateUpdate", state: { ...state, stateUpdateSeq: ++this.stateUpdateSeq } })
    if (state.planCompleted && this.session) {
      void getPlanContentForFollowup(this.session, this.getCwd()).then((planFollowupText) => {
        const latest = this.getStateToPostToWebview()
        if (!latest.planCompleted || this.mode !== "plan" || this.isRunning) return
        this.postMessageToWebview({
          type: "stateUpdate",
          state: { ...latest, planFollowupText, stateUpdateSeq: ++this.stateUpdateSeq },
        })
      })
    }
  }

  private setServerConnectionState(state: ServerConnectionState, error?: string): void {
    this.serverConnectionState = state
    this.serverConnectionError = error
    this.postStateToWebview()
  }

  private reportServerError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.setServerConnectionState("error", message)
  }

  private async persistSessionMode(mode: Mode): Promise<void> {
    this.mode = mode
    const session = this.session
    if (!session) return
    session.setMode(mode)

    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()
    if (serverUrl && this.serverSessionId) {
      try {
        await (await this.createServerClient(cwd))
          .setSessionMode(this.serverSessionId, mode)
      } catch (error) {
        this.reportServerError(error)
      }
      return
    }

    const updated = await mutateSession(session.id, cwd, (stored) => ({
      ...stored,
      mode,
      ts: Date.now(),
    }))
    if (!updated) {
      await session.save()
    }
  }

  /** Load skills from config paths, skillsUrls registries, Nexus skill dirs (.nexus/skills), Claude ~/.claude/skills, walk-up, send to webview Skills list. */
  private loadAndSendSkillDefinitions(): void {
    const generation = ++this.skillDefinitionsLoadGeneration
    if (this.getServerUrl()) {
      this.webviewPathCapabilities.replaceKnownSkillPaths([])
      this.postMessageToWebview({ type: "skillDefinitions", definitions: [] })
      return
    }
    const cwd = this.getCwd()
    const paths = this.config?.skills ?? []
    loadSkills(
      paths,
      cwd,
      this.config?.skillsUrls,
      this.config ? getClaudeCompatibilityOptions(this.config) : undefined,
      this.config,
    )
      .then((skills) => {
        if (generation !== this.skillDefinitionsLoadGeneration) return
        this.webviewPathCapabilities.replaceKnownSkillPaths(
          skills.map((skill) => skill.path),
        )
        this.postMessageToWebview({
          type: "skillDefinitions",
          definitions: skills.map((s) => ({ name: s.name, path: s.path, summary: s.summary })),
        })
      })
      .catch(() => {
        if (generation !== this.skillDefinitionsLoadGeneration) return
        this.webviewPathCapabilities.replaceKnownSkillPaths([])
        this.postMessageToWebview({ type: "skillDefinitions", definitions: [] })
      })
  }

  private async refreshAfterMarketplaceChange(): Promise<void> {
    const cwd = this.getCwd()
    try {
      const loaded = await this.loadHostConfig(cwd)
      this.applyHostSelections(loaded)
      this.config = loaded
      this.configurationError = undefined
    } catch (error) {
      this.setConfigurationLoadError(error, cwd)
      return
    }
    if (this.config) {
      this.postConfigToWebview()
      void this.loadAndSendSkillDefinitions()
      if (!this.getServerUrl()) {
        void this.reconnectMcpServers().catch(() => {})
      }
    }
    this.postStateToWebview()
  }

  /** Clear current task/session and reset run state. */
  async clearTask(): Promise<void> {
    const remoteSessionId = this.serverSessionId
    await this.abortServerTask()
    this.abortController?.abort()
    this.approvalResolveRef.current?.resolve({ approved: false })
    if (this.getServerUrl()) {
      const remoteState = this.getRemoteWorkspaceState()
      if (remoteSessionId) await remoteState.clear(remoteSessionId)
      await remoteState.setSelectedSessionId(undefined)
    }
    this.session = undefined
    this.sessionUnacceptedEdits = []
    this.changeSetReviewSessionId = null
    this.serverSessionOldestLoadedOffset = undefined
    this.checkpoint = undefined
    this.serverSessionId = undefined
    this.forcedRemoteModeForNextRun = null
    this.postStateToWebview()
    void this.postSlashCommandCatalog().catch(() => undefined)
  }

  /** Cancel running agent (abort + keep session, then post state). */
  async cancelTask(): Promise<void> {
    await this.abortServerTask()
    this.abortController?.abort()
    this.approvalResolveRef.current?.resolve({ approved: false })
    this.postStateToWebview()
  }

  async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise
      this.postStateToWebview()
      this.sendIndexStatus()
      return
    }
    this.initPromise = (async () => {
      this.initialized = true
      const cwd = this.getCwd()
      const remoteRuntime = Boolean(this.getServerUrl())
      let restoredRemoteSession = false
      let restoredLocalSession = false
      if (!remoteRuntime) {
        await this.migrateLegacyPlaintextSecrets(cwd).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          vscode.window.showErrorMessage(
            `NexusCode: Secure credential migration was not applied — ${message}`,
          )
        })
      }
      try {
        this.config = await this.loadHostConfig(cwd)
      } catch (error) {
        this.setConfigurationLoadError(error, cwd)
        this.session ??= Session.create(cwd)
        this.postStateToWebview()
        this.sendIndexStatus()
        return
      }
      this.configurationError = undefined
      this.captureInitialConfigSnapshot(this.config)
      this.applyHostSelections(this.config)
      this.postConfigToWebview()
      void this.loadAndSendSkillDefinitions()
      if (remoteRuntime) {
        restoredRemoteSession =
          await this.restoreSelectedRemoteSession(cwd)
      } else {
        restoredLocalSession =
          await this.restoreSelectedLocalSession(cwd)
      }
      if (!this.session) {
        this.session = Session.create(cwd)
      }
      if (!remoteRuntime && !restoredLocalSession) {
        await this.session.save()
        await this.setSelectedLocalSessionId(this.session.id, cwd)
      }
      this.onAutocompleteConfigReady?.()
      this.postStateToWebview()
      this.sendIndexStatus()
      // Resolve init here so first message is not blocked. MCP/indexer/catalog/skills run in background.
      if (remoteRuntime) {
        this.mcpReconnectPromise = Promise.resolve()
        if (restoredRemoteSession) {
          void this.resumeRemoteTurnIfActive().catch(() => undefined)
        }
      } else {
        this.mcpReconnectPromise = this.reconnectMcpServers().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
        })
        void this.initializeIndexer(cwd).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[indexer] ${message}` } })
        })
      }
      if (!this.modelsCatalogCache) {
        void getModelsCatalog()
          .then((cat) => {
            this.modelsCatalogCache = cat
            this.postStateToWebview()
          })
          .catch(() => {
            this.modelsCatalogCache = { providers: [], recommended: [] }
            this.postStateToWebview()
          })
      }
    })()
    await this.initPromise
    this.initPromise = Promise.resolve()
  }

  async handleWebviewMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "newMessage": {
        let admissionReported = false
        const reportAdmission = (accepted: boolean): void => {
          if (admissionReported) return
          admissionReported = true
          this.postMessageToWebview({
            type: "messageSubmissionResult",
            clientMessageId: msg.clientMessageId,
            accepted,
          })
        }
        try {
          await this.ensureInitialized()
          await this.runAgent(
            msg.content,
            msg.mode,
            msg.images,
            msg.presetName,
            reportAdmission,
            msg.clientMessageId,
          )
        } finally {
          reportAdmission(false)
        }
        break
      }
      case "setChatPreset": {
        const name = (msg.presetName ?? "").trim() || "Default"
        this.chatPresetName = name
        this.postStateToWebview()
        break
      }
      case "abort":
        await this.cancelTask()
        break
      case "compact":
        await this.compactHistory()
        break
      case "clearChat":
        await this.createNewSession()
        break
      case "setMode":
        if (this.isRunning) {
          // The run captured its mode at admission. Ignore stale/forged UI
          // updates until it finishes so the displayed mode cannot diverge
          // from the prompt and backend tool policy currently executing.
          this.postStateToWebview()
          break
        }
        await this.persistSessionMode(msg.mode)
        this.forcedRemoteModeForNextRun = null
        this.postStateToWebview()
        break
      case "setProfile":
        if (this.config) {
          if (!msg.profile) {
            this.activeProfileName = undefined
            if (this.defaultModelProfile) {
              this.config.model = { ...this.defaultModelProfile }
            }
            this.postConfigToWebview()
        void this.loadAndSendSkillDefinitions()
            this.postStateToWebview()
            break
          }
          const profile = this.config.profiles[msg.profile]
          if (!profile) break
          this.activeProfileName = msg.profile
          this.config.model = selectProviderProfile(
            this.defaultModelProfile ?? this.config.model,
            profile,
          )
          this.postConfigToWebview()
        void this.loadAndSendSkillDefinitions()
          this.postStateToWebview()
        }
        break
      case "getState":
        this.postStateToWebview()
        this.sendIndexStatus()
        void this.postSlashCommandCatalog().catch(() => undefined)
        if (this.config) {
          this.postConfigToWebview()
          void this.loadAndSendSkillDefinitions()
        }
        void this.ensureInitialized().then(() => {
          this.postStateToWebview()
          this.sendIndexStatus()
        })
        await this.sendSessionList()
        break
      case "getModelsCatalog": {
        if (this.modelsCatalogCache) {
          this.postMessageToWebview({ type: "modelsCatalog", catalog: this.modelsCatalogCache })
          break
        }
        void getModelsCatalog()
          .then((catalog) => {
            this.modelsCatalogCache = catalog
            this.postMessageToWebview({ type: "modelsCatalog", catalog })
          })
          .catch(() => {
            this.modelsCatalogCache = { providers: [], recommended: [] }
            this.postMessageToWebview({ type: "modelsCatalog", catalog: this.modelsCatalogCache })
          })
        break
      }
      case "getSlashCommandCatalog": {
        await this.ensureInitialized()
        const remoteRuntime = Boolean(this.getServerUrl())
        if (!remoteRuntime) {
          await Promise.race([
            this.mcpReconnectPromise?.catch(() => undefined) ??
              Promise.resolve(),
            new Promise<void>((resolve) => setTimeout(resolve, 2_500)),
          ])
        }
        await this.postSlashCommandCatalog({
          ensureRemoteSession: remoteRuntime,
          reportRemoteError: true,
        })
        break
      }
      case "reloadConfiguration":
        await this.ensureInitialized()
        await this.reloadHostConfiguration(true)
        break
      case "webviewDidLaunch":
        this.postStateToWebview()
        this.sendIndexStatus()
        void this.postSlashCommandCatalog().catch(() => undefined)
        if (this.config) {
          this.postConfigToWebview()
          void this.loadAndSendSkillDefinitions()
        }
        void this.ensureInitialized().then(() => {
          this.postStateToWebview()
          this.sendIndexStatus()
        })
        await this.sendSessionList()
        break
      case "openSettings":
        try {
          await vscode.commands.executeCommand("workbench.action.openSettings", "nexuscode")
        } catch {
          try {
            await vscode.commands.executeCommand("workbench.action.openSettings")
          } catch {}
        }
        break
      case "saveConfig":
        await this.handleSaveConfig(msg.config)
        break
      case "removeCredential":
        await this.handleRemoveCredential(msg.target, msg.profileName)
        break
      case "switchSession":
        await this.switchSession(msg.sessionId)
        break
      case "createNewSession":
        await this.createNewSession()
        break
      case "loadOlderMessages":
        await this.loadOlderMessages()
        break
      case "rollbackToBeforeMessage":
        await this.rollbackToBeforeMessage(msg.messageId)
        break
      case "deleteSession":
        await this.deleteSession(msg.sessionId)
        break
      case "forkSession":
        if (this.session && msg.messageId) {
          if (this.isRunning) {
            vscode.window.showWarningMessage(
              "NexusCode: Stop the current run before forking the session.",
            )
            break
          }
          if (this.getServerUrl()) {
            vscode.window.showWarningMessage(
              "NexusCode: Server-side session fork is not supported yet; the current remote session was left unchanged.",
            )
            break
          }
          this.session = this.session.fork(msg.messageId) as Session
          this.forcedRemoteModeForNextRun = null
          this.postStateToWebview()
        }
        break
      case "reindex":
        await this.reindex()
        break
      case "clearIndex":
        await this.clearIndex()
        break
      case "fullRebuildIndex":
        await this.fullRebuildIndex()
        break
      case "pauseIndexing":
        this.indexer?.pauseIndexing?.()
        break
      case "resumeIndexing":
        this.indexer?.resumeIndexing?.()
        break
      case "startOrConnectVectorDb": {
        let request: ReturnType<typeof resolveVectorDbRequest>
        try {
          request = resolveVectorDbRequest(
            msg.url,
            msg.autoStart === true,
            this.getServerUrl() ? "remote" : "local",
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          vscode.window.showErrorMessage(`NexusCode: ${message}`)
          break
        }
        if (request.requiresConfirmation) {
          const choice = await vscode.window.showWarningMessage(
            `Allow NexusCode to start or reuse a local Qdrant process at ${request.url}?`,
            { modal: true },
            "Start local Qdrant",
            "Cancel",
          )
          if (choice !== "Start local Qdrant") break
        }
        void (async () => {
          try {
            const result = await ensureQdrantRunning({
              url: request.url,
              autoStart: request.autoStart,
              onProgress: (message: string) => {
                this.postMessageToWebview({ type: "agentEvent", event: { type: "vector_db_progress", message } })
              },
              maxWaitMs: 20_000,
            })
            if (result.available) {
              this.postMessageToWebview({ type: "agentEvent", event: { type: "vector_db_ready" } })
            } else {
              this.postMessageToWebview({
                type: "agentEvent",
                event: { type: "error", error: result.warning ?? "Qdrant is not available." },
              })
              this.postMessageToWebview({ type: "agentEvent", event: { type: "vector_db_ready" } })
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[vector db] ${message}` } })
            this.postMessageToWebview({ type: "agentEvent", event: { type: "vector_db_ready" } })
          }
        })()
        break
      }
      case "openFileAtLocation": {
        const cwd = this.getCwd()
        let authorizedPath: string
        try {
          authorizedPath =
            this.webviewPathCapabilities.resolveWorkspacePath(cwd, msg.path)
        } catch {
          vscode.window.showErrorMessage(
            "NexusCode: Refusing to open a file outside the active workspace.",
          )
          break
        }
        const uri = this.workspaceUriForAuthorizedPath(cwd, authorizedPath)
        const line = Math.max(0, (msg.line ?? 1) - 1)
        const endLine = msg.endLine != null ? Math.max(0, msg.endLine - 1) : line
        try {
          const doc = await vscode.workspace.openTextDocument(uri)
          const range = new vscode.Range(line, 0, endLine, 0)
          const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Active,
            selection: range,
            preview: false,
          })
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
        } catch {
          vscode.window.showErrorMessage(`NexusCode: Could not open ${msg.path}`)
        }
        break
      }
      case "showDiff": {
        const cwd = this.getCwd()
        let authorizedPath: string
        try {
          authorizedPath =
            this.webviewPathCapabilities.resolveWorkspacePath(cwd, msg.path)
        } catch {
          vscode.window.showErrorMessage(
            "NexusCode: Refusing to show a diff outside the active workspace.",
          )
          break
        }
        const key = authorizedPath.replace(/\\/g, "/")
        const pendingPreview =
          this.pendingWriteApprovalPreview &&
          (() => {
            try {
              return (
                this.normalizePathKey(
                  this.pendingWriteApprovalPreview.path,
                  cwd,
                ) === key
              )
            } catch {
              return false
            }
          })()
            ? this.pendingWriteApprovalPreview
            : null
        const sessionEdit = this.sessionUnacceptedEdits.find((entry) => {
          try {
            return this.normalizePathKey(entry.path, cwd) === key
          } catch {
            return false
          }
        })
        if (pendingPreview) {
          const uri = this.workspaceUriForAuthorizedPath(cwd, authorizedPath)
          const before = await Promise.resolve(
            vscode.workspace.openTextDocument(uri),
          )
            .then((document) => document.getText())
            .catch(() => "")
          await showSessionEditDiff(
            cwd,
            authorizedPath,
            before,
            pendingPreview.content,
            { useWorkspaceAfterFile: false },
          )
        } else if (sessionEdit) {
          if (sessionEdit.contentOmitted) {
            vscode.window.showInformationMessage(
              `NexusCode: The exact diff for ${sessionEdit.path} was omitted because it exceeds the remote review limit.`,
            )
            break
          }
          await showSessionEditDiff(
            cwd,
            authorizedPath,
            sessionEdit.originalContent,
            sessionEdit.newContent,
            { useWorkspaceAfterFile: false },
          )
        } else {
          await this.openWorkspaceFile(cwd, authorizedPath)
        }
        break
      }
      case "openSessionEditDiff": {
        const cwd = this.getCwd()
        let key: string
        try {
          key = this.normalizePathKey(msg.path, cwd)
        } catch {
          break
        }
        const entry = this.sessionUnacceptedEdits.find((candidate) => {
          try {
            return this.normalizePathKey(candidate.path, cwd) === key
          } catch {
            return false
          }
        })
        if (entry) {
          if (entry.contentOmitted) {
            vscode.window.showInformationMessage(
              `NexusCode: The exact diff for ${entry.path} was omitted because it exceeds the remote review limit.`,
            )
            break
          }
          await showSessionEditDiff(
            cwd,
            key,
            entry.originalContent,
            entry.newContent,
            { useWorkspaceAfterFile: false },
          )
        }
        break
      }
      case "undoSessionEdits": {
        const remaining: SessionUnacceptedEdit[] = []
        const durableIds = [
          ...new Set(
            this.sessionUnacceptedEdits.map((edit) => edit.changeSetId),
          ),
        ].reverse()
        for (const changeSetId of durableIds) {
          try {
            await this.resolveDurableChange(changeSetId, "revert")
          } catch (error) {
            remaining.push(
              ...this.sessionUnacceptedEdits.filter(
                (edit) => edit.changeSetId === changeSetId,
              ),
            )
            const detail =
              error instanceof Error ? error.message : String(error)
            vscode.window.showErrorMessage(
              `NexusCode: Could not undo change ${changeSetId} — ${detail}`,
            )
          }
        }
        this.sessionUnacceptedEdits = remaining
        this.changeSetReviewSessionId = null
        await this.refreshSessionChangeSets(true).catch(() => undefined)
        this.postStateToWebview()
        break
      }
      case "keepAllSessionEdits": {
        const ids = [
          ...new Set(
            this.sessionUnacceptedEdits.map((edit) => edit.changeSetId),
          ),
        ]
        const failedIds = new Set<string>()
        for (const id of ids) {
          try {
            await this.resolveDurableChange(id, "accept")
          } catch (error) {
            failedIds.add(id)
            vscode.window.showErrorMessage(
              `NexusCode: Could not accept change ${id} — ` +
              (error instanceof Error ? error.message : String(error)),
            )
          }
        }
        this.sessionUnacceptedEdits = this.sessionUnacceptedEdits.filter(
          (edit) => failedIds.has(edit.changeSetId),
        )
        this.changeSetReviewSessionId = null
        await this.refreshSessionChangeSets(true).catch(() => undefined)
        this.postStateToWebview()
        break
      }
      case "revertSessionEditFile": {
        const cwd = this.getCwd()
        let key: string
        try {
          key = this.normalizePathKey(msg.path, cwd)
        } catch {
          break
        }
        const entry = this.sessionUnacceptedEdits.find((candidate) => {
          try {
            return this.normalizePathKey(candidate.path, cwd) === key
          } catch {
            return false
          }
        })
        if (entry) {
          try {
            await this.resolveDurableChange(
              entry.changeSetId,
              "revert",
            )
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error)
            vscode.window.showErrorMessage(
              `NexusCode: Failed to revert ${entry.path} — ${detail}`,
            )
            break
          }
          this.sessionUnacceptedEdits = this.sessionUnacceptedEdits.filter(
            (candidate) => {
              try {
                return this.normalizePathKey(candidate.path, cwd) !== key
              } catch {
                return false
              }
            },
          )
          this.changeSetReviewSessionId = null
          await this.refreshSessionChangeSets(true).catch(() => undefined)
          this.postStateToWebview()
        }
        break
      }
      case "acceptSessionEditFile": {
        const cwd = this.getCwd()
        let key: string
        try {
          key = this.normalizePathKey(msg.path, cwd)
        } catch {
          break
        }
        const entry = this.sessionUnacceptedEdits.find((candidate) => {
          try {
            return this.normalizePathKey(candidate.path, cwd) === key
          } catch {
            return false
          }
        })
        if (entry) {
          try {
            await this.resolveDurableChange(
              entry.changeSetId,
              "accept",
            )
          } catch (error) {
            vscode.window.showErrorMessage(
              `NexusCode: Failed to accept ${entry.path} — ` +
              (error instanceof Error ? error.message : String(error)),
            )
            break
          }
        }
        this.sessionUnacceptedEdits = this.sessionUnacceptedEdits.filter(
          (candidate) => {
            try {
              return this.normalizePathKey(candidate.path, cwd) !== key
            } catch {
              return false
            }
          },
        )
        this.changeSetReviewSessionId = null
        await this.refreshSessionChangeSets(true).catch(() => undefined)
        this.postStateToWebview()
        break
      }
      case "setServerUrl": {
        if (this.isRunning) {
          void vscode.window.showWarningMessage(
            "NexusCode: Stop the current run before changing the server destination.",
          )
          break
        }
        const url = typeof msg.url === "string" ? msg.url.trim() : ""
        const canonical = url ? canonicalizeNexusServerBaseUrl(url) : undefined
        await vscode.workspace
          .getConfiguration("nexuscode")
          .update(
            "serverUrl",
            canonical,
            vscode.ConfigurationTarget.Global,
          )
        await this.handleServerDestinationChange()
        this.postStateToWebview()
        break
      }
      case "setServerToken": {
        const token = typeof msg.token === "string" ? msg.token.trim() : ""
        const serverUrl = this.getServerUrl()
        if (!serverUrl) {
          vscode.window.showErrorMessage(
            "NexusCode: Set and save the server URL before storing its token.",
          )
          break
        }
        const secretKey = getNexusServerTokenSecretKey(serverUrl)
        if (token) {
          await this.context.secrets.store(secretKey, token)
          vscode.window.showInformationMessage(
            "NexusCode: Server token saved securely.",
          )
        } else {
          await this.context.secrets.delete(secretKey)
          vscode.window.showInformationMessage(
            "NexusCode: Stored server token removed.",
          )
        }
        this.serverConnectionError = undefined
        this.postStateToWebview()
        break
      }
      case "setAutocompleteExtensionSettings": {
        const c = vscode.workspace.getConfiguration()
        const p = msg.patch
        const t = vscode.ConfigurationTarget.Global
        if (p.enableAutoTrigger !== undefined) {
          await c.update("nexuscode.autocomplete.enableAutoTrigger", p.enableAutoTrigger, t)
        }
        if (p.useSeparateModel !== undefined) {
          await c.update("nexuscode.autocomplete.useSeparateModel", p.useSeparateModel, t)
        }
        if (p.modelProvider !== undefined) {
          await c.update("nexuscode.autocomplete.provider", p.modelProvider.trim() || undefined, t)
        }
        if (p.modelId !== undefined) {
          await c.update("nexuscode.autocomplete.model", p.modelId.trim() || undefined, t)
        }
        if (p.modelApiKey !== undefined) {
          const key = p.modelApiKey.trim()
          if (key) {
            await this.context.secrets.store(AUTOCOMPLETE_API_KEY_SECRET, key)
          } else {
            await this.context.secrets.delete(AUTOCOMPLETE_API_KEY_SECRET)
          }
          this.autocompleteApiKeyConfigured = Boolean(key)
        }
        if (p.modelBaseUrl !== undefined) {
          await c.update("nexuscode.autocomplete.baseUrl", p.modelBaseUrl.trim() || undefined, t)
        }
        if (p.modelTemperature !== undefined) {
          const n = parseFloat(p.modelTemperature)
          await c.update("nexuscode.autocomplete.temperature", Number.isFinite(n) ? n : 0.2, t)
        }
        if (p.modelReasoningEffort !== undefined) {
          await c.update("nexuscode.autocomplete.reasoningEffort", p.modelReasoningEffort.trim() || undefined, t)
        }
        if (p.modelContextWindow !== undefined) {
          const n = parseInt(p.modelContextWindow, 10)
          await c.update(
            "nexuscode.autocomplete.contextWindow",
            Number.isFinite(n) && n > 0 ? n : 0,
            t,
          )
        }
        this.onAutocompleteConfigReady?.()
        this.postStateToWebview()
        break
      }
      case "openNexusConfigFolder": {
        const scope = msg.scope === "project" ? "project" : "global"
        if (scope === "global") {
          const dir = path.join(os.homedir(), ".nexus")
          const uri = vscode.Uri.file(dir)
          try { await Promise.resolve(vscode.workspace.fs.createDirectory(uri)).catch(() => {}) } catch { /* noop */ }
          const configPath = path.join(dir, "nexus.yaml")
          const configUri = vscode.Uri.file(configPath)
          const doc = await Promise.resolve(vscode.workspace.openTextDocument(configUri)).catch(() => null)
          if (doc) {
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
          }
          /* Do not use revealInExplorer — on macOS it opens Finder. */
        } else {
          const cwd = this.getCwd()
          const dir = path.join(cwd, ".nexus")
          const dirUri = vscode.Uri.file(dir)
          try { await Promise.resolve(vscode.workspace.fs.createDirectory(dirUri)).catch(() => {}) } catch { /* noop */ }
          const configPath = path.join(cwd, ".nexus", "nexus.yaml")
          const uri = vscode.Uri.file(configPath)
          const doc = await Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => null)
          if (doc) {
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
          } else {
            const wsEdit = new vscode.WorkspaceEdit()
            wsEdit.createFile(uri, { ignoreIfExists: true })
            await vscode.workspace.applyEdit(wsEdit)
            const newDoc = await vscode.workspace.openTextDocument(uri)
            await vscode.window.showTextDocument(newDoc, { viewColumn: vscode.ViewColumn.Active, preview: false })
          }
          /* Do not use revealInExplorer — on macOS it opens Finder. */
        }
        break
      }
      case "openCursorignore": {
        const cwd = this.getCwd()
        const filePath = path.join(cwd, ".cursorignore")
        const uri = vscode.Uri.file(filePath)
        const doc = await Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => null)
        if (doc) {
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
        } else {
          const wsEdit = new vscode.WorkspaceEdit()
          wsEdit.createFile(uri, { ignoreIfExists: true })
          await vscode.workspace.applyEdit(wsEdit)
          const newDoc = await vscode.workspace.openTextDocument(uri)
          await vscode.window.showTextDocument(newDoc, { viewColumn: vscode.ViewColumn.Active, preview: false })
        }
        break
      }
      case "openMcpConfig": {
        const cwd = this.getCwd()
        const mcpPath = path.join(cwd, ".nexus", "mcp-servers.json")
        const uri = vscode.Uri.file(mcpPath)
        const doc = await Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(async () => {
          const dir = path.join(cwd, ".nexus")
          try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir))
          } catch {}
          const defaultContent = JSON.stringify({ servers: [] }, null, 2)
          await vscode.workspace.fs.writeFile(uri, Buffer.from(defaultContent, "utf8"))
          return vscode.workspace.openTextDocument(uri)
        })
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
        break
      }
      case "testMcpServers": {
        if (!this.config) {
          this.postMessageToWebview({
            type: "mcpServerStatus",
            results: [],
          })
          break
        }
        try {
          const resolved = await this.getResolvedMcpServers()
          if (resolved.length === 0) {
            this.postMessageToWebview({ type: "mcpServerStatus", results: [] })
            break
          }
          const results = await testVsCodeMcpServers(
            resolved,
            new VsCodeHost(this.getCwd(), () => {}),
          )
          this.postMessageToWebview({ type: "mcpServerStatus", results })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.postMessageToWebview({
            type: "mcpServerStatus",
            results: this.config.mcp.servers.map((s) => ({ name: s.name, status: "error" as const, error: message })),
          })
        }
        break
      }
      case "approvePendingMcp": {
        const pending = this.config?.mcp.pendingProjectServers?.find(
          (entry) =>
            entry.config.name === msg.name &&
            entry.origin === msg.origin,
        )
        if (!pending) {
          vscode.window.showErrorMessage(
            `NexusCode: Pending MCP request not found: ${msg.name}`,
          )
          break
        }
        const nextServers = [
          ...(this.config?.mcp.servers ?? []).filter(
            (server) => server.name !== pending.config.name,
          ),
          {
            ...pending.config,
            enabled: true,
          },
        ]
        await this.handleSaveConfig({
          mcp: { servers: nextServers },
        })
        break
      }
      case "approvePendingProjectAuthority": {
        if (this.getServerUrl()) {
          vscode.window.showErrorMessage(
            "NexusCode: Project authority must be approved on the runtime host.",
          )
          break
        }
        const fingerprint = msg.fingerprint.trim().toLowerCase()
        const pending = this.config?.pendingProjectAuthority?.find(
          (request) => request.fingerprint === fingerprint,
        )
        if (!pending) {
          vscode.window.showErrorMessage(
            "NexusCode: This project authority request is no longer pending.",
          )
          break
        }
        const choice = await vscode.window.showWarningMessage(
          `Approve the exact ${pending.kind} request for this workspace?\n\n${JSON.stringify(pending.payload)}`,
          { modal: true },
          "Approve exact request",
          "Cancel",
        )
        if (choice !== "Approve exact request") break
        const cwd = this.getCwd()
        try {
          await approvePendingVsCodeProjectAuthority(
            cwd,
            fingerprint,
            { loadEnv: true },
          )
          let loaded: NexusConfig
          try {
            loaded = await this.loadHostConfig(cwd)
          } catch (error) {
            this.setConfigurationLoadError(error, cwd)
            break
          }
          this.configurationError = undefined
          this.config = loaded
          this.applyHostSelections(loaded)
          this.postConfigToWebview()
          void this.loadAndSendSkillDefinitions()
          void this.reconnectMcpServers().catch(() => undefined)
          void this.initializeIndexer(cwd).catch(() => undefined)
          vscode.window.showInformationMessage(
            `NexusCode: Approved exact ${pending.kind} request for this workspace.`,
            { modal: false },
          )
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error)
          vscode.window.showErrorMessage(
            `NexusCode: Project authority approval failed — ${message}`,
          )
        }
        break
      }
      case "fetchMarketplaceData": {
        await this.ensureInitialized()
        const cwd = this.getCwd()
        const folders = vscode.workspace.workspaceFolders
        const ws = folders && folders.length > 0 ? cwd : undefined
        const includeSkills = msg.includeSkills !== false
        const skillSearch = includeSkills
          ? {
              q: msg.skillSearchQuery?.trim() || "skill",
              mode: msg.skillSearchMode ?? "keyword",
              page: msg.skillPage ?? 1,
              category: msg.skillCategory,
              limit: 24,
              threshold: msg.skillVectorThreshold,
            }
          : undefined
        try {
          const data = await this.marketplaceService.fetchData(ws, {
            includeSkills,
            skillSearch,
            bypassCache: msg.forceRefresh === true,
          })
          this.postMessageToWebview({
            type: "marketplaceData",
            marketplaceItems: data.marketplaceItems,
            marketplaceInstalledMetadata: data.marketplaceInstalledMetadata,
            errors: data.errors,
            skillSearchMeta: data.skillSearchMeta,
          })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          this.postMessageToWebview({
            type: "marketplaceData",
            marketplaceItems: [],
            marketplaceInstalledMetadata: { project: {}, global: {} },
            errors: [message],
          })
        }
        break
      }
      case "installMarketplaceItem": {
        await this.ensureInitialized()
        const cwd = this.getCwd()
        const folders = vscode.workspace.workspaceFolders
        const ws = folders && folders.length > 0 ? cwd : undefined
        const result = await this.marketplaceService.install(
          msg.item,
          msg.options,
          ws,
        )
        this.postMessageToWebview({
          type: "marketplaceInstallResult",
          slug: msg.item.id,
          success: result.success,
          error: result.error,
        })
        if (result.success) {
          await this.refreshAfterMarketplaceChange()
        }
        break
      }
      case "removeInstalledMarketplaceItem": {
        await this.ensureInitialized()
        const cwd = this.getCwd()
        const folders = vscode.workspace.workspaceFolders
        const ws = folders && folders.length > 0 ? cwd : undefined
        const scope = msg.options.target
        const result = await this.marketplaceService.remove(msg.item, scope, ws)
        this.postMessageToWebview({
          type: "marketplaceRemoveResult",
          slug: msg.item.id,
          success: result.success,
          error: result.error,
        })
        if (result.success) {
          await this.refreshAfterMarketplaceChange()
        }
        break
      }
      case "openSkillFolder": {
        let authorizedPath: string
        try {
          authorizedPath =
            this.webviewPathCapabilities.resolveKnownSkillPath(msg.path)
        } catch {
          vscode.window.showErrorMessage(
            "NexusCode: This skill path is not part of the current host-loaded skill catalog.",
          )
          break
        }
        const uri = vscode.Uri.file(authorizedPath)
        const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => null)
        if (stat?.type === vscode.FileType.File) {
          const doc = await Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => null)
          if (doc) {
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
          }
        } else {
          const skillMd = path.join(authorizedPath, "SKILL.md")
          const skillUri = vscode.Uri.file(skillMd)
          const doc = await Promise.resolve(vscode.workspace.openTextDocument(skillUri)).catch(() => null)
          if (doc) {
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
          }
        }
        /* Do not use revealInExplorer — on macOS it opens Finder. */
        break
      }
      case "approvalResponse": {
        const result: PermissionResult = {
          approved: msg.approved,
          alwaysApprove: msg.alwaysApprove,
          addToAllowedCommand: msg.addToAllowedCommand,
          skipAll: msg.skipAll,
          whatToDoInstead: msg.whatToDoInstead,
        }
        if (
          resolveWebviewApproval(
            this.approvalResolveRef,
            msg.partId,
            result,
          )
        ) {
          // Exact local tool-part approval resolved.
          if (this.pendingWriteApprovalPreview?.partId === msg.partId) {
            this.pendingWriteApprovalPreview = null
          }
        } else if (
          this.getServerUrl() &&
          this.activeRemoteTurn
        ) {
          try {
            await this.activeRemoteTurn.resolveApproval(msg.partId, result)
            if (this.pendingWriteApprovalPreview?.partId === msg.partId) {
              this.pendingWriteApprovalPreview = null
            }
          } catch (error) {
            this.reportServerError(error)
          }
        }
        break
      }
      case "openExternal": {
        try {
          const url = parseExternalHttpUrl(msg.url)
          await vscode.env.openExternal(vscode.Uri.parse(url.toString()))
        } catch {
          vscode.window.showErrorMessage(
            "NexusCode: Refusing to open a non-HTTP(S) external URL.",
          )
        }
        break
      }
      case "showConfirm": {
        const choice = await vscode.window.showWarningMessage(msg.message, { modal: true }, "Yes", "No")
        this.postMessageToWebview({ type: "confirmResult", id: msg.id, ok: choice === "Yes" })
        break
      }
      case "openNexusignore": {
        const cwd = this.getCwd()
        const filePath = path.join(cwd, ".nexusignore")
        const uri = vscode.Uri.file(filePath)
        const doc = await Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => null)
        if (doc) {
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
        } else {
          const wsEdit = new vscode.WorkspaceEdit()
          wsEdit.createFile(uri, { ignoreIfExists: true })
          await vscode.workspace.applyEdit(wsEdit)
          const newDoc = await vscode.workspace.openTextDocument(uri)
          await vscode.window.showTextDocument(newDoc, { viewColumn: vscode.ViewColumn.Active, preview: false })
        }
        break
      }
      case "restoreCheckpoint":
        if (msg.hash?.trim() && msg.restoreType) {
          await this.restoreCheckpointToHash(msg.hash.trim(), msg.restoreType)
        }
        break
      case "showCheckpointDiff":
        if (msg.fromHash?.trim()) {
          await this.showCheckpointDiff(msg.fromHash.trim(), msg.toHash?.trim())
        }
        break
      case "getAgentPresets": {
        const presets = await this.readAgentPresets()
        this.postMessageToWebview({ type: "agentPresets", presets })
        break
      }
      case "getAgentPresetOptions": {
        const options = await this.getAgentPresetOptions()
        this.postMessageToWebview({ type: "agentPresetOptions", options })
        break
      }
      case "createAgentPreset":
        if (msg.preset?.name?.trim()) {
          await this.createAgentPreset(msg.preset)
          const presets = await this.readAgentPresets()
          this.postMessageToWebview({ type: "agentPresets", presets })
        }
        break
      case "deleteAgentPreset":
        if (msg.presetName?.trim()) {
          await this.deleteAgentPreset(msg.presetName.trim())
          const presets = await this.readAgentPresets()
          this.postMessageToWebview({ type: "agentPresets", presets })
        }
        break
      case "applyAgentPreset":
        if (msg.presetName != null) {
          await this.applyAgentPreset(typeof msg.presetName === "string" ? msg.presetName : "Default")
        }
        break
      case "planFollowupChoice": {
        if (msg.choice === "abandon") {
          await this.persistSessionMode("agent")
          this.postStateToWebview()
          break
        }
        const cwd = this.getCwd()
        if (msg.choice === "implement") {
          this.mode = "agent"
          const planText =
            msg.planText?.trim() ||
            (this.session ? await getPlanContentForFollowup(this.session, cwd) : "")
          const continueContent = planText
            ? `Implement the following plan:\n\n${planText}`
            : "Implement the plan above."
          if (msg.newSession && this.session) {
            const freshPlanText = planText || (await getPlanContentForFollowup(this.session, cwd))
            this.session = Session.create(cwd)
            if (!this.getServerUrl()) {
              await this.session.save()
              await this.setSelectedLocalSessionId(this.session.id, cwd)
            }
            this.lastRunMode = null
            this.checkpoint = undefined
            this.serverSessionId = undefined
            this.serverSessionOldestLoadedOffset = undefined
            if (this.getServerUrl()) {
              await this.getRemoteWorkspaceState(cwd)
                .setSelectedSessionId(undefined)
            }
            this.localSessionWindowed = false
            this.postStateToWebview()
            await this.runAgent(`Implement the following plan:\n\n${freshPlanText}`, "agent")
          } else {
            await this.runAgent(continueContent, "agent")
          }
          break
        }
        if (msg.choice === "revise") {
          this.mode = "plan"
          const planText =
            msg.planText?.trim() ||
            (this.session ? await getPlanContentForFollowup(this.session, cwd) : "")
          const instruction = msg.instruction?.trim() || "Improve the plan based on the user's feedback."
          const reviseContent = `Revise the current implementation plan based on this feedback.\n\nCurrent plan:\n${planText || "(no extracted plan text)"}\n\nUser feedback / requested changes:\n${instruction}\n\nDo not implement the code. Update the plan file in .nexus/plans/ and call PlanExit again when the revised plan is ready.`
          await this.runAgent(reviseContent, "plan")
        }
        break
      }
      case "dismissQuestionnaire": {
        if (this.pendingQuestionCoordinator.dismiss(msg.requestId)) {
          // Force immediate sync so webview doesn't briefly re-show stale pending from a batched state post.
          this.postStateToWebview(true)
        }
        break
      }
      case "questionnaireResponse": {
        const resolution = this.pendingQuestionCoordinator.resolve(
          msg.requestId,
          msg.answers,
        )
        if (!resolution.accepted || !resolution.request || !resolution.answers) {
          break
        }
        const prompt = formatQuestionnaireAnswersForAgent(
          resolution.request,
          resolution.answers,
        )
        this.postStateToWebview(true)
        await this.runAgent(prompt, this.mode)
        break
      }
      case "slashCommand": {
        const command = typeof msg.command === "string" ? msg.command.trim() : ""
        if (!command) break
        const cwd = this.getCwd()
        const raw = command.replace(/^\//, "").trim()
        const [name, ...rest] = raw.split(/\s+/)
        const args = rest.join(" ")
        switch (name) {
          case "compact":
            await this.compactHistory()
            break
          case "diff": {
            // Show session file changes as a diff summary
            const edits = this.getSessionUnacceptedEditsForState()
            if (edits.length === 0) {
              vscode.window.showInformationMessage("NexusCode: No file changes in this session.")
            } else {
              const summary = edits.map(e => {
                const stats = `+${e.diffStats.added}/-${e.diffStats.removed}`
                return `${e.path} (${stats})`
              }).join("\n")
              vscode.window.showInformationMessage(`Session changes:\n${summary}`, { modal: true })
            }
            break
          }
          case "mode":
          case "llm":
            this.postMessageToWebview({ type: "action", action: "switchView", view: "settings", settingsTab: "llm" })
            break
          case "embeddings":
            this.postMessageToWebview({ type: "action", action: "switchView", view: "settings", settingsTab: "embeddings" })
            break
          case "presets":
            this.postMessageToWebview({ type: "action", action: "switchView", view: "settings", settingsTab: "presets" })
            break
          case "sessions":
            this.postMessageToWebview({ type: "action", action: "switchView", view: "sessions" })
            break
          case "index":
            this.sendIndexStatus()
            this.postMessageToWebview({ type: "action", action: "switchView", view: "settings", settingsTab: "index" })
            break
          case "skills":
            this.postMessageToWebview({ type: "action", action: "switchView", view: "settings", settingsTab: "integrations", settingsIntegTab: "rules-skills" })
            break
          case "mcp":
            this.postMessageToWebview({ type: "action", action: "switchView", view: "settings", settingsTab: "integrations", settingsIntegTab: "mcp" })
            break
          case "create-skill": {
            const skillName = await vscode.window.showInputBox({ prompt: "Skill name (e.g. my-skill)" })
            if (!skillName?.trim()) break
            const scope = await vscode.window.showQuickPick(
              ["Project (.nexus/skills/)", "Global (~/.nexus/skills/)"],
              { placeHolder: "Create skill in..." }
            )
            const baseDir = scope?.startsWith("Global")
              ? path.join(os.homedir(), ".nexus", "skills")
              : path.join(cwd, ".nexus", "skills")
            const skillDir = path.join(baseDir, skillName.trim())
            const skillFile = path.join(skillDir, "SKILL.md")
            try {
              await vscode.workspace.fs.createDirectory(vscode.Uri.file(skillDir))
              const template = `# ${skillName.trim()}\n\nDescribe what this skill does and when to use it.\n\n## Instructions\n\n- Step 1\n- Step 2\n`
              await vscode.workspace.fs.writeFile(vscode.Uri.file(skillFile), Buffer.from(template, "utf8"))
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(skillFile))
              await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active })
            } catch (err) {
              vscode.window.showErrorMessage(`NexusCode: Failed to create skill — ${err}`)
            }
            break
          }
          case "create-rule": {
            const ruleName = await vscode.window.showInputBox({ prompt: "Rule file name (e.g. my-rule.md)" })
            if (!ruleName?.trim()) break
            const scope = await vscode.window.showQuickPick(
              ["Project (.nexus/rules/)", "Global (~/.nexus/rules/)"],
              { placeHolder: "Create rule in..." }
            )
            const baseDir = scope?.startsWith("Global")
              ? path.join(os.homedir(), ".nexus", "rules")
              : path.join(cwd, ".nexus", "rules")
            const ruleFile = path.join(baseDir, ruleName.trim().endsWith(".md") ? ruleName.trim() : `${ruleName.trim()}.md`)
            try {
              await vscode.workspace.fs.createDirectory(vscode.Uri.file(baseDir))
              const template = `# Rule: ${ruleName.trim()}\n\nDefine your project rules here.\n`
              await vscode.workspace.fs.writeFile(vscode.Uri.file(ruleFile), Buffer.from(template, "utf8"))
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ruleFile))
              await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active })
            } catch (err) {
              vscode.window.showErrorMessage(`NexusCode: Failed to create rule — ${err}`)
            }
            break
          }
          case "clear":
            await this.createNewSession()
            break
          default: {
            const resolved = await this.resolvePromptCommand(name, args)
            if (resolved.status === "resolved") {
              await this.runAgent(resolved.prompt, this.mode)
              break
            }
            if (resolved.status === "ambiguous") {
              vscode.window.showWarningMessage(
                `NexusCode: /${name} is ambiguous. Use ${resolved.candidates.map((candidate) => `/${candidate}`).join(" or ")}.`,
              )
              break
            }
            if (isMcpPromptCommandName(name)) {
              vscode.window.showWarningMessage(
                `NexusCode: MCP prompt /${name} is not available from the connected ${this.getServerUrl() ? "NexusCode Server workspace" : "local MCP servers"}.`,
              )
              break
            }
            // Unknown slash command — switch to settings view as fallback
            this.postMessageToWebview({ type: "action", action: "switchView", view: "settings" })
          }
        }
        break
      }
    }
  }

  /**
   * Restore workspace/chat to a checkpoint.
   * restoreType: task = rewind chat only; workspace = files only; taskAndWorkspace = both.
   */
  private async restoreCheckpointToHash(hash: string, restoreType: "task" | "workspace" | "taskAndWorkspace"): Promise<void> {
    if (!this.session || !this.config) return
    if (this.isRunning) {
      vscode.window.showWarningMessage(
        "NexusCode: Stop the current run before restoring a checkpoint.",
      )
      return
    }
    const cwd = this.getCwd()
    const tracker = await this.ensureCheckpointForCurrentSession(this.session.id, cwd, this.config)
    if (!tracker) {
      vscode.window.showWarningMessage("NexusCode: Checkpoints are not enabled or no checkpoint is available.", { modal: false })
      return
    }
    const entry = tracker.getEntries().find((e) => e.hash === hash)
    if (!entry) {
      vscode.window.showWarningMessage(
        "NexusCode: Refusing to restore an unknown checkpoint.",
      )
      return
    }

    const restoresWorkspace =
      restoreType === "workspace" || restoreType === "taskAndWorkspace"
    if (restoresWorkspace && !entry.messageId) {
      vscode.window.showWarningMessage(
        "NexusCode: This legacy checkpoint is preview-only because it has no exact message binding. Chat-only restore remains available.",
        { modal: false },
      )
      return
    }
    const confirmation = await vscode.window.showWarningMessage(
      restoresWorkspace
        ? "Restore this checkpoint? Nexus will revert only pending, content-matched Nexus-owned edits after this point. Manual, accepted, ignored, and nested-repository changes will be preserved."
        : "Restore this checkpoint? This will discard chat messages created after it.",
      { modal: true },
      "Restore checkpoint",
      "Cancel",
    )
    if (confirmation !== "Restore checkpoint") return

    const checkpointTs = entry.ts
    let workspace:
      | {
          service: ChangeSetService
          reverted: readonly ChangeSetRecord[]
        }
      | undefined
    try {
      if (restoresWorkspace) {
        workspace = await this.revertNexusChangesAfterCheckpoint(entry)
      }
      if (
        restoreType === "task" ||
        restoreType === "taskAndWorkspace"
      ) {
        await this.persistCheckpointChatRewind({
          rewind: () =>
            this.session?.rewindToTimestamp(checkpointTs),
          isPersisted: () =>
            this.session?.messages.every((message) =>
              message.ts <= checkpointTs,
            ) ?? false,
          ...(workspace
            ? {
                service: workspace.service,
                reverted: workspace.reverted,
              }
            : {}),
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(
        `NexusCode: Failed to restore checkpoint safely — ${message}`,
      )
      return
    }

    if (restoresWorkspace) {
      try {
        this.sessionUnacceptedEdits = []
        this.changeSetReviewSessionId = null
        await this.refreshSessionChangeSets(true)
      } catch {
        // The durable store remains authoritative; the next state refresh can
        // retry without changing any files.
      }
    }

    const msg =
      restoreType === "task"
        ? "Chat restored to checkpoint."
        : restoreType === "workspace"
          ? `Reverted ${workspace?.reverted.length ?? 0} pending Nexus-owned change set(s); unrelated changes were preserved.`
          : `Chat restored and ${workspace?.reverted.length ?? 0} pending Nexus-owned change set(s) reverted; unrelated changes were preserved.`
    vscode.window.showInformationMessage(`NexusCode: ${msg}`, { modal: false })
    this.postStateToWebview()
  }

  /** Show diff between two checkpoints (or checkpoint and current). */
  private async showCheckpointDiff(fromHash: string, toHash?: string): Promise<void> {
    if (!this.session || !this.config) return
    const tracker = await this.ensureCheckpointForCurrentSession(this.session.id, this.getCwd(), this.config)
    if (!tracker) {
      vscode.window.showWarningMessage("NexusCode: Checkpoints are not enabled.", { modal: false })
      return
    }
    const knownHashes = new Set(
      tracker.getEntries().map((entry) => entry.hash),
    )
    if (
      !knownHashes.has(fromHash) ||
      (toHash !== undefined && !knownHashes.has(toHash))
    ) {
      vscode.window.showWarningMessage(
        "NexusCode: Refusing to compare an unknown checkpoint.",
      )
      return
    }
    try {
      const files = await tracker.getDiff(fromHash, toHash)
      if (files.length === 0) {
        vscode.window.showInformationMessage("NexusCode: No changes between these checkpoints.", { modal: false })
        return
      }
      if (files.length === 1) {
        const f = files[0]!
        await openReadonlyTextDiff(
          f.path,
          f.before,
          f.after,
          `${path.basename(f.path)}: Checkpoint diff`
        )
        return
      }
      const chosen = await vscode.window.showQuickPick(
        files.map((f) => ({ label: f.path, file: f })),
        { title: "Select file to view diff", placeHolder: `${files.length} files changed` }
      )
      if (chosen) {
        await openReadonlyTextDiff(
          chosen.file.path,
          chosen.file.before,
          chosen.file.after,
          `${path.basename(chosen.file.path)}: Checkpoint diff`
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`NexusCode: Failed to get checkpoint diff — ${message}`)
    }
  }

  /** Read agent presets from .nexus/agent-configs.json (same format as CLI). */
  private async readAgentPresets(): Promise<
    Array<{ name: string; vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string }>
  > {
    const cwd = this.getCwd()
    const filePath = path.join(cwd, ".nexus", "agent-configs.json")
    try {
      const uri = vscode.Uri.file(filePath)
      const raw = await vscode.workspace.fs.readFile(uri)
      const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as { presets?: unknown[]; configs?: unknown[] } | unknown[]
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { presets?: unknown[] }).presets)
          ? (parsed as { presets: unknown[] }).presets
          : Array.isArray((parsed as { configs?: unknown[] }).configs)
            ? (parsed as { configs: unknown[] }).configs
            : []
      return list.map(normalizeAgentPresetForExtension).filter(Boolean) as Array<{
        name: string
        vector: boolean
        skills: string[]
        mcpServers: string[]
        rulesFiles: string[]
        modelProvider?: string
        modelId?: string
      }>
    } catch {
      return []
    }
  }

  private async getPresetByName(name: string): Promise<
    | { name: string; vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string }
    | null
  > {
    const trimmed = name.trim()
    if (!trimmed || trimmed === "Default") return null
    const presets = await this.readAgentPresets()
    return presets.find((p) => p.name === trimmed) ?? null
  }

  private resolveConfigForPreset(base: NexusConfig, presetName: string): NexusConfig {
    const trimmed = presetName.trim() || "Default"
    if (trimmed === "Default") return base
    // NOTE: preset lookup is async; this function expects caller to already resolve selected preset if needed.
    return base
  }

  private applyPresetFields(base: NexusConfig, preset: { vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string }): NexusConfig {
    return applyRepositoryAgentPreset(base, preset, this.getCwd())
  }

  /** Discover available skills, MCP server names, and rules files for preset builder. Uses same source as Skills tab (loadSkills) so ~/.nexus and all .md are included. */
  private async getAgentPresetOptions(): Promise<{ skills: string[]; mcpServers: string[]; rulesFiles: string[] }> {
    const cwd = this.getCwd()
    const skillDefs = await loadSkills(
      this.config?.skills ?? [],
      cwd,
      this.config?.skillsUrls,
      this.config ? getClaudeCompatibilityOptions(this.config) : undefined,
      this.config,
    ).catch(() => [])
    const skills = dedupeStringList(skillDefs.map((s) => s.path))
    const configuredAndPlugin = this.config
      ? await resolveConfiguredAndPluginMcpServers(cwd, this.config).catch(() => ({ servers: [] }))
      : { servers: [] }
    const fromConfig = configuredAndPlugin.servers
      .map((server) => server.name)
      .filter((name): name is string => Boolean(name?.trim()))
    const discoveredMcp = await discoverMcpServerNamesForExtension(cwd)
    const mcpServers = dedupeStringList([...fromConfig, ...discoveredMcp])
    const rulesFiles = await discoverRuleFilesForExtension(cwd)
    const fromRulesConfig = this.config?.rules?.files ?? []
    const rulesMerged = dedupeStringList([...fromRulesConfig, ...rulesFiles, "NEXUS.md", "AGENTS.md", "CLAUDE.md"])
    return { skills, mcpServers, rulesFiles: rulesMerged }
  }

  private async createAgentPreset(preset: {
    name: string
    vector: boolean
    skills: string[]
    mcpServers: string[]
    rulesFiles: string[]
    modelProvider?: string
    modelId?: string
  }): Promise<void> {
    const cwd = this.getCwd()
    const available = await this.getAgentPresetOptions()
    const availableSkills = new Set(available.skills)
    const availableMcpServers = new Set(available.mcpServers)
    const availableRulesFiles = new Set(available.rulesFiles)
    const containsUnknownSelection =
      preset.skills.some((skill) => !availableSkills.has(skill)) ||
      preset.mcpServers.some((server) => !availableMcpServers.has(server)) ||
      preset.rulesFiles.some((file) => !availableRulesFiles.has(file))
    if (containsUnknownSelection) {
      vscode.window.showWarningMessage(
        "NexusCode: Refusing to create a preset with skills, MCP servers, or rule files that were not discovered by the extension host.",
      )
      return
    }
    const normalized = normalizeAgentPresetForExtension({
      ...preset,
      createdAt: Date.now(),
    })
    if (!normalized) return
    const presets = await this.readAgentPresets()
    const filtered = presets.filter((p) => p.name !== normalized.name)
    await writeAgentPresetsForExtension(cwd, [normalized, ...filtered])
    vscode.window.showInformationMessage(`NexusCode: Preset "${normalized.name}" created.`, { modal: false })
  }

  private async deleteAgentPreset(presetName: string): Promise<void> {
    const cwd = this.getCwd()
    const presets = await this.readAgentPresets()
    const next = presets.filter((p) => p.name !== presetName)
    if (next.length === presets.length) {
      vscode.window.showWarningMessage(`NexusCode: Preset "${presetName}" not found.`, { modal: false })
      return
    }
    await writeAgentPresetsForExtension(cwd, next)
    vscode.window.showInformationMessage(`NexusCode: Preset "${presetName}" deleted.`, { modal: false })
  }

  /** Apply an agent preset by name: merge vector, skills, MCP, rules (and optional model) into config and save. "Default" = restore initial full config. */
  private async applyAgentPreset(presetName: string): Promise<void> {
    const trimmed = presetName.trim()
    if (!this.config) {
      vscode.window.showWarningMessage("NexusCode: No config loaded.", { modal: false })
      return
    }
    if (trimmed === "Default" || trimmed === "") {
      const snap = this.initialFullConfigSnapshot
      if (!snap) {
        vscode.window.showWarningMessage("NexusCode: Default preset not available (no initial config snapshot).", { modal: false })
        return
      }
      const updates: Partial<NexusConfig> = {
        indexing: { ...this.config.indexing, ...snap.indexing },
        skills: snap.skills,
        mcp: { servers: [...snap.mcp.servers] },
        rules: { files: snap.rules.files.length > 0 ? [...snap.rules.files] : ["NEXUS.md", "AGENTS.md", "CLAUDE.md"] },
      }
      await this.handleSaveConfig(updates)
      vscode.window.showInformationMessage("NexusCode: Applied preset \"Default\" (all skills, MCP, rules).", { modal: false })
      return
    }
    const presets = await this.readAgentPresets()
    const preset = presets.find((p) => p.name === trimmed)
    if (!preset) {
      vscode.window.showWarningMessage(`NexusCode: Preset "${trimmed}" not found.`, { modal: false })
      return
    }
    const current = this.config
    const namedServers = (current.mcp?.servers ?? []).map((s) => ({ name: (s as McpServerConfig).name ?? "", server: s }))
    const selectedServers = namedServers
      .filter((item) => item.name && preset.mcpServers.includes(item.name))
      .map((item) => item.server)
    const updates: Partial<NexusConfig> = {
      indexing: {
        ...current.indexing,
        vector: preset.vector,
      },
      skills: preset.skills,
      mcp: { servers: preset.mcpServers.length === 0 ? [] : selectedServers },
      rules: { files: preset.rulesFiles.length > 0 ? preset.rulesFiles : ["NEXUS.md", "AGENTS.md", "CLAUDE.md"] },
    }
    if (preset.modelProvider && preset.modelId) {
      try {
        updates.model = mergeModelPresetSelection(
          current.model,
          preset.modelProvider,
          preset.modelId,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        vscode.window.showErrorMessage(
          `NexusCode: Cannot apply preset "${trimmed}" — ${message}`,
        )
        return
      }
    }
    await this.handleSaveConfig(updates)
    vscode.window.showInformationMessage(`NexusCode: Applied preset "${trimmed}".`, { modal: false })
  }

  private async handleSaveConfig(patch: Partial<NexusConfig>): Promise<void> {
    if (!this.config || !patch) return
    const current: NexusConfig = {
      ...this.config,
      model: {
        ...(this.defaultModelProfile ?? this.config.model),
      },
    }
    const indexBefore = JSON.stringify({
      indexing: current.indexing,
      vectorDb: current.vectorDb,
      embeddings: current.embeddings,
    })
    const mcpBefore = JSON.stringify({ mcp: current.mcp })
    const next = mergeConfigPatchSafely(current, patch)
    const removals = getCredentialRemovalsForConfigPatch(
      current,
      next,
      patch,
    )
    const persistence = partitionConfigPatchForPersistence(current, patch)
    const writesProjectConfig =
      Object.keys(persistence.projectPatch).length > 0
    const writesGlobalConfig =
      Object.keys(persistence.globalPatch).length > 0
    const cwd = this.getCwd()
    const folders = vscode.workspace.workspaceFolders
    if ((!folders || folders.length === 0) && writesProjectConfig) {
      vscode.window.showWarningMessage(
        "NexusCode: Open a workspace folder first to save project preferences. Host-owned settings can still be saved globally.",
        { modal: false }
      )
    }

    if (
      hasExplicitCredentialInput(patch as unknown as Record<string, unknown>) ||
      Object.keys(removals).length > 0
    ) {
      try {
        await persistSecretsFromConfig(
          next as unknown as Record<string, unknown>,
          this.secretsStore,
          { remove: removals },
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`NexusCode: Failed to save API keys — ${message}`)
        this.postMessageToWebview({
          type: "agentEvent",
          event: { type: "error", error: `Credential save failed: ${message}` },
        })
        return
      }
    }

    try {
      if (writesGlobalConfig) {
        await patchGlobalConfig(persistence.globalPatch)
      }
      if (writesProjectConfig && folders && folders.length > 0) {
        await patchProjectConfig(persistence.projectPatch, cwd)
      }
      if (writesGlobalConfig || writesProjectConfig) {
        vscode.window.showInformationMessage(
          writesProjectConfig && (!folders || folders.length === 0)
            ? "NexusCode: Host settings saved; project preferences were not saved without an open workspace."
            : "NexusCode: Settings saved.",
          { modal: false },
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`NexusCode: Failed to save settings — ${message}`)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `Save failed: ${message}` } })
      return
    }
    try {
      this.config = await this.loadHostConfig(cwd)
      this.applyHostSelections(this.config)
      this.configurationError = undefined
    } catch (err) {
      this.setConfigurationLoadError(err, cwd)
      return
    }
    const mcpAfter = JSON.stringify({ mcp: this.config.mcp })
    if (!this.getServerUrl() && mcpBefore !== mcpAfter) {
      void this.reconnectMcpServers().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
      })
    }
    const indexAfter = JSON.stringify({
      indexing: this.config.indexing,
      vectorDb: this.config.vectorDb,
      embeddings: this.config.embeddings,
    })
    if (!this.getServerUrl() && indexBefore !== indexAfter) {
      void this.initializeIndexer(cwd).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[indexer] ${message}` } })
      })
    }
    this.postConfigToWebview()
        void this.loadAndSendSkillDefinitions()
    this.postStateToWebview()
  }

  private async handleRemoveCredential(
    target: "model" | "embeddings" | "qdrant" | "profile",
    profileName?: string,
  ): Promise<void> {
    if (!this.config) return
    const baseConfig: NexusConfig = {
      ...this.config,
      model: {
        ...(this.defaultModelProfile ?? this.config.model),
      },
    }
    const trimmedProfileName = profileName?.trim()
    if (target === "profile" && !trimmedProfileName) {
      vscode.window.showWarningMessage(
        "NexusCode: A profile name is required to remove its credential.",
      )
      return
    }
    await persistSecretsFromConfig(
      baseConfig as unknown as Record<string, unknown>,
      this.secretsStore,
      {
        remove: {
          ...(target === "model" ? { model: true } : {}),
          ...(target === "embeddings" ? { embeddings: true } : {}),
          ...(target === "qdrant" ? { qdrant: true } : {}),
          ...(target === "profile" && trimmedProfileName
            ? { profileNames: [trimmedProfileName] }
            : {}),
        },
      },
    )
    vscode.window.showInformationMessage(
      target === "profile"
        ? `NexusCode: Stored credential for profile "${trimmedProfileName}" removed.`
        : `NexusCode: Stored ${target} credential removed.`,
      { modal: false },
    )
    this.postConfigToWebview()
  }

  private getModeReminder(_mode: Mode): string {
    // Not shown in UI; mode is enforced via system prompt and API mode parameter only.
    return ""
  }

  private async runAgent(
    content: string,
    mode?: Mode,
    images?: Array<{ data: string; mimeType: string }>,
    presetName?: string,
    onAdmission?: (accepted: boolean) => void,
    clientMessageId?: string,
  ): Promise<void> {
    if (this.isRunning) return
    if (this.configurationError) {
      this.postMessageToWebview({
        type: "agentEvent",
        event: {
          type: "error",
          error:
            `${this.configurationError} Use “Reload configuration” after fixing the file.`,
        },
      })
      this.postStateToWebview()
      return
    }
    if (!this.session || !this.config) {
      this.isRunning = false
      this.postMessageToWebview({
        type: "agentEvent",
        event: { type: "error", error: "NexusCode is still initializing. Please retry in a moment." },
      })
      this.postStateToWebview()
      return
    }
    const trimmedInput = content.trim()
    const serverUrl = this.getServerUrl()
    if (serverUrl && this.serverSessionId) {
      try {
        if (await this.resumeRemoteTurnIfActive()) {
          return
        }
      } catch {
        // Starting a second turn after an inconclusive snapshot could duplicate
        // an already-running server turn. Keep the reported connection error.
        return
      }
    }
    this.pendingQuestionRequest = null
    if (!this.getServerUrl() && this.localSessionWindowed && this.session) {
      const fullSession = await Session.resume(this.session.id, this.getCwd())
      if (fullSession) {
        this.session = fullSession
        this.serverSessionOldestLoadedOffset = undefined
        this.localSessionWindowed = false
      }
    }
    if (/^\/compact(\s|$)/i.test(trimmedInput)) {
      await this.compactHistory()
      return
    }

    let liveConfig: NexusConfig
    try {
      liveConfig = await this.loadHostConfig()
    } catch (error) {
      this.setConfigurationLoadError(error)
      return
    }
    this.configurationError = undefined
    this.applyHostSelections(liveConfig)
    this.config = liveConfig

    const reviewCommand = /^\/review(\s|$)/i.test(trimmedInput)
    const forcedRemoteModeForRun = serverUrl
      ? this.forcedRemoteModeForNextRun
      : null
    const requestedMode =
      forcedRemoteModeForRun ?? mode ?? this.mode
    this.mode = requestedMode
    const runMode: Mode = reviewCommand ? "review" : requestedMode
    this.session.setMode(runMode)
    this.lastRunMode = runMode
    this.abortController = new AbortController()
    this.isRunning = true
    this.toolContributionDiagnostics = []

    let actualContent = content
    let createSkillMode = false
    const effectivePresetName = (presetName ?? this.chatPresetName).trim() || "Default"
    this.chatPresetName = effectivePresetName
    if (serverUrl) {
      try {
        assertRemotePresetSupported(effectivePresetName)
        assertRemoteHostSelectionSupported(this.activeProfileName)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.isRunning = false
        this.postMessageToWebview({
          type: "agentEvent",
          event: { type: "error", error: message },
        })
        this.postStateToWebview()
        return
      }
    }
    const promptInvocation =
      !reviewCommand &&
      !/^\/create-skill(?:\s|$)/iu.test(trimmedInput)
        ? parseSlashPromptInvocation(trimmedInput)
        : null
    if (promptInvocation) {
      try {
        const resolved = await this.resolvePromptCommand(
          promptInvocation.name,
          promptInvocation.args,
          this.abortController!.signal,
        )
        if (resolved.status === "resolved") {
          actualContent = resolved.prompt
        } else if (resolved.status === "ambiguous") {
          throw new Error(
            `/${promptInvocation.name} is ambiguous. Use ${resolved.candidates
              .map((candidate) => `/${candidate}`)
              .join(" or ")}.`,
          )
        } else if (isMcpPromptCommandName(promptInvocation.name)) {
          throw new Error(
            `MCP prompt /${promptInvocation.name} is not available from the connected ${serverUrl ? "NexusCode Server workspace" : "local MCP servers"}.`,
          )
        }
      } catch (error) {
        this.isRunning = false
        const message =
          error instanceof Error ? error.message : String(error)
        if (!this.abortController?.signal.aborted) {
          this.postMessageToWebview({
            type: "agentEvent",
            event: { type: "error", error: message },
          })
        }
        this.postStateToWebview()
        return
      }
    }
    const configEnvironment = getConfigEnvironment(this.config)
    let configForRun = this.resolveConfigForPreset(this.config, effectivePresetName)
    let presetOverridesModel = false
    if (effectivePresetName !== "Default") {
      const preset = await this.getPresetByName(effectivePresetName)
      if (preset) {
        try {
          const previousModel = configForRun.model
          configForRun = this.applyPresetFields(configForRun, preset)
          presetOverridesModel =
            configForRun.model.provider !== previousModel.provider ||
            configForRun.model.id !== previousModel.id ||
            configForRun.model.baseUrl !== previousModel.baseUrl
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.isRunning = false
          this.postMessageToWebview({
            type: "agentEvent",
            event: { type: "error", error: `Invalid preset: ${message}` },
          })
          this.postStateToWebview()
          return
        }
      }
    }
    if (reviewCommand) {
      const reviewArgs = trimmedInput.replace(/^\/review\s*/i, "").trim()
      actualContent =
        reviewArgs ||
        `Run a local code review of uncommitted changes in this repository.

Use git diff against HEAD and inspect changed files.
Focus on bugs, regressions, security, and missing tests.

Return in this format:
## Local Review
### Summary
### Issues Found
### Detailed Findings
### Recommendation`
    }
    if (content.trim().toLowerCase().startsWith("/create-skill")) {
      createSkillMode = true
      actualContent = content.replace(/^\/create-skill\s*/i, "").trim() || "Describe what you want the skill to do."
      configForRun = {
        ...configForRun,
        permissions: {
          ...configForRun.permissions,
          rules: [
            ...configForRun.permissions.rules,
            { tool: "Write", pathPattern: ".nexus/skills/**", action: "allow" as const },
            { tool: "Edit", pathPattern: ".nexus/skills/**", action: "allow" as const },
            { tool: "write_to_file", pathPattern: ".nexus/skills/**", action: "allow" as const },
            { tool: "replace_in_file", pathPattern: ".nexus/skills/**", action: "allow" as const },
          ],
        },
      }
    }

    let remoteClientForRun: NexusServerClient | undefined
    if (serverUrl) {
      try {
        const remote = await this.ensureRemoteSession()
        remoteClientForRun = remote.client
      } catch (error) {
        this.isRunning = false
        this.abortController = undefined
        this.reportServerError(error)
        this.postStateToWebview()
        return
      }
    }

    // Do NOT prepend mode reminder to user message — mode is in system prompt and API; keeps UI clean.
    const userContent: string | import("@nexuscode/core").MessagePart[] =
      images != null && images.length > 0
        ? [
            ...(actualContent.trim() ? [{ type: "text" as const, text: actualContent }] : []),
            ...images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
          ]
        : actualContent
    const userMessage = this.session.addMessage(
      {
        role: "user",
        content: userContent,
        presetName: effectivePresetName,
        mode: runMode,
      },
      clientMessageId ? { id: clientMessageId } : undefined,
    )
    if (!serverUrl) onAdmission?.(true)
    this.postStateToWebview()

    const cwd = this.getCwd()

    if (serverUrl) {
      this.setServerConnectionState("connecting")
      let remoteTurn: VsCodeRemoteTurn | undefined
      let remoteAdmitted = false
      let remotePrepared = false
      try {
        const client =
          remoteClientForRun ?? await this.createServerClient(cwd)
        let sid = this.serverSessionId
        if (!sid) {
          const created = await client.createSession()
          sid = created.id
          this.serverSessionId = sid
        }
        const remoteState = this.getRemoteWorkspaceState(cwd)
        await remoteState.setSelectedSessionId(sid)
        void this.postSlashCommandCatalog().catch(() => undefined)
        this.setServerConnectionState("streaming")
        const remoteInput = (
          Array.isArray(userContent)
            ? userContent
            : [{ type: "text" as const, text: userContent }]
        ).map((part) => UserInputPartSchema.parse(part))
        remoteTurn = new VsCodeRemoteTurn({
          client,
          sessionId: sid,
        })
        this.activeRemoteTurn = remoteTurn
        let liveIdentity:
          | { turnId: string; runId: string }
          | undefined
        let acknowledgedSequence = 0
        let admissionCursorWrite: Promise<void> = Promise.resolve()
        try {
          for await (const event of remoteTurn.run({
            ...(clientMessageId ? { inputId: clientMessageId } : {}),
            input: remoteInput,
            mode: runMode,
            signal: this.abortController!.signal,
            onCommandPrepared: async (prepared) => {
              acknowledgedSequence = Math.max(
                acknowledgedSequence,
                prepared.afterSequence,
              )
              await remoteState.savePrepared(sid, {
                version: 1,
                phase: "prepared",
                ...prepared,
                input: remoteInput,
                mode: runMode,
              })
              remotePrepared = true
            },
            onTurn: (identity) => {
              liveIdentity = identity
              remoteAdmitted = true
              onAdmission?.(true)
              if (
                forcedRemoteModeForRun &&
                this.forcedRemoteModeForNextRun ===
                  forcedRemoteModeForRun
              ) {
                this.forcedRemoteModeForNextRun = null
              }
              admissionCursorWrite = remoteState.save(sid, {
                ...identity,
                afterSequence: acknowledgedSequence,
              })
            },
            onSequence: async (sequence) => {
              await admissionCursorWrite
              if (!liveIdentity) {
                throw new Error(
                  "Remote sequence arrived before turn admission",
                )
              }
              acknowledgedSequence = Math.max(
                acknowledgedSequence,
                sequence,
              )
              await remoteState.save(sid, {
                ...liveIdentity,
                afterSequence: acknowledgedSequence,
              })
            },
          })) {
            if (this.abortController?.signal.aborted) break
            if (
              event.type === "tool_approval_needed" &&
              !remoteTurn.bindApprovalPart(event.partId)
            ) {
              throw new Error(
                "Remote approval event is missing its protocol approval identity",
              )
            }
            this.forwardServerEvent(event)
          }
        } catch (error) {
          await admissionCursorWrite
          if (error instanceof SessionTurnTerminalError) {
            await remoteState.clear(sid)
          } else if (
            !liveIdentity &&
            error instanceof SessionProtocolError &&
            !error.protocolError.retryable
          ) {
            await remoteState.clear(sid)
            remotePrepared = false
          }
          throw error
        }
        await admissionCursorWrite
        if (!this.abortController?.signal.aborted) {
          await remoteState.clear(sid)
        }
        await this.refreshRemoteSession(client, sid, cwd).catch(
          () => undefined,
        )
      } catch (err) {
        if (!remoteAdmitted && !remotePrepared) {
          this.session?.rewindBeforeMessageId(userMessage.id)
        }
        const msg = err instanceof Error ? err.message : String(err)
        if (!this.abortController?.signal.aborted) {
          this.setServerConnectionState("error", msg)
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: msg } })
        }
      } finally {
        if (this.activeRemoteTurn === remoteTurn) {
          this.activeRemoteTurn = undefined
        }
        this.pendingWriteApprovalPreview = null
        this.isRunning = false
        if (this.serverConnectionState !== "error") {
          this.serverConnectionState = "idle"
          this.serverConnectionError = undefined
        }
        this.postStateToWebview()
      }
      return
    }

    await this.commitCheckpointForUserMessage(
      this.session.id,
      cwd,
      configForRun,
      userMessage,
    ).catch((err) => {
      console.warn("[nexus] Failed to commit message checkpoint:", err)
    })

    let fatalRunErrorEmitted: string | undefined
    const rememberFatalRunError = (event: AgentEvent): void => {
      if (event.type === "error" && event.fatal) {
        fatalRunErrorEmitted = event.error
      }
    }
    const deliverLocalEvent = (event: AgentEvent) => {
      rememberFatalRunError(event)
      this.updatePendingWriteApprovalPreview(event)
      if (event.type === "question_request") {
        this.pendingQuestionRequest = event.request
      }
      if (event.type === "context_usage") {
        this.lastContextUsage = {
          usedTokens: event.usedTokens,
          limitTokens: event.limitTokens,
          percent: event.percent,
          source: event.source,
          providerTokens: event.providerTokens,
          pendingTokens: event.pendingTokens,
          modelId: event.modelId,
          sessionId: this.session?.id ?? "",
        }
      }
      // Track spawn agent partId for subagent event routing (local mode doesn't go through applyAgentEventToSessionShadow for non-subagent events)
      if (event.type === "tool_start") {
        if (isDelegatedAgentParentTool(event.tool, event.input)) {
          this.streamLastSpawnAgentPartId = event.partId
        }
      } else if (event.type === "tool_end") {
        if (isDelegatedAgentParentToolEndClear(event.tool, (event as { input?: Record<string, unknown> }).input)) {
          this.streamLastSpawnAgentPartId = null
        }
        if (typeof event.metadata?.changeSetId === "string") {
          void this.refreshSessionChangeSets(true).catch((error) => {
            console.warn(
              "[nexus] Failed to refresh durable change review:",
              error,
            )
          })
        }
      } else if (
        event.type === "subagent_start" ||
        event.type === "subagent_tool_start" ||
        event.type === "subagent_tool_end" ||
        event.type === "subagent_done"
      ) {
        // Apply subagent events to session shadow so stateUpdates carry current subagent progress
        this.applyAgentEventToSessionShadow(event)
      }
      this.postMessageToWebview({ type: "agentEvent", event })
      if (this.eventAffectsVisibleState(event)) {
        this.postStateToWebview()
      }
      if (
        event.type === "tool_approval_needed" &&
        event.action.type !== "doom_loop"
      ) {
        this.postMessageToWebview({
          type: "pendingApproval",
          partId: event.partId,
          action: event.action,
        })
      }
      if (event.type === "error") {
        this.postStateToWebview()
      }
      // VsCodeHost owns editor/disk synchronization. Never revert a dirty
      // document in response to a tool event: that can discard user edits
      // which arrived while an approved write was completing.
    }
    const durableEventSink = await DurableRunEventSink.create({
      cwd,
      sessionId: this.session.id,
      mode: runMode,
      deliver: deliverLocalEvent,
    })
    const host = new VsCodeHost(cwd, (event: AgentEvent) => {
      // Record before the durable sink's asynchronous flush. The core loop
      // emits its terminal error and then rejects with that same error.
      rememberFatalRunError(event)
      durableEventSink.emit(event)
    }, { useWebviewApproval: true, approvalResolveRef: this.approvalResolveRef, runCommandsInTerminal: vscode.workspace.getConfiguration("nexuscode").get<boolean>("runCommandsInTerminal") ?? true, onCheckpointEntriesUpdated: () => this.postStateToWebview(), onModeChangeRequested: async (nextMode) => {
      this.mode = nextMode
      this.postStateToWebview()
    }, onWorkingDirectoryChangeRequested: async (nextCwd) => {
      await this.applyHostWorkingDirectoryChange(nextCwd)
    } })
    let durableRunStatus: "completed" | "failed" | "aborted" = "completed"
    const timeoutMs = 10 * 60_000
    const timeout = setTimeout(() => {
      if (!this.isRunning) return
      this.abortController?.abort()
      durableEventSink.emit({
        type: "error",
        error: `LLM request timed out after ${Math.round(timeoutMs / 60000)} minutes.`,
        fatal: true,
      })
    }, timeoutMs)

    try {
      // Capture one immutable integration generation for this turn. A loader
      // deadline is an explicit degraded-mode diagnostic, never a silent
      // disappearance of MCP, rules, or skills.
      const emitDependencyDiagnostic = (error: string): void => {
        durableEventSink.emit({ type: "error", error })
      }
      const MCP_FIRST_MESSAGE_TIMEOUT_MS = 2500
      const mcpP = settleRuntimeDependency(
        "MCP",
        (async () => {
          await this.mcpReconnectPromise
          await this.reconnectMcpServers(configForRun)
        })(),
        MCP_FIRST_MESSAGE_TIMEOUT_MS,
        undefined,
        emitDependencyDiagnostic,
      )
      const claudeCompatibility = getClaudeCompatibilityOptions(configForRun)
      const RULES_SKILLS_TIMEOUT_MS = 2000
      const rulesP = settleRuntimeDependency(
        "rules",
        loadAgentInstructionBundle(
          cwd,
          configForRun.rules.files,
          configForRun,
          claudeCompatibility,
        ),
        RULES_SKILLS_TIMEOUT_MS,
        "",
        emitDependencyDiagnostic,
      )
      const skillsP = settleRuntimeDependency(
        "skills",
        loadSkills(
          configForRun.skills,
          cwd,
          configForRun.skillsUrls,
          claudeCompatibility,
          configForRun,
        ),
        RULES_SKILLS_TIMEOUT_MS,
        [],
        emitDependencyDiagnostic,
      )
      const [, rulesContent, skills] = await Promise.all([
        mcpP,
        rulesP,
        skillsP,
      ])

      const toolRegistry = new ToolRegistry()
      const workspaceServices = this.workspaceRunServices.get(cwd)
      const servicesWithMcp = {
        ...workspaceServices,
        ...(this.mcpClient ? { mcpClient: this.mcpClient } : {}),
      }
      const resolvedMcpServers =
        await this.getResolvedMcpServers(configForRun)
      const allowedMcpServers = new Set(
        resolvedMcpServers
          .filter((server) => server.enabled !== false)
          .map((server) => server.name)
          .filter(
            (name): name is string =>
              typeof name === "string" &&
              name.trim().length > 0,
          ),
      )
      const preparedIntegrations =
        await prepareVsCodeRunIntegrations({
          cwd,
          authorityConfig: configForRun,
          services: servicesWithMcp,
          registry: toolRegistry,
          allowedMcpServerNames: allowedMcpServers,
        })
      this.toolContributionDiagnostics =
        projectToolContributionDiagnostics(
          cwd,
          preparedIntegrations.diagnostics,
        )
      if (this.toolContributionDiagnostics.length > 0) {
        this.postStateToWebview()
      }

      const runtimeConfig = await finalizeConfigCredentials(
        configForRun as unknown as Record<string, unknown>,
        this.secretsStore,
        {
          profileName: presetOverridesModel
            ? undefined
            : this.activeProfileName,
          environment: configEnvironment,
        },
      ) as unknown as NexusConfig
      const client = createLLMClient(runtimeConfig.model)
      const parallelManager =
        preparedIntegrations.services.parallelAgentManager
      for (const tool of [
        createSpawnAgentTool(parallelManager, runtimeConfig),
        createSpawnAgentOutputTool(parallelManager),
        createSpawnAgentStopTool(parallelManager),
        createSpawnAgentsParallelTool(parallelManager, runtimeConfig),
        createListAgentRunsTool(parallelManager),
        createAgentRunSnapshotTool(parallelManager),
        createResumeAgentTool(parallelManager, runtimeConfig),
      ]) {
        toolRegistry.registerDynamicOrThrow(tool, "manager compatibility")
      }
      for (const tool of [
        createTaskCreateBatchTool(parallelManager, runtimeConfig),
        createTaskSnapshotTool(parallelManager),
        createTaskResumeTool(parallelManager, runtimeConfig),
      ]) {
        toolRegistry.registerBoundBuiltinOrThrow(tool)
      }
      const { builtin, dynamic } = toolRegistry.getForMode(runMode)
      const allTools = toolRegistry.mergeWithHiddenExecutionTools([...builtin, ...dynamic])
      const compaction = createCompaction()
      if (configForRun.checkpoint.enabled && !this.checkpoint) {
        this.checkpoint = new CheckpointTracker(this.session.id, cwd)
        void this.checkpoint.init(configForRun.checkpoint.timeoutMs).catch(console.warn)
      }
      if (this.checkpoint) {
        host.setCheckpoint(this.checkpoint)
      }
      try {
        void this.refreshIndexerFromGit(cwd)
      } catch {
        // Git not available or not a repo — skip incremental refresh
      }
      await runAgentLoop({
        session: this.session,
        executionIdentity: {
          workspaceId: hashWorkspaceIdentity(
            await fsPromises.realpath(cwd).catch(() => path.resolve(cwd)),
          ),
          sessionId: this.session.id,
          turnId: `turn_${durableEventSink.runId}`,
          runId: durableEventSink.runId,
        },
        client,
        host,
        config: configForRun,
        services: preparedIntegrations.services,
        mode: runMode,
        tools: allTools,
        skills,
        rulesContent,
        indexer: this.indexer,
        compaction,
        signal: this.abortController!.signal,
        checkpoint: this.checkpoint,
        createSkillMode,
      })
    } catch (err) {
      const errMsg = (err as Error).message
      durableRunStatus = this.abortController?.signal.aborted ? "aborted" : "failed"
      if (errMsg !== "AbortError" && !errMsg.includes("aborted")) {
        console.error("[nexus] Agent loop error:", err)
        if (
          !fatalRunErrorEmitted ||
          fatalRunErrorEmitted !== errMsg
        ) {
          durableEventSink.emit({
            type: "error",
            error: errMsg,
            fatal: true,
          })
        }
      }
    } finally {
      clearTimeout(timeout)
      if (this.abortController?.signal.aborted) durableRunStatus = "aborted"
      await durableEventSink.finish(durableRunStatus).catch((error) => {
        console.error("[nexus] Failed to finalize durable local run:", error)
      })
      this.pendingWriteApprovalPreview = null
      this.isRunning = false
      await this.session!.save().catch(() => {})
      this.postStateToWebview()
      if (this.session && hadPlanExit(this.session)) {
        void this.showPlanFollowup(cwd).catch(() => {})
      }
    }
  }

  private async showPlanFollowup(cwd: string): Promise<void> {
    if (!this.session) return
    const planText = await getPlanContentForFollowup(this.session, cwd)
    const latest = this.getStateToPostToWebview()
    if (!latest.planCompleted || this.mode !== "plan") return
    this.postMessageToWebview({
      type: "stateUpdate",
      state: { ...latest, planFollowupText: planText },
    })
  }

  private getNexusRoot(): string | null {
    try {
      const root = path.resolve(this.context.extensionPath, "..", "..")
      const startPath = path.join(root, "sources", "claude-context-mode", "start.mjs")
      return fs.existsSync(startPath) ? root : null
    } catch {
      return null
    }
  }

  private async getResolvedMcpServers(config = this.config): Promise<McpServerConfig[]> {
    if (!config) return []
    const cwd = this.getCwd()
    const nexusRoot = this.getNexusRoot()
    const pluginMcp = await resolveConfiguredAndPluginMcpServers(cwd, config)
    return resolveBundledMcpServers(pluginMcp.servers, { cwd, nexusRoot })
  }

  private async getSlashCommandCatalog(
    options: {
      ensureRemoteSession?: boolean
      reportRemoteError?: boolean
    } = {},
  ): Promise<SlashCommandCatalogItem[]> {
    if (this.configurationError || this.disposed) return []
    const cwd = this.getCwd()
    const config = this.config
    const compatibility = config
      ? getClaudeCompatibilityOptions(config)
      : undefined
    const custom = await loadSlashCommands(
      cwd,
      compatibility,
      config,
    ).catch(() => [])
    const customCommands: SlashCommandCatalogItem[] = custom.map((command) => ({
      name: command.command,
      description: command.description.slice(0, 512),
      kind: "custom",
    }))
    let mcpCatalog: ReturnType<typeof getMcpPromptCommandCatalog> = []
    const serverUrl = this.getServerUrl()
    if (serverUrl) {
      try {
        const remote =
          this.serverSessionId
            ? {
                client: await this.createServerClient(cwd),
                sessionId: this.serverSessionId,
              }
            : options.ensureRemoteSession
              ? await this.ensureRemoteSession()
              : undefined
        if (remote) {
          const catalog = await remote.client.getMcpPromptCatalog(
            remote.sessionId,
          )
          if (
            this.getServerUrl() === serverUrl &&
            this.getCwd() === cwd &&
            this.serverSessionId === remote.sessionId
          ) {
            mcpCatalog = getRemoteMcpPromptCommandCatalog(catalog)
          }
        }
      } catch (error) {
        if (options.reportRemoteError) {
          const message =
            error instanceof Error ? error.message : String(error)
          this.postMessageToWebview({
            type: "agentEvent",
            event: {
              type: "error",
              error: `[mcp] Failed to load server prompt catalog: ${message}`,
            },
          })
        }
      }
    } else if (this.mcpClient) {
      mcpCatalog = getMcpPromptCommandCatalog(this.mcpClient)
    }
    const mcpCommands: SlashCommandCatalogItem[] = mcpCatalog.map(
      (command) => ({
        name: command.name,
        description: command.description.slice(0, 512),
        kind: "mcp",
        ...(command.argumentHint
          ? { argumentHint: command.argumentHint.slice(0, 4_096) }
          : {}),
      }),
    )
    const unique = new Map<string, SlashCommandCatalogItem>()
    const candidates = [...customCommands, ...mcpCommands].sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.name.localeCompare(right.name),
    )
    for (const command of candidates) {
      if (
        !command.name ||
        command.name.length > MAX_SLASH_COMMAND_NAME_CHARS ||
        unique.has(command.name)
      ) {
        continue
      }
      unique.set(command.name, command)
      if (unique.size >= MAX_SLASH_COMMAND_CATALOG_ITEMS) break
    }
    return [...unique.values()]
  }

  private async postSlashCommandCatalog(
    options: {
      ensureRemoteSession?: boolean
      reportRemoteError?: boolean
    } = {},
  ): Promise<void> {
    const generation = ++this.slashCommandCatalogGeneration
    const commands = await this.getSlashCommandCatalog(options)
    if (generation !== this.slashCommandCatalogGeneration) return
    this.postMessageToWebview({
      type: "slashCommandCatalog",
      commands,
    })
  }

  private async resolvePromptCommand(
    name: string,
    args: string,
    signal?: AbortSignal,
  ): Promise<PromptCommandResolution> {
    if (this.getServerUrl() && isMcpPromptCommandName(name)) {
      const remote = await this.ensureRemoteSession()
      return resolveRemoteMcpPromptCommand(
        remote.client,
        remote.sessionId,
        name,
        args,
        signal,
      )
    }
    if (!this.getServerUrl()) {
      await this.mcpReconnectPromise?.catch(() => undefined)
      await this.reconnectMcpServers(this.config)
      if (this.mcpClient) {
        const mcp = await resolveMcpPromptCommand(
          this.mcpClient,
          name,
          args,
          signal,
        )
        if (mcp.status !== "not-found") return mcp
      }
      if (isMcpPromptCommandName(name)) return { status: "not-found" }
    }

    const cwd = this.getCwd()
    const liveConfig = await this.loadHostConfig(cwd)
      .catch(() => this.config)
    const compatibility = liveConfig
      ? getClaudeCompatibilityOptions(liveConfig)
      : undefined
    const commands = await loadSlashCommands(
      cwd,
      compatibility,
      liveConfig,
    )
    const resolved = resolveSlashCommand(commands, name)
    if (resolved.status !== "resolved") return resolved
    return {
      status: "resolved",
      prompt: renderSlashCommandPrompt(resolved.command, args),
    }
  }

  private async reconnectMcpServers(config = this.config): Promise<void> {
    if (this.getServerUrl()) {
      await this.mcpClient?.disconnectAll().catch(() => {})
      this.mcpClient = undefined
      this.mcpConfigFingerprint = null
      void this.postSlashCommandCatalog().catch(() => undefined)
      return
    }
    if (!config) {
      void this.postSlashCommandCatalog().catch(() => undefined)
      return
    }
    const resolved = await this.getResolvedMcpServers(config)
    const fingerprint = JSON.stringify(resolved)
    const currentStatuses = this.mcpClient?.getServerStatuses() ?? {}
    const healthy =
      Object.keys(currentStatuses).length === resolved.length &&
      Object.values(currentStatuses).every(
        (status) => status.state === "connected" || status.state === "disabled",
      )
    if (this.mcpClient && this.mcpConfigFingerprint === fingerprint && healthy) {
      void this.postSlashCommandCatalog().catch(() => undefined)
      return
    }
    if (!this.mcpClient) {
      this.mcpClient = createVsCodeMcpClient(
        new VsCodeHost(this.getCwd(), () => {}),
      )
    }
    if (resolved.length === 0) {
      await this.mcpClient.connectAll([])
      this.mcpConfigFingerprint = fingerprint
      void this.postSlashCommandCatalog().catch(() => undefined)
      return
    }
    process.env.CLAUDE_PROJECT_DIR = this.getCwd()
    await this.mcpClient.connectAll(resolved).then(() => {
      this.mcpConfigFingerprint = fingerprint
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
    })
    const status = this.mcpClient.getServerStatuses()
    this.postMessageToWebview({
      type: "mcpServerStatus",
      results: resolved.map((s) => ({
        name: s.name,
        status: status[s.name]?.state === "connected" ? ("ok" as const) : ("error" as const),
        error:
          status[s.name]?.state === "connected"
            ? status[s.name]?.error
            : status[s.name]?.error ?? status[s.name]?.state ?? "Not connected",
      })),
    })
    void this.postSlashCommandCatalog().catch(() => undefined)
  }

  private async compactHistory(): Promise<void> {
    if (this.isRunning) {
      vscode.window.showInformationMessage(
        "NexusCode: Wait for the active turn to finish before compacting.",
      )
      return
    }
    if (this.configurationError) {
      this.postMessageToWebview({
        type: "agentEvent",
        event: { type: "error", error: this.configurationError },
      })
      return
    }
    if (!this.session || !this.config) return
    if (this.getServerUrl()) {
      vscode.window.showInformationMessage("NexusCode: Compaction is not supported when using NexusCode Server.")
      return
    }
    let live: NexusConfig
    try {
      live = await this.loadHostConfig()
    } catch (error) {
      this.setConfigurationLoadError(error)
      return
    }
    this.applyHostSelections(live)
    let selected = live
    let profileName = this.activeProfileName
    const preset = await this.getPresetByName(this.chatPresetName)
    if (preset) {
      const previousModel = selected.model
      selected = this.applyPresetFields(selected, preset)
      if (
        selected.model.provider !== previousModel.provider ||
        selected.model.id !== previousModel.id ||
        selected.model.baseUrl !== previousModel.baseUrl
      ) {
        profileName = undefined
      }
    }
    const runtime = await finalizeConfigCredentials(
      selected as unknown as Record<string, unknown>,
      this.secretsStore,
      {
        profileName,
        environment: getConfigEnvironment(live),
      },
    ) as unknown as NexusConfig
    const client = createLLMClient(runtime.model)
    const compaction = createCompaction()
    const abortController = new AbortController()
    this.abortController = abortController
    this.isRunning = true
    this.postMessageToWebview({ type: "agentEvent", event: { type: "compaction_start" } })
    this.postStateToWebview()
    try {
      const result = await compactSessionAndPersist({
        session: this.session,
        client,
        compaction,
        signal: abortController.signal,
        durableContext: {
          mode: this.mode,
          memoryCitations: [],
          taskIds: [],
        },
        projection: {
          cwd: this.getCwd(),
          config: runtime,
          orchestrationRuntime:
            this.workspaceRunServices.get(this.getCwd())
              .orchestrationRuntime,
        },
      })
      if (result.status === "failed") throw result.error
      if (result.status !== "compacted") {
        throw new Error(
          `Compaction did not produce a summary (${result.reason}).`,
        )
      }
      vscode.window.showInformationMessage(
        "NexusCode: Conversation compacted and saved.",
      )
    } catch (error) {
      this.postMessageToWebview({
        type: "agentEvent",
        event: {
          type: "error",
          error: `Compaction failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          fatal: false,
        },
      })
    } finally {
      if (this.abortController === abortController) {
        this.abortController = undefined
      }
      this.isRunning = false
      this.postMessageToWebview({ type: "agentEvent", event: { type: "compaction_end" } })
      this.postStateToWebview()
    }
  }

  async reindex(): Promise<void> {
    if (!this.indexer || !this.config) return
    try {
      await this.indexer.reindex()
    } catch (err) {
      console.warn("[nexus] Reindex error:", err)
    }
  }

  async clearIndex(): Promise<void> {
    if (!this.config || !this.config.indexing.enabled) return
    const cwd = this.getCwd()
    await this.initializeIndexer(cwd, { skipStartIndexing: true })
    await this.indexer?.deleteIndex?.()
    this.sendIndexStatus()
    this.postStateToWebview()
  }

  async fullRebuildIndex(): Promise<void> {
    await this.ensureInitialized()
    if (!this.indexer || !this.config) return
    try {
      await this.indexer.fullRebuildIndex?.()
    } catch (err) {
      console.warn("[nexus] fullRebuildIndex error:", err)
    }
  }

  async deleteIndexScope(relPathOrAbs: string): Promise<void> {
    await this.ensureInitialized()
    if (!this.indexer || !this.config?.indexing.enabled) return
    try {
      await this.indexer.deleteIndexScope?.(relPathOrAbs)
      this.sendIndexStatus()
      this.postStateToWebview()
    } catch (err) {
      console.warn("[nexus] deleteIndexScope error:", err)
    }
  }

  addToChat(text: string): void {
    this.postMessageToWebview({ type: "addToChatContent", content: text })
    vscode.commands.executeCommand("nexuscode.sidebar.focus").then(() => {}, () => {})
  }

  async runAgentWithPrompt(content: string, mode?: Mode): Promise<void> {
    await this.ensureInitialized()
    vscode.commands.executeCommand("nexuscode.sidebar.focus").then(() => {}, () => {})
    await this.runAgent(content, mode)
  }

  private sendIndexStatus(status?: IndexStatus): void {
    const s = status ?? this.indexer?.status() ?? { state: "idle" as const }
    this.postMessageToWebview({ type: "indexStatus", status: s })
  }

  private async sendSessionList(): Promise<void> {
    const serverUrl = this.getServerUrl()
    const cwd = this.getCwd()
    this.postMessageToWebview({ type: "sessionListLoading", loading: true })
    try {
      if (serverUrl) {
        try {
          const sessions = await (await this.createServerClient(cwd)).listSessions()
          this.postMessageToWebview({ type: "sessionList", sessions })
          return
        } catch (error) {
          this.reportServerError(error)
          this.postMessageToWebview({ type: "sessionList", sessions: [] })
          return
        }
      }
      const sessions = await listSessions(cwd).catch(() => [])
      this.postMessageToWebview({ type: "sessionList", sessions })
    } finally {
      this.postMessageToWebview({ type: "sessionListLoading", loading: false })
    }
  }

  private async loadOlderMessages(): Promise<void> {
    const serverUrl = this.getServerUrl()
    const cwd = this.getCwd()
    if (
      !this.session ||
      this.serverSessionOldestLoadedOffset == null ||
      this.serverSessionOldestLoadedOffset <= 0
    ) {
      return
    }
    const limit = Math.min(INITIAL_SERVER_MESSAGES, this.serverSessionOldestLoadedOffset)
    if (limit <= 0) return
    this.loadingOlderMessages = true
    this.postStateToWebview()
    try {
      const offset = Math.max(0, this.serverSessionOldestLoadedOffset - limit)
      let olderMessages: SessionMessage[] = []
      let localRevision = 0
      if (serverUrl) {
        if (this.session.id !== this.serverSessionId) return
        olderMessages = await (await this.createServerClient(cwd)).getMessages(
          this.session.id,
          { limit, offset },
        )
      } else {
        const loaded = await loadSessionMessages(this.session.id, cwd, limit, offset)
        if (!loaded) return
        olderMessages = loaded.messages
        localRevision = loaded.meta.revision
      }
      if (olderMessages.length === 0) return
      const existingIds = new Set(this.session.messages.map((msg) => msg.id))
      const dedupedOlder = olderMessages.filter((msg) => !existingIds.has(msg.id))
      if (dedupedOlder.length === 0) {
        this.serverSessionOldestLoadedOffset = offset
        return
      }
      this.session = new Session(
        this.session.id,
        cwd,
        [...dedupedOlder, ...this.session.messages],
        undefined,
        Boolean(serverUrl) || offset > 0,
        null,
        localRevision,
      )
      this.serverSessionOldestLoadedOffset = offset
      if (!serverUrl) this.localSessionWindowed = offset > 0
    } catch (error) {
      if (serverUrl) this.reportServerError(error)
    } finally {
      this.loadingOlderMessages = false
      this.postStateToWebview()
    }
  }

  private async switchSession(sessionId: string): Promise<void> {
    if (this.isRunning) {
      vscode.window.showWarningMessage(
        "NexusCode: Stop the current run before switching sessions.",
      )
      return
    }
    this.lastRunMode = null
    this.forcedRemoteModeForNextRun = null
    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()
    if (serverUrl) {
      try {
        const client = await this.createServerClient(cwd)
        const meta = await client.getSession(sessionId)
        const offset = Math.max(0, meta.messageCount - INITIAL_SERVER_MESSAGES)
        const messages = await client.getMessages(sessionId, {
          limit: INITIAL_SERVER_MESSAGES,
          offset,
        })
        this.session = new Session(sessionId, cwd, messages, undefined, true)
        if (meta.mode) this.session.setMode(meta.mode)
        this.mode = getSessionModeForResume(this.session, this.mode)
        this.serverSessionId = sessionId
        await this.getRemoteWorkspaceState(cwd)
          .setSelectedSessionId(sessionId)
        this.serverSessionOldestLoadedOffset = offset
        this.localSessionWindowed = false
        this.pendingQuestionRequest = null
        this.checkpoint = undefined
        this.postStateToWebview()
        void this.postSlashCommandCatalog().catch(() => undefined)
        void this.resumeRemoteTurnIfActive().catch(() => undefined)
      } catch (error) {
        this.reportServerError(error)
      }
      return
    }
    const meta = await getSessionMeta(sessionId, cwd)
    if (!meta) return
    const offset = Math.max(0, meta.messageCount - INITIAL_SERVER_MESSAGES)
    const loaded = await Session.resumeWindow(sessionId, cwd, INITIAL_SERVER_MESSAGES, offset)
    if (loaded) {
      this.session = loaded
      this.mode = getSessionModeForResume(loaded, this.mode)
      await this.setSelectedLocalSessionId(sessionId, cwd)
      this.sessionUnacceptedEdits = []
      this.changeSetReviewSessionId = null
      this.serverSessionId = undefined
      this.serverSessionOldestLoadedOffset = offset
      this.localSessionWindowed = offset > 0
      this.pendingQuestionRequest = null
      this.checkpoint = undefined
      this.postStateToWebview()
    }
  }

  private async createNewSession(): Promise<void> {
    if (this.isRunning) {
      vscode.window.showWarningMessage(
        "NexusCode: Stop the current run before creating a new session.",
      )
      return
    }
    this.lastRunMode = null
    this.forcedRemoteModeForNextRun = null
    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()
    if (serverUrl) {
      try {
        const created = await (await this.createServerClient(cwd)).createSession()
        this.session = new Session(created.id, cwd, [], undefined, true)
        this.serverSessionId = created.id
        await this.getRemoteWorkspaceState(cwd)
          .setSelectedSessionId(created.id)
        this.serverSessionOldestLoadedOffset = undefined
      } catch (error) {
        this.reportServerError(error)
        return
      }
    } else {
      this.session = Session.create(cwd)
      await this.session.save()
      await this.setSelectedLocalSessionId(this.session.id, cwd)
      this.serverSessionId = undefined
    }
    this.sessionUnacceptedEdits = []
    this.changeSetReviewSessionId = null
    this.serverSessionOldestLoadedOffset = undefined
    this.localSessionWindowed = false
    this.pendingQuestionRequest = null
    this.checkpoint = undefined
    this.lastContextUsage = null
    this.postStateToWebview()
    void this.postSlashCommandCatalog().catch(() => undefined)
    await this.sendSessionList()
  }

  private async deleteSession(sessionId: string): Promise<void> {
    if (this.isRunning && this.session?.id === sessionId) {
      vscode.window.showWarningMessage(
        "NexusCode: Stop the current run before deleting its session.",
      )
      return
    }
    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()
    let deleted = false
    if (serverUrl) {
      try {
        deleted = await (await this.createServerClient(cwd)).deleteSession(sessionId)
        if (deleted) {
          await this.getRemoteWorkspaceState(cwd).clear(sessionId)
        }
      } catch (error) {
        this.reportServerError(error)
        return
      }
    } else {
      deleted = await deleteSession(sessionId, cwd)
    }
    if (deleted && this.session?.id === sessionId) {
      if (serverUrl) {
        try {
          const created = await (await this.createServerClient(cwd)).createSession()
          this.session = new Session(created.id, cwd, [], undefined, true)
          this.serverSessionId = created.id
          await this.getRemoteWorkspaceState(cwd)
            .setSelectedSessionId(created.id)
          this.serverSessionOldestLoadedOffset = undefined
        } catch (error) {
          this.reportServerError(error)
          return
        }
      } else {
        this.session = Session.create(cwd)
        await this.session.save()
        await this.setSelectedLocalSessionId(this.session.id, cwd)
        this.serverSessionId = undefined
      }
      this.checkpoint = undefined
      this.postStateToWebview()
      void this.postSlashCommandCatalog().catch(() => undefined)
    }
    await this.sendSessionList()
  }

  private applyVscodeOverrides(config: NexusConfig): void {
    const cfg = vscode.workspace.getConfiguration("nexuscode")
    const getExplicitValue = <T>(key: string): T | undefined => {
      const inspected = cfg.inspect<T>(key)
      if (!inspected) return undefined
      return (
        inspected.workspaceFolderValue ??
        inspected.workspaceValue ??
        inspected.globalValue
      )
    }
    const getHostAuthorityValue = <T>(key: string): T | undefined => {
      const inspected = cfg.inspect<T>(key)
      return inspected?.globalValue
    }
    applyExplicitConfigOverrides(
      config,
      getExplicitValue,
      getHostAuthorityValue,
    )
  }

  private applyHostSelections(config: NexusConfig): void {
    this.applyVscodeOverrides(config)
    this.defaultModelProfile = { ...config.model }
    const profileName = this.activeProfileName?.trim()
    if (!profileName) return
    const profile = config.profiles[profileName]
    if (!profile) {
      this.activeProfileName = undefined
      return
    }
    config.model = selectProviderProfile(this.defaultModelProfile, profile)
  }

  private async migrateLegacyPlaintextSecrets(cwd: string): Promise<void> {
    const resource = vscode.Uri.file(cwd)
    const cfg = vscode.workspace.getConfiguration("nexuscode", resource)
    const model = selectLegacySetting(cfg.inspect<string>("apiKey"))
    const embeddings = selectLegacySetting(cfg.inspect<string>("embeddingsApiKey"))
    const autocomplete = selectLegacySetting(
      cfg.inspect<string>("autocomplete.apiKey"),
    )

    if (model || embeddings) {
      const existing = await this.context.secrets.get(
        NEXUS_SECRETS_STORAGE_KEY,
      )
      const merged = mergeLegacyNexusSecrets(existing, { model, embeddings })
      if (merged !== existing) {
        await this.context.secrets.store(NEXUS_SECRETS_STORAGE_KEY, merged)
      }
    }

    const existingAutocomplete = (
      await this.context.secrets.get(AUTOCOMPLETE_API_KEY_SECRET)
    )?.trim()
    if (!existingAutocomplete && autocomplete) {
      await this.context.secrets.store(
        AUTOCOMPLETE_API_KEY_SECRET,
        autocomplete,
      )
    }
    this.autocompleteApiKeyConfigured = Boolean(
      existingAutocomplete || autocomplete,
    )

    await this.clearLegacySecretSetting("apiKey")
    await this.clearLegacySecretSetting("embeddingsApiKey")
    await this.clearLegacySecretSetting("autocomplete.apiKey")
  }

  private async clearLegacySecretSetting(key: string): Promise<void> {
    let failed = false
    const clearConfiguredScopes = async (
      cfg: vscode.WorkspaceConfiguration,
      includeSharedScopes: boolean,
    ): Promise<void> => {
      const inspected = cfg.inspect<string>(key)
      if (!inspected) return
      const clear = async (target: vscode.ConfigurationTarget): Promise<void> => {
        try {
          await cfg.update(key, undefined, target)
        } catch {
          failed = true
        }
      }
      if (includeSharedScopes && inspected.globalValue !== undefined) {
        await clear(vscode.ConfigurationTarget.Global)
      }
      if (includeSharedScopes && inspected.workspaceValue !== undefined) {
        await clear(vscode.ConfigurationTarget.Workspace)
      }
      if (inspected.workspaceFolderValue !== undefined) {
        await clear(vscode.ConfigurationTarget.WorkspaceFolder)
      }
    }

    await clearConfiguredScopes(
      vscode.workspace.getConfiguration("nexuscode"),
      true,
    )
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await clearConfiguredScopes(
        vscode.workspace.getConfiguration("nexuscode", folder.uri),
        false,
      )
    }
    if (failed) {
      vscode.window.showWarningMessage(
        `NexusCode migrated the legacy ${key} secret, but could not remove every plaintext setting. Remove it manually from settings.json.`,
      )
    }
  }

  private postConfigToWebview(): void {
    if (!this.config) return
    const safeConfig = stripSecretsFromConfig(
      this.config as unknown as Record<string, unknown>,
    ) as unknown as NexusConfig
    this.postMessageToWebview({ type: "configLoaded", config: safeConfig })
  }

  private queueIndexerRefresh(fsPath: string): void {
    this.indexerWatcherPending.add(fsPath)
    if (this.indexerWatcherDebounceTimer) clearTimeout(this.indexerWatcherDebounceTimer)
    this.indexerWatcherDebounceTimer = setTimeout(() => {
      this.indexerWatcherDebounceTimer = undefined
      const paths = [...this.indexerWatcherPending]
      this.indexerWatcherPending.clear()
      if (paths.length === 0) return
      const ix = this.indexer
      if (!ix) return
      if (ix.refreshFilesBatchNow) void ix.refreshFilesBatchNow(paths)
      else void Promise.all(paths.map((p) => ix.refreshFile(p)))
    }, INDEX_FILE_WATCHER_DEBOUNCE_MS)
  }

  private async initializeIndexer(cwd: string, opts?: { skipStartIndexing?: boolean }): Promise<void> {
    this.indexerWatcherPending.clear()
    if (this.indexerWatcherDebounceTimer) {
      clearTimeout(this.indexerWatcherDebounceTimer)
      this.indexerWatcherDebounceTimer = undefined
    }
    this.indexStatusUnsubscribe?.()
    this.indexStatusUnsubscribe = undefined
    this.indexerFileWatcher?.dispose()
    this.indexerFileWatcher = undefined
    await this.indexer?.closeAndWait()
    this.indexer = undefined
    if (this.getServerUrl()) {
      this.sendIndexStatus({ state: "idle" })
      return
    }
    if (
      !this.config?.indexing.enabled ||
      !this.config.indexing.vector ||
      !this.config.vectorDb?.enabled
    ) {
      this.sendIndexStatus({ state: "idle" })
      return
    }
    const runtimeConfig = await finalizeConfigCredentials(
      this.config as unknown as Record<string, unknown>,
      this.secretsStore,
      {
        profileName: this.activeProfileName,
        environment: getConfigEnvironment(this.config),
      },
    ) as unknown as NexusConfig
    // Same as server run-session: short timeout so first message is not delayed (Qdrant default is 20s).
    const INDEXER_CREATE_TIMEOUT_MS = 2500
    this.indexer = await Promise.race([
      createCodebaseIndexer(cwd, runtimeConfig, {
        onWarning: (message: string) => console.warn(message),
        onProgress: (message: string) => {
          this.postMessageToWebview({ type: "agentEvent", event: { type: "vector_db_progress", message } })
        },
        maxQdrantWaitMs: INDEXER_CREATE_TIMEOUT_MS,
        listAbsolutePaths: listAbsolutePathsRipgrep,
      }),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), INDEXER_CREATE_TIMEOUT_MS)),
    ])
    if (!this.indexer) {
      console.warn("[nexus] Indexer creation timed out; running without vector search.")
      this.sendIndexStatus({ state: "idle" })
      this.postMessageToWebview({ type: "agentEvent", event: { type: "vector_db_ready" } })
      return
    }
    this.postMessageToWebview({ type: "agentEvent", event: { type: "vector_db_ready" } })
    // Only `indexStatus` messages update the webview store. Do not mirror via `agentEvent` / `index_update`:
    // agent events are applied in a deferred RAF batch and can reorder after immediate `indexStatus`, wiping
    // fields like `paused` and making Pause/Resume labels disagree with the progress line.
    this.indexStatusUnsubscribe = this.indexer.onStatusChange((status: IndexStatus) => {
      this.sendIndexStatus(status)
    })
    if (!opts?.skipStartIndexing) {
      this.indexer.startIndexing().catch((err: unknown) => console.warn("[nexus] Indexer start error:", err))
    }

    const watcherGlob = buildIndexWatcherGlobPattern(Boolean(this.config.indexing.vector))
    const pattern = new vscode.RelativePattern(vscode.Uri.file(cwd), watcherGlob)
    const watcher = vscode.workspace.createFileSystemWatcher(pattern)
    watcher.onDidChange((uri) => this.queueIndexerRefresh(uri.fsPath))
    watcher.onDidCreate((uri) => this.queueIndexerRefresh(uri.fsPath))
    watcher.onDidDelete((uri) => this.indexer?.refreshFileNow(uri.fsPath))
    this.indexerFileWatcher = watcher
  }

  private async refreshIndexerFromGit(cwd: string): Promise<void> {
    if (!this.indexer?.refreshFileNow) return
    const { execa } = await import("execa")
    const runGit = async (args: string[]): Promise<string> => {
      const res = await execa("git", ["-C", cwd, ...args], { reject: false, timeout: 4000 })
      if (res.exitCode !== 0) return ""
      return (res.stdout ?? "").trim()
    }
    const [changedTracked, changedStaged, untracked, deletedTracked, deletedStaged] = await Promise.all([
      runGit(["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"]),
      runGit(["diff", "--name-only", "--cached", "--diff-filter=ACMRTUXB"]),
      runGit(["ls-files", "--others", "--exclude-standard"]),
      runGit(["diff", "--name-only", "--diff-filter=D", "HEAD"]),
      runGit(["diff", "--name-only", "--cached", "--diff-filter=D"]),
    ])
    const changed = new Set<string>()
    const deleted = new Set<string>()
    for (const line of [changedTracked, changedStaged, untracked].join("\n").split(/\r?\n/)) {
      const p = line.trim()
      if (p) changed.add(p)
    }
    for (const line of [deletedTracked, deletedStaged].join("\n").split(/\r?\n/)) {
      const p = line.trim()
      if (p) deleted.add(p)
    }
    const all = [...changed, ...deleted].slice(0, 512)
    const batch = this.indexer.refreshFilesBatchNow
    if (batch) {
      for (let i = 0; i < all.length; i += 16) {
        const chunk = all.slice(i, i + 16).map((relPath) => path.resolve(cwd, relPath))
        await batch.call(this.indexer, chunk)
      }
    } else {
      for (let i = 0; i < all.length; i += 16) {
        const chunk = all.slice(i, i + 16)
        await Promise.allSettled(
          chunk.map((relPath) => this.indexer!.refreshFileNow!(path.resolve(cwd, relPath)))
        )
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.abortController?.abort()
    this.approvalResolveRef.current?.resolve({ approved: false })
    this.skillDefinitionsLoadGeneration += 1
    this.slashCommandCatalogGeneration += 1
    void this.workspaceRunServices.close().catch((error: unknown) => {
      console.error("[nexus] Failed to close workspace run services:", error)
    })
    this.marketplaceService.dispose()
    this.indexerWatcherPending.clear()
    if (this.indexerWatcherDebounceTimer) {
      clearTimeout(this.indexerWatcherDebounceTimer)
      this.indexerWatcherDebounceTimer = undefined
    }
    this.indexStatusUnsubscribe?.()
    this.indexerFileWatcher?.dispose()
    this.indexerFileWatcher = undefined
    this.indexer?.close()
    this.indexer = undefined
    this.mcpClient?.disconnectAll().catch(() => {})
    this.mcpClient = undefined
    this.mcpConfigFingerprint = null
    for (const d of this.disposables) {
      d.dispose()
    }
    this.disposables = []
    this.initialized = false
    this.initPromise = undefined
  }
}

function deepMergeInto<T extends Record<string, unknown>>(target: T, patch: Partial<T>): T {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = target[key as keyof T]
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      deepMergeInto(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      (target as Record<string, unknown>)[key] = value as unknown
    }
  }
  return target
}

function hasExplicitCredentialInput(
  patch: Record<string, unknown>,
): boolean {
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false
    if (Array.isArray(value)) return value.some(visit)
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (
        key.toLowerCase().replace(/[^a-z0-9]/g, "") === "apikey" &&
        typeof entry === "string" &&
        entry.trim()
      ) {
        return true
      }
      if (visit(entry)) return true
    }
    return false
  }
  return ["model", "embeddings", "vectorDb", "profiles"].some((section) =>
    visit(patch[section]),
  )
}

type AgentPresetForExtension = {
  name: string
  vector: boolean
  skills: string[]
  mcpServers: string[]
  rulesFiles: string[]
  modelProvider?: string
  modelId?: string
}

function normalizeAgentPresetForExtension(value: unknown): AgentPresetForExtension | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name) return null
  return {
    name,
    modelProvider: typeof raw.modelProvider === "string" ? raw.modelProvider : undefined,
    modelId: typeof raw.modelId === "string" ? raw.modelId : undefined,
    vector: Boolean(raw.vector),
    skills: asStringList(raw.skills),
    mcpServers: asStringList(raw.mcpServers),
    rulesFiles: asStringList(raw.rulesFiles),
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of value) {
    if (typeof v !== "string") continue
    const s = v.trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

function dedupeStringList(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of items) {
    const t = s.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

async function walkSkillFilesForExtension(rootDir: string, maxDepth: number): Promise<string[]> {
  if (maxDepth < 0) return []
  let entries: fs.Dirent[]
  try {
    entries = await fsPromises.readdir(rootDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      const nested = await walkSkillFilesForExtension(fullPath, maxDepth - 1)
      out.push(...nested)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.toLowerCase() === "skill.md") out.push(fullPath)
  }
  return out
}

function toDisplayPathForExtension(filePath: string, projectDir: string): string {
  if (path.isAbsolute(filePath) && filePath.startsWith(projectDir)) {
    return path.relative(projectDir, filePath) || filePath
  }
  return filePath
}

async function discoverSkillPathsForExtension(projectDir: string): Promise<string[]> {
  const home = path.resolve(process.env.HOME || os.homedir())
  const roots = [path.join(projectDir, ".nexus", "skills"), path.join(home, ".nexus", "skills")]
  const files: string[] = []
  for (const root of roots) {
    const fromRoot = await walkSkillFilesForExtension(root, 5)
    files.push(...fromRoot)
  }
  const normalized = dedupeStringList(files.map((f) => toDisplayPathForExtension(f, projectDir)))
  return normalized
}

async function discoverRuleFilesForExtension(projectDir: string): Promise<string[]> {
  const names = ["NEXUS.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md"]
  const out: string[] = []
  const visited = new Set<string>()
  let current = path.resolve(projectDir)
  const home = path.resolve(os.homedir())
  while (true) {
    if (visited.has(current)) break
    visited.add(current)
    for (const name of names) {
      for (const file of [path.join(current, name), path.join(current, ".nexus", name)]) {
        try {
          const stat = await fsPromises.stat(file)
          if (stat.isFile()) out.push(file)
        } catch {
          // skip
        }
      }
    }
    if (current === path.dirname(current) || current === home) break
    current = path.dirname(current)
  }
  for (const name of names) {
    for (const file of [path.join(home, name), path.join(home, ".nexus", name)]) {
      try {
        const stat = await fsPromises.stat(file)
        if (stat.isFile()) out.push(file)
      } catch {
        // skip
      }
    }
  }
  return dedupeStringList(out)
}

/** Discover MCP server names from project .nexus/mcp-servers.json and ~/.nexus/mcp-servers.json (same sources as config merge). */
async function discoverMcpServerNamesForExtension(projectDir: string): Promise<string[]> {
  const names: string[] = []
  const readJson = async (filePath: string): Promise<string[]> => {
    try {
      const content = await fsPromises.readFile(filePath, "utf8")
      const data = JSON.parse(content)
      const servers = Array.isArray(data) ? data : (data?.servers ?? data?.mcp?.servers)
      if (!Array.isArray(servers)) return []
      return servers
        .map((s: unknown) => (s && typeof s === "object" && "name" in s && typeof (s as { name: unknown }).name === "string" ? (s as { name: string }).name.trim() : ""))
        .filter((n: string) => n.length > 0)
    } catch {
      return []
    }
  }
  const projectPath = path.join(projectDir, ".nexus", "mcp-servers.json")
  const globalPath = path.join(os.homedir(), ".nexus", "mcp-servers.json")
  const [fromProject, fromGlobal] = await Promise.all([readJson(projectPath), readJson(globalPath)])
  names.push(...fromProject, ...fromGlobal)
  return dedupeStringList(names)
}

async function writeAgentPresetsForExtension(
  projectDir: string,
  presets: Array<{ name: string; vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string }>
): Promise<void> {
  const dir = path.join(projectDir, ".nexus")
  const filePath = path.join(dir, "agent-configs.json")
  await fsPromises.mkdir(dir, { recursive: true })
  await fsPromises.writeFile(filePath, JSON.stringify({ presets }, null, 2), "utf8")
}
