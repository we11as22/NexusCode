import type { z } from "zod"

// ─── Modes ───────────────────────────────────────────────────────────────────

export type Mode = "agent" | "plan" | "ask" | "debug"

export const MODES: Mode[] = ["agent", "plan", "ask", "debug"]

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
  /** For execute_command: add this command to the project allowlist so it is not asked again in this folder */
  addToAllowedCommand?: string
  /** When set with approved: false, the user declined the action and asked to do this instead; agent continues with this instruction. */
  whatToDoInstead?: string
}

// ─── Tool Types ───────────────────────────────────────────────────────────────

export interface ToolDef<TArgs = Record<string, unknown>> {
  name: string
  description: string
  parameters: z.ZodType<TArgs>
  /** If true, can be executed in parallel with other read-only tools */
  readOnly?: boolean
  /** Which modes this tool is available in. undefined = all modes */
  modes?: Mode[]
  /** If true, always show approval dialog */
  requiresApproval?: boolean
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
  /** Current loop mode (agent / plan / ask). Used e.g. by spawn_agent to set sub-agent permissions. */
  mode?: Mode
  indexer?: IIndexer
  signal: AbortSignal
  /** Optional: trigger context compaction (condense/summarize_task tools). */
  compactSession?: () => Promise<void>
  /** Current tool call part id (e.g. part_xyz). Set by loop for write/replace so tool can emit tool_approval_needed. */
  partId?: string
}

// ─── Host Interface ───────────────────────────────────────────────────────────

export interface ApprovalAction {
  type: "write" | "execute" | "mcp" | "browser" | "read" | "doom_loop"
  tool: string
  description: string
  content?: string
  diff?: string
  /** For write/replace_in_file: lines added and removed, shown in approval UI and after completion. */
  diffStats?: { added: number; removed: number }
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
  resolveAtMention?(mention: string): Promise<string | null>
  getProblems?(): Promise<DiagnosticItem[]>
  /** Restore workspace to a checkpoint (Cline-style). Optional if host has no checkpoint. */
  restoreCheckpoint?(hash: string): Promise<void>
  /** List checkpoint entries for UI. */
  getCheckpointEntries?(): Promise<CheckpointEntry[]>
  /** Get diff between two checkpoints for preview. */
  getCheckpointDiff?(fromHash: string, toHash?: string): Promise<ChangedFile[]>
  /** Called by the loop after a checkpoint is committed so the host can push updated entries to the UI. */
  notifyCheckpointEntriesUpdated?(): void

  /**
   * Roo/Cline-style file edit flow: open → [approval] → save or revert.
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
  fork(messageId: string): ISession
  /** Rewind chat to timestamp; keeps only messages with ts <= timestamp (for checkpoint restore). */
  rewindToTimestamp(timestamp: number): void
  save(): Promise<void>
  load(): Promise<void>
}

export type SessionRole = "user" | "assistant" | "system" | "tool"

export interface SessionMessage {
  id: string
  ts: number
  role: SessionRole
  content: string | MessagePart[]
  parentId?: string
  model?: string
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  cost?: number
  /** If true, this message is a compaction summary */
  summary?: boolean
  todo?: string
}

export type MessagePart = TextPart | ToolPart | ReasoningPart

export interface TextPart {
  type: "text"
  text: string
  /** Optional short line shown to the user (progress line); when present, explored block collapses. */
  user_message?: string
}

export interface ReasoningPart {
  type: "reasoning"
  text: string
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
}

// ─── Indexer Interface ────────────────────────────────────────────────────────

export interface IIndexer {
  search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]>
  status(): IndexStatus
  refreshFile?(filePath: string): Promise<void>
  refreshFileNow?(filePath: string): Promise<void>
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
}

export type IndexStatus =
  | { state: "idle" }
  | { state: "indexing"; progress: number; total: number; chunksProcessed?: number; chunksTotal?: number }
  | { state: "ready"; files: number; symbols: number; chunks?: number }
  | { state: "error"; error: string }

// ─── Agent Events ─────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "assistant_message_started"; messageId: string }
  | { type: "text_delta"; delta: string; messageId: string; user_message_delta?: string }
  | { type: "reasoning_delta"; delta: string; messageId: string }
  | { type: "tool_start"; tool: string; partId: string; messageId: string; input?: Record<string, unknown> }
  | { type: "tool_end"; tool: string; partId: string; messageId: string; success: boolean; output?: string; error?: string; compacted?: boolean; path?: string; writtenContent?: string; diffStats?: { added: number; removed: number }; diffHunks?: Array<{ type: string; lineNum: number; line: string }> }
  | { type: "subagent_start"; subagentId: string; mode: Mode; task: string }
  | { type: "subagent_tool_start"; subagentId: string; tool: string }
  | { type: "subagent_tool_end"; subagentId: string; tool: string; success: boolean }
  | { type: "subagent_done"; subagentId: string; success: boolean; outputPreview?: string; error?: string }
  | { type: "tool_approval_needed"; action: ApprovalAction; partId: string }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "index_update"; status: IndexStatus }
  | { type: "session_saved"; sessionId: string }
  | { type: "context_usage"; usedTokens: number; limitTokens: number; percent: number }
  | { type: "error"; error: string; fatal?: boolean }
  | { type: "done"; messageId: string }
  | { type: "todo_updated"; todo: string }
  | { type: "doom_loop_detected"; tool: string }
  | { type: "plan_followup_ask"; planText: string }

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
  }
  modes: {
    agent?: ModeConfig
    plan?: ModeConfig
    ask?: ModeConfig
    debug?: ModeConfig
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
    debounceMs: number
  }
  permissions: {
    autoApproveRead: boolean
    autoApproveWrite: boolean
    autoApproveCommand: boolean
    autoApproveMcp?: boolean
    autoApproveBrowser?: boolean
    autoApproveReadPatterns: string[]
    /** Commands allowed without approval for this project (from .nexus/allowed-commands.json) */
    allowedCommands: string[]
    /** Command patterns from .nexus/settings.json + settings.local.json (allow = no approval) */
    allowCommandPatterns: string[]
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
    /** When true, first final_report_to_user (agent) is rejected; model must re-verify and call again (Cline-style). */
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
  tools: {
    custom: string[]
    classifyToolsEnabled: boolean
    classifyThreshold: number
    parallelReads: boolean
    maxParallelReads: number
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
  url?: string
  transport?: "stdio" | "http" | "sse"
  enabled?: boolean
  /** Resolve to a bundled MCP server (e.g. "context-mode") when nexusRoot is set by host */
  bundle?: string
}

// ─── Skill Types ───────────────────────────────────────────────────────────────

export interface SkillDef {
  name: string
  path: string
  /** First non-empty line as summary */
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
