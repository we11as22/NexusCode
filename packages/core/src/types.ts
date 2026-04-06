import type { z } from "zod"

// ─── Modes ───────────────────────────────────────────────────────────────────

export type Mode = "agent" | "plan" | "ask" | "debug" | "review"

export const MODES: Mode[] = ["agent", "plan", "ask", "debug", "review"]

// ─── Permissions ─────────────────────────────────────────────────────────────

export type PermissionAction =
  | "read"
  | "write"
  | "execute"
  | "mcp"
  | "browser"
  | "search"

export interface PermissionResult {
  approved: boolean
  alwaysApprove?: boolean
  /** When true, host should set autoApprove for the rest of the session (e.g. "Skip all") */
  skipAll?: boolean
  /** For Bash: add this command to the project allowlist so it is not asked again in this folder */
  addToAllowedCommand?: string
  /** When set with approved: false, the user declined the action and asked to do this instead; agent continues with this instruction. */
  whatToDoInstead?: string
  /** For Bash: add this command pattern to allowCommandPatterns so matching commands are not asked again in this folder (e.g. "npm run:*"). */
  addToAllowedPattern?: string
  /** For MCP: add this tool name to allowed list so it is not asked again in this folder (e.g. "codex - codex"). */
  addToAllowedMcpTool?: string
}

// ─── Tool Types ───────────────────────────────────────────────────────────────

export interface ToolDef<TArgs = Record<string, unknown>> {
  name: string
  description: string
  parameters: z.ZodType<TArgs>
  /** Short searchable hint used by ToolSearch / deferred-tool discovery. */
  searchHint?: string
  /** When true, the tool may be omitted from the initial prompt and loaded later via ToolSearch. */
  shouldDefer?: boolean
  /** When true, the tool is always included in the initial prompt even if deferred-tool mode is active. */
  alwaysLoad?: boolean
  /** If true, can be executed in parallel with other read-only tools */
  readOnly?: boolean
  /** Which modes this tool is available in. undefined = all modes */
  modes?: Mode[]
  /** If true, always show approval dialog */
  requiresApproval?: boolean
  /**
   * Optional: produce a human-readable validation error from a ZodError.
   * Return value is sent back to the LLM as the tool result so it can self-correct.
   * Pattern from kilocode — include the correct format example in the message.
   */
  formatValidationError?: (error: z.ZodError) => string
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolResult {
  success: boolean
  output: string
  /** Metadata for indexing/rendering */
  metadata?: Record<string, unknown>
  /** Attachments (images, diffs, etc.) */
  attachments?: ToolAttachment[]
}

export interface ToolAttachment {
  type: "image" | "diff" | "file"
  content: string
  mimeType?: string
}

export interface ToolContext {
  cwd: string
  host: IHost
  session: ISession
  config: NexusConfig
  /** Current loop mode (agent / plan / ask). Used e.g. by SpawnAgent to set sub-agent permissions. */
  mode?: Mode
  indexer?: IIndexer
  signal: AbortSignal
  /** Optional: trigger context compaction (condense/summarize_task tools). */
  compactSession?: () => Promise<void>
  /** Current tool call part id (e.g. part_xyz). Set by loop for write/replace so tool can emit tool_approval_needed. */
  partId?: string
  /** Assistant message id for the in-flight tool call (loop); used e.g. to merge sub-agent file edits when part id lookup fails. */
  toolExecutionMessageId?: string
  /**
   * Set by the Parallel tool around batched executes so concurrent SpawnAgent calls are not
   * mistaken for duplicate spawns (shared recentSpawnTasks guard).
   */
  skipSubagentDuplicateCheck?: boolean
  /** All resolved tools for this run (set by loop). Used e.g. by Parallel to run multiple tools in one call. */
  resolvedTools?: ToolDef[]
}

// ─── Host Interface ───────────────────────────────────────────────────────────

export interface ApprovalAction {
  type: "write" | "execute" | "mcp" | "browser" | "read" | "doom_loop"
  tool: string
  description: string
  content?: string
  /** Short human-readable description for approval UI (e.g. "List prompts and built-in tools"). */
  shortDescription?: string
  /** Optional warning to show in approval UI (e.g. "Command contains quoted characters in flag names"). */
  warning?: string
  diff?: string
  /** For write/replace_in_file: lines added and removed, shown in approval UI and after completion. */
  diffStats?: { added: number; removed: number }
}

export interface UserQuestionOption {
  id: string
  label: string
}

export interface UserQuestionItem {
  id: string
  question: string
  options: UserQuestionOption[]
  allowCustom?: boolean
}

export interface UserQuestionRequest {
  requestId: string
  title?: string
  submitLabel?: string
  customOptionLabel?: string
  questions: UserQuestionItem[]
}

export interface UserQuestionAnswer {
  questionId: string
  optionId?: string
  optionLabel?: string
  customText?: string
}

export type LspOperation =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "goToImplementation"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls"

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspLocation {
  path: string
  range: LspRange
  targetSelectionRange?: LspRange
}

export interface LspSymbolRecord {
  name: string
  kind: string
  detail?: string
  path?: string
  range?: LspRange
}

export interface LspCallRecord {
  name: string
  kind?: string
  path: string
  range: LspRange
  selectionRange?: LspRange
  fromRanges?: LspRange[]
}

export interface LspQueryRequest {
  operation: LspOperation
  filePath?: string
  line?: number
  character?: number
  query?: string
}

export interface LspQueryResult {
  operation: LspOperation
  summary: string
  locations?: LspLocation[]
  symbols?: LspSymbolRecord[]
  hover?: string
  calls?: LspCallRecord[]
}

export interface ModeChangeResult {
  success: boolean
  mode: Mode
  message?: string
}

export interface WorkingDirectoryChangeResult {
  success: boolean
  cwd: string
  message?: string
}

export interface McpAuthRequest {
  server: string
  message?: string
  startUrl?: string
}

export interface McpAuthResult {
  success: boolean
  message: string
}

export interface IHost {
  readonly cwd: string
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  deleteFile(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  showDiff(path: string, before: string, after: string): Promise<boolean>
  runCommand(
    command: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
  showApprovalDialog(action: ApprovalAction): Promise<PermissionResult>
  emit(event: AgentEvent): void
  /** Persist command to .nexus/allowed-commands.json for this cwd so it is not asked for approval again */
  addAllowedCommand?(cwd: string, command: string): Promise<void>
  /** Persist command pattern to .nexus/settings.local.json permissions.allow so matching commands are not asked again (e.g. "npm run:*"). */
  addAllowedPattern?(cwd: string, pattern: string): Promise<void>
  /** Persist MCP tool name to project allow list so it is not asked again (e.g. "codex - codex"). */
  addAllowedMcpTool?(cwd: string, toolName: string): Promise<void>
  resolveAtMention?(mention: string): Promise<string | null>
  getProblems?(): Promise<DiagnosticItem[]>
  /** Restore workspace to a checkpoint. Optional if host has no checkpoint. */
  restoreCheckpoint?(hash: string): Promise<void>
  /** List checkpoint entries for UI. */
  getCheckpointEntries?(): Promise<CheckpointEntry[]>
  /** Get diff between two checkpoints for preview. */
  getCheckpointDiff?(fromHash: string, toHash?: string): Promise<ChangedFile[]>
  /** Called by the loop after a checkpoint is committed so the host can push updated entries to the UI. */
  notifyCheckpointEntriesUpdated?(): void
  /** Host-side mode transition for the next turn/UI state. */
  requestModeChange?(mode: Mode, reason?: string): Promise<ModeChangeResult>
  /** Host-side cwd/worktree transition for subsequent turns. */
  setWorkingDirectory?(cwd: string, reason?: string): Promise<WorkingDirectoryChangeResult>
  /** Rich language-server operations when the current host can provide them (VS Code, IDE bridge, etc.). */
  queryLanguageServer?(request: LspQueryRequest): Promise<LspQueryResult>
  /** Generic MCP auth handoff (open browser / show instructions / complete login). */
  requestMcpAuthentication?(request: McpAuthRequest): Promise<McpAuthResult>

  /**
   * File edit flow: open → [approval] → save or revert.
   * openFileEdit: open diff view (extension) or store pending edit (CLI). Do not write to disk yet.
   * saveFileEdit: commit current pending edit to disk.
   * revertFileEdit: discard pending edit; for new files do not create, for existing restore original (if view was opened).
   */
  openFileEdit?(path: string, options: { originalContent: string; newContent: string; isNewFile: boolean }): Promise<void>
  saveFileEdit?(path: string): Promise<void>
  revertFileEdit?(path: string): Promise<void>
}

export interface DiagnosticItem {
  file: string
  line: number
  col: number
  severity: "error" | "warning" | "info"
  message: string
  source?: string
}

// ─── Session Interface ────────────────────────────────────────────────────────

export interface ISession {
  readonly id: string
  readonly messages: SessionMessage[]
  addMessage(msg: Omit<SessionMessage, "id" | "ts">): SessionMessage
  updateMessage(id: string, updates: Partial<SessionMessage>): void
  addToolPart(messageId: string, part: ToolPart): void
  updateToolPart(messageId: string, partId: string, updates: Partial<ToolPart>): void
  updateTodo(markdown: string): void
  getTodo(): string
  getTokenEstimate(): number
  /** Last full context bar values from agent (session + system + tools); undefined if stale or never recorded. */
  getLastContextUsageSnapshot(): { usedTokens: number; limitTokens: number; percent: number } | undefined
  /** Called by agent loop when emitting context_usage so resume/switch session can show the same numbers. */
  recordContextUsage(snapshot: { usedTokens: number; limitTokens: number; percent: number }): void
  fork(messageId: string): ISession
  /** Rewind chat to timestamp; keeps only messages with ts <= timestamp (for checkpoint restore). */
  rewindToTimestamp(timestamp: number): void
  /** Rewind so that only messages with ts < timestamp remain (for rollback before a message). */
  rewindBeforeTimestamp(timestamp: number): void
  /** Rewind so that only messages strictly before the given message remain. */
  rewindBeforeMessageId(messageId: string): void
  save(): Promise<void>
  load(): Promise<void>
}

export type SessionRole = "user" | "assistant" | "system" | "tool"

export interface SessionMessage {
  id: string
  ts: number
  role: SessionRole
  content: string | MessagePart[]
  /**
   * Optional per-user-message preset name (extension/server may attach).
   * Used to scope skills + MCP/tool visibility for the run that produced the assistant reply.
   */
  presetName?: string
  parentId?: string
  model?: string
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  cost?: number
  /** If true, this message is a compaction summary */
  summary?: boolean
  todo?: string
}

export interface TextPart {
  type: "text"
  text: string
  /** Optional short line shown to the user (progress line); when present, explored block collapses. */
  user_message?: string
}

export interface ReasoningPart {
  type: "reasoning"
  text: string
  reasoningId?: string
  durationMs?: number
  providerMetadata?: Record<string, unknown>
}

/** User message part: image (base64 data URL or raw base64, with mimeType). */
export interface ImagePart {
  type: "image"
  data: string
  mimeType: string
}

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
  /** If true, output has been pruned for compaction */
  compacted?: boolean
  /** Set when tool is Write/Edit and completed; used for session diff (e.g. CLI "N files" block). */
  path?: string
  diffStats?: { added: number; removed: number }
  /** Copied from sub-agent session into parent for diff; omit from chat tool rows (CLI). */
  mergedFromSubagent?: boolean
}

export type MessagePart = TextPart | ToolPart | ReasoningPart | ImagePart

// ─── Orchestration Types ─────────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "killed"
  | "cancelled"
  | "deleted"

export interface TaskRecord {
  id: string
  subject: string
  description: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  activeForm?: string
  owner?: string
  teamName?: string
  metadata?: Record<string, unknown>
  blocks?: string[]
  blockedBy?: string[]
  outputFile?: string
  toolUseId?: string
}

export interface TeamMessageRecord {
  id: string
  ts: number
  from: string
  to: string
  message: string
  teamName?: string
}

export interface TeamMemberRecord {
  name: string
  agentId?: string
  agentType?: string
  joinedAt: number
}

export interface TeamRecord {
  name: string
  description: string
  createdAt: number
  members: TeamMemberRecord[]
  messages: TeamMessageRecord[]
}

export interface AgentDefinition {
  agentType: string
  whenToUse: string
  systemPrompt?: string
  tools?: string[]
  disallowedTools?: string[]
  sourcePath?: string
  builtin?: boolean
}

export type BackgroundTaskKind = "bash" | "subagent" | "workflow" | "external"
export type BackgroundTaskStatus = "pending" | "running" | "completed" | "failed" | "killed"

export interface BackgroundTaskRecord {
  id: string
  kind: BackgroundTaskKind
  description: string
  createdAt: number
  updatedAt: number
  status: BackgroundTaskStatus
  command?: string
  cwd?: string
  processId?: number
  exitCode?: number
  logPath?: string
  outputFile?: string
  output?: string
  error?: string
  sessionId?: string
  metadata?: Record<string, unknown>
}

export interface RemoteSessionRecord {
  id: string
  url: string
  sessionId?: string
  runId?: string
  status: "connecting" | "connected" | "reconnecting" | "disconnected" | "completed" | "error"
  createdAt: number
  updatedAt: number
  lastEventSeq?: number
  reconnectAttempts?: number
  reconnectable?: boolean
  error?: string
  viewerOnly?: boolean
  metadata?: Record<string, unknown>
}

export interface WorktreeSession {
  id: string
  originalCwd: string
  worktreePath: string
  branch: string
  createdAt: number
  status: "active" | "kept" | "removed" | "error"
  metadata?: Record<string, unknown>
}

export interface DeferredToolDef {
  name: string
  description: string
  searchHint?: string
}

export interface MemoryRecord {
  id: string
  scope: "session" | "project" | "team"
  title: string
  content: string
  createdAt: number
  updatedAt: number
  metadata?: Record<string, unknown>
}

export interface PluginManifestRecord {
  name: string
  version?: string
  description: string
  commands: string[]
  agents: string[]
  skills: string[]
  hooks: string[]
  mcpServers: string[]
  enabled: boolean
  rootDir: string
  sourcePath: string
  scope: "project" | "global"
  settingsSchema?: Record<string, unknown>
  warnings?: string[]
  trusted?: boolean
  runtimeEnabled?: boolean
  options?: Record<string, unknown>
}

// ─── Indexer Interface ────────────────────────────────────────────────────────

export interface IIndexer {
  search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]>
  status(): IndexStatus
  refreshFile?(filePath: string): Promise<void>
  refreshFileNow?(filePath: string): Promise<void>
  /** Batched incremental refresh (single tracker load/save). */
  refreshFilesBatchNow?(absPaths: string[]): Promise<void>
  /**
   * True when Qdrant + embeddings are actually wired (not only indexing.vector in YAML).
   * Used by CodebaseSearch to explain YAML vs runtime mismatch.
   */
  semanticSearchActive?(): boolean
  /** Pause full workspace indexing between parse/embed steps (Settings). */
  pauseIndexing?(): void
  resumeIndexing?(): void
  /** Incremental index run without clearing tracker/Qdrant (one index per workspace). */
  syncIndexing?(): Promise<void>
  /** Clear tracker + collection and re-index from scratch. */
  fullRebuildIndex?(): Promise<void>
  /** Remove indexed data for paths under this repo-relative prefix only. */
  deleteIndexScope?(relPathOrAbs: string): Promise<void>
  /** Clear all index data for the workspace (tracker + vector collection). */
  deleteIndex?(): Promise<void>
}

export interface IndexSearchOptions {
  limit?: number
  kind?: SymbolKind
  semantic?: boolean
  /** Scope search to paths under this prefix (relative to project root). Can be multiple. */
  pathScope?: string | string[]
}

export interface IndexSearchResult {
  path: string
  name?: string
  kind?: SymbolKind
  parent?: string
  startLine?: number
  endLine?: number
  content: string
  score?: number
}

export type SymbolKind =
  | "class"
  | "function"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "arrow"
  | "chunk"

/** Used by AST extractor and vector indexer for symbol/chunk entries. */
export interface SymbolEntry {
  path: string
  name: string
  kind: SymbolKind
  parent?: string
  startLine: number
  endLine: number
  docstring?: string
  content: string
  /** Semantic chunk hash — stable vector point id when present. */
  segmentHash?: string
}

export type IndexStatus =
  | { state: "idle" }
  | { state: "stopping"; message?: string }
  | {
      state: "indexing"
      progress: number
      total: number
      chunksProcessed?: number
      chunksTotal?: number
      /** Without vector: files parsed / total files. With vector: chunks indexed / max(found, indexed) — Roo-style block ratio. */
      overallPercent?: number
      phase?: "parsing" | "embedding"
      message?: string
      /** Debounced file-watcher batch (Roo-style queue line), not full `startIndexing` scan. */
      watcherQueue?: boolean
      paused?: boolean
    }
  | { state: "ready"; files: number; symbols: number; chunks?: number }
  | { state: "error"; error: string }

// ─── Agent Events ─────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "assistant_message_started"; messageId: string }
  | { type: "assistant_content_complete"; messageId: string }
  | { type: "text_delta"; delta: string; messageId: string; user_message_delta?: string }
  | { type: "reasoning_start"; messageId: string; reasoningId: string; providerMetadata?: Record<string, unknown> }
  | { type: "reasoning_delta"; delta: string; messageId: string; reasoningId?: string; providerMetadata?: Record<string, unknown> }
  | { type: "reasoning_end"; messageId: string; reasoningId?: string; providerMetadata?: Record<string, unknown> }
  | { type: "tool_start"; tool: string; partId: string; messageId: string; input?: Record<string, unknown> }
  | { type: "tool_end"; tool: string; partId: string; messageId: string; success: boolean; output?: string; error?: string; compacted?: boolean; path?: string; writtenContent?: string; diffStats?: { added: number; removed: number }; diffHunks?: Array<{ type: string; lineNum: number; line: string }>; appliedReplacements?: Array<{ oldSnippet: string; newSnippet: string }>; metadata?: Record<string, unknown> }
  | { type: "subagent_start"; subagentId: string; mode: Mode; task: string; parentPartId?: string }
  | { type: "subagent_tool_start"; subagentId: string; tool: string; input?: Record<string, unknown>; parentPartId?: string }
  | { type: "subagent_tool_end"; subagentId: string; tool: string; success: boolean; parentPartId?: string }
  | { type: "subagent_done"; subagentId: string; success: boolean; outputPreview?: string; error?: string; parentPartId?: string }
  | { type: "tool_approval_needed"; action: ApprovalAction; partId: string }
  | { type: "question_request"; request: UserQuestionRequest; partId?: string }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "index_update"; status: IndexStatus }
  | { type: "vector_db_progress"; message?: string }
  | { type: "vector_db_ready" }
  | { type: "session_saved"; sessionId: string }
  | { type: "context_usage"; usedTokens: number; limitTokens: number; percent: number }
  | { type: "error"; error: string; fatal?: boolean }
  | { type: "done"; messageId: string }
  | { type: "todo_updated"; todo: string }
  | { type: "doom_loop_detected"; tool: string }
  | { type: "plan_followup_ask"; planText: string }
  | { type: "task_updated"; task: TaskRecord }
  | { type: "team_updated"; team: TeamRecord }
  | { type: "team_message"; message: TeamMessageRecord }
  | { type: "background_task_updated"; task: BackgroundTaskRecord }
  | { type: "remote_session_updated"; remoteSession: RemoteSessionRecord }
  | { type: "plugin_hook"; pluginName: string; hookEvent: string; output: string; success: boolean }

// ─── Config Types ─────────────────────────────────────────────────────────────

export interface ProviderConfig {
  provider: ProviderName
  id: string
  apiKey?: string
  baseUrl?: string
  /**
   * Sampling temperature for generation. 0 = deterministic.
   * Most providers support range [0, 2].
   */
  temperature?: number
  /**
   * Optional reasoning effort hint for reasoning-capable models.
   * Supported values depend on provider/model (e.g. low/medium/high/minimal/none/max).
   */
  reasoningEffort?: string
  /**
   * Prior assistant reasoning on the next LLM request (KiloCode-style).
   * `auto` uses model heuristics (e.g. DeepSeek → `reasoning_content` on the message).
   */
  reasoningHistoryMode?: "auto" | "inline" | "reasoning_content" | "reasoning_details"
  /** Optional explicit context window override in tokens for this model. */
  contextWindow?: number
  /** Azure-specific */
  resourceName?: string
  deploymentId?: string
  apiVersion?: string
  /** Extra provider options */
  extra?: Record<string, unknown>
}

export type ProviderName =
  | "anthropic"
  | "openai"
  | "google"
  | "ollama"
  | "openai-compatible"
  | "azure"
  | "bedrock"
  | "groq"
  | "mistral"
  | "xai"
  | "deepinfra"
  | "cerebras"
  | "cohere"
  | "togetherai"
  | "perplexity"
  | "minimax"

export interface EmbeddingConfig {
  provider: "openai" | "openai-compatible" | "openrouter" | "ollama" | "google" | "mistral" | "bedrock" | "local"
  model: string
  baseUrl?: string
  apiKey?: string
  dimensions?: number
  region?: string
}

export interface NexusConfig {
  model: ProviderConfig
  embeddings?: EmbeddingConfig
  vectorDb?: {
    enabled: boolean
    url: string
    collection: string
    autoStart: boolean
    apiKey?: string
    upsertWait?: boolean
    searchMinScore?: number
    searchHnswEf?: number
    searchExact?: boolean
  }
  modes: {
    agent?: ModeConfig
    plan?: ModeConfig
    ask?: ModeConfig
    debug?: ModeConfig
    review?: ModeConfig
    [key: string]: ModeConfig | undefined
  }
  indexing: {
    enabled: boolean
    excludePatterns: string[]
    symbolExtract: boolean
    vector: boolean
    batchSize: number
    embeddingBatchSize: number
    embeddingConcurrency: number
    maxPendingEmbedBatches: number
    batchProcessingConcurrency: number
    maxIndexedFiles: number
    searchWhileIndexing: boolean
    maxIndexingFailureRate: number
    debounceMs: number
    codebaseSearchSnippetMaxChars: number
  }
  permissions: {
    autoApproveRead: boolean
    autoApproveWrite: boolean
    autoApproveCommand: boolean
    autoApproveMcp?: boolean
    autoApproveBrowser?: boolean
    /** Default true: skill loads without approval. Set false for Kilo-style confirmation. */
    autoApproveSkillLoad?: boolean
    autoApproveReadPatterns: string[]
    /** Commands allowed without approval for this project (from .nexus/allowed-commands.json) */
    allowedCommands: string[]
    /** Command patterns from .nexus/settings.json + settings.local.json (allow = no approval) */
    allowCommandPatterns: string[]
    /** MCP tool names allowed without approval for this project */
    allowedMcpTools?: string[]
    /** Command patterns that always require approval (deny list) */
    denyCommandPatterns: string[]
    /** Command patterns that always ask (ask list) */
    askCommandPatterns: string[]
    denyPatterns: string[]
    /** Fine-grained permission rules evaluated in order, first match wins */
    rules: PermissionRule[]
  }
  retry: RetryConfig
  checkpoint: {
    enabled: boolean
    timeoutMs: number
    createOnWrite: boolean
    /** When true, first completion attempt (agent) is rejected; model must re-verify and complete again. */
    doubleCheckCompletion?: boolean
  }
  /** UI preferences (e.g. chat pane). */
  ui?: {
    /** When true, streamed text_delta is shown in chat as muted/small; when false, only tool-written text is shown. */
    showReasoningInChat?: boolean
  }
  mcp: {
    servers: McpServerConfig[]
  }
  /** Normalized list for UI: path + enabled. skills is derived (enabled only). */
  skillsConfig?: Array<{ path: string; enabled: boolean }>
  skills: string[]
  /** Remote skill index URLs (optional). */
  skillsUrls?: string[]
  tools: {
    custom: string[]
    classifyToolsEnabled: boolean
    classifyThreshold: number
    parallelReads: boolean
    maxParallelReads: number
    /** Deferred tool loading strategy. auto = use ToolSearch only when deferred tools are materially large. */
    deferredLoadingMode?: "auto" | "always" | "never"
    /** In auto mode, defer tool schemas once deferred tools exceed this fraction of model context. */
    deferredLoadingThresholdPercent?: number
    /** In auto mode, always defer once at least this many tools are marked shouldDefer. */
    deferredLoadingMinimumTools?: number
  }
  skillClassifyEnabled: boolean
  skillClassifyThreshold: number
  structuredOutput: "auto" | "always" | "never"
  summarization: {
    auto: boolean
    threshold: number
    keepRecentMessages: number
    model: string
  }
  parallelAgents: {
    maxParallel: number
    maxTasksPerCall?: number
  }
  compatibility?: {
    claude?: {
      enabled?: boolean
      includeGlobalDir?: boolean
      includeProjectDir?: boolean
      includeLocalInstructions?: boolean
      includeRules?: boolean
      includeSettings?: boolean
      includeCommands?: boolean
      includeSkills?: boolean
      includeAgents?: boolean
      includePlugins?: boolean
    }
  }
  plugins?: {
    enabled?: boolean
    trusted?: string[]
    blocked?: string[]
    enableHooks?: boolean
    hookTimeoutMs?: number
    options?: Record<string, Record<string, unknown>>
  }
  /** Optional overrides for agent loop limits (tool budget and max iterations per mode). */
  agentLoop?: {
    toolCallBudget?: Partial<Record<Mode, number>>
    maxIterations?: Partial<Record<Mode, number>>
  }
  rules: {
    files: string[]
  }
  profiles: Record<string, Partial<ProviderConfig>>
}

export interface ModeConfig {
  autoApprove?: PermissionAction[]
  systemPrompt?: string
  customInstructions?: string
}

// ─── Permission Rules ─────────────────────────────────────────────────────────

export type PermissionRuleAction = "allow" | "deny" | "ask"

export interface PermissionRule {
  /** Tool name or glob pattern matching tool names */
  tool?: string
  /** Path pattern (glob) to match against file args */
  pathPattern?: string
  /** Regex to match against command args */
  commandPattern?: string
  /** Action to take when rule matches */
  action: PermissionRuleAction
  /** Human-readable reason for the rule */
  reason?: string
}

// ─── Retry Config ─────────────────────────────────────────────────────────────

export interface RetryConfig {
  enabled: boolean
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  /** HTTP status codes that trigger retry */
  retryOnStatus: number[]
}

export interface McpServerConfig {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Working directory for stdio MCP server process. */
  cwd?: string
  url?: string
  /** Remote transport. `http` = Streamable HTTP (MCP spec). `sse` = legacy SSE+POST. */
  transport?: "stdio" | "http" | "sse"
  /**
   * Roo / external configs: `streamable-http` | `sse` | `stdio`.
   * Used when `transport` is omitted (URL servers default to SSE unless type says streamable-http).
   */
  type?: "stdio" | "sse" | "streamable-http" | "http"
  /** Extra headers for SSE / Streamable HTTP (e.g. Authorization). */
  headers?: Record<string, string>
  enabled?: boolean
  /** Resolve to a bundled MCP server (e.g. "context-mode") when nexusRoot is set by host */
  bundle?: string
  auth?: {
    type?: "oauth" | "url" | "manual"
    startUrl?: string
    message?: string
  }
}

// ─── Skill Types ───────────────────────────────────────────────────────────────

export interface SkillDef {
  name: string
  path: string
  /** Short description (YAML `description` or first heading / line). */
  summary: string
  content: string
}

// ─── Checkpoint ───────────────────────────────────────────────────────────────

export interface CheckpointEntry {
  hash: string
  ts: number
  messageId: string
  description?: string
}

export interface ChangedFile {
  path: string
  before: string
  after: string
  status: "added" | "modified" | "deleted"
}
