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
  provider: z.enum(["openai", "openai-compatible", "ollama", "local"]),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
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
})

export const NexusConfigSchema = z.object({
  model: providerSchema.default({
    provider: "anthropic",
    id: "claude-sonnet-4-5",
  }),

  maxMode: z.object({
    enabled: z.boolean().default(false),
    tokenBudgetMultiplier: z.number().min(1).max(6).default(2),
  }).default({
    enabled: false,
    tokenBudgetMultiplier: 2,
  }),

  embeddings: embeddingSchema.optional(),

  vectorDb: z.object({
    enabled: z.boolean().default(false),
    url: z.string().default("http://localhost:6333"),
    collection: z.string().default("nexus"),
    autoStart: z.boolean().default(true),
  }).optional(),

  modes: z.object({
    agent: modeConfigSchema.optional(),
    plan: modeConfigSchema.optional(),
    ask: modeConfigSchema.optional(),
  }).catchall(modeConfigSchema.optional()).default({}),

  indexing: z.object({
    enabled: z.boolean().default(true),
    excludePatterns: z.array(z.string()).default([
      "node_modules/**", ".git/**", "dist/**", "build/**",
      "*.lock", ".next/**", ".nuxt/**", "coverage/**",
    ]),
    symbolExtract: z.boolean().default(true),
    fts: z.boolean().default(true),
    vector: z.boolean().default(false),
    batchSize: z.number().int().positive().default(50),
    embeddingBatchSize: z.number().int().positive().default(60),
    embeddingConcurrency: z.number().int().positive().default(2),
    debounceMs: z.number().int().positive().default(1500),
  }).default({}),

  permissions: z.object({
    autoApproveRead: z.boolean().default(true),
    autoApproveWrite: z.boolean().default(false),
    autoApproveCommand: z.boolean().default(false),
    autoApproveReadPatterns: z.array(z.string()).default([]),
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

  skills: z.array(z.string()).default([]),

  tools: z.object({
    custom: z.array(z.string()).default([]),
    classifyThreshold: z.number().int().positive().default(15),
    parallelReads: z.boolean().default(true),
    maxParallelReads: z.number().int().positive().default(5),
  }).default({}),

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
  }).default({}),

  /** Optional overrides for agent loop limits (OpenCode-style: allow enough tools/iterations to finish). */
  agentLoop: z.object({
    toolCallBudget: z.object({
      ask: z.number().int().positive().optional(),
      plan: z.number().int().positive().optional(),
      agent: z.number().int().positive().optional(),
    }).optional(),
    maxIterations: z.object({
      ask: z.number().int().positive().optional(),
      plan: z.number().int().positive().optional(),
      agent: z.number().int().positive().optional(),
    }).optional(),
  }).default({}),

  rules: z.object({
    files: z.array(z.string()).default(["CLAUDE.md", "AGENTS.md", ".nexus/rules/**"]),
  }).default({}),

  profiles: z.record(providerSchema.partial()).default({}),
})

export type NexusConfigInput = z.input<typeof NexusConfigSchema>
