/**
 * Controller — Cline-style single owner of task/session state and agent run.
 * Owns session, config, run state, and posts state/events to webview via postMessage.
 */

import * as vscode from "vscode"
import * as path from "path"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { promises as fsPromises } from "node:fs"
import * as os from "node:os"
import {
  formatQuestionnaireAnswersForAgent,
  type AgentEvent,
  type NexusConfig,
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
  type McpServerConfig,
} from "@nexuscode/core"
import {
  loadConfig,
  writeConfig,
  writeGlobalProfiles,
  loadProjectSettings,
  persistSecretsFromConfig,
  Session,
  listSessions,
  deleteSession,
  getSessionMeta,
  loadSessionMessages,
  createLLMClient,
  ToolRegistry,
  loadSkills,
  loadRules,
  McpClient,
  setMcpClientInstance,
  resolveBundledMcpServers,
  testMcpServers,
  createCompaction,
  ParallelAgentManager,
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
  setParallelAgentManager,
  runAgentLoop,
  CheckpointTracker,
  CodebaseIndexer,
  createCodebaseIndexer,
  buildIndexWatcherGlobPattern,
  ensureQdrantRunning,
  NexusConfigSchema,
  getModelsCatalog,
  hadPlanExit,
  getPlanContentForFollowup,
  NexusServerClient,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  INDEX_FILE_WATCHER_DEBOUNCE_MS,
  canonicalProjectRoot,
  computeContextUsageMetrics,
  estimateToolsDefinitionsTokens,
  getAllBuiltinTools,
  getClaudeCompatibilityOptions,
  loadSlashCommands,
  renderSlashCommandPrompt,
} from "@nexuscode/core"
import { VsCodeHost, showSessionEditDiff, openReadonlyTextDiff } from "./host.js"
import { MarketplaceService, type MarketplaceItem } from "./services/marketplace/index.js"
import { listAbsolutePathsRipgrep } from "./services/indexing/list-absolute-paths-rg.js"

const MODE_REMINDER_REGEX = /^\[You are now in [^\]]+\.\]\s*\n?\n?/i
const THOUGHT_PLACEHOLDER = "Model reasoning is active, but the provider has not streamed visible reasoning text yet."

function isDelegatedAgentToolEvent(tool: string, input?: Record<string, unknown>): boolean {
  if (tool === "TaskCreateBatch" || tool === "SpawnAgent" || tool === "SpawnAgents" || tool === "SpawnAgentsParallel") return true
  if (tool === "TaskCreate") {
    const kind = typeof input?.kind === "string" ? input.kind : "tracking"
    return kind === "agent"
  }
  return false
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
const FILE_WRITE_TOOL_NAMES = new Set(["Write", "Edit", "write_to_file", "replace_in_file"])
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

export type WebviewMessage =
  | { type: "newMessage"; content: string; mode: Mode; mentions?: string; images?: Array<{ data: string; mimeType: string }>; presetName?: string }
  | { type: "abort" }
  | { type: "compact" }
  | { type: "clearChat" }
  | { type: "setMode"; mode: Mode }
  | { type: "setProfile"; profile: string }
  | { type: "getState" }
  | { type: "webviewDidLaunch" }
  | { type: "openSettings" }
  | { type: "saveConfig"; config: Partial<NexusConfig> }
  | { type: "switchSession"; sessionId: string }
  | { type: "createNewSession" }
  | { type: "forkSession"; messageId: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "reindex" }
  | { type: "clearIndex" }
  | { type: "fullRebuildIndex" }
  | { type: "pauseIndexing" }
  | { type: "resumeIndexing" }
  | { type: "openFileAtLocation"; path: string; line?: number; endLine?: number }
  | { type: "showDiff"; path: string }
  | { type: "setServerUrl"; url: string }
  | { type: "openNexusConfigFolder"; scope: "global" | "project" }
  | { type: "openCursorignore" }
  | { type: "openMcpConfig" }
  | { type: "testMcpServers" }
  | { type: "openSkillFolder"; path: string }
  | { type: "approvalResponse"; partId: string; approved: boolean; alwaysApprove?: boolean; addToAllowedCommand?: string; skipAll?: boolean; whatToDoInstead?: string }
  | { type: "openExternal"; url: string }
  | { type: "showConfirm"; id: string; message: string }
  | { type: "openNexusignore" }
  | { type: "getModelsCatalog" }
  | { type: "restoreCheckpoint"; hash: string; restoreType: "task" | "workspace" | "taskAndWorkspace" }
  | { type: "showCheckpointDiff"; fromHash: string; toHash?: string }
  | { type: "getAgentPresets" }
  | { type: "getAgentPresetOptions" }
  | { type: "createAgentPreset"; preset: { name: string; vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string } }
  | { type: "deleteAgentPreset"; presetName: string }
  | { type: "applyAgentPreset"; presetName: string }
  | { type: "planFollowupChoice"; choice: "implement" | "revise" | "dismiss"; planText?: string; instruction?: string; newSession?: boolean }
  | { type: "dismissQuestionnaire"; requestId: string }
  | { type: "questionnaireResponse"; requestId: string; answers: UserQuestionAnswer[] }
  | { type: "loadOlderMessages" }
  | { type: "rollbackToBeforeMessage"; messageId: string }
  | { type: "startOrConnectVectorDb"; url: string; autoStart?: boolean }
  | { type: "openSessionEditDiff"; path: string }
  | { type: "undoSessionEdits" }
  | { type: "keepAllSessionEdits" }
  | { type: "revertSessionEditFile"; path: string }
  | { type: "acceptSessionEditFile"; path: string }
  | { type: "slashCommand"; command: string }
  | { type: "setChatPreset"; presetName: string }
  | {
      type: "fetchMarketplaceData"
      /** When false, skip SkillNet (e.g. MCP-only tab). Default: fetch skills. */
      includeSkills?: boolean
      skillSearchQuery?: string
      skillSearchMode?: "keyword" | "vector"
      skillPage?: number
      skillCategory?: string
      skillVectorThreshold?: number
      /** When true, skip extension cache and refetch catalogs (Refresh button). */
      forceRefresh?: boolean
    }
  | {
      type: "installMarketplaceItem"
      mpItem: MarketplaceItem
      mpInstallOptions: { target?: "global" | "project"; parameters?: Record<string, unknown> }
    }
  | {
      type: "removeInstalledMarketplaceItem"
      mpItem: MarketplaceItem
      mpInstallOptions: { target: "global" | "project" }
    }
  | {
      type: "setAutocompleteExtensionSettings"
      patch: Partial<{
        enableAutoTrigger: boolean
        useSeparateModel: boolean
        modelProvider: string
        modelId: string
        modelApiKey: string
        modelBaseUrl: string
        modelTemperature: string
        modelReasoningEffort: string
        modelContextWindow: string
      }>
    }

export type ExtensionMessage =
  | { type: "stateUpdate"; state: WebviewState }
  | { type: "agentEvent"; event: AgentEvent }
  | { type: "sessionList"; sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> }
  | { type: "sessionListLoading"; loading: boolean }
  | { type: "indexStatus"; status: IndexStatus }
  | { type: "configLoaded"; config: NexusConfig }
  | { type: "skillDefinitions"; definitions: Array<{ name: string; path: string; summary: string }> }
  | { type: "addToChatContent"; content: string }
  | { type: "action"; action: "switchView"; view: "chat" | "sessions" | "settings"; settingsTab?: "llm" | "embeddings" | "index" | "tools" | "integrations" | "presets"; settingsIntegTab?: "rules-skills" | "mcp" | "rules-instructions" }
  | { type: "mcpServerStatus"; results: Array<{ name: string; status: "ok" | "error"; error?: string }> }
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

export type ServerConnectionState = "idle" | "connecting" | "streaming" | "error"

/** Inline autocomplete UI (backed by nexuscode.autocomplete.* VS Code settings). */
export interface AutocompleteExtensionUiState {
  enableAutoTrigger: boolean
  useSeparateModel: boolean
  modelProvider: string
  modelId: string
  modelApiKey: string
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
  serverUrl?: string
  /** When using server: connection state for UI indicator and retry. */
  connectionState?: ServerConnectionState
  /** When connectionState === "error": message to show and trigger retry. */
  serverConnectionError?: string
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
  sessionUnacceptedEdits?: Array<{ path: string; diffStats: { added: number; removed: number }; isNewFile?: boolean }>
  pendingQuestionRequest?: UserQuestionRequest | null
  /** Active preset name for the chat (per-message scoping for skills + MCP). */
  activePresetName?: string
  /** Inline editor autocomplete: master toggle + optional separate model (VS Code settings). */
  autocompleteExtension: AutocompleteExtensionUiState
}

function simpleDiffStats(originalContent: string, newContent: string): { added: number; removed: number } {
  const a = originalContent.split(/\r?\n/)
  const b = newContent.split(/\r?\n/)
  const setA = new Set(a)
  const setB = new Set(b)
  let removed = 0
  let added = 0
  for (const line of a) if (!setB.has(line)) removed++
  for (const line of b) if (!setA.has(line)) added++
  return { added, removed }
}

export class Controller {
  private session?: Session
  private config?: NexusConfig
  private stateUpdateSeq = 0
  private defaultModelProfile?: NexusConfig["model"]
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
  private serverSessionId?: string
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
  private modelsCatalogCache: import("@nexuscode/core").ModelsCatalog | null = null
  private indexStatusUnsubscribe?: () => void
  private indexerFileWatcher?: vscode.Disposable
  /** Debounced paths for batched incremental reindex (see INDEX_FILE_WATCHER_DEBOUNCE_MS). */
  private indexerWatcherPending = new Set<string>()
  private indexerWatcherDebounceTimer: ReturnType<typeof setTimeout> | undefined
  private disposables: vscode.Disposable[] = []
  private readonly marketplaceService = new MarketplaceService()
  private onAutocompleteConfigReady?: () => void
  private approvalResolveRef: { current: ((r: PermissionResult) => void) | null } = { current: null }
  /** VS Code Secret Storage for API keys (keys not stored in YAML). */
  private readonly secretsStore = {
    getSecret: async (key: string) => this.context.secrets.get(key),
    setSecret: async (key: string, value: string) => this.context.secrets.store(key, value),
  }
  /** Session unaccepted edits: full content for revert/diff; cleared on session change. */
  private sessionUnacceptedEdits: Array<{ path: string; originalContent: string; newContent: string; diffStats: { added: number; removed: number }; isNewFile: boolean }> = []
  /** Active host for the running local loop; used for pending write/edit previews before approval. */
  private activeRunHost: VsCodeHost | null = null
  /** Server-stream shadow state: remembers latest SpawnAgent tool so subagent events can attach even before final server snapshot arrives. */
  private streamLastSpawnAgentPartId: string | null = null
  /** Last context_usage from agent loop (includes system prompt tokens). Used in getStateToPostToWebview so stateUpdate does not overwrite with session-only count. */
  private lastContextUsage: { usedTokens: number; limitTokens: number; percent: number; sessionId: string } | null = null
  /** Coalesce frequent state snapshots during agent streaming to avoid UI thrash. */
  private statePostTimer: ReturnType<typeof setTimeout> | null = null
  /** True when a local session was opened as a recent-message window instead of fully loaded. */
  private localSessionWindowed = false
  /** Pending structured questionnaire requested by AskFollowupQuestion. */
  private pendingQuestionRequest: UserQuestionRequest | null = null
  private cwdOverride: string | null = null

  private normalizePathKey(filePath: string, cwd: string): string {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
    return path.normalize(absPath).replace(/\\/g, "/")
  }

  private async revertDirtyWorkspaceDocs(cwd: string): Promise<void> {
    const cwdResolved = path.resolve(cwd)
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== "file") continue
      const rel = path.relative(cwdResolved, doc.uri.fsPath)
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue
      if (!doc.isDirty) continue
      try {
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false })
        await vscode.commands.executeCommand("workbench.action.files.revert")
      } catch {
        // Ignore per-doc revert errors
      }
    }
  }

  private async openWorkspaceFile(cwd: string, filePath: string): Promise<void> {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
    const wf = vscode.workspace.workspaceFolders?.[0]
    const relPath = path.relative(cwd, absPath).replace(/\\/g, "/")
    const uri =
      wf && !(relPath.startsWith("..") || path.isAbsolute(relPath))
        ? vscode.Uri.joinPath(wf.uri, relPath)
        : vscode.Uri.file(absPath)
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

  private extractUserMessageText(message: SessionMessage): string {
    if (typeof message.content === "string") {
      return message.content.replace(/\s+/g, " ").trim()
    }
    if (!Array.isArray(message.content)) return ""
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text?: string }).text ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
  }

  private selectRollbackCheckpointEntry(
    entries: CheckpointEntry[],
    messages: SessionMessage[],
    target: SessionMessage,
    targetIndex: number
  ): CheckpointEntry | undefined {
    if (entries.length === 0) return undefined
    const reversed = [...entries].reverse()
    const exact = reversed.find((entry) => entry.messageId === target.id)
    if (exact) return exact

    const nextUserMessage = messages.slice(targetIndex + 1).find((m) => m.role === "user")
    const windowUpperTs = nextUserMessage?.ts ?? Number.POSITIVE_INFINITY
    const forwardInWindow = entries.find((entry) => entry.ts >= target.ts && entry.ts < windowUpperTs)
    if (forwardInWindow) return forwardInWindow

    const fallbackByTime = reversed.find((entry) => entry.ts <= target.ts)
    if (fallbackByTime) return fallbackByTime

    // Compatibility fallback: map user-message ordinal to checkpoint ordinal when message ids/timestamps drift.
    const targetUserOrdinal = messages
      .slice(0, targetIndex + 1)
      .filter((m) => m.role === "user")
      .length
    if (targetUserOrdinal > 0 && entries[targetUserOrdinal - 1]) {
      return entries[targetUserOrdinal - 1]
    }

    // Last fallback: match checkpoint description prefix with target user text.
    const targetText = this.extractUserMessageText(target)
    if (targetText) {
      const normalizedTarget = targetText.slice(0, 80).toLowerCase()
      const byDescription = reversed.find((entry) =>
        (entry.description ?? "").toLowerCase().includes(normalizedTarget)
      )
      if (byDescription) return byDescription
    }

    return undefined
  }

  private isFileWriteTool(toolName: string): boolean {
    return FILE_WRITE_TOOL_NAMES.has(toolName)
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
        if (isDelegatedAgentToolEvent(event.tool, event.input)) {
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
            timeEnd: Date.now(),
          } as ToolPart
        }
        if (isDelegatedAgentToolEvent(event.tool, (event as { input?: Record<string, unknown> }).input)) {
          this.streamLastSpawnAgentPartId = null
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
    const msgs = this.session.messages
    const idx = msgs.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const target = msgs[idx]!
    if (target.role !== "user") return

    const choice = await vscode.window.showWarningMessage(
      "Discard all changes and chat messages up to this checkpoint?",
      { modal: true },
      "Continue",
      "Cancel"
    )
    if (choice !== "Continue") return

    const cwd = this.getCwd()
    const tracker = await this.ensureCheckpointForCurrentSession(this.session.id, cwd, this.config)
    const entries = tracker?.getEntries() ?? []
    const checkpointEntry = this.selectRollbackCheckpointEntry(entries, msgs, target, idx)

    if (checkpointEntry && tracker) {
      this.abortController?.abort()
      this.isRunning = false
      try {
        await tracker.resetHead(checkpointEntry.hash)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`NexusCode: Failed to rollback workspace — ${message}`)
        return
      }
      await this.revertDirtyWorkspaceDocs(cwd)
      this.session.rewindBeforeMessageId(target.id)
      this.sessionUnacceptedEdits = []
      await this.session.save().catch(() => {})
      this.postStateToWebview()
      vscode.window.showInformationMessage("NexusCode: Rolled back workspace and chat to before this message.", { modal: false })
      return
    }

    // Fallback for old sessions without message-linked checkpoints.
    this.session.rewindBeforeMessageId(target.id)
    await this.session.save().catch(() => {})
    this.postStateToWebview()
    vscode.window.showWarningMessage(
      "NexusCode: No workspace checkpoint found for this message. Chat was rolled back, but files were not changed.",
      { modal: false }
    )
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly postMessageToWebview: (msg: ExtensionMessage) => void
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("nexuscode")) return
        if (this.config) {
          this.applyVscodeOverrides(this.config)
          this.postStateToWebview()
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

  private async applyHostWorkingDirectoryChange(cwd: string, _reason?: string): Promise<void> {
    this.cwdOverride = canonicalProjectRoot(cwd)
    this.checkpoint = undefined
    this.indexer = undefined
    this.sendIndexStatus()
    this.postStateToWebview()
    void this.reconnectMcpServers().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
    })
    void this.initializeIndexer(this.cwdOverride).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[indexer] ${message}` } })
    })
  }

  getServerUrl(): string {
    return vscode.workspace.getConfiguration("nexuscode").get<string>("serverUrl")?.trim() ?? ""
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
      modelApiKey: c.get<string>("nexuscode.autocomplete.apiKey") ?? "",
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
        contextLimitTokens: 128000,
        contextPercent: 0,
        serverUrl: this.getServerUrl(),
        connectionState: this.serverConnectionState,
        serverConnectionError: this.serverConnectionError,
        modelsCatalog: this.modelsCatalogCache ?? null,
        sessionUnacceptedEdits: this.getSessionUnacceptedEditsForState(),
        pendingQuestionRequest: this.pendingQuestionRequest,
        activePresetName: this.chatPresetName,
        autocompleteExtension: this.readAutocompleteExtensionSettingsForWebview(),
      }
    }
    // Prefer live stream snapshot; else persisted session snapshot; else same formula as agent (session + tools; no system until next run).
    const sessionId = this.session.id
    const useLastContext =
      this.lastContextUsage != null && this.lastContextUsage.sessionId === sessionId
    if (!useLastContext && this.lastContextUsage != null) this.lastContextUsage = null

    let contextUsedTokens: number
    let contextLimitTokens: number
    let contextPercent: number
    if (useLastContext) {
      contextUsedTokens = this.lastContextUsage!.usedTokens
      contextLimitTokens = this.lastContextUsage!.limitTokens
      contextPercent = this.lastContextUsage!.percent
    } else {
      const snap = this.session.getLastContextUsageSnapshot()
      if (snap) {
        contextUsedTokens = snap.usedTokens
        contextLimitTokens = snap.limitTokens
        contextPercent = snap.percent
      } else {
        const mcpN = Array.isArray(this.config.mcp?.servers) ? this.config.mcp.servers.length : 0
        const toolsTok = estimateToolsDefinitionsTokens(getAllBuiltinTools()) + mcpN * 1200
        const m = computeContextUsageMetrics({
          sessionMessages: this.session.messages,
          toolsDefinitionTokens: toolsTok,
          modelId: this.config.model.id,
          configuredContextWindow: this.config.model.contextWindow,
        })
        contextUsedTokens = m.usedTokens
        contextLimitTokens = m.limitTokens
        contextPercent = m.percent
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
      serverUrl: this.getServerUrl(),
      connectionState: this.serverConnectionState,
      serverConnectionError: this.serverConnectionError,
      modelsCatalog: this.modelsCatalogCache ?? null,
      checkpointEnabled: this.config?.checkpoint?.enabled === true || this.checkpoint != null,
      checkpointEntries: this.checkpoint?.getEntries() ?? [],
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
  private getSessionUnacceptedEditsForState(): Array<{ path: string; diffStats: { added: number; removed: number }; isNewFile?: boolean }> {
    return this.sessionUnacceptedEdits.map((e) => ({
      path: e.path,
      diffStats: e.diffStats,
      isNewFile: e.isNewFile,
    }))
  }

  /** Add an edit to session unaccepted after saveFileEdit (called from host callback). */
  addSessionUnacceptedEdit(path: string, originalContent: string, newContent: string, isNewFile: boolean): void {
    const key = path.replace(/\\/g, "/")
    const existing = this.sessionUnacceptedEdits.findIndex((e) => e.path.replace(/\\/g, "/") === key)
    if (existing >= 0) this.sessionUnacceptedEdits.splice(existing, 1)
    this.sessionUnacceptedEdits.push({
      path: key,
      originalContent,
      newContent,
      diffStats: simpleDiffStats(originalContent, newContent),
      isNewFile,
    })
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

  /** Load skills from config paths, skillsUrls registries, Nexus skill dirs (.nexus/skills), Claude ~/.claude/skills, walk-up, send to webview Skills list. */
  private loadAndSendSkillDefinitions(): void {
    const cwd = this.getCwd()
    const paths = this.config?.skills ?? []
    loadSkills(paths, cwd, this.config?.skillsUrls, this.config ? getClaudeCompatibilityOptions(this.config) : undefined)
      .then((skills) => {
        this.postMessageToWebview({
          type: "skillDefinitions",
          definitions: skills.map((s) => ({ name: s.name, path: s.path, summary: s.summary })),
        })
      })
      .catch(() => {
        this.postMessageToWebview({ type: "skillDefinitions", definitions: [] })
      })
  }

  private async refreshAfterMarketplaceChange(): Promise<void> {
    const cwd = this.getCwd()
    try {
      this.config = await loadConfig(cwd, { secrets: this.secretsStore })
    } catch {
      /* keep previous config */
    }
    if (this.config) {
      this.postMessageToWebview({ type: "configLoaded", config: this.config })
      void this.loadAndSendSkillDefinitions()
      void this.reconnectMcpServers().catch(() => {})
    }
    this.postStateToWebview()
  }

  /** Clear current task/session and reset run state. */
  async clearTask(): Promise<void> {
    this.abortController?.abort()
    this.session = undefined
    this.sessionUnacceptedEdits = []
    this.serverSessionOldestLoadedOffset = undefined
    this.checkpoint = undefined
    this.serverSessionId = undefined
    this.postStateToWebview()
  }

  /** Cancel running agent (abort + keep session, then post state). */
  async cancelTask(): Promise<void> {
    this.abortController?.abort()
    this.isRunning = false
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
      try {
        this.config = await loadConfig(cwd, { secrets: this.secretsStore })
      } catch {
        this.config = undefined
      }
      if (!this.config) {
        try {
          this.config = await loadConfig(process.cwd(), { secrets: this.secretsStore })
        } catch {}
      }
      if (!this.config) {
        this.config = NexusConfigSchema.parse({}) as NexusConfig
      }
      if (!this.initialFullConfigSnapshot && this.config) {
        this.initialFullConfigSnapshot = {
          skills: [...(this.config.skills ?? [])],
          mcp: { servers: [...(this.config.mcp?.servers ?? [])] },
          rules: { files: [...(this.config.rules?.files ?? [])] },
          indexing: { ...this.config.indexing },
        }
      }
      this.postMessageToWebview({ type: "configLoaded", config: this.config })
      void this.loadAndSendSkillDefinitions()
      try {
        const allowPath = path.join(cwd, ".nexus", "allowed-commands.json")
        const uri = vscode.Uri.file(allowPath)
        const data = await vscode.workspace.fs.readFile(uri)
        const parsed = JSON.parse(Buffer.from(data).toString("utf8")) as { commands?: string[] }
        if (Array.isArray(parsed?.commands)) {
          this.config.permissions.allowedCommands = parsed.commands
        }
      } catch {
        // No file or invalid — keep default
      }
      try {
        const settings = loadProjectSettings(cwd, this.config ? { compatibility: getClaudeCompatibilityOptions(this.config) } : undefined)
        const perms = settings.permissions
        if (perms) {
          if (!this.config.permissions.allowCommandPatterns) this.config.permissions.allowCommandPatterns = []
          if (!this.config.permissions.denyCommandPatterns) this.config.permissions.denyCommandPatterns = []
          if (!this.config.permissions.askCommandPatterns) this.config.permissions.askCommandPatterns = []
          if (!this.config.permissions.allowedMcpTools) this.config.permissions.allowedMcpTools = []
          if (Array.isArray(perms.allow)) this.config.permissions.allowCommandPatterns = perms.allow
          if (Array.isArray(perms.deny)) this.config.permissions.denyCommandPatterns = perms.deny
          if (Array.isArray(perms.ask)) this.config.permissions.askCommandPatterns = perms.ask
          if (Array.isArray(perms.allowedMcpTools)) this.config.permissions.allowedMcpTools = perms.allowedMcpTools
        }
      } catch {
        // ignore
      }
      this.applyVscodeOverrides(this.config)
      this.defaultModelProfile = { ...this.config.model }
      this.session = Session.create(cwd)
      this.onAutocompleteConfigReady?.()
      this.postStateToWebview()
      this.sendIndexStatus()
      // Resolve init here so first message is not blocked. MCP/indexer/catalog/skills run in background.
      this.mcpReconnectPromise = this.reconnectMcpServers().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
      })
      void this.initializeIndexer(cwd).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[indexer] ${message}` } })
      })
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
      case "newMessage":
        await this.ensureInitialized()
        await this.runAgent(msg.content, msg.mode, msg.images, msg.presetName)
        break
      case "setChatPreset": {
        const name = (msg.presetName ?? "").trim() || "Default"
        this.chatPresetName = name
        this.postStateToWebview()
        break
      }
      case "abort":
        this.abortController?.abort()
        this.isRunning = false
        this.postStateToWebview()
        break
      case "compact":
        await this.compactHistory()
        break
      case "clearChat":
        this.session = Session.create(this.getCwd())
        this.lastRunMode = null
        this.sessionUnacceptedEdits = []
        this.checkpoint = undefined
        this.serverSessionId = undefined
        this.postStateToWebview()
        break
      case "setMode":
        this.mode = msg.mode
        this.postStateToWebview()
        break
      case "setProfile":
        if (this.config) {
          if (!msg.profile) {
            if (this.defaultModelProfile) {
              this.config.model = { ...this.defaultModelProfile }
            }
            this.postMessageToWebview({ type: "configLoaded", config: this.config })
        void this.loadAndSendSkillDefinitions()
            this.postStateToWebview()
            break
          }
          const profile = this.config.profiles[msg.profile]
          if (!profile) break
          this.config.model = { ...this.config.model, ...profile }
          this.postMessageToWebview({ type: "configLoaded", config: this.config })
        void this.loadAndSendSkillDefinitions()
          this.postStateToWebview()
        }
        break
      case "getState":
        this.postStateToWebview()
        this.sendIndexStatus()
        if (this.config) {
          this.postMessageToWebview({ type: "configLoaded", config: this.config })
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
      case "webviewDidLaunch":
        this.postStateToWebview()
        this.sendIndexStatus()
        if (this.config) {
          this.postMessageToWebview({ type: "configLoaded", config: this.config })
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
          this.session = this.session.fork(msg.messageId) as Session
          if (this.getServerUrl()) {
            this.serverSessionId = undefined
            this.serverSessionOldestLoadedOffset = undefined
          }
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
        const url = (msg as { url: string; autoStart?: boolean }).url?.trim() || "http://127.0.0.1:6333"
        const autoStart = (msg as { autoStart?: boolean }).autoStart !== false
        void (async () => {
          try {
            const result = await ensureQdrantRunning({
              url,
              autoStart,
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
        const absPath = path.isAbsolute(msg.path) ? msg.path : path.join(cwd, msg.path)
        const relPath = path.relative(cwd, absPath).replace(/\\/g, "/")
        const wf = vscode.workspace.workspaceFolders?.[0]
        const uri = wf ? vscode.Uri.joinPath(wf.uri, relPath) : vscode.Uri.file(absPath)
        const line = Math.max(0, (msg.line ?? 1) - 1)
        const endLine = msg.endLine != null ? Math.max(0, msg.endLine - 1) : line
        const isPlanFile = absPath.replace(/\\/g, "/").includes(".nexus/plans")
        void (async () => {
          try {
            const doc = await vscode.workspace.openTextDocument(uri)
            const editor = await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.Active,
              selection: new vscode.Range(line, 0, endLine, 0),
              preview: false,
            })
            if (doc.isDirty) await vscode.commands.executeCommand("workbench.action.files.revert")
            editor.revealRange(new vscode.Range(line, 0, endLine, 0), vscode.TextEditorRevealType.InCenter)
            if (isPlanFile && doc.getText().trim() === "") {
              await new Promise((r) => setTimeout(r, 200))
              await vscode.commands.executeCommand("workbench.action.files.revert")
            }
          } catch {
            vscode.window.showErrorMessage(`NexusCode: Could not open ${msg.path}`)
          }
        })()
        break
      }
      case "showDiff": {
        const cwd = this.getCwd()
        const raw = msg.path?.trim() ?? ""
        // Avoid using multi-line or huge strings as path (e.g. accidental content paste).
        if (raw.length > 0 && raw.length < 2048 && !raw.includes("\n")) {
          const key = this.normalizePathKey(raw, cwd)
          const sessionEdit = this.sessionUnacceptedEdits.find((e) => this.normalizePathKey(e.path, cwd) === key)
          if (sessionEdit) {
            await showSessionEditDiff(cwd, raw, sessionEdit.originalContent, sessionEdit.newContent)
          } else {
            const pending = this.activeRunHost?.getPendingFileEdit(raw)
            if (pending) {
              await showSessionEditDiff(cwd, raw, pending.originalContent, pending.newContent, {
                useWorkspaceAfterFile: false,
              })
            } else {
              await this.openWorkspaceFile(cwd, raw)
            }
          }
        }
        break
      }
      case "openSessionEditDiff": {
        const raw = (msg as { path: string }).path?.trim() ?? ""
        if (raw.length === 0 || raw.length >= 2048 || raw.includes("\n")) break
        const cwd = this.getCwd()
        const key = this.normalizePathKey(raw, cwd)
        const entry = this.sessionUnacceptedEdits.find((e) => this.normalizePathKey(e.path, cwd) === key)
        if (entry) {
          await showSessionEditDiff(cwd, raw, entry.originalContent, entry.newContent)
        }
        break
      }
      case "undoSessionEdits": {
        const cwd = this.getCwd()
        for (const e of [...this.sessionUnacceptedEdits]) {
          const absPath = path.isAbsolute(e.path) ? e.path : path.join(cwd, e.path)
          const uri = vscode.Uri.file(absPath)
          try {
            if (e.isNewFile) {
              await vscode.workspace.fs.delete(uri, { useTrash: true })
            } else {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(e.originalContent, "utf8"))
            }
          } catch {
            // Ignore per-file errors
          }
        }
        this.sessionUnacceptedEdits = []
        this.postStateToWebview()
        break
      }
      case "keepAllSessionEdits":
        this.sessionUnacceptedEdits = []
        this.postStateToWebview()
        break
      case "revertSessionEditFile": {
        const pathMsg = (msg as { path: string }).path?.trim() ?? ""
        if (pathMsg.length === 0 || pathMsg.length >= 2048 || pathMsg.includes("\n")) break
        const cwd = this.getCwd()
        const key = this.normalizePathKey(pathMsg, cwd)
        const entry = this.sessionUnacceptedEdits.find((e) => this.normalizePathKey(e.path, cwd) === key)
        if (entry) {
          const absPath = path.isAbsolute(entry.path) ? entry.path : path.join(cwd, entry.path)
          const uri = vscode.Uri.file(absPath)
          try {
            if (entry.isNewFile) {
              await vscode.workspace.fs.delete(uri, { useTrash: true })
            } else {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(entry.originalContent, "utf8"))
            }
          } catch {
            vscode.window.showErrorMessage(`NexusCode: Failed to revert ${entry.path}`)
          }
          this.sessionUnacceptedEdits = this.sessionUnacceptedEdits.filter((e) => this.normalizePathKey(e.path, cwd) !== key)
          this.postStateToWebview()
        }
        break
      }
      case "acceptSessionEditFile": {
        const pathMsg = (msg as { path: string }).path?.trim() ?? ""
        if (pathMsg.length === 0 || pathMsg.length >= 2048 || pathMsg.includes("\n")) break
        const cwd = this.getCwd()
        const key = this.normalizePathKey(pathMsg, cwd)
        this.sessionUnacceptedEdits = this.sessionUnacceptedEdits.filter((e) => this.normalizePathKey(e.path, cwd) !== key)
        this.postStateToWebview()
        break
      }
      case "setServerUrl": {
        const url = typeof msg.url === "string" ? msg.url.trim() : ""
        await vscode.workspace.getConfiguration("nexuscode").update("serverUrl", url || undefined, vscode.ConfigurationTarget.Global)
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
          await c.update("nexuscode.autocomplete.apiKey", p.modelApiKey.trim() || undefined, t)
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
        if (!this.config?.mcp.servers.length) {
          this.postMessageToWebview({
            type: "mcpServerStatus",
            results: [],
          })
          break
        }
        try {
          const resolved = this.getResolvedMcpServers()
          const results = await testMcpServers(resolved)
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
        const result = await this.marketplaceService.install(msg.mpItem, msg.mpInstallOptions, ws)
        this.postMessageToWebview({
          type: "marketplaceInstallResult",
          slug: msg.mpItem.id,
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
        const scope = msg.mpInstallOptions.target
        const result = await this.marketplaceService.remove(msg.mpItem, scope, ws)
        this.postMessageToWebview({
          type: "marketplaceRemoveResult",
          slug: msg.mpItem.id,
          success: result.success,
          error: result.error,
        })
        if (result.success) {
          await this.refreshAfterMarketplaceChange()
        }
        break
      }
      case "openSkillFolder": {
        const cwd = this.getCwd()
        const absPath = path.isAbsolute(msg.path) ? msg.path : path.resolve(cwd, msg.path)
        const uri = vscode.Uri.file(absPath)
        const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => null)
        if (stat?.type === vscode.FileType.File) {
          const doc = await Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => null)
          if (doc) {
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false })
          }
        } else {
          const skillMd = path.join(absPath, "SKILL.md")
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
        const resolve = this.approvalResolveRef.current
        if (resolve) {
          resolve({
            approved: msg.approved,
            alwaysApprove: msg.alwaysApprove,
            addToAllowedCommand: msg.addToAllowedCommand,
            skipAll: msg.skipAll,
            whatToDoInstead: msg.whatToDoInstead,
          })
        }
        break
      }
      case "openExternal": {
        if (typeof msg.url === "string" && msg.url.startsWith("http")) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url))
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
        if (msg.choice === "dismiss") {
          this.mode = "agent"
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
            this.lastRunMode = null
            this.checkpoint = undefined
            this.serverSessionId = undefined
            this.serverSessionOldestLoadedOffset = undefined
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
        if (this.pendingQuestionRequest?.requestId === msg.requestId) {
          this.pendingQuestionRequest = null
          // Force immediate sync so webview doesn't briefly re-show stale pending from a batched state post.
          this.postStateToWebview(true)
        }
        break
      }
      case "questionnaireResponse": {
        if (!this.pendingQuestionRequest || this.pendingQuestionRequest.requestId !== msg.requestId) break
        const prompt = formatQuestionnaireAnswersForAgent(this.pendingQuestionRequest, msg.answers)
        this.pendingQuestionRequest = null
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
            this.session = Session.create(cwd)
            this.lastRunMode = null
            this.sessionUnacceptedEdits = []
            this.postStateToWebview()
            break
          default: {
            const compat = this.config ? getClaudeCompatibilityOptions(this.config) : undefined
            const loaded = await loadSlashCommands(cwd, compat)
            const resolved =
              loaded.find((item) => item.command === name) ??
              loaded.find((item) => item.command === `project:${name}`) ??
              loaded.find((item) => item.command === `user:${name}`)
            if (resolved) {
              await this.runAgent(renderSlashCommandPrompt(resolved, args), this.mode)
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
    const cwd = this.getCwd()
    const tracker = await this.ensureCheckpointForCurrentSession(this.session.id, cwd, this.config)
    if (!tracker) {
      vscode.window.showWarningMessage("NexusCode: Checkpoints are not enabled or no checkpoint is available.", { modal: false })
      return
    }
    const entry = tracker.getEntries().find((e) => e.hash === hash)
    const checkpointTs = entry?.ts

    if (restoreType === "taskAndWorkspace" || restoreType === "workspace") {
      this.abortController?.abort()
      this.isRunning = false
    }

    if (restoreType === "workspace" || restoreType === "taskAndWorkspace") {
      try {
        await tracker.resetHead(hash)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`NexusCode: Failed to restore checkpoint — ${message}`)
        return
      }
    }

    if ((restoreType === "task" || restoreType === "taskAndWorkspace") && this.session && checkpointTs != null) {
      this.session.rewindToTimestamp(checkpointTs)
      await this.session.save().catch(() => {})
    }

    if (restoreType === "workspace" || restoreType === "taskAndWorkspace") {
      await this.revertDirtyWorkspaceDocs(cwd)
      this.sessionUnacceptedEdits = []
    }

    const msg =
      restoreType === "task"
        ? "Chat restored to checkpoint."
        : restoreType === "workspace"
          ? "Workspace files restored to checkpoint."
          : "Workspace and chat restored to checkpoint."
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
    if (trimmed === "Default") {
      const snap = this.initialFullConfigSnapshot
      if (!snap) return base
      return {
        ...base,
        indexing: { ...base.indexing, ...snap.indexing },
        skills: snap.skills,
        mcp: { servers: [...snap.mcp.servers] },
        rules: { files: snap.rules.files.length > 0 ? [...snap.rules.files] : ["NEXUS.md", "AGENTS.md", "CLAUDE.md"] },
      }
    }
    // NOTE: preset lookup is async; this function expects caller to already resolve selected preset if needed.
    return base
  }

  private applyPresetFields(base: NexusConfig, preset: { vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string }): NexusConfig {
    const current = base
    const namedServers = (current.mcp?.servers ?? []).map((s) => ({ name: (s as McpServerConfig).name ?? "", server: s }))
    const selectedServers = namedServers
      .filter((item) => item.name && preset.mcpServers.includes(item.name))
      .map((item) => item.server)
    const next: NexusConfig = {
      ...current,
      indexing: { ...current.indexing, vector: preset.vector },
      skills: preset.skills,
      mcp: { servers: preset.mcpServers.length === 0 ? [] : selectedServers },
      rules: { files: preset.rulesFiles.length > 0 ? preset.rulesFiles : ["NEXUS.md", "AGENTS.md", "CLAUDE.md"] },
    }
    if (preset.modelProvider && preset.modelId) {
      const provider =
        preset.modelProvider === "openrouter"
          ? "openai-compatible"
          : (preset.modelProvider as NexusConfig["model"]["provider"])
      next.model = { ...current.model, provider, id: preset.modelId }
    }
    return next
  }

  /** Discover available skills, MCP server names, and rules files for preset builder. Uses same source as Skills tab (loadSkills) so ~/.nexus and all .md are included. */
  private async getAgentPresetOptions(): Promise<{ skills: string[]; mcpServers: string[]; rulesFiles: string[] }> {
    const cwd = this.getCwd()
    const skillDefs = await loadSkills(
      this.config?.skills ?? [],
      cwd,
      this.config?.skillsUrls,
      this.config ? getClaudeCompatibilityOptions(this.config) : undefined,
    ).catch(() => [])
    const skills = dedupeStringList(skillDefs.map((s) => s.path))
    const fromConfig = (this.config?.mcp?.servers ?? []).map((s) => (s as McpServerConfig).name).filter((n): n is string => Boolean(n?.trim()))
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
      const provider =
        preset.modelProvider === "openrouter"
          ? "openai-compatible"
          : (preset.modelProvider as NexusConfig["model"]["provider"])
      updates.model = { ...current.model, provider, id: preset.modelId }
    }
    await this.handleSaveConfig(updates)
    vscode.window.showInformationMessage(`NexusCode: Applied preset "${trimmed}".`, { modal: false })
  }

  private async handleSaveConfig(patch: Partial<NexusConfig>): Promise<void> {
    if (!this.config || !patch) return
    const modelPatch = (patch as { model?: Record<string, unknown> }).model
    if (modelPatch && (modelPatch.apiKey === "" || modelPatch.apiKey === undefined)) {
      const existing = this.config.model as unknown as Record<string, unknown>
      if (existing?.apiKey) modelPatch.apiKey = existing.apiKey
    }
    if (modelPatch && (modelPatch.baseUrl === "" || modelPatch.baseUrl === undefined)) {
      const existing = this.config.model as unknown as Record<string, unknown>
      if (existing?.baseUrl) modelPatch.baseUrl = existing.baseUrl
    }
    const indexBefore = JSON.stringify({
      indexing: this.config.indexing,
      vectorDb: this.config.vectorDb,
      embeddings: this.config.embeddings,
    })
    const mcpBefore = JSON.stringify({ mcp: this.config.mcp })
    deepMergeInto(
      this.config as unknown as Record<string, unknown>,
      patch as unknown as Partial<Record<string, unknown>>
    )
    this.defaultModelProfile = { ...this.config.model }
    if (patch.profiles && typeof patch.profiles === "object") {
      writeGlobalProfiles(patch.profiles as Record<string, unknown>)
    }
    const cwd = this.getCwd()
    const folders = vscode.workspace.workspaceFolders
    if (!folders || folders.length === 0) {
      vscode.window.showWarningMessage(
        "NexusCode: Open a workspace folder first so settings can be saved to .nexus/nexus.yaml in the project.",
        { modal: false }
      )
      this.postMessageToWebview({ type: "configLoaded", config: this.config })
        void this.loadAndSendSkillDefinitions()
      this.postStateToWebview()
      return
    }
    try {
      await persistSecretsFromConfig(
        this.config as unknown as Record<string, unknown>,
        this.secretsStore
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`NexusCode: Failed to save API keys — ${message}`)
    }
    const toWrite = { ...this.config } as unknown as Record<string, unknown>
    if (Array.isArray((toWrite as { skillsConfig?: Array<{ path: string; enabled: boolean }> }).skillsConfig)) {
      const skillsConfig = (toWrite as { skillsConfig: Array<{ path: string; enabled: boolean }> }).skillsConfig
      toWrite.skills = skillsConfig.map((s) =>
        s.enabled ? s.path : { path: s.path, enabled: false }
      )
      delete toWrite.skillsConfig
    }
    try {
      writeConfig(toWrite as unknown as NexusConfig, cwd)
      vscode.window.showInformationMessage("NexusCode: Settings saved.", { modal: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`NexusCode: Failed to save settings — ${message}`)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `Save failed: ${message}` } })
    }
    const mcpAfter = JSON.stringify({ mcp: this.config.mcp })
    if (mcpBefore !== mcpAfter) {
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
    if (indexBefore !== indexAfter) {
      void this.initializeIndexer(cwd).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[indexer] ${message}` } })
      })
    }
    this.postMessageToWebview({ type: "configLoaded", config: this.config })
        void this.loadAndSendSkillDefinitions()
    this.postStateToWebview()
  }

  private getModeReminder(_mode: Mode): string {
    // Not shown in UI; mode is enforced via system prompt and API mode parameter only.
    return ""
  }

  private async runAgent(content: string, mode?: Mode, images?: Array<{ data: string; mimeType: string }>, presetName?: string): Promise<void> {
    if (this.isRunning) return
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

    const reviewCommand = /^\/review(\s|$)/i.test(trimmedInput)
    const requestedMode = mode ?? this.mode
    this.mode = requestedMode
    const runMode: Mode = reviewCommand ? "review" : requestedMode
    this.lastRunMode = runMode
    this.abortController = new AbortController()
    this.isRunning = true

    let actualContent = content
    let createSkillMode = false
    const effectivePresetName = (presetName ?? this.chatPresetName).trim() || "Default"
    this.chatPresetName = effectivePresetName
    let configForRun = this.resolveConfigForPreset(this.config, effectivePresetName)
    if (effectivePresetName !== "Default") {
      const preset = await this.getPresetByName(effectivePresetName)
      if (preset) configForRun = this.applyPresetFields(configForRun, preset)
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
        ...this.config,
        permissions: {
          ...this.config.permissions,
          rules: [
            ...this.config.permissions.rules,
            { tool: "Write", pathPattern: ".nexus/skills/**", action: "allow" as const },
            { tool: "Edit", pathPattern: ".nexus/skills/**", action: "allow" as const },
            { tool: "write_to_file", pathPattern: ".nexus/skills/**", action: "allow" as const },
            { tool: "replace_in_file", pathPattern: ".nexus/skills/**", action: "allow" as const },
          ],
        },
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
    const userMessage = this.session.addMessage({ role: "user", content: userContent, presetName: effectivePresetName })
    this.postStateToWebview()

    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()
    await this.commitCheckpointForUserMessage(this.session.id, cwd, configForRun, userMessage).catch((err) => {
      console.warn("[nexus] Failed to commit message checkpoint:", err)
    })

    if (serverUrl) {
      this.setServerConnectionState("connecting")
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
      const clearHeartbeat = () => {
        if (heartbeatTimer != null) {
          clearTimeout(heartbeatTimer)
          heartbeatTimer = null
        }
      }
      const resetHeartbeat = () => {
        clearHeartbeat()
        if (this.abortController?.signal.aborted) return
        heartbeatTimer = setTimeout(() => {
          heartbeatTimer = null
          this.setServerConnectionState("error", "Connection lost (no response from server). You can retry by sending again.")
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: "Connection lost: heartbeat timeout" } })
          this.abortController?.abort()
        }, DEFAULT_HEARTBEAT_TIMEOUT_MS)
      }
      try {
        const client = new NexusServerClient({ baseUrl: serverUrl, directory: cwd })
        let sid = this.serverSessionId
        if (!sid) {
          const created = await client.createSession()
          sid = created.id
          this.serverSessionId = sid
        }
        this.setServerConnectionState("streaming")
        const forwardServerEvent = (event: AgentEvent) => {
          if (event.type === "question_request") {
            this.pendingQuestionRequest = event.request
          }
          if (event.type === "context_usage") {
            this.lastContextUsage = {
              usedTokens: event.usedTokens,
              limitTokens: event.limitTokens,
              percent: event.percent,
              sessionId: this.session?.id ?? "",
            }
          }
          this.applyAgentEventToSessionShadow(event)
          this.postMessageToWebview({ type: "agentEvent", event })
          if (this.eventAffectsVisibleState(event)) {
            this.postStateToWebview()
          }
          if (event.type === "tool_end" && event.success && this.isFileWriteTool(event.tool) && event.path) {
            const writtenContent = (event as AgentEvent & { writtenContent?: string }).writtenContent
            if (typeof writtenContent === "string") {
              const absPath = path.isAbsolute(event.path) ? event.path : path.join(cwd, event.path)
              let dir = path.dirname(absPath)
              const toCreate: string[] = []
              while (dir !== cwd && dir.length > cwd.length) {
                toCreate.push(dir)
                dir = path.dirname(dir)
              }
              toCreate.reverse()
              for (const p of toCreate) {
                void vscode.workspace.fs.createDirectory(vscode.Uri.file(p)).then(undefined, () => {})
              }
              void vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), new TextEncoder().encode(writtenContent)).then(undefined, () => {})
            }
          }
          if (event.type === "error") {
            this.isRunning = false
            this.setServerConnectionState("error", event.error)
            this.postStateToWebview()
          }
        }
        for await (const event of client.streamMessage(sid, actualContent, runMode, effectivePresetName, this.abortController!.signal)) {
          if (this.abortController?.signal.aborted) break
          resetHeartbeat()
          forwardServerEvent(event)
        }
        try {
          const meta = await client.getSession(sid)
          const offset = Math.max(0, meta.messageCount - INITIAL_SERVER_MESSAGES)
          const messages = await client.getMessages(sid, { limit: INITIAL_SERVER_MESSAGES, offset })
          this.session = new Session(sid, cwd, messages)
          this.serverSessionOldestLoadedOffset = offset
        } catch {
          // keep current session shadow
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes("abort")) {
          this.setServerConnectionState("error", msg)
          this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: msg } })
        }
      } finally {
        clearHeartbeat()
        this.isRunning = false
        this.serverConnectionState = "idle"
        this.serverConnectionError = undefined
        this.postStateToWebview()
      }
      return
    }

    const host = new VsCodeHost(cwd, (event: AgentEvent) => {
      if (event.type === "question_request") {
        this.pendingQuestionRequest = event.request
      }
      if (event.type === "context_usage") {
        this.lastContextUsage = {
          usedTokens: event.usedTokens,
          limitTokens: event.limitTokens,
          percent: event.percent,
          sessionId: this.session?.id ?? "",
        }
      }
      // Track spawn agent partId for subagent event routing (local mode doesn't go through applyAgentEventToSessionShadow for non-subagent events)
      if (event.type === "tool_start") {
        if (isDelegatedAgentToolEvent(event.tool, event.input)) {
          this.streamLastSpawnAgentPartId = event.partId
        }
      } else if (event.type === "tool_end") {
        if (isDelegatedAgentToolEvent(event.tool, (event as { input?: Record<string, unknown> }).input)) {
          this.streamLastSpawnAgentPartId = null
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
      if (event.type === "tool_approval_needed") {
        this.postMessageToWebview({
          type: "pendingApproval",
          partId: event.partId,
          action: event.action,
        })
      }
      if (event.type === "error") {
        this.isRunning = false
        this.postStateToWebview()
      }
      // Sync full state after tool_end so webview gets latest todo and messages
      if (event.type === "tool_end") {
        // Keep editor "memory" in sync with disk: after a successful file write, reload the doc if open so it's not dirty
        if (
          event.success &&
          "path" in event &&
          typeof (event as { path?: string }).path === "string" &&
          ((event as { path?: string }).path as string).length > 0 &&
          this.isFileWriteTool(event.tool)
        ) {
          const filePath = (event as { path: string }).path
          const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
          const uri = vscode.Uri.file(absPath)
          const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath)
          if (doc?.isDirty) {
            void vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }).then(() =>
              vscode.commands.executeCommand("workbench.action.files.revert")
            )
          }
        }
      }
    }, { useWebviewApproval: true, approvalResolveRef: this.approvalResolveRef, onCheckpointEntriesUpdated: () => this.postStateToWebview(), onModeChangeRequested: async (nextMode) => {
      this.mode = nextMode
      this.postStateToWebview()
    }, onWorkingDirectoryChangeRequested: async (nextCwd) => {
      await this.applyHostWorkingDirectoryChange(nextCwd)
    }, onSessionEditSaved: (filePath, originalContent, newContent, isNewFile) => {
      const norm = filePath.replace(/\\/g, "/")
      if (norm.includes(".nexus/plans")) {
        this.postStateToWebview()
        return
      }
      this.addSessionUnacceptedEdit(filePath, originalContent, newContent, isNewFile)
      this.postStateToWebview()
    } })
    this.activeRunHost = host

    const timeoutMs = 10 * 60_000
    const timeout = setTimeout(() => {
      if (!this.isRunning) return
      this.abortController?.abort()
      this.postMessageToWebview({
        type: "agentEvent",
        event: { type: "error", error: `LLM request timed out after ${Math.round(timeoutMs / 60000)} minutes.` },
      })
    }, timeoutMs)

    try {
      // MCP (started in ensureInitialized), rules, skills in parallel so first message is faster.
      // Cap MCP wait so first message is not blocked when vector is off or MCP servers are slow.
      const MCP_FIRST_MESSAGE_TIMEOUT_MS = 2500
      const mcpP = this.mcpReconnectPromise
        ? Promise.race([
            this.mcpReconnectPromise,
            new Promise<void>((r) => setTimeout(r, MCP_FIRST_MESSAGE_TIMEOUT_MS)),
          ])
        : Promise.resolve()
      const claudeCompatibility = getClaudeCompatibilityOptions(configForRun)
      const rulesP = loadRules(cwd, configForRun.rules.files, claudeCompatibility).catch(() => "")
      const skillsP = loadSkills(configForRun.skills, cwd, configForRun.skillsUrls, claudeCompatibility).catch(() => [])
      const RULES_SKILLS_TIMEOUT_MS = 2000
      const rulesAndSkillsP = Promise.race([
        Promise.all([rulesP, skillsP]).then(([rulesContent, skills]) => ({ type: "ok" as const, rulesContent, skills })),
        new Promise<{ type: "timeout" }>((r) => setTimeout(() => r({ type: "timeout" }), RULES_SKILLS_TIMEOUT_MS)),
      ])
      const [, rulesAndSkillsResult] = await Promise.all([mcpP, rulesAndSkillsP])
      const rulesContent = rulesAndSkillsResult.type === "ok" ? rulesAndSkillsResult.rulesContent : ""
      const skills = rulesAndSkillsResult.type === "ok" ? rulesAndSkillsResult.skills : []

      const client = createLLMClient(configForRun.model)
      const toolRegistry = new ToolRegistry()
      const allowedMcpServers = new Set(
        (configForRun.mcp?.servers ?? [])
          .map((s) => (s as McpServerConfig).name)
          .filter((n): n is string => typeof n === "string" && n.trim().length > 0),
      )
      if (this.mcpClient && allowedMcpServers.size > 0) {
        for (const tool of this.mcpClient.getTools()) {
          const serverName = tool.name.split("__", 1)[0] ?? ""
          if (allowedMcpServers.has(serverName)) toolRegistry.register(tool)
        }
      }
      const parallelManager = new ParallelAgentManager()
      setParallelAgentManager(parallelManager)
      toolRegistry.register(createSpawnAgentTool(parallelManager, configForRun))
      toolRegistry.register(createSpawnAgentOutputTool(parallelManager))
      toolRegistry.register(createSpawnAgentStopTool(parallelManager))
      toolRegistry.register(createSpawnAgentsParallelTool(parallelManager, configForRun))
      toolRegistry.register(createListAgentRunsTool(parallelManager))
      toolRegistry.register(createAgentRunSnapshotTool(parallelManager))
      toolRegistry.register(createResumeAgentTool(parallelManager, configForRun))
      toolRegistry.register(createTaskCreateBatchTool(parallelManager, configForRun))
      toolRegistry.register(createTaskSnapshotTool(parallelManager))
      toolRegistry.register(createTaskResumeTool(parallelManager, configForRun))
      const { builtin: tools, dynamic } = toolRegistry.getForMode(runMode)
      const allTools = [...tools, ...dynamic]
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
        client,
        host,
        config: configForRun,
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
      if (errMsg !== "AbortError" && !errMsg.includes("aborted")) {
        console.error("[nexus] Agent loop error:", err)
        this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: errMsg } })
      }
    } finally {
      clearTimeout(timeout)
      this.activeRunHost = null
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

  private getResolvedMcpServers(): McpServerConfig[] {
    if (!this.config?.mcp.servers.length) return []
    const cwd = this.getCwd()
    const nexusRoot = this.getNexusRoot()
    return resolveBundledMcpServers(this.config.mcp.servers, { cwd, nexusRoot })
  }

  private async reconnectMcpServers(): Promise<void> {
    if (!this.config) return
    if (!this.mcpClient) {
      this.mcpClient = new McpClient()
      setMcpClientInstance(this.mcpClient)
    }
    await this.mcpClient.disconnectAll().catch(() => {})
    if (this.config.mcp.servers.length === 0) return
    const resolved = this.getResolvedMcpServers()
    process.env.CLAUDE_PROJECT_DIR = this.getCwd()
    await this.mcpClient.connectAll(resolved).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this.postMessageToWebview({ type: "agentEvent", event: { type: "error", error: `[mcp] ${message}` } })
    })
    const status = this.mcpClient.getStatus()
    this.postMessageToWebview({
      type: "mcpServerStatus",
      results: this.config.mcp.servers.map((s) => ({
        name: s.name,
        status: status[s.name] === "connected" ? ("ok" as const) : ("error" as const),
        error: status[s.name] === "connected" ? undefined : "Not connected",
      })),
    })
  }

  private async compactHistory(): Promise<void> {
    if (!this.session || !this.config) return
    if (this.getServerUrl()) {
      vscode.window.showInformationMessage("NexusCode: Compaction is not supported when using NexusCode Server.")
      return
    }
    const client = createLLMClient(this.config.model)
    const compaction = createCompaction()
    this.postMessageToWebview({ type: "agentEvent", event: { type: "compaction_start" } })
    try {
      await compaction.compact(this.session, client)
    } finally {
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
          const res = await fetch(
            `${serverUrl.replace(/\/$/, "")}/session?directory=${encodeURIComponent(cwd)}`,
            { headers: { "x-nexus-directory": cwd } }
          )
          if (res.ok) {
            const sessions = (await res.json()) as Array<{ id: string; ts: number; title?: string; messageCount: number }>
            this.postMessageToWebview({ type: "sessionList", sessions })
            return
          }
        } catch {}
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
      if (serverUrl) {
        if (this.session.id !== this.serverSessionId) return
        const msgRes = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${this.session.id}/message?directory=${encodeURIComponent(cwd)}&limit=${limit}&offset=${offset}`,
          { headers: { "x-nexus-directory": cwd } }
        )
        if (!msgRes.ok) return
        olderMessages = (await msgRes.json()) as SessionMessage[]
      } else {
        const loaded = await loadSessionMessages(this.session.id, cwd, limit, offset)
        if (!loaded) return
        olderMessages = loaded.messages
      }
      if (olderMessages.length === 0) return
      const existingIds = new Set(this.session.messages.map((msg) => msg.id))
      const dedupedOlder = olderMessages.filter((msg) => !existingIds.has(msg.id))
      if (dedupedOlder.length === 0) {
        this.serverSessionOldestLoadedOffset = offset
        return
      }
      this.session = new Session(this.session.id, cwd, [...dedupedOlder, ...this.session.messages])
      this.serverSessionOldestLoadedOffset = offset
      if (!serverUrl) this.localSessionWindowed = offset > 0
    } finally {
      this.loadingOlderMessages = false
      this.postStateToWebview()
    }
  }

  private async switchSession(sessionId: string): Promise<void> {
    this.lastRunMode = null
    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()
    if (serverUrl) {
      try {
        const metaRes = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${sessionId}?directory=${encodeURIComponent(cwd)}`,
          { headers: { "x-nexus-directory": cwd } }
        )
        if (!metaRes.ok) return
        const meta = (await metaRes.json()) as { messageCount: number }
        const offset = Math.max(0, meta.messageCount - INITIAL_SERVER_MESSAGES)
        const msgRes = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${sessionId}/message?directory=${encodeURIComponent(cwd)}&limit=${INITIAL_SERVER_MESSAGES}&offset=${offset}`,
          { headers: { "x-nexus-directory": cwd } }
        )
        if (!msgRes.ok) return
        const messages = (await msgRes.json()) as SessionMessage[]
        this.session = new Session(sessionId, cwd, messages)
        this.serverSessionId = sessionId
        this.serverSessionOldestLoadedOffset = offset
        this.localSessionWindowed = false
        this.pendingQuestionRequest = null
        this.checkpoint = undefined
        this.postStateToWebview()
      } catch {}
      return
    }
    const meta = await getSessionMeta(sessionId, cwd)
    if (!meta) return
    const offset = Math.max(0, meta.messageCount - INITIAL_SERVER_MESSAGES)
    const loaded = await Session.resumeWindow(sessionId, cwd, INITIAL_SERVER_MESSAGES, offset)
    if (loaded) {
      this.session = loaded
      this.sessionUnacceptedEdits = []
      this.serverSessionId = undefined
      this.serverSessionOldestLoadedOffset = offset
      this.localSessionWindowed = offset > 0
      this.pendingQuestionRequest = null
      this.checkpoint = undefined
      this.postStateToWebview()
    }
  }

  private async createNewSession(): Promise<void> {
    this.lastRunMode = null
    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()
    if (serverUrl) {
      try {
        const res = await fetch(`${serverUrl.replace(/\/$/, "")}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-nexus-directory": cwd },
          body: "{}",
        })
        if (res.ok) {
          const created = (await res.json()) as { id: string }
          this.session = new Session(created.id, cwd, [])
          this.serverSessionId = created.id
          this.serverSessionOldestLoadedOffset = undefined
        }
      } catch {
        // fallback to local session
        this.session = Session.create(cwd)
        this.serverSessionId = undefined
      }
    } else {
      this.session = Session.create(cwd)
      this.serverSessionId = undefined
    }
    this.sessionUnacceptedEdits = []
    this.serverSessionOldestLoadedOffset = undefined
    this.localSessionWindowed = false
    this.pendingQuestionRequest = null
    this.checkpoint = undefined
    this.postStateToWebview()
    await this.sendSessionList()
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const cwd = this.getCwd()
    const serverUrl = this.getServerUrl()
    let deleted = false
    if (serverUrl) {
      try {
        const res = await fetch(
          `${serverUrl.replace(/\/$/, "")}/session/${sessionId}?directory=${encodeURIComponent(cwd)}`,
          { method: "DELETE", headers: { "x-nexus-directory": cwd } }
        )
        deleted = res.ok
      } catch {
        // fall through to sendSessionList
      }
    } else {
      deleted = await deleteSession(sessionId, cwd)
    }
    if (deleted && this.session?.id === sessionId) {
      if (serverUrl) {
        try {
          const createRes = await fetch(`${serverUrl.replace(/\/$/, "")}/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-nexus-directory": cwd },
            body: "{}",
          })
          if (createRes.ok) {
            const created = (await createRes.json()) as { id: string }
            this.session = new Session(created.id, cwd, [])
            this.serverSessionId = created.id
            this.serverSessionOldestLoadedOffset = undefined
          }
        } catch {
          // keep current session ref; list will refresh
        }
      } else {
        this.session = Session.create(cwd)
        this.serverSessionId = undefined
      }
      this.checkpoint = undefined
      this.postStateToWebview()
    }
    await this.sendSessionList()
  }

  private applyVscodeOverrides(config: NexusConfig): void {
    const cfg = vscode.workspace.getConfiguration("nexuscode")
    const getConfiguredBoolean = (key: string): boolean | undefined => {
      const inspected = cfg.inspect<boolean>(key)
      if (!inspected) return undefined
      const hasExplicitValue =
        inspected.workspaceFolderValue !== undefined ||
        inspected.workspaceValue !== undefined ||
        inspected.globalValue !== undefined
      if (!hasExplicitValue) return undefined
      return (
        inspected.workspaceFolderValue ??
        inspected.workspaceValue ??
        inspected.globalValue ??
        inspected.defaultValue
      )
    }
    const provider = cfg.get<string>("provider")
    if (provider != null && provider !== "") {
      if (provider === "openrouter") {
        config.model.provider = "openai-compatible"
        if (!config.model.baseUrl) config.model.baseUrl = "https://openrouter.ai/api/v1"
      } else {
        config.model.provider = provider as NexusConfig["model"]["provider"]
      }
    }
    const model = cfg.get<string>("model")
    if (model != null && model !== "") config.model.id = model
    const apiKey = cfg.get<string>("apiKey")
    if (apiKey != null && apiKey !== "") config.model.apiKey = apiKey
    const baseUrl = cfg.get<string>("baseUrl")
    if (baseUrl != null && baseUrl !== "") config.model.baseUrl = baseUrl
    const temperature = cfg.get<number>("temperature")
    if (typeof temperature === "number" && Number.isFinite(temperature)) {
      config.model.temperature = Math.max(0, Math.min(2, temperature))
    }
    const reasoningEffort = cfg.get<string>("reasoningEffort")
    if (typeof reasoningEffort === "string" && reasoningEffort.trim() !== "") {
      config.model.reasoningEffort = reasoningEffort.trim()
    }
    const contextWindow = cfg.get<number>("contextWindow")
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
      config.model.contextWindow = Math.floor(contextWindow)
    }
    const enableCheckpoints = getConfiguredBoolean("enableCheckpoints")
    if (typeof enableCheckpoints === "boolean") config.checkpoint.enabled = enableCheckpoints
    const autoApproveRead = getConfiguredBoolean("autoApproveRead")
    if (typeof autoApproveRead === "boolean") config.permissions.autoApproveRead = autoApproveRead
    const autoApproveWrite = getConfiguredBoolean("autoApproveWrite")
    if (typeof autoApproveWrite === "boolean") config.permissions.autoApproveWrite = autoApproveWrite
    const autoApproveCommand = getConfiguredBoolean("autoApproveCommand")
    if (typeof autoApproveCommand === "boolean") config.permissions.autoApproveCommand = autoApproveCommand
    const autoApproveMcp = getConfiguredBoolean("autoApproveMcp")
    if (typeof autoApproveMcp === "boolean") config.permissions.autoApproveMcp = autoApproveMcp
    const autoApproveBrowser = getConfiguredBoolean("autoApproveBrowser")
    if (typeof autoApproveBrowser === "boolean") config.permissions.autoApproveBrowser = autoApproveBrowser
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
    this.indexer?.close()
    this.indexer = undefined
    if (!this.config?.indexing.enabled) {
      this.sendIndexStatus({ state: "idle" })
      return
    }
    // Same as server run-session: short timeout so first message is not delayed (Qdrant default is 20s).
    const INDEXER_CREATE_TIMEOUT_MS = 2500
    const projectHash = createHash("sha1").update(cwd).digest("hex").slice(0, 16)
    const fileTrackerJsonPath = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      `nexus-index-tracker-${projectHash}.json`,
    ).fsPath
    this.indexer = await Promise.race([
      createCodebaseIndexer(cwd, this.config, {
        onWarning: (message: string) => console.warn(message),
        onProgress: (message: string) => {
          this.postMessageToWebview({ type: "agentEvent", event: { type: "vector_db_progress", message } })
        },
        maxQdrantWaitMs: INDEXER_CREATE_TIMEOUT_MS,
        listAbsolutePaths: listAbsolutePathsRipgrep,
        fileTrackerJsonPath,
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
    this.abortController?.abort()
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
