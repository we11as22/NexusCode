import { z } from "zod"

const PROVIDER_NAMES = [
  "anthropic", "openai", "google", "ollama", "openai-compatible",
  "azure", "bedrock", "groq", "mistral", "xai", "deepinfra", "cerebras",
  "cohere", "togetherai", "perplexity",
] as const

const providerSchema = z.object({
  provider: z.enum(PROVIDER_NAMES),
  id: z.string().min(1),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
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
  url: z.string().optional(),
  transport: z.enum(["stdio", "http", "sse"]).optional(),
  enabled: z.boolean().optional().default(true),
  /** Bundled server id (e.g. "context-mode"); resolved by host to command/args/env */
  bundle: z.string().optional(),
})

export const NexusConfigSchema = z.object({
  model: providerSchema.default({
    provider: "openai-compatible",
    id: "minimax/minimax-m2.5:free",
    baseUrl: "https://api.kilo.ai/api/gateway",
  }),

  embeddings: embeddingSchema.optional(),

  vectorDb: z.object({
    /** Disabled by default. Set to true to enable vector codebase search (requires Qdrant + embeddings). */
    enabled: z.boolean().default(false),
    url: z.string().default("http://localhost:6333"),
    collection: z.string().default("nexus"),
    autoStart: z.boolean().default(true),
  }).optional(),

  modes: z.object({
    agent: modeConfigSchema.optional(),
    plan: modeConfigSchema.optional(),
    ask: modeConfigSchema.optional(),
    debug: modeConfigSchema.optional(),
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
    embeddingBatchSize: z.number().int().positive().default(60),
    embeddingConcurrency: z.number().int().positive().default(2),
    debounceMs: z.number().int().positive().default(800),
  }).default({}),

  permissions: z.object({
    autoApproveRead: z.boolean().default(true),
    autoApproveWrite: z.boolean().default(false),
    autoApproveCommand: z.boolean().default(false),
    autoApproveReadPatterns: z.array(z.string()).default([".nexus/tool-output/**"]),
    /** Commands allowed without approval for this project (stored in .nexus/allowed-commands.json) */
    allowedCommands: z.array(z.string()).default([]),
    /** Command patterns from .nexus/settings.json + settings.local.json */
    allowCommandPatterns: z.array(z.string()).default([]),
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

  mcp: z.object({
    servers: z.array(mcpServerSchema).default([]),
  }).default({}),

  skills: z.array(z.union([
    z.string(),
    z.object({ path: z.string(), enabled: z.boolean().optional() }),
  ])).default([]),

  tools: z.object({
    custom: z.array(z.string()).default([]),
    /** When true, use LLM to filter MCP/custom tools by task when count > classifyThreshold. Default off. */
    classifyToolsEnabled: z.boolean().default(false),
    classifyThreshold: z.number().int().positive().default(15),
    parallelReads: z.boolean().default(true),
    maxParallelReads: z.number().int().positive().default(5),
  }).default({}),

  /** When true, use LLM to filter skills by task when count > skillClassifyThreshold. Default off. */
  skillClassifyEnabled: z.boolean().default(false),
  skillClassifyThreshold: z.number().int().positive().default(8),

  structuredOutput: z.enum(["auto", "always", "never"]).default("auto"),

  summarization: z.object({
    auto: z.boolean().default(true),
    threshold: z.number().min(0.1).max(1).default(0.80),
    keepRecentMessages: z.number().int().positive().default(8),
    model: z.string().default(""),
  }).default({}),

  parallelAgents: z.object({
    maxParallel: z.number().int().positive().default(4),
    /** Max tasks per single spawn_agent call when using \`tasks\` array (default 12). */
    maxTasksPerCall: z.number().int().positive().default(12),
  }).default({}),

  /** Optional overrides for agent loop limits (OpenCode-style: allow enough tools/iterations to finish). */
  agentLoop: z.object({
    toolCallBudget: z.object({
      ask: z.number().int().positive().optional(),
      plan: z.number().int().positive().optional(),
      agent: z.number().int().positive().optional(),
      debug: z.number().int().positive().optional(),
    }).optional(),
    maxIterations: z.object({
      ask: z.number().int().positive().optional(),
      plan: z.number().int().positive().optional(),
      agent: z.number().int().positive().optional(),
      debug: z.number().int().positive().optional(),
    }).optional(),
  }).default({}),

  rules: z.object({
    files: z.array(z.string()).default(["CLAUDE.md", "AGENTS.md", ".nexus/rules/**"]),
  }).default({}),

  profiles: z.record(providerSchema.partial()).default({}),
})

export type NexusConfigInput = z.input<typeof NexusConfigSchema>
