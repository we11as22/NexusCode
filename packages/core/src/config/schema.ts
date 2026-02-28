import { z } from "zod"

const providerSchema = z.object({
  provider: z.enum(["anthropic", "openai", "google", "openrouter", "ollama", "openai-compatible", "azure", "bedrock"]),
  id: z.string().min(1),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
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

  maxMode: providerSchema.extend({
    enabled: z.boolean().default(false),
  }).default({
    provider: "anthropic",
    id: "claude-opus-4-5",
    enabled: false,
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
    debug: modeConfigSchema.optional(),
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
    debounceMs: z.number().int().positive().default(1500),
  }).default({}),

  permissions: z.object({
    autoApproveRead: z.boolean().default(true),
    autoApproveWrite: z.boolean().default(false),
    autoApproveCommand: z.boolean().default(false),
    autoApproveReadPatterns: z.array(z.string()).default([]),
    denyPatterns: z.array(z.string()).default(["**/.env", "**/secrets/**", "**/*.key", "**/*.pem"]),
  }).default({}),

  checkpoint: z.object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(15000),
    createOnWrite: z.boolean().default(true),
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

  rules: z.object({
    files: z.array(z.string()).default(["CLAUDE.md", "AGENTS.md", ".nexus/rules/**"]),
  }).default({}),

  profiles: z.record(providerSchema.partial()).default({}),
})

export type NexusConfigInput = z.input<typeof NexusConfigSchema>
