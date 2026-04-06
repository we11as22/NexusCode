import { z } from "zod"

const PROVIDER_NAMES = [
  "anthropic", "openai", "google", "ollama", "openai-compatible",
  "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras",
  "cohere", "togetherai", "perplexity", "minimax",
] as const

const providerSchema = z.object({
  provider: z.enum(PROVIDER_NAMES),
  id: z.string().min(1),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Reasoning effort hint for reasoning-capable models. "auto" (default) enables thinking only for known reasoning models. */
  reasoningEffort: z.string().default("auto"),
  /**
   * How stored assistant reasoning is sent on the next request (KiloCode-style).
   * `auto` hoists to `reasoning_content` for e.g. DeepSeek; otherwise keeps native `reasoning` parts in message content.
   */
  reasoningHistoryMode: z
    .enum(["auto", "inline", "reasoning_content", "reasoning_details"])
    .default("auto"),
  /** Optional explicit context window size override (tokens). */
  contextWindow: z.number().int().positive().optional(),
  resourceName: z.string().optional(),
  deploymentId: z.string().optional(),
  apiVersion: z.string().optional(),
  extra: z.record(z.unknown()).optional(),
})

const embeddingSchema = z.object({
  provider: z.enum(["openai", "openai-compatible", "openrouter", "ollama", "google", "mistral", "bedrock", "local"]),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
  /** AWS region for Bedrock */
  region: z.string().optional(),
})

const modeConfigSchema = z.object({
  autoApprove: z.array(z.enum(["read", "write", "execute", "mcp", "browser", "search"])).optional(),
  systemPrompt: z.string().optional(),
  customInstructions: z.string().optional(),
})

const mcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  transport: z.enum(["stdio", "http", "sse"]).optional(),
  type: z.enum(["stdio", "sse", "streamable-http", "http"]).optional(),
  headers: z.record(z.string()).optional(),
  enabled: z.boolean().optional().default(true),
  /** Bundled server id (e.g. "context-mode"); resolved by host to command/args/env */
  bundle: z.string().optional(),
  auth: z.object({
    type: z.enum(["oauth", "url", "manual"]).optional(),
    startUrl: z.string().optional(),
    message: z.string().optional(),
  }).optional(),
})

export const NexusConfigSchema = z.object({
  model: providerSchema.default({
    provider: "openai-compatible",
    id: "minimax/minimax-m2.5:free",
    baseUrl: "https://api.kilo.ai/api/openrouter",
  }),

  embeddings: embeddingSchema.optional(),

  vectorDb: z.object({
    /** Disabled by default. Set to true to enable vector codebase search (requires Qdrant + embeddings). */
    enabled: z.boolean().default(false),
    url: z.string().default("http://localhost:6333"),
    collection: z.string().default("nexus"),
    autoStart: z.boolean().default(true),
    /** Qdrant API key (e.g. Qdrant Cloud). Also read from env `QDRANT_API_KEY` when unset. */
    apiKey: z.string().optional(),
    /** Wait for Qdrant to persist upserts/deletes (recommended). */
    upsertWait: z.boolean().default(true),
    /** Minimum similarity score (0–1 for cosine) for search hits. Omit for no threshold (legacy behavior). */
    searchMinScore: z.number().min(0).max(1).optional(),
    /** HNSW `ef` at query time (higher → better recall, slower). Default 128. */
    searchHnswEf: z.number().int().positive().optional(),
    /** Exhaustive/exact vector search (slower). */
    searchExact: z.boolean().optional(),
  }).optional(),

  modes: z.object({
    agent: modeConfigSchema.optional(),
    plan: modeConfigSchema.optional(),
    ask: modeConfigSchema.optional(),
    debug: modeConfigSchema.optional(),
    review: modeConfigSchema.optional(),
  }).catchall(modeConfigSchema.optional()).default({}),

  indexing: z.object({
    enabled: z.boolean().default(true),
    excludePatterns: z.array(z.string()).default([
      "node_modules/**", ".git/**", "dist/**", "build/**",
      "*.lock", ".next/**", ".nuxt/**", "coverage/**", ".nexus/**",
    ]),
    symbolExtract: z.boolean().default(true),
    /** Disabled by default. Set to true with vectorDb.enabled to use semantic codebase_search. */
    vector: z.boolean().default(false),
    batchSize: z.number().int().positive().default(50),
    /** Min semantic segments per embed/upsert batch (Roo-style segment threshold). */
    embeddingBatchSize: z.number().int().positive().default(60),
    embeddingConcurrency: z.number().int().positive().default(2),
    /** Max embed batches in flight while parsing (backpressure / memory). */
    maxPendingEmbedBatches: z.number().int().positive().default(20),
    /** Parallel embed/upsert pipelines (batches). */
    batchProcessingConcurrency: z.number().int().positive().default(10),
    /**
     * Max indexable files per workspace. Roo parity: **0 = scan nothing** (same as `listFiles(..., 0)`).
     * Use a large positive value if you need an effectively unlimited tree. Default 50_000 matches Roo.
     */
    maxIndexedFiles: z.number().int().min(0).default(50_000),
    /**
     * Allow CodebaseSearch while indexing is in progress when Qdrant already has points (partial results).
     * Default true. Set false to wait until `markIndexingComplete` (strict consistency).
     */
    searchWhileIndexing: z.boolean().default(true),
    /**
     * If >0, indexing is treated as failed when more than this fraction of chunks could not be embedded
     * (after retries). Triggers index + tracker reset (Roo-style).
     */
    maxIndexingFailureRate: z.number().min(0).max(1).default(0.1),
    debounceMs: z.number().int().positive().default(800),
    /** Max characters of each hit’s code snippet in CodebaseSearch output (indexed payload is capped separately). */
    codebaseSearchSnippetMaxChars: z.number().int().positive().max(50_000).default(4000),
  }).default({}),

  permissions: z.object({
    autoApproveRead: z.boolean().default(true),
    autoApproveWrite: z.boolean().default(false),
    autoApproveCommand: z.boolean().default(false),
    autoApproveMcp: z.boolean().default(false),
    autoApproveBrowser: z.boolean().default(false),
    /** When false, loading a skill via `Skill` shows an approval dialog (Kilo-style). Default true = no prompt. */
    autoApproveSkillLoad: z.boolean().default(true),
    autoApproveReadPatterns: z.array(z.string()).default([
    ".nexus/tool-output/**",
    "**/.nexus/data/tool-output/**",
    "**/.nexus/data/run/**",
  ]),
    /** Commands allowed without approval for this project (stored in .nexus/allowed-commands.json) */
    allowedCommands: z.array(z.string()).default([]),
    /** Command patterns from .nexus/settings.json + settings.local.json */
    allowCommandPatterns: z.array(z.string()).default([]),
    /** MCP tool names allowed without approval for this project (e.g. ["codex - codex"]) */
    allowedMcpTools: z.array(z.string()).default([]),
    denyCommandPatterns: z.array(z.string()).default([]),
    askCommandPatterns: z.array(z.string()).default([]),
    denyPatterns: z.array(z.string()).default(["**/.env", "**/secrets/**", "**/*.key", "**/*.pem"]),
    rules: z.array(z.object({
      tool: z.string().optional(),
      pathPattern: z.string().optional(),
      commandPattern: z.string().optional(),
      action: z.enum(["allow", "deny", "ask"]),
      reason: z.string().optional(),
    })).default([]),
  }).default({}),

  retry: z.object({
    enabled: z.boolean().default(true),
    maxAttempts: z.number().int().positive().default(3),
    initialDelayMs: z.number().int().positive().default(1000),
    maxDelayMs: z.number().int().positive().default(30000),
    retryOnStatus: z.array(z.number().int()).default([429, 500, 502, 503, 504]),
  }).default({}),

  checkpoint: z.object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(15000),
    createOnWrite: z.boolean().default(true),
    doubleCheckCompletion: z.boolean().default(false),
  }).default({}),

  /** UI preferences (e.g. chat pane). */
  ui: z.object({
    /** When true, streamed text_delta is shown in chat as muted/small "reasoning"; when false, only final assistant text is shown. */
    showReasoningInChat: z.boolean().default(false),
  }).default({}),

  mcp: z.object({
    servers: z.array(mcpServerSchema).default([]),
  }).default({}),

  skills: z.array(z.union([
    z.string(),
    z.object({ path: z.string(), enabled: z.boolean().optional() }),
  ])).default([]),

  /** Remote skill registries (base URL → index.json + files), cached under ~/.nexus/cache/skills/. */
  skillsUrls: z.array(z.string()).optional(),

  tools: z.object({
    custom: z.array(z.string()).default([]),
    /** When true, use LLM to filter which MCP servers to use when server count > classifyThreshold. Default off. */
    classifyToolsEnabled: z.boolean().default(false),
    /** Threshold: when MCP server count exceeds this, classifier selects which servers to use. Default 20. */
    classifyThreshold: z.number().int().positive().default(20),
    parallelReads: z.boolean().default(true),
    maxParallelReads: z.number().int().positive().default(5),
    /** Deferred tool loading strategy for MCP/custom heavy tools. */
    deferredLoadingMode: z.enum(["auto", "always", "never"]).default("auto"),
    /** In auto mode, switch to ToolSearch when deferred tools exceed this fraction of context. */
    deferredLoadingThresholdPercent: z.number().min(0.01).max(1).default(0.10),
    /** In auto mode, always defer once this many tools are marked shouldDefer. */
    deferredLoadingMinimumTools: z.number().int().positive().default(8),
  }).default({}),

  /** When true, use LLM to filter skills by task when count > skillClassifyThreshold. Default off. */
  skillClassifyEnabled: z.boolean().default(false),
  /** Threshold for skill classification. Default 20. */
  skillClassifyThreshold: z.number().int().positive().default(20),

  structuredOutput: z.enum(["auto", "always", "never"]).default("auto"),

  summarization: z.object({
    auto: z.boolean().default(true),
    threshold: z.number().min(0.1).max(1).default(0.80),
    keepRecentMessages: z.number().int().positive().default(8),
    model: z.string().default(""),
  }).default({}),

  parallelAgents: z.object({
    maxParallel: z.number().int().positive().default(4),
    /** Deprecated: old SpawnAgents multi-task setting. Parallel sub-agent batching now uses Parallel + SpawnAgent calls. */
    maxTasksPerCall: z.number().int().positive().default(12),
  }).default({}),

  compatibility: z.object({
    claude: z.object({
      enabled: z.boolean().default(false),
      includeGlobalDir: z.boolean().default(true),
      includeProjectDir: z.boolean().default(true),
      includeLocalInstructions: z.boolean().default(true),
      includeRules: z.boolean().default(true),
      includeSettings: z.boolean().default(true),
      includeCommands: z.boolean().default(true),
      includeSkills: z.boolean().default(true),
      includeAgents: z.boolean().default(true),
      includePlugins: z.boolean().default(true),
    }).default({}),
  }).default({}),

  plugins: z.object({
    enabled: z.boolean().default(true),
    trusted: z.array(z.string()).default([]),
    blocked: z.array(z.string()).default([]),
    enableHooks: z.boolean().default(true),
    hookTimeoutMs: z.number().int().positive().max(300000).default(15000),
    options: z.record(z.record(z.unknown())).default({}),
  }).default({}),

  /** Optional overrides for agent loop limits (OpenCode-style: allow enough tools/iterations to finish). */
  agentLoop: z.object({
    toolCallBudget: z.object({
      ask: z.number().int().positive().optional(),
      plan: z.number().int().positive().optional(),
      agent: z.number().int().positive().optional(),
      debug: z.number().int().positive().optional(),
      review: z.number().int().positive().optional(),
    }).optional(),
    maxIterations: z.object({
      ask: z.number().int().positive().optional(),
      plan: z.number().int().positive().optional(),
      agent: z.number().int().positive().optional(),
      debug: z.number().int().positive().optional(),
      review: z.number().int().positive().optional(),
    }).optional(),
  }).default({}),

  rules: z.object({
    files: z.array(z.string()).default(["NEXUS.md", "AGENTS.md", "CLAUDE.md", ".nexus/rules/**"]),
  }).default({}),

  profiles: z.record(providerSchema.partial()).default({}),
})

export type NexusConfigInput = z.input<typeof NexusConfigSchema>
