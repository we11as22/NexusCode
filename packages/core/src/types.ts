import type { z } from "zod"

// ─── Modes ───────────────────────────────────────────────────────────────────

export type Mode = "agent" | "plan" | "debug" | "ask"

export const MODES: Mode[] = ["agent", "plan", "debug", "ask"]

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
  indexer?: IIndexer
  signal: AbortSignal
}

// ─── Host Interface ───────────────────────────────────────────────────────────

export interface ApprovalAction {
  type: "write" | "execute" | "mcp" | "browser" | "read" | "doom_loop"
  tool: string
  description: string
  content?: string
  diff?: string
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
  resolveAtMention?(mention: string): Promise<string | null>
  getProblems?(): Promise<DiagnosticItem[]>
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
}

export interface IndexSearchOptions {
  limit?: number
  kind?: SymbolKind
  semantic?: boolean
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

export type IndexStatus =
  | { state: "idle" }
  | { state: "indexing"; progress: number; total: number }
  | { state: "ready"; files: number; symbols: number }
  | { state: "error"; error: string }

// ─── Agent Events ─────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "text_delta"; delta: string; messageId: string }
  | { type: "reasoning_delta"; delta: string; messageId: string }
  | { type: "tool_start"; tool: string; partId: string; messageId: string }
  | { type: "tool_end"; tool: string; partId: string; messageId: string; success: boolean }
  | { type: "tool_approval_needed"; action: ApprovalAction; partId: string }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "index_update"; status: IndexStatus }
  | { type: "session_saved"; sessionId: string }
  | { type: "error"; error: string; fatal?: boolean }
  | { type: "done"; messageId: string }
  | { type: "doom_loop_detected"; tool: string }

// ─── Config Types ─────────────────────────────────────────────────────────────

export interface ProviderConfig {
  provider: ProviderName
  id: string
  apiKey?: string
  baseUrl?: string
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
  | "openrouter"
  | "ollama"
  | "openai-compatible"
  | "azure"
  | "bedrock"

export interface EmbeddingConfig {
  provider: "openai" | "openai-compatible" | "ollama" | "local"
  model: string
  baseUrl?: string
  apiKey?: string
  dimensions?: number
}

export interface NexusConfig {
  model: ProviderConfig
  maxMode: ProviderConfig & { enabled: boolean }
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
    debug?: ModeConfig
    ask?: ModeConfig
    [key: string]: ModeConfig | undefined
  }
  indexing: {
    enabled: boolean
    excludePatterns: string[]
    symbolExtract: boolean
    fts: boolean
    vector: boolean
    batchSize: number
    debounceMs: number
  }
  permissions: {
    autoApproveRead: boolean
    autoApproveWrite: boolean
    autoApproveCommand: boolean
    autoApproveReadPatterns: string[]
    denyPatterns: string[]
  }
  checkpoint: {
    enabled: boolean
    timeoutMs: number
    createOnWrite: boolean
  }
  mcp: {
    servers: McpServerConfig[]
  }
  skills: string[]
  tools: {
    custom: string[]
    classifyThreshold: number
    parallelReads: boolean
    maxParallelReads: number
  }
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

export interface McpServerConfig {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: "stdio" | "http" | "sse"
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
