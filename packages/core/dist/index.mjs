import * as fs from 'fs';
import { mkdirSync } from 'fs';
import * as path4 from 'path';
import * as os5 from 'os';
import { z } from 'zod';
import * as yaml from 'js-yaml';
import { createAnthropic } from '@ai-sdk/anthropic';
import { embedMany, streamText, generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createAzure } from '@ai-sdk/azure';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createXai } from '@ai-sdk/xai';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createCerebras } from '@ai-sdk/cerebras';
import { createCohere } from '@ai-sdk/cohere';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createPerplexity } from '@ai-sdk/perplexity';
import * as crypto from 'crypto';
import * as fs10 from 'fs/promises';
import { glob } from 'glob';
import { applyPatch } from 'diff';
import { execa } from 'execa';
import stripAnsi from 'strip-ansi';
import TurndownService from 'turndown';
import Database from 'better-sqlite3';
import { QdrantClient } from '@qdrant/js-client-rest';
import ignore from 'ignore';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { simpleGit } from 'simple-git';

// src/config/index.ts
var PROVIDER_NAMES = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "ollama",
  "openai-compatible",
  "azure",
  "bedrock",
  "groq",
  "mistral",
  "xai",
  "deepinfra",
  "cerebras",
  "cohere",
  "togetherai",
  "perplexity"
];
var providerSchema = z.object({
  provider: z.enum(PROVIDER_NAMES),
  id: z.string().min(1),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  resourceName: z.string().optional(),
  deploymentId: z.string().optional(),
  apiVersion: z.string().optional(),
  extra: z.record(z.unknown()).optional()
});
var embeddingSchema = z.object({
  provider: z.enum(["openai", "openai-compatible", "ollama", "local"]),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  dimensions: z.number().int().positive().optional()
});
var modeConfigSchema = z.object({
  autoApprove: z.array(z.enum(["read", "write", "execute", "mcp", "browser", "search"])).optional(),
  systemPrompt: z.string().optional(),
  customInstructions: z.string().optional()
});
var mcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  transport: z.enum(["stdio", "http", "sse"]).optional()
});
var NexusConfigSchema = z.object({
  model: providerSchema.default({
    provider: "anthropic",
    id: "claude-sonnet-4-5"
  }),
  maxMode: providerSchema.extend({
    enabled: z.boolean().default(false)
  }).default({
    provider: "anthropic",
    id: "claude-opus-4-5",
    enabled: false
  }),
  embeddings: embeddingSchema.optional(),
  vectorDb: z.object({
    enabled: z.boolean().default(false),
    url: z.string().default("http://localhost:6333"),
    collection: z.string().default("nexus"),
    autoStart: z.boolean().default(true)
  }).optional(),
  modes: z.object({
    agent: modeConfigSchema.optional(),
    plan: modeConfigSchema.optional(),
    debug: modeConfigSchema.optional(),
    ask: modeConfigSchema.optional()
  }).catchall(modeConfigSchema.optional()).default({}),
  indexing: z.object({
    enabled: z.boolean().default(true),
    excludePatterns: z.array(z.string()).default([
      "node_modules/**",
      ".git/**",
      "dist/**",
      "build/**",
      "*.lock",
      ".next/**",
      ".nuxt/**",
      "coverage/**"
    ]),
    symbolExtract: z.boolean().default(true),
    fts: z.boolean().default(true),
    vector: z.boolean().default(false),
    batchSize: z.number().int().positive().default(50),
    debounceMs: z.number().int().positive().default(1500)
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
      reason: z.string().optional()
    })).default([])
  }).default({}),
  retry: z.object({
    enabled: z.boolean().default(true),
    maxAttempts: z.number().int().positive().default(3),
    initialDelayMs: z.number().int().positive().default(1e3),
    maxDelayMs: z.number().int().positive().default(3e4),
    retryOnStatus: z.array(z.number().int()).default([429, 500, 502, 503, 504])
  }).default({}),
  checkpoint: z.object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(15e3),
    createOnWrite: z.boolean().default(true)
  }).default({}),
  mcp: z.object({
    servers: z.array(mcpServerSchema).default([])
  }).default({}),
  skills: z.array(z.string()).default([]),
  tools: z.object({
    custom: z.array(z.string()).default([]),
    classifyThreshold: z.number().int().positive().default(15),
    parallelReads: z.boolean().default(true),
    maxParallelReads: z.number().int().positive().default(5)
  }).default({}),
  skillClassifyThreshold: z.number().int().positive().default(8),
  structuredOutput: z.enum(["auto", "always", "never"]).default("auto"),
  summarization: z.object({
    auto: z.boolean().default(true),
    threshold: z.number().min(0.1).max(1).default(0.8),
    keepRecentMessages: z.number().int().positive().default(8),
    model: z.string().default("")
  }).default({}),
  parallelAgents: z.object({
    maxParallel: z.number().int().positive().default(4)
  }).default({}),
  rules: z.object({
    files: z.array(z.string()).default(["CLAUDE.md", "AGENTS.md", ".nexus/rules/**"])
  }).default({}),
  profiles: z.record(providerSchema.partial()).default({})
});
function getYaml() {
  return yaml;
}
var CONFIG_FILE_NAMES = [".nexus/nexus.yaml", ".nexus/nexus.yml", ".nexusrc.yaml", ".nexusrc.yml"];
var GLOBAL_CONFIG_DIR = path4.join(os5.homedir(), ".nexus");
var GLOBAL_CONFIG_PATH = path4.join(GLOBAL_CONFIG_DIR, "nexus.yaml");
async function loadConfig(cwd) {
  const startDir = cwd ?? process.cwd();
  const globalRaw = readConfigFile(GLOBAL_CONFIG_PATH);
  let projectRaw = null;
  let dir = startDir;
  let maxUp = 20;
  while (maxUp-- > 0) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path4.join(dir, name);
      const raw = readConfigFile(candidate);
      if (raw) {
        projectRaw = raw;
        break;
      }
    }
    if (projectRaw) break;
    const parent = path4.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const merged = deepMerge(globalRaw ?? {}, projectRaw ?? {});
  applyEnvOverrides(merged);
  const result = NexusConfigSchema.safeParse(merged);
  if (!result.success) {
    console.warn("[nexus] Config validation warnings:", result.error.issues.map((i) => i.message).join(", "));
    return NexusConfigSchema.parse({});
  }
  return result.data;
}
function readConfigFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf8");
    if (filePath.endsWith(".json")) {
      return JSON.parse(content);
    }
    return getYaml().load(content);
  } catch {
    return null;
  }
}
var PROVIDER_API_KEY_ENV = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  azure: ["AZURE_OPENAI_API_KEY"],
  bedrock: ["AWS_ACCESS_KEY_ID"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepinfra: ["DEEPINFRA_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  cohere: ["COHERE_API_KEY"],
  togetherai: ["TOGETHER_AI_API_KEY", "TOGETHERAI_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"]
};
var PROVIDER_MODEL_ENV = {
  openrouter: ["OPENROUTER_MODEL"],
  anthropic: ["ANTHROPIC_MODEL"],
  openai: ["OPENAI_MODEL"],
  groq: ["GROQ_MODEL"],
  mistral: ["MISTRAL_MODEL"],
  google: ["GOOGLE_MODEL", "GEMINI_MODEL"],
  xai: ["XAI_MODEL"],
  cerebras: ["CEREBRAS_MODEL"]
};
function applyEnvOverrides(config) {
  if (!config.model || typeof config.model !== "object") config.model = {};
  const model = config.model;
  const nexusKey = process.env["NEXUS_API_KEY"];
  if (nexusKey && !model["apiKey"]) model["apiKey"] = nexusKey;
  if (!model["apiKey"]) {
    const provider = String(model["provider"] ?? "");
    const envVars = PROVIDER_API_KEY_ENV[provider] ?? [];
    for (const envVar of envVars) {
      const v = process.env[envVar];
      if (v) {
        model["apiKey"] = v;
        break;
      }
    }
  }
  if (!model["id"] || model["id"] === "") {
    const provider = String(model["provider"] ?? "");
    const envVars = PROVIDER_MODEL_ENV[provider] ?? [];
    for (const envVar of envVars) {
      const v = process.env[envVar];
      if (v) {
        model["id"] = v;
        break;
      }
    }
  }
  const nexusModel = process.env["NEXUS_MODEL"];
  if (nexusModel) {
    const slashIdx = nexusModel.indexOf("/");
    if (slashIdx > 0) {
      model["provider"] = nexusModel.slice(0, slashIdx);
      model["id"] = nexusModel.slice(slashIdx + 1);
    } else {
      model["id"] = nexusModel;
    }
  }
  if (process.env["NEXUS_BASE_URL"]) {
    model["baseUrl"] = process.env["NEXUS_BASE_URL"];
  }
  if (process.env["NEXUS_MAX_MODE"] === "1" || process.env["NEXUS_MAX_MODE"] === "true") {
    if (!config.maxMode || typeof config.maxMode !== "object") config.maxMode = {};
    config.maxMode["enabled"] = true;
  }
  if (config.maxMode && typeof config.maxMode === "object") {
    const mm = config.maxMode;
    if (!mm["apiKey"] && mm["provider"]) {
      const provider = String(mm["provider"]);
      const envVars = PROVIDER_API_KEY_ENV[provider] ?? [];
      for (const envVar of envVars) {
        const v = process.env[envVar];
        if (v) {
          mm["apiKey"] = v;
          break;
        }
      }
    }
  }
}
function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (val && typeof val === "object" && !Array.isArray(val) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}
function writeConfig(config, cwd) {
  const dir = path4.join(cwd ?? process.cwd(), ".nexus");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path4.join(dir, "nexus.yaml");
  const content = getYaml().dump(config, { indent: 2, lineWidth: 120 });
  fs.writeFileSync(filePath, content, "utf8");
}
function getGlobalConfigDir() {
  return GLOBAL_CONFIG_DIR;
}
function ensureGlobalConfigDir() {
  if (!fs.existsSync(GLOBAL_CONFIG_DIR)) {
    fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  }
  const skillsDir = path4.join(GLOBAL_CONFIG_DIR, "skills");
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
  const rulesDir = path4.join(GLOBAL_CONFIG_DIR, "rules");
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
}
var STRUCTURED_OUTPUT_SUPPORT = {
  "anthropic/*": true,
  "openai/gpt-4o": true,
  "openai/gpt-4o-mini": true,
  "openai/gpt-4-turbo": true,
  "openai/gpt-4.1": true,
  "openai/gpt-5": true,
  "openai/o1": true,
  "openai/o3": true,
  "google/gemini-2": true,
  "google/gemini-1.5-pro": false
};
function supportsStructuredOutput(provider, modelId) {
  const wildcardKey = `${provider}/*`;
  if (wildcardKey in STRUCTURED_OUTPUT_SUPPORT) {
    const val = STRUCTURED_OUTPUT_SUPPORT[wildcardKey];
    return typeof val === "function" ? val(modelId) : Boolean(val);
  }
  for (const [key, val] of Object.entries(STRUCTURED_OUTPUT_SUPPORT)) {
    if (key.endsWith("/*")) continue;
    if (modelId.startsWith(key.replace(`${provider}/`, ""))) {
      return typeof val === "function" ? val(modelId) : Boolean(val);
    }
  }
  return false;
}
async function generateStructuredWithFallback(client, opts) {
  if (client.supportsStructuredOutput()) {
    try {
      const model = client.getModel();
      const result = await generateObject({
        model,
        schema: opts.schema,
        messages: opts.messages,
        system: opts.systemPrompt,
        maxRetries: opts.maxRetries ?? 2
      });
      return result.object;
    } catch (err) {
      console.warn("[nexus] Structured output failed, falling back to text extraction:", err);
    }
  }
  return extractJsonFromStream(client, opts);
}
async function extractJsonFromStream(client, opts) {
  const messages = [
    ...opts.messages,
    {
      role: "user",
      content: "IMPORTANT: Your response must be valid JSON only, no markdown, no explanation. Start with { or [."
    }
  ];
  let fullText = "";
  for await (const event of client.stream({
    messages,
    systemPrompt: opts.systemPrompt,
    signal: opts.signal,
    temperature: 0.1
  })) {
    if (event.type === "text_delta" && event.delta) {
      fullText += event.delta;
    }
    if (event.type === "finish") break;
    if (event.type === "error" && event.error) throw event.error;
  }
  const jsonStr = extractJsonString(fullText);
  try {
    const parsed = JSON.parse(jsonStr);
    return opts.schema.parse(parsed);
  } catch (err) {
    throw new Error(`Failed to parse structured output: ${err}. Raw: ${fullText.slice(0, 200)}`);
  }
}
function extractJsonString(text) {
  const tagMatch = text.match(/<json>([\s\S]*?)<\/json>/i);
  if (tagMatch?.[1]) return tagMatch[1].trim();
  const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeMatch?.[1]) return codeMatch[1].trim();
  const objectMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/m);
  if (objectMatch?.[1]) return objectMatch[1].trim();
  return text.trim();
}

// src/provider/base.ts
var DEFAULT_MAX_RETRIES = 3;
var DEFAULT_INITIAL_DELAY = 1e3;
var DEFAULT_MAX_DELAY = 3e4;
var RETRYABLE_STATUS = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var BaseLLMClient = class {
  constructor(model, providerName, modelId) {
    this.model = model;
    this.providerName = providerName;
    this.modelId = modelId;
  }
  getModel() {
    return this.model;
  }
  supportsStructuredOutput() {
    return supportsStructuredOutput(this.providerName, this.modelId);
  }
  async *stream(opts) {
    const tools = opts.tools ? Object.fromEntries(
      opts.tools.map((t) => [
        t.name,
        {
          description: t.description,
          parameters: t.parameters
        }
      ])
    ) : void 0;
    const messages = buildAISDKMessages(opts.messages);
    let attempt = 0;
    const maxAttempts = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const initialDelay = DEFAULT_INITIAL_DELAY;
    const maxDelay = DEFAULT_MAX_DELAY;
    while (true) {
      attempt++;
      try {
        yield* this._streamOnce(opts, messages, tools);
        return;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const status = getErrorStatus(err);
        const isRetryable = status ? RETRYABLE_STATUS.has(status) : isNetworkError(err);
        if (!isRetryable || attempt >= maxAttempts) {
          throw err;
        }
        const delay = Math.min(
          initialDelay * Math.pow(2, attempt - 1) + Math.random() * 500,
          maxDelay
        );
        yield { type: "error", error: new Error(`Retrying after error (attempt ${attempt}/${maxAttempts}): ${String(err)}`) };
        await sleep(delay, opts.signal);
      }
    }
  }
  async *_streamOnce(opts, messages, tools) {
    const result = streamText({
      model: this.model,
      system: opts.systemPrompt,
      messages,
      tools,
      maxTokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature,
      abortSignal: opts.signal,
      maxSteps: 1
      // We handle multi-step manually in agentLoop
    });
    let reasoningText = "";
    for await (const part of result.fullStream) {
      if (opts.signal?.aborted) break;
      switch (part.type) {
        case "text-delta":
          yield { type: "text_delta", delta: part.textDelta };
          break;
        case "reasoning":
          reasoningText += part["textDelta"] ?? "";
          yield { type: "reasoning_delta", delta: part["textDelta"] ?? "" };
          break;
        case "tool-call":
          yield {
            type: "tool_call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            toolInput: part.args
          };
          break;
        case "tool-result":
          yield {
            type: "tool_result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            toolOutput: typeof part.result === "string" ? part.result : JSON.stringify(part.result)
          };
          break;
        case "finish": {
          const usage = result.usage;
          const usageData = await usage.catch(() => null);
          yield {
            type: "finish",
            finishReason: part.finishReason,
            usage: {
              inputTokens: usageData?.promptTokens ?? 0,
              outputTokens: usageData?.completionTokens ?? 0
            }
          };
          break;
        }
        case "error":
          yield { type: "error", error: part.error instanceof Error ? part.error : new Error(String(part.error)) };
          break;
      }
    }
  }
  async generateStructured(opts) {
    return generateStructuredWithFallback(this, opts);
  }
};
function buildAISDKMessages(messages) {
  const result = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (typeof msg.content === "string") {
      if (msg.role === "tool") continue;
      result.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content) || msg.content.length === 0) continue;
    if (msg.role === "tool") {
      const toolResultParts = msg.content.filter((p) => p.type === "tool-result").map((p) => {
        const tr = p;
        return {
          type: "tool-result",
          toolCallId: tr.toolCallId,
          toolName: tr.toolName ?? "",
          result: [{ type: "text", text: tr.result }],
          isError: tr.isError ?? false
        };
      });
      if (toolResultParts.length > 0) {
        result.push({ role: "tool", content: toolResultParts });
      }
      continue;
    }
    const parts = [];
    for (const part of msg.content) {
      switch (part.type) {
        case "text":
          parts.push({ type: "text", text: part.text });
          break;
        case "image":
          parts.push({ type: "image", image: part.data, mimeType: part.mimeType });
          break;
        case "tool-call":
          parts.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args
          });
          break;
        case "tool-result":
          parts.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName ?? "",
            result: [{ type: "text", text: part.result }],
            isError: part.isError ?? false
          });
          break;
      }
    }
    if (parts.length > 0) {
      result.push({ role: msg.role, content: parts });
    }
  }
  return result;
}
function getErrorStatus(err) {
  if (err && typeof err === "object") {
    const status = err["statusCode"] ?? err["status"];
    if (typeof status === "number") return status;
  }
  const msg = String(err);
  const m = msg.match(/(?:status|code)[^\d]*(\d{3})/i);
  if (m) return parseInt(m[1]);
  return null;
}
function isNetworkError(err) {
  const msg = String(err).toLowerCase();
  return msg.includes("econnreset") || msg.includes("econnrefused") || msg.includes("etimedout") || msg.includes("network") || msg.includes("socket") || msg.includes("fetch failed");
}
function sleep(ms, signal) {
  return new Promise((resolve9, reject) => {
    const timer = setTimeout(resolve9, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    });
  });
}

// src/provider/anthropic.ts
function createAnthropicClient(config) {
  const apiKey = config.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
  const anthropic = createAnthropic({
    apiKey,
    baseURL: config.baseUrl
  });
  const model = anthropic(config.id, {
    // Enable caching for supported models
    cacheControl: true
  });
  return new AnthropicClient(model, config.id);
}
var AnthropicClient = class extends BaseLLMClient {
  constructor(model, modelId) {
    super(model, "anthropic", modelId);
  }
  /**
   * Override stream to add cache_control markers on system blocks.
   * Anthropic prompt caching: mark the first N system blocks as ephemeral.
   * Order: [role+capabilities] [rules] [skills] [dynamic...]
   * Blocks 1-3 (if present) get cache_control.
   */
  async *stream(opts) {
    yield* super.stream(opts);
  }
};
function createOpenAIClient(config) {
  const apiKey = config.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
  const openai = createOpenAI({
    apiKey,
    baseURL: config.baseUrl
  });
  const isResponsesModel = config.id.startsWith("o") || config.id.startsWith("gpt-5") || config.id.includes("gpt-4o");
  const model = isResponsesModel ? openai.responses(config.id) : openai.chat(config.id);
  return new BaseLLMClient(model, "openai", config.id);
}
function createGoogleClient(config) {
  const apiKey = config.apiKey ?? process.env["GOOGLE_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "";
  const google = createGoogleGenerativeAI({
    apiKey,
    baseURL: config.baseUrl
  });
  const model = google(config.id, {
    useSearchGrounding: false
  });
  return new BaseLLMClient(model, "google", config.id);
}
function createOpenRouterClient(config) {
  const apiKey = config.apiKey ?? process.env["OPENROUTER_API_KEY"] ?? "";
  const openrouter = createOpenRouter({ apiKey });
  const model = openrouter(config.id);
  return new BaseLLMClient(model, "openrouter", config.id);
}
function createOpenAICompatibleClient(config) {
  if (!config.baseUrl) {
    throw new Error("openai-compatible provider requires baseUrl");
  }
  const apiKey = config.apiKey ?? process.env["NEXUS_API_KEY"] ?? "dummy";
  const openai = createOpenAI({
    apiKey,
    baseURL: config.baseUrl,
    compatibility: "compatible"
  });
  const model = openai.chat(config.id);
  const providerName = detectProviderFromUrl(config.baseUrl);
  return new BaseLLMClient(model, providerName, config.id);
}
function createOllamaClient(config) {
  const openai = createOpenAI({
    apiKey: "ollama",
    baseURL: config.baseUrl ?? "http://localhost:11434/v1",
    compatibility: "compatible"
  });
  const model = openai.chat(config.id);
  return new BaseLLMClient(model, "ollama", config.id);
}
function detectProviderFromUrl(baseUrl) {
  const url = baseUrl.toLowerCase();
  if (url.includes("groq")) return "groq";
  if (url.includes("together")) return "together";
  if (url.includes("mistral")) return "mistral";
  if (url.includes("fireworks")) return "fireworks";
  if (url.includes("cerebras")) return "cerebras";
  if (url.includes("perplexity")) return "perplexity";
  if (url.includes("deepseek")) return "deepseek";
  if (url.includes("x.ai") || url.includes("xai")) return "xai";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "local";
  return "openai-compatible";
}
function createAzureClient(config) {
  const apiKey = config.apiKey ?? process.env["AZURE_API_KEY"] ?? "";
  const azure = createAzure({
    apiKey,
    resourceName: config.resourceName ?? "",
    apiVersion: config.apiVersion ?? "2025-01-01-preview"
  });
  const model = azure(config.deploymentId ?? config.id);
  return new BaseLLMClient(model, "azure", config.id);
}
function createBedrockClient(config) {
  const bedrock = createAmazonBedrock({
    region: config.extra?.["region"] ?? process.env["AWS_REGION"] ?? "us-east-1",
    accessKeyId: config.extra?.["accessKeyId"] ?? process.env["AWS_ACCESS_KEY_ID"],
    secretAccessKey: config.extra?.["secretAccessKey"] ?? process.env["AWS_SECRET_ACCESS_KEY"],
    sessionToken: config.extra?.["sessionToken"] ?? process.env["AWS_SESSION_TOKEN"]
  });
  const model = bedrock(config.id);
  return new BaseLLMClient(model, "bedrock", config.id);
}
function createGroqClient(config) {
  const apiKey = config.apiKey ?? process.env["GROQ_API_KEY"] ?? "";
  const groq = createGroq({ apiKey });
  return new BaseLLMClient(groq(config.id), "groq", config.id);
}
function createMistralClient(config) {
  const apiKey = config.apiKey ?? process.env["MISTRAL_API_KEY"] ?? "";
  const mistral = createMistral({ apiKey, baseURL: config.baseUrl });
  return new BaseLLMClient(mistral(config.id), "mistral", config.id);
}
function createXAIClient(config) {
  const apiKey = config.apiKey ?? process.env["XAI_API_KEY"] ?? "";
  const xai = createXai({ apiKey });
  return new BaseLLMClient(xai(config.id), "xai", config.id);
}
function createDeepInfraClient(config) {
  const apiKey = config.apiKey ?? process.env["DEEPINFRA_API_KEY"] ?? "";
  const deepinfra = createDeepInfra({ apiKey });
  return new BaseLLMClient(deepinfra(config.id), "deepinfra", config.id);
}
function createCerebrasClient(config) {
  const apiKey = config.apiKey ?? process.env["CEREBRAS_API_KEY"] ?? "";
  const cerebras = createCerebras({ apiKey });
  return new BaseLLMClient(cerebras(config.id), "cerebras", config.id);
}
function createCohereClient(config) {
  const apiKey = config.apiKey ?? process.env["COHERE_API_KEY"] ?? "";
  const cohere = createCohere({ apiKey });
  return new BaseLLMClient(cohere(config.id), "cohere", config.id);
}
function createTogetherAIClient(config) {
  const apiKey = config.apiKey ?? process.env["TOGETHER_AI_API_KEY"] ?? process.env["TOGETHERAI_API_KEY"] ?? "";
  const together = createTogetherAI({ apiKey });
  return new BaseLLMClient(together(config.id), "togetherai", config.id);
}
function createPerplexityClient(config) {
  const apiKey = config.apiKey ?? process.env["PERPLEXITY_API_KEY"] ?? "";
  const perplexity = createPerplexity({ apiKey });
  return new BaseLLMClient(perplexity(config.id), "perplexity", config.id);
}
function createEmbeddingClient(config) {
  switch (config.provider) {
    case "openai":
      return new OpenAIEmbeddingClient(config);
    case "openai-compatible":
      return new OpenAICompatibleEmbeddingClient(config);
    case "ollama":
      return new OllamaEmbeddingClient(config);
    case "local":
      return new LocalEmbeddingClient(config);
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}
var OpenAIEmbeddingClient = class {
  model;
  dimensions;
  constructor(config) {
    const openai = createOpenAI({
      apiKey: config.apiKey ?? process.env["OPENAI_API_KEY"] ?? ""
    });
    this.model = openai.embedding(config.model);
    this.dimensions = config.dimensions ?? 1536;
  }
  async embed(texts) {
    const result = await embedMany({ model: this.model, values: texts });
    return result.embeddings;
  }
};
var OpenAICompatibleEmbeddingClient = class {
  model;
  dimensions;
  constructor(config) {
    const openai = createOpenAI({
      apiKey: config.apiKey ?? "dummy",
      baseURL: config.baseUrl,
      compatibility: "compatible"
    });
    this.model = openai.embedding(config.model);
    this.dimensions = config.dimensions ?? 1536;
  }
  async embed(texts) {
    const result = await embedMany({ model: this.model, values: texts });
    return result.embeddings;
  }
};
var OllamaEmbeddingClient = class {
  model;
  dimensions;
  constructor(config) {
    const openai = createOpenAI({
      apiKey: "ollama",
      baseURL: config.baseUrl ?? "http://localhost:11434/v1",
      compatibility: "compatible"
    });
    this.model = openai.embedding(config.model);
    this.dimensions = config.dimensions ?? 384;
  }
  async embed(texts) {
    const result = await embedMany({ model: this.model, values: texts });
    return result.embeddings;
  }
};
var LocalEmbeddingClient = class {
  dimensions;
  modelName;
  pipeline = null;
  constructor(config) {
    this.modelName = config.model ?? "Xenova/all-MiniLM-L6-v2";
    this.dimensions = config.dimensions ?? 384;
  }
  async embed(texts) {
    if (!this.pipeline) {
      const { pipeline } = await import('@xenova/transformers');
      this.pipeline = await pipeline("feature-extraction", this.modelName);
    }
    const results = [];
    for (const text of texts) {
      const output = await this.pipeline([text], { pooling: "mean", normalize: true });
      results.push(Array.from(output.data[0]));
    }
    return results;
  }
};

// src/provider/index.ts
function createLLMClient(config) {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicClient(config);
    case "openai":
      return createOpenAIClient(config);
    case "google":
      return createGoogleClient(config);
    case "openrouter":
      return createOpenRouterClient(config);
    case "ollama":
      return createOllamaClient(config);
    case "openai-compatible":
      return createOpenAICompatibleClient(config);
    case "azure":
      return createAzureClient(config);
    case "bedrock":
      return createBedrockClient(config);
    case "groq":
      return createGroqClient(config);
    case "mistral":
      return createMistralClient(config);
    case "xai":
      return createXAIClient(config);
    case "deepinfra":
      return createDeepInfraClient(config);
    case "cerebras":
      return createCerebrasClient(config);
    case "cohere":
      return createCohereClient(config);
    case "togetherai":
      return createTogetherAIClient(config);
    case "perplexity":
      return createPerplexityClient(config);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
function getSessionsDir(cwd) {
  const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  return path4.join(os5.homedir(), ".nexus", "sessions", hash);
}
async function saveSession(session) {
  const dir = getSessionsDir(session.cwd);
  await fs10.mkdir(dir, { recursive: true });
  const filePath = path4.join(dir, `${session.id}.jsonl`);
  const lines = session.messages.map((m) => JSON.stringify(m)).join("\n");
  const meta = JSON.stringify({ id: session.id, cwd: session.cwd, ts: session.ts, title: session.title });
  await fs10.writeFile(filePath, `${meta}
${lines}
`, "utf8");
}
async function loadSession(sessionId, cwd) {
  const dir = getSessionsDir(cwd);
  const filePath = path4.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return null;
  const content = await fs10.readFile(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const meta = JSON.parse(lines[0]);
  const messages = lines.slice(1).map((l) => JSON.parse(l));
  return { ...meta, messages };
}
async function listSessions(cwd) {
  const dir = getSessionsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const files = await fs10.readdir(dir).catch(() => []);
  const sessions = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    try {
      const content = await fs10.readFile(path4.join(dir, file), "utf8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length === 0) continue;
      const meta = JSON.parse(lines[0]);
      sessions.push({ id: meta.id, ts: meta.ts, title: meta.title, messageCount: lines.length - 1 });
    } catch {
    }
  }
  return sessions.sort((a, b) => b.ts - a.ts);
}
function generateSessionId() {
  return `session_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

// src/context/condense.ts
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// src/session/index.ts
var Session = class _Session {
  id;
  _messages = [];
  _todo = "";
  cwd;
  constructor(id, cwd, messages) {
    this.id = id;
    this.cwd = cwd;
    this._messages = messages ?? [];
  }
  get messages() {
    return this._messages;
  }
  addMessage(msg) {
    const full = {
      ...msg,
      id: `msg_${crypto.randomBytes(6).toString("hex")}`,
      ts: Date.now()
    };
    this._messages.push(full);
    return full;
  }
  updateMessage(id, updates) {
    const idx = this._messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    this._messages[idx] = { ...this._messages[idx], ...updates };
  }
  addToolPart(messageId, part) {
    const msg = this._messages.find((m) => m.id === messageId);
    if (!msg) return;
    if (typeof msg.content === "string") {
      const textPart = { type: "text", text: msg.content };
      msg.content = [textPart, part];
    } else {
      msg.content.push(part);
    }
  }
  updateToolPart(messageId, partId, updates) {
    const msg = this._messages.find((m) => m.id === messageId);
    if (!msg || typeof msg.content === "string") return;
    const parts = msg.content;
    const idx = parts.findIndex((p) => p.type === "tool" && p.id === partId);
    if (idx === -1) return;
    parts[idx] = { ...parts[idx], ...updates };
  }
  updateTodo(markdown) {
    this._todo = markdown;
  }
  getTodo() {
    return this._todo;
  }
  getTokenEstimate() {
    let total = 0;
    for (const msg of this._messages) {
      if (msg.summary) {
        total += estimateTokens(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
        continue;
      }
      if (typeof msg.content === "string") {
        total += estimateTokens(msg.content);
      } else {
        for (const part of msg.content) {
          if (part.type === "text") {
            total += estimateTokens(part.text);
          } else if (part.type === "tool") {
            const tp = part;
            if (!tp.compacted && tp.output) {
              total += estimateTokens(tp.output);
            }
            if (tp.input) {
              total += estimateTokens(JSON.stringify(tp.input));
            }
          }
        }
      }
    }
    return total;
  }
  fork(messageId) {
    const idx = this._messages.findIndex((m) => m.id === messageId);
    const messages = idx === -1 ? [...this._messages] : this._messages.slice(0, idx + 1);
    return new _Session(generateSessionId(), this.cwd, JSON.parse(JSON.stringify(messages)));
  }
  async save() {
    const stored = {
      id: this.id,
      cwd: this.cwd,
      ts: Date.now(),
      messages: this._messages
    };
    await saveSession(stored);
  }
  async load() {
    const stored = await loadSession(this.id, this.cwd);
    if (stored) {
      this._messages = stored.messages;
    }
  }
  static create(cwd) {
    return new _Session(generateSessionId(), cwd);
  }
  static async resume(sessionId, cwd) {
    const stored = await loadSession(sessionId, cwd);
    if (!stored) return null;
    return new _Session(sessionId, cwd, stored.messages);
  }
};

// src/session/compaction.ts
var PRUNE_MINIMUM = 1e4;
var PRUNE_PROTECT = 3e4;
var PRUNE_PROTECTED_TOOLS = /* @__PURE__ */ new Set(["use_skill", "read_file", "codebase_search"]);
var COMPACTION_BUFFER = 2e4;
function createCompaction() {
  return {
    prune,
    compact,
    isOverflow(tokenCount, contextLimit, threshold) {
      if (contextLimit <= 0) return false;
      const usable = contextLimit - COMPACTION_BUFFER;
      return tokenCount >= usable * threshold;
    }
  };
}
function prune(session) {
  let total = 0;
  let pruned = 0;
  const toPrune = [];
  const messages = [...session.messages].reverse();
  let turns = 0;
  outer: for (const msg of messages) {
    if (msg.role === "user") turns++;
    if (turns < 2) continue;
    if (msg.summary) break outer;
    if (!Array.isArray(msg.content)) continue;
    for (const part of [...msg.content].reverse()) {
      if (part.type !== "tool") continue;
      const tp = part;
      if (tp.status !== "completed") continue;
      if (PRUNE_PROTECTED_TOOLS.has(tp.tool)) continue;
      if (tp.compacted) break outer;
      const est = estimateTokens(tp.output ?? "");
      total += est;
      if (total > PRUNE_PROTECT) {
        pruned += est;
        toPrune.push(tp);
      }
    }
  }
  if (pruned >= PRUNE_MINIMUM) {
    for (const part of toPrune) {
      session.updateToolPart(
        findMessageIdForPart(session, part.id) ?? "",
        part.id,
        { compacted: true, output: "[output pruned for context efficiency]" }
      );
    }
  }
}
async function compact(session, client, signal) {
  const messages = session.messages.filter((m) => !m.summary);
  if (messages.length < 4) return;
  buildConversationText(messages);
  const compactPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the work, including what we did,
what we're doing, which files we're working on, and what we're going to do next.

Use this template:

---
## Goal
[What goal(s) is the user trying to accomplish?]

## Instructions
[Important instructions from the user relevant to the work. Include any plan or spec.]

## Discoveries
[Notable things learned about the codebase that would be useful to know when continuing]

## Accomplished
[What work has been completed, what's in progress, and what's left to do]

## Code Changes
[Files created/modified/deleted with brief description]
- \`path/to/file.ts\` \u2014 Added X, modified Y

## Relevant Files / Directories
[Structured list of files relevant to the current task]
---`;
  let summaryText = "";
  try {
    for await (const event of client.stream({
      messages: [
        ...buildLLMMessages(messages),
        { role: "user", content: compactPrompt }
      ],
      systemPrompt: "You are a conversation summarizer. Create a concise but complete summary.",
      signal,
      maxTokens: 4096,
      temperature: 0.3
    })) {
      if (event.type === "text_delta" && event.delta) summaryText += event.delta;
      if (event.type === "finish") break;
      if (event.type === "error") throw event.error;
    }
  } catch (err) {
    console.warn("[nexus] Compaction LLM call failed:", err);
    return;
  }
  if (!summaryText.trim()) return;
  session.addMessage({
    role: "assistant",
    content: summaryText,
    summary: true
  });
  prune(session);
}
function buildConversationText(messages) {
  return messages.map((m) => {
    const role = m.role.toUpperCase();
    if (typeof m.content === "string") {
      return `${role}: ${m.content}`;
    }
    const parts = m.content;
    const text = parts.map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "tool") {
        const tp = p;
        return `[Tool: ${tp.tool}(${JSON.stringify(tp.input ?? {}).slice(0, 100)}) \u2192 ${(tp.output ?? "").slice(0, 200)}]`;
      }
      return "";
    }).filter(Boolean).join("\n");
    return `${role}: ${text}`;
  }).join("\n\n");
}
function buildLLMMessages(messages) {
  const result = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else {
      const parts = m.content;
      text = parts.map((p) => {
        if (p.type === "text") return p.text;
        if (p.type === "tool") {
          const tp = p;
          if (tp.compacted) return `[${tp.tool}: output pruned]`;
          return `[${tp.tool}: ${(tp.output ?? "").slice(0, 300)}]`;
        }
        return "";
      }).join("\n");
    }
    if (text.trim()) result.push({ role: m.role, content: text });
  }
  return result;
}
function findMessageIdForPart(session, partId) {
  for (const msg of session.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "tool" && part.id === partId) {
        return msg.id;
      }
    }
  }
  return void 0;
}
function buildRoleBlock(ctx) {
  const lines = [];
  lines.push(IDENTITY_BLOCK);
  lines.push("");
  lines.push(getModeBlock(ctx.mode));
  lines.push("");
  if (ctx.maxMode) {
    lines.push(MAX_MODE_BLOCK);
    lines.push("");
  }
  lines.push(CORE_PRINCIPLES);
  lines.push("");
  lines.push(EDITING_FILES_GUIDE);
  lines.push("");
  lines.push(TOOL_USE_GUIDE);
  lines.push("");
  lines.push(GIT_HYGIENE);
  lines.push("");
  lines.push(TASK_PROGRESS_GUIDE);
  lines.push("");
  lines.push(RESPONSE_STYLE);
  lines.push("");
  lines.push(CODE_REFERENCES_FORMAT);
  lines.push("");
  lines.push(SECURITY_GUIDELINES);
  return lines.join("\n");
}
var IDENTITY_BLOCK = `You are Nexus, an expert software engineering assistant with deep knowledge of programming languages, frameworks, architecture patterns, and best practices.

You are an interactive tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user efficiently and accurately.

Your goal is to accomplish the user's task \u2014 not to engage in back-and-forth conversation. Work autonomously, break tasks into steps, and execute them methodically.`;
function getModeBlock(mode) {
  const blocks = {
    agent: `## AGENT Mode \u2014 Full Capabilities

You have complete access: read/write files, run shell commands, search the codebase, browser automation, and MCP tool servers. Autonomously complete software engineering tasks end-to-end.

- Read all relevant context before making changes
- Prefer \`replace_in_file\` over \`write_to_file\` for existing files
- Verify your changes compile/run and don't break existing functionality
- Use parallel tool calls for independent operations
- Call \`attempt_completion\` when the task is fully done`,
    plan: `## PLAN Mode \u2014 Research & Planning

You can READ files and explore the codebase, but MUST NOT modify source code files. Create detailed plans as markdown files in \`.nexus/plans/\`.

- Thoroughly analyze the codebase before planning
- Use parallel reads to explore efficiently
- Create a concrete, step-by-step implementation plan
- Include file paths, function signatures, and architecture decisions
- Identify risks, dependencies, and edge cases
- When plan is complete, call \`attempt_completion\` with a summary`,
    debug: `## DEBUG Mode \u2014 Systematic Problem Diagnosis

Diagnose and fix bugs using a structured approach:

1. **Reproduce** \u2014 Understand exactly what's failing and when
2. **Isolate** \u2014 Narrow down the failing component (add targeted logging if needed)
3. **Root cause** \u2014 Identify the actual underlying cause (don't guess)
4. **Minimal fix** \u2014 Make the smallest correct change to fix the issue
5. **Verify** \u2014 Confirm the fix works and nothing else broke

- Reflect on 3-5 possible causes before committing to one
- Read the code before diagnosing; never assume
- Prefer minimal targeted fixes over broad refactors`,
    ask: `## ASK Mode \u2014 Questions & Explanations

Answer questions, explain code, and analyze implementations. You CAN read files but MUST NOT modify anything.

- Give thorough, accurate, technically precise answers
- Use Mermaid diagrams when they clarify architecture
- If implementation is needed, suggest switching to agent mode
- Support your answers with actual code evidence (read files to verify)`
  };
  return blocks[mode];
}
var MAX_MODE_BLOCK = `## \u26A1 MAX MODE ACTIVE

You are running in MAX MODE with extended depth and thoroughness. Apply these additional steps:

- Read ALL relevant files (not just the obvious ones) before starting
- Map all dependencies, callers, and affected modules
- After changes: review for correctness, regressions, security, edge cases
- Run tests if available; check for compilation errors explicitly
- Use parallel tool calls aggressively to explore faster
- Document non-obvious decisions in comments`;
var CORE_PRINCIPLES = `## Core Principles

- **Accuracy first** \u2014 Prioritize correctness over speed. Investigate before concluding.
- **Minimal impact** \u2014 Make targeted changes. Prefer \`replace_in_file\` over full rewrites.
- **No assumptions** \u2014 Read actual code before modifying it. Never guess file contents.
- **Verify your work** \u2014 After changes, check for errors, test failures, and regressions.
- **Professional tone** \u2014 Be direct, objective, technically precise. No unnecessary praise.
- **Complete tasks** \u2014 Never leave tasks half-done. If blocked, explain why clearly.`;
var EDITING_FILES_GUIDE = `## Editing Files

Two tools to modify files: **write_to_file** and **replace_in_file**.

### replace_in_file (PREFERRED for existing files)
- Make targeted edits without rewriting the entire file
- Use for: bug fixes, adding/modifying functions, updating imports, small changes
- SEARCH block must match exactly \u2014 read the file first if unsure
- Stack multiple SEARCH/REPLACE blocks in one call for related changes
- Tool returns final file state \u2014 use it as reference for subsequent edits

### write_to_file (for new files or major rewrites)
- Creates new files or completely replaces content
- Use when: new files, complete restructuring, files where >50% changes
- Must provide complete final content \u2014 no partial writes

### Auto-formatting
Editor may auto-format files after writing. Tool response includes post-format content \u2014 always use that as reference for next edits.`;
var TOOL_USE_GUIDE = `## Tool Usage

- **Parallel reads** \u2014 When fetching multiple independent files/results, call all tools in parallel in a single response. This is significantly faster.
- **Sequential when dependent** \u2014 If tool B needs tool A's output, run them in order.
- **Specialized tools** \u2014 Use \`read_file\` instead of \`execute_command\` with cat. Use \`search_files\` instead of execute+grep. Reserve \`execute_command\` for actual shell operations.
- **Codebase search** \u2014 Use \`codebase_search\` for semantic queries, \`search_files\` for exact pattern matching, \`list_code_definitions\` for symbol discovery.
- **Don't repeat** \u2014 If a tool already returned a result, don't call it again with the same args.`;
var GIT_HYGIENE = `## Git & Workspace

- Never revert changes you didn't make unless explicitly asked
- If there are unrelated changes in files you touch, work around them \u2014 don't revert them
- Never use destructive commands (\`git reset --hard\`, \`git checkout --\`) unless explicitly requested
- Do not amend commits unless explicitly asked
- When creating commits: use conventional commit format (\`feat:\`, \`fix:\`, \`refactor:\`, etc.)`;
var TASK_PROGRESS_GUIDE = `## Task Progress

Use \`update_todo_list\` frequently to track progress on complex tasks:

- Start complex tasks with a checklist: \`- [ ] Step 1\`, \`- [ ] Step 2\`
- Mark complete immediately: \`- [x] Step 1\`
- Update as scope changes or new steps emerge
- For simple 1-2 step tasks, a todo list is optional
- Call \`update_todo_list\` silently \u2014 don't announce it`;
var RESPONSE_STYLE = `## Response Style

- **Concise**: Be direct and to the point. Match verbosity to task complexity.
- **No preamble**: Don't start with "Great!", "Sure!", "Certainly!". Go straight to the answer/action.
- **No postamble**: Don't end with "Let me know if you need anything!", "Feel free to ask!", etc.
- **No unnecessary summaries**: After completing a task, confirm briefly. Don't re-explain what you did.
- **No emojis** unless the user explicitly asks for them.
- For substantial changes: lead with a quick explanation of what changed and why.
- For code changes: mention relevant file paths with line numbers when helpful.
- Never ask permission questions ("Should I proceed?", "Do you want me to run tests?") \u2014 just do the most reasonable thing.
- If you must ask: do all non-blocked work first, ask exactly one targeted question.`;
var CODE_REFERENCES_FORMAT = `## Code References

When referencing specific code locations, use the format \`path/to/file.ts:42\` \u2014 this makes references clickable.

Examples:
- \`src/auth/login.ts:156\` \u2014 specific line
- \`packages/core/src/agent/loop.ts\` \u2014 whole file
- \`packages/core/src/provider/base.ts:30\` \u2014 function start

Rules:
- Use workspace-relative or absolute paths
- Include line numbers for specific functions or bugs
- Each reference should be a standalone inline code span`;
var SECURITY_GUIDELINES = `## Security

- Assist only with defensive security tasks
- Never help with credential harvesting, bulk scraping of keys/tokens, or malicious code
- Never guess or fabricate API keys, passwords, or tokens
- If a task seems malicious or harmful, decline and explain briefly
- Never write code that bypasses authentication without explicit user consent`;
function buildRulesBlock(rulesContent) {
  if (!rulesContent.trim()) return "";
  return `## Project Rules & Guidelines

The following rules apply to this project. Follow them strictly:

${rulesContent}`;
}
function buildSkillsBlock(skills) {
  if (skills.length === 0) return "";
  const lines = [`## Active Skills
`, `The following skills are active for this task:
`];
  for (const skill of skills) {
    lines.push(`### Skill: ${skill.name}`);
    lines.push(skill.content);
    lines.push(``);
  }
  return lines.join("\n");
}
function buildSystemInfoBlock(ctx) {
  const lines = [];
  lines.push(`## Environment`);
  lines.push(`<env>`);
  lines.push(`  Working directory: ${ctx.cwd}`);
  lines.push(`  Platform: ${os5.platform()} ${os5.arch()}`);
  lines.push(`  Date: ${(/* @__PURE__ */ new Date()).toISOString().split("T")[0]}`);
  lines.push(`  Shell: ${process.env["SHELL"] ?? "bash"}`);
  lines.push(`  Node.js: ${process.version}`);
  lines.push(`  Model: ${ctx.providerName}/${ctx.modelId}`);
  if (ctx.gitBranch) {
    lines.push(`  Git branch: ${ctx.gitBranch}`);
  }
  if (ctx.indexStatus) {
    const s = ctx.indexStatus;
    if (s.state === "ready") {
      lines.push(`  Codebase index: ready \u2014 ${s.files ?? 0} files, ${s.symbols ?? 0} symbols indexed`);
      lines.push(`  Tip: Use codebase_search for semantic queries, search_files for exact patterns`);
    } else if (s.state === "indexing") {
      lines.push(`  Codebase index: indexing ${s.progress ?? 0}/${s.total ?? 0} files...`);
    } else {
      lines.push(`  Codebase index: not ready (${s.state})`);
    }
  }
  lines.push(`</env>`);
  if (ctx.todoList?.trim()) {
    lines.push(``);
    lines.push(`## Current Todo List`);
    lines.push(ctx.todoList);
  }
  if (ctx.diagnostics && ctx.diagnostics.length > 0) {
    lines.push(``);
    lines.push(`## Active Diagnostics (Errors/Warnings)`);
    lines.push(`The following diagnostics are currently active. Address them if relevant to your task:`);
    const shown = ctx.diagnostics.slice(0, 30);
    for (const d of shown) {
      const icon = d.severity === "error" ? "\u2717" : d.severity === "warning" ? "\u26A0" : "\u2139";
      lines.push(`  ${icon} ${d.file}:${d.line}:${d.col} [${d.severity}] ${d.message}${d.source ? ` (${d.source})` : ""}`);
    }
    if (ctx.diagnostics.length > 30) {
      lines.push(`  ... and ${ctx.diagnostics.length - 30} more`);
    }
  }
  return lines.join("\n");
}
function buildMentionsBlock(mentionsContext) {
  if (!mentionsContext.trim()) return "";
  return `## Additional Context (from @mentions)

${mentionsContext}`;
}
function buildCompactionBlock(summary) {
  if (!summary.trim()) return "";
  return `## Conversation History Summary

The conversation has been compacted. Here is the context to continue:

${summary}

> Note: Continue from where we left off based on this summary.`;
}
function buildSystemPrompt(ctx) {
  const blocks = [];
  blocks.push(buildRoleBlock(ctx));
  if (ctx.rulesContent.trim()) {
    blocks.push(buildRulesBlock(ctx.rulesContent));
  }
  if (ctx.skills.length > 0) {
    blocks.push(buildSkillsBlock(ctx.skills));
  }
  const cacheableCount = blocks.length;
  blocks.push(buildSystemInfoBlock(ctx));
  if (ctx.mentionsContext?.trim()) {
    blocks.push(buildMentionsBlock(ctx.mentionsContext));
  }
  if (ctx.compactionSummary?.trim()) {
    blocks.push(buildCompactionBlock(ctx.compactionSummary));
  }
  return { blocks, cacheableCount };
}

// src/agent/modes.ts
var MODE_TOOL_GROUPS = {
  agent: ["always", "read", "write", "execute", "search", "browser", "mcp", "skills", "agents"],
  plan: ["always", "read", "write", "search", "skills"],
  // write allowed but restricted to docs
  debug: ["always", "read", "write", "execute", "search", "skills"],
  ask: ["always", "read", "search"]
};
var MODE_BLOCKED_TOOLS = {
  agent: [],
  plan: ["execute_command", "browser_action"],
  debug: [],
  ask: ["write_to_file", "replace_in_file", "apply_patch", "execute_command", "browser_action", "spawn_agent", "create_rule"]
};
var PLAN_MODE_BLOCKED_EXTENSIONS = /* @__PURE__ */ new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".cs",
  ".swift",
  ".kt",
  ".lua",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".sql",
  ".graphql"
]);
var TOOL_GROUP_MEMBERS = {
  always: ["attempt_completion", "ask_followup_question", "update_todo_list"],
  read: ["read_file", "list_files", "list_code_definitions"],
  write: ["write_to_file", "replace_in_file", "apply_patch", "create_rule"],
  execute: ["execute_command"],
  search: ["search_files", "codebase_search", "web_fetch", "web_search"],
  browser: ["browser_action"],
  mcp: [],
  // populated dynamically from MCP registry
  skills: ["use_skill"],
  agents: ["spawn_agent"]
};
var READ_ONLY_TOOLS = /* @__PURE__ */ new Set([
  "read_file",
  "list_files",
  "list_code_definitions",
  "search_files",
  "codebase_search",
  "web_fetch",
  "web_search",
  "use_skill"
]);
function getBuiltinToolsForMode(mode) {
  const groups = MODE_TOOL_GROUPS[mode];
  const tools = /* @__PURE__ */ new Set();
  for (const group of groups) {
    if (group === "mcp") continue;
    for (const tool of TOOL_GROUP_MEMBERS[group]) {
      tools.add(tool);
    }
  }
  return Array.from(tools);
}
function getBlockedToolsForMode(mode) {
  return new Set(MODE_BLOCKED_TOOLS[mode]);
}
function getAutoApproveActions(mode, modeConfig) {
  const defaults = {
    agent: ["read"],
    plan: ["read"],
    debug: ["read"],
    ask: ["read"]
  };
  const configured = modeConfig?.autoApprove ?? defaults[mode];
  return new Set(configured);
}
var TOOL_SELECTION_SCHEMA = z.object({
  selected: z.array(z.string()),
  reasoning: z.string().optional()
});
var SKILL_SELECTION_SCHEMA = z.object({
  selected: z.array(z.string()),
  reasoning: z.string().optional()
});
var ALWAYS_INCLUDE_TOOLS = /* @__PURE__ */ new Set([
  "attempt_completion",
  "ask_followup_question",
  "update_todo_list"
]);
async function classifyTools(tools, taskDescription, client) {
  const alwaysIncluded = tools.filter((t) => ALWAYS_INCLUDE_TOOLS.has(t.name));
  const toClassify = tools.filter((t) => !ALWAYS_INCLUDE_TOOLS.has(t.name));
  if (toClassify.length === 0) return tools.map((t) => t.name);
  const toolList = toClassify.map((t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 100)}`).join("\n");
  const systemPrompt = `You are a tool selector. Given a task description and a list of available tools, select the tools most likely needed to complete the task.

Rules:
- Select between 5 and 15 tools (fewer is better \u2014 don't include tools that are clearly irrelevant)
- When unsure, include the tool (false negative is worse than false positive)
- Include tools for: reading/writing code relevant to the task, testing, building, deploying if mentioned
- Do NOT include tools for: unrelated languages/frameworks, tools the task clearly doesn't need
- Always select tools that are clearly relevant to the task domain

Respond with JSON: { "selected": ["tool_name_1", "tool_name_2", ...] }`;
  const userMessage = `Task: ${taskDescription.slice(0, 500)}

Available tools:
${toolList}

Select the most relevant tools.`;
  try {
    const result = await client.generateStructured({
      messages: [{ role: "user", content: userMessage }],
      schema: TOOL_SELECTION_SCHEMA,
      systemPrompt,
      maxRetries: 2
    });
    const selectedNames = /* @__PURE__ */ new Set([
      ...alwaysIncluded.map((t) => t.name),
      ...result.selected.filter((name) => toClassify.some((t) => t.name === name))
    ]);
    return tools.filter((t) => selectedNames.has(t.name)).map((t) => t.name);
  } catch {
    return tools.map((t) => t.name);
  }
}
async function classifySkills(skills, taskDescription, client) {
  if (skills.length === 0) return [];
  const skillList = skills.map((s) => `- ${s.name}: ${s.summary}`).join("\n");
  const systemPrompt = `You are a skill relevance classifier. Select the skills most relevant to completing the given task.

Rules:
- Select at most 5 skills (+ 1 buffer for edge cases = max 6)
- Always include skills about the main technology stack mentioned in the task
- Include skills that provide useful context or guidelines for the task domain
- When in doubt, include (false negative is worse than false positive)
- Return the exact skill names as listed

Respond with JSON: { "selected": ["skill_name_1", ...] }`;
  const userMessage = `Task: ${taskDescription.slice(0, 500)}

Available skills:
${skillList}

Select the most relevant skills.`;
  try {
    const result = await client.generateStructured({
      messages: [{ role: "user", content: userMessage }],
      schema: SKILL_SELECTION_SCHEMA,
      systemPrompt,
      maxRetries: 2
    });
    const selectedNames = new Set(result.selected);
    return skills.filter((s) => selectedNames.has(s.name));
  } catch {
    return skills.slice(0, 6);
  }
}

// src/agent/loop.ts
var DOOM_LOOP_THRESHOLD = 3;
async function runAgentLoop(opts) {
  const {
    session,
    client,
    maxModeClient,
    host,
    config,
    mode,
    tools,
    skills,
    rulesContent,
    indexer,
    compaction,
    signal,
    gitBranch
  } = opts;
  const activeClient = config.maxMode.enabled && maxModeClient ? maxModeClient : client;
  const blockedTools = getBlockedToolsForMode(mode);
  const builtinToolNames = new Set(getBuiltinToolsForMode(mode));
  const builtinTools = tools.filter((t) => builtinToolNames.has(t.name) && !blockedTools.has(t.name));
  const dynamicTools = tools.filter((t) => !builtinToolNames.has(t.name) && !blockedTools.has(t.name));
  let resolvedDynamicTools;
  if (dynamicTools.length > config.tools.classifyThreshold) {
    const lastMessage = session.messages[session.messages.length - 1];
    const taskDesc = typeof lastMessage?.content === "string" ? lastMessage.content : lastMessage?.content?.find((p) => p.type === "text")?.text ?? "";
    const selectedNames = await classifyTools(dynamicTools, taskDesc, activeClient);
    const selectedSet = new Set(selectedNames);
    resolvedDynamicTools = dynamicTools.filter((t) => selectedSet.has(t.name));
  } else {
    resolvedDynamicTools = dynamicTools;
  }
  const resolvedTools = [...builtinTools, ...resolvedDynamicTools];
  let resolvedSkills;
  if (skills.length > config.skillClassifyThreshold) {
    const lastMessage = session.messages[session.messages.length - 1];
    const taskDesc = typeof lastMessage?.content === "string" ? lastMessage.content : lastMessage?.content?.find((p) => p.type === "text")?.text ?? "";
    resolvedSkills = await classifySkills(skills, taskDesc, activeClient);
  } else {
    resolvedSkills = skills;
  }
  const toolCtx = {
    cwd: host.cwd,
    host,
    session,
    config,
    indexer,
    signal
  };
  const autoApproveActions = getAutoApproveActions(mode, config.modes[mode]);
  while (!signal.aborted) {
    const promptCtx = {
      mode,
      maxMode: config.maxMode.enabled,
      cwd: host.cwd,
      modelId: activeClient.modelId,
      providerName: activeClient.providerName,
      skills: resolvedSkills,
      rulesContent,
      indexStatus: indexer?.status(),
      gitBranch,
      todoList: session.getTodo(),
      compactionSummary: getCompactionSummary(session),
      mentionsContext: void 0
    };
    const { blocks, cacheableCount } = buildSystemPrompt(promptCtx);
    const systemPrompt = blocks.join("\n\n---\n\n");
    const llmTools = resolvedTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
    const messages = buildMessagesFromSession(session);
    const newMessageId = session.addMessage({
      role: "assistant",
      content: ""
    }).id;
    let currentText = "";
    const pendingReads = [];
    let lastToolName = "";
    let finishReason;
    let consecutiveInvalidToolCalls = 0;
    const MAX_CONSECUTIVE_INVALID = 3;
    const flushPendingReads = async () => {
      if (pendingReads.length === 0) return;
      const tasks = pendingReads.map(
        (tc) => executeToolCall(tc.toolCallId, tc.toolName, tc.toolInput, resolvedTools, toolCtx, autoApproveActions, config, host).catch((err) => ({ success: false, output: `Error: ${err.message}` }))
      );
      const results = await Promise.all(tasks);
      for (let i = 0; i < pendingReads.length; i++) {
        const tc = pendingReads[i];
        const result = results[i];
        const partId = `part_${tc.toolCallId}`;
        session.updateToolPart(newMessageId, partId, {
          status: result.success ? "completed" : "error",
          output: result.output,
          timeEnd: Date.now()
        });
        host.emit({
          type: "tool_end",
          tool: tc.toolName,
          partId,
          messageId: newMessageId,
          success: result.success
        });
      }
      pendingReads.length = 0;
    };
    try {
      for await (const event of activeClient.stream({
        messages,
        tools: llmTools,
        systemPrompt,
        signal,
        cacheableSystemBlocks: cacheableCount,
        maxTokens: config.maxMode.enabled ? 16384 : 8192
      })) {
        if (signal.aborted) break;
        switch (event.type) {
          case "text_delta":
            if (event.delta) {
              currentText += event.delta;
              session.updateMessage(newMessageId, { content: currentText });
              host.emit({ type: "text_delta", delta: event.delta, messageId: newMessageId });
            }
            break;
          case "reasoning_delta":
            if (event.delta) {
              host.emit({ type: "reasoning_delta", delta: event.delta, messageId: newMessageId });
            }
            break;
          case "tool_call": {
            const { toolCallId, toolName, toolInput } = event;
            if (!toolCallId || !toolName || !toolInput) break;
            const isKnownTool = resolvedTools.some((t) => t.name === toolName);
            if (!isKnownTool) {
              consecutiveInvalidToolCalls++;
              if (consecutiveInvalidToolCalls >= MAX_CONSECUTIVE_INVALID) {
                throw new Error(
                  `Model called ${consecutiveInvalidToolCalls} non-existent tools in a row ("${toolName}" etc). This likely indicates model confusion. Stopping to prevent infinite loop.`
                );
              }
            } else {
              consecutiveInvalidToolCalls = 0;
            }
            const partId = `part_${toolCallId}`;
            session.addToolPart(newMessageId, {
              type: "tool",
              id: partId,
              tool: toolName,
              status: "pending",
              input: toolInput,
              timeStart: Date.now()
            });
            host.emit({ type: "tool_start", tool: toolName, partId, messageId: newMessageId });
            if (toolInput["task_progress"] && typeof toolInput["task_progress"] === "string") {
              session.updateTodo(toolInput["task_progress"]);
            }
            if (await detectDoomLoop(session, toolName, toolInput)) {
              host.emit({ type: "doom_loop_detected", tool: toolName });
              if (!process.stdin.isTTY) {
                throw new Error(`Doom loop: tool "${toolName}" called ${DOOM_LOOP_THRESHOLD} times with same arguments. Aborting.`);
              }
              const doomApproval = await host.showApprovalDialog({
                type: "doom_loop",
                tool: toolName,
                description: `Potential infinite loop: "${toolName}" called ${DOOM_LOOP_THRESHOLD} times with same args.`
              });
              if (!doomApproval.approved) {
                throw new Error(`User aborted doom loop for "${toolName}"`);
              }
            }
            if (READ_ONLY_TOOLS.has(toolName) && config.tools.parallelReads && !toolInput["task_progress"]) {
              pendingReads.push({ toolCallId, toolName, toolInput });
              if (pendingReads.length >= config.tools.maxParallelReads) {
                await flushPendingReads();
              }
            } else {
              await flushPendingReads();
              const result = await executeToolCall(
                toolCallId,
                toolName,
                toolInput,
                resolvedTools,
                toolCtx,
                autoApproveActions,
                config,
                host,
                session,
                newMessageId
              );
              session.updateToolPart(newMessageId, partId, {
                status: result.success ? "completed" : "error",
                output: result.output,
                timeEnd: Date.now()
              });
              host.emit({
                type: "tool_end",
                tool: toolName,
                partId,
                messageId: newMessageId,
                success: result.success
              });
              lastToolName = toolName;
            }
            break;
          }
          case "finish":
            await flushPendingReads();
            finishReason = event.finishReason;
            if (event.usage) {
              session.updateMessage(newMessageId, {
                tokens: {
                  input: event.usage.inputTokens,
                  output: event.usage.outputTokens,
                  cacheRead: event.usage.cacheReadTokens,
                  cacheWrite: event.usage.cacheWriteTokens
                }
              });
            }
            host.emit({ type: "done", messageId: newMessageId });
            break;
          case "error":
            if (event.error) {
              await flushPendingReads();
              host.emit({ type: "error", error: event.error.message });
            }
            break;
        }
      }
    } catch (err) {
      if (signal.aborted) break;
      const errMsg = err instanceof Error ? err.message : String(err);
      host.emit({ type: "error", error: errMsg });
      if (isContextOverflowError(errMsg)) {
        await handleCompaction(session, activeClient, config, host, compaction, signal);
        continue;
      }
      break;
    }
    if (lastToolName === "attempt_completion") break;
    if (finishReason === "stop" && !lastToolName) break;
    if (signal.aborted) break;
    const tokenCount = session.getTokenEstimate();
    const contextLimit = getContextLimit(activeClient.modelId);
    if (contextLimit > 0 && tokenCount / contextLimit > config.summarization.threshold) {
      host.emit({ type: "compaction_start" });
      await handleCompaction(session, activeClient, config, host, compaction, signal);
      host.emit({ type: "compaction_end" });
    }
    await session.save();
  }
}
async function executeToolCall(toolCallId, toolName, toolInput, tools, ctx, autoApproveActions, config, host, session, messageId) {
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    const availableList = tools.map((t) => t.name).join(", ");
    return {
      success: false,
      output: `ERROR: Tool "${toolName}" does not exist. IMPORTANT: Use ONLY these available tools: ${availableList}. To run shell commands, use execute_command. To present final results, use attempt_completion.`
    };
  }
  if (ctx.config.modes && ["write_to_file", "replace_in_file", "apply_patch"].includes(toolName) && toolInput["path"] && typeof toolInput["path"] === "string") {
    const pathExtension = toolInput["path"].match(/\.[a-zA-Z0-9]+$/);
    const ext = pathExtension ? pathExtension[0].toLowerCase() : "";
    if (ext && PLAN_MODE_BLOCKED_EXTENSIONS.has(ext)) {
      const isRestrictedMode = !tools.some((t) => t.name === "execute_command");
      if (isRestrictedMode) {
        return {
          success: false,
          output: `In the current mode, you cannot modify source code files (${ext}). You may only write documentation files (.md, .txt). Use attempt_completion to present your plan as text.`
        };
      }
    }
  }
  const ruleResult = evaluatePermissionRules(toolName, toolInput, config);
  if (ruleResult === "deny") {
    const ruleReason = findRuleReason(toolName, toolInput, config);
    return { success: false, output: `Access denied by permission rule${ruleReason ? `: ${ruleReason}` : ""}` };
  }
  if (ruleResult === "ask") {
    const action = buildApprovalAction(toolName, toolInput);
    action.description = `[Permission Rule] ${action.description}`;
    host.emit({ type: "tool_approval_needed", action, partId: `part_${toolCallId}` });
    const approval = await host.showApprovalDialog(action);
    if (!approval.approved) {
      return { success: false, output: `User denied ${toolName}` };
    }
  }
  if (ruleResult === null && toolInput["path"] && typeof toolInput["path"] === "string") {
    for (const pattern of config.permissions.denyPatterns) {
      if (matchesGlob(toolInput["path"], pattern)) {
        return { success: false, output: `Access denied: path matches deny pattern "${pattern}"` };
      }
    }
  }
  if (ruleResult === null) {
    const needsApproval = toolNeedsApproval(toolName, toolInput, autoApproveActions, config);
    if (needsApproval) {
      const action = buildApprovalAction(toolName, toolInput);
      host.emit({ type: "tool_approval_needed", action, partId: `part_${toolCallId}` });
      const approval = await host.showApprovalDialog(action);
      if (!approval.approved) {
        return { success: false, output: `User denied ${toolName}` };
      }
    }
  }
  let validatedArgs;
  try {
    validatedArgs = tool.parameters.parse(toolInput);
  } catch (err) {
    return { success: false, output: `Invalid arguments for ${toolName}: ${err}` };
  }
  try {
    const result = await tool.execute(validatedArgs, ctx);
    return { success: result.success, output: result.output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Tool ${toolName} error: ${msg}` };
  }
}
async function detectDoomLoop(session, toolName, toolInput) {
  const allParts = session.messages.flatMap((m) => {
    if (!Array.isArray(m.content)) return [];
    return m.content.filter((p) => p.type === "tool" && p.tool === toolName).map((p) => p.input);
  }).slice(-DOOM_LOOP_THRESHOLD);
  if (allParts.length < DOOM_LOOP_THRESHOLD) return false;
  const inputSig = JSON.stringify(toolInput);
  return allParts.every((p) => JSON.stringify(p) === inputSig);
}
function getCompactionSummary(session) {
  const summaryMsg = [...session.messages].reverse().find((m) => m.summary);
  if (!summaryMsg) return void 0;
  return typeof summaryMsg.content === "string" ? summaryMsg.content : void 0;
}
async function handleCompaction(session, client, config, host, compaction, signal) {
  try {
    compaction.prune(session);
    const tokenCount = session.getTokenEstimate();
    const contextLimit = getContextLimit(client.modelId);
    if (contextLimit > 0 && tokenCount / contextLimit > config.summarization.threshold) {
      await compaction.compact(session, client, signal);
    }
  } catch (err) {
    console.warn("[nexus] Compaction failed:", err);
  }
}
function buildMessagesFromSession(session) {
  const messages = [];
  for (const msg of session.messages) {
    if (msg.summary) {
      messages.push({
        role: "user",
        content: `<conversation_summary>
${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}
</conversation_summary>`
      });
      continue;
    }
    if (msg.role === "system") continue;
    if (typeof msg.content === "string") {
      if (!msg.content.trim()) continue;
      if (msg.role === "user") {
        messages.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        messages.push({ role: "assistant", content: msg.content });
      }
      continue;
    }
    const parts = msg.content;
    if (!Array.isArray(parts) || parts.length === 0) continue;
    if (msg.role === "user") {
      const textContent2 = parts.filter((p) => p.type === "text").map((p) => p.text).join("").trim();
      if (textContent2) {
        messages.push({ role: "user", content: textContent2 });
      }
      continue;
    }
    if (msg.role !== "assistant") continue;
    const textParts = parts.filter((p) => p.type === "text");
    parts.filter((p) => p.type === "reasoning");
    const toolParts = parts.filter((p) => p.type === "tool");
    const textContent = textParts.map((p) => p.text).join("").trim();
    const toolCallParts = toolParts.filter((tp) => tp.input != null);
    const completedToolParts = toolParts.filter((tp) => tp.status === "completed" || tp.status === "error");
    if (toolCallParts.length > 0) {
      const assistantContent = [];
      if (textContent) {
        assistantContent.push({ type: "text", text: textContent });
      }
      for (const tp of toolCallParts) {
        assistantContent.push({
          type: "tool-call",
          toolCallId: tp.id,
          toolName: tp.tool,
          args: tp.input ?? {}
        });
      }
      messages.push({ role: "assistant", content: assistantContent });
      if (completedToolParts.length > 0) {
        const toolResultContent = completedToolParts.map((tp) => ({
          type: "tool-result",
          toolCallId: tp.id,
          toolName: tp.tool,
          result: tp.compacted ? "[output pruned for context efficiency]" : tp.output ?? "",
          isError: tp.status === "error"
        }));
        messages.push({ role: "tool", content: toolResultContent });
      }
    } else if (textContent) {
      messages.push({ role: "assistant", content: textContent });
    }
  }
  return messages;
}
function toolNeedsApproval(toolName, toolInput, autoApproveActions, config) {
  if (READ_ONLY_TOOLS.has(toolName)) {
    if (autoApproveActions.has("read")) return false;
    if (toolInput["path"] && typeof toolInput["path"] === "string") {
      for (const pattern of config.permissions.autoApproveReadPatterns) {
        if (matchesGlob(toolInput["path"], pattern)) return false;
      }
    }
    return !config.permissions.autoApproveRead;
  }
  if (["write_to_file", "replace_in_file", "apply_patch"].includes(toolName)) {
    return !config.permissions.autoApproveWrite && !autoApproveActions.has("write");
  }
  if (toolName === "execute_command") {
    return !config.permissions.autoApproveCommand && !autoApproveActions.has("execute");
  }
  return false;
}
function buildApprovalAction(toolName, toolInput) {
  if (["write_to_file", "replace_in_file"].includes(toolName)) {
    return {
      type: "write",
      tool: toolName,
      description: `Write to ${toolInput["path"] ?? "file"}`,
      content: toolInput["content"]
    };
  }
  if (toolName === "execute_command") {
    return {
      type: "execute",
      tool: toolName,
      description: `Run: ${toolInput["command"]}`
    };
  }
  return {
    type: "read",
    tool: toolName,
    description: `${toolName}(${JSON.stringify(toolInput).slice(0, 100)})`
  };
}
function evaluatePermissionRules(toolName, toolInput, config) {
  const rules = config.permissions.rules ?? [];
  for (const rule of rules) {
    if (!ruleMatchesTool(rule.tool, toolName)) continue;
    if (rule.pathPattern && !ruleMatchesPath(rule.pathPattern, toolInput)) continue;
    if (rule.commandPattern && !ruleMatchesCommand(rule.commandPattern, toolInput)) continue;
    return rule.action;
  }
  return null;
}
function findRuleReason(toolName, toolInput, config) {
  const rules = config.permissions.rules ?? [];
  for (const rule of rules) {
    if (!ruleMatchesTool(rule.tool, toolName)) continue;
    if (rule.pathPattern && !ruleMatchesPath(rule.pathPattern, toolInput)) continue;
    if (rule.commandPattern && !ruleMatchesCommand(rule.commandPattern, toolInput)) continue;
    return rule.reason;
  }
  return void 0;
}
function ruleMatchesTool(pattern, toolName) {
  if (!pattern) return true;
  if (pattern.includes("*") || pattern.includes("?")) {
    return matchesGlob(toolName, pattern);
  }
  return pattern === toolName || toolName.startsWith(pattern + "_");
}
function ruleMatchesPath(pathPattern, toolInput) {
  const filePath = toolInput["path"];
  if (!filePath) return false;
  return matchesGlob(filePath, pathPattern);
}
function ruleMatchesCommand(commandPattern, toolInput) {
  const command = String(toolInput["command"] ?? "");
  try {
    return new RegExp(commandPattern).test(command);
  } catch {
    return command.includes(commandPattern);
  }
}
function matchesGlob(filePath, pattern) {
  try {
    return globMatch(filePath, pattern);
  } catch {
    return filePath.includes(pattern.replace(/\*/g, ""));
  }
}
function globMatch(str, pattern) {
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regexStr += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        regexStr += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        regexStr += "\\{";
        i++;
        continue;
      }
      const alts = pattern.slice(i + 1, end).split(",").map(escapeRegex);
      regexStr += `(?:${alts.join("|")})`;
      i = end + 1;
    } else {
      regexStr += escapeRegex(c);
      i++;
    }
  }
  try {
    return new RegExp(`^${regexStr}$`).test(str);
  } catch {
    return str.includes(pattern.replace(/[*?{}]/g, ""));
  }
}
function escapeRegex(s) {
  return s.replace(/[.+^$|()[\]\\]/g, "\\$&");
}
function isContextOverflowError(message) {
  const lower = message.toLowerCase();
  return lower.includes("context length") || lower.includes("context window") || lower.includes("max tokens") || lower.includes("too long") || lower.includes("token limit");
}
function getContextLimit(modelId) {
  const lower = modelId.toLowerCase();
  if (lower.includes("claude-3") || lower.includes("claude-4") || lower.includes("claude-sonnet") || lower.includes("claude-opus")) return 2e5;
  if (lower.includes("gpt-4o")) return 128e3;
  if (lower.includes("gpt-4")) return 128e3;
  if (lower.includes("gpt-3.5")) return 16e3;
  if (lower.includes("gemini-2")) return 1e6;
  if (lower.includes("gemini")) return 2e5;
  return 128e3;
}
async function loadRules(cwd, rulePatterns) {
  const contents = [];
  const seen = /* @__PURE__ */ new Set();
  const topLevelFiles = rulePatterns.filter((p) => !p.includes("**") && !p.includes("*"));
  const globPatterns = rulePatterns.filter((p) => p.includes("**") || p.includes("*"));
  let dir = cwd;
  let maxUp = 10;
  while (maxUp-- > 0) {
    for (const file of topLevelFiles) {
      const candidate = path4.join(dir, file);
      if (!seen.has(candidate)) {
        const content = await readFileSafe(candidate);
        if (content) {
          seen.add(candidate);
          const rel = path4.relative(cwd, candidate);
          contents.push(`<!-- Rules from ${rel} -->
${content}`);
        }
      }
    }
    const parent = path4.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const pattern of globPatterns) {
    const expandedPath = pattern.startsWith("~") ? pattern.replace("~", os5.homedir()) : path4.join(cwd, pattern);
    const matches = await glob(expandedPath).catch(() => []);
    for (const match of matches.sort()) {
      if (!seen.has(match)) {
        const content = await readFileSafe(match);
        if (content) {
          seen.add(match);
          const rel = path4.relative(cwd, match);
          contents.push(`<!-- Rules from ${rel} -->
${content}`);
        }
      }
    }
  }
  const globalRulesDir = path4.join(os5.homedir(), ".nexus", "rules");
  const globalRules = await glob(path4.join(globalRulesDir, "**/*.md")).catch(() => []);
  for (const match of globalRules.sort()) {
    if (!seen.has(match)) {
      const content = await readFileSafe(match);
      if (content) {
        seen.add(match);
        contents.push(`<!-- Global rule: ${path4.basename(match)} -->
${content}`);
      }
    }
  }
  return contents.join("\n\n");
}
async function readFileSafe(filePath) {
  try {
    const stat7 = await fs10.stat(filePath);
    if (!stat7.isFile()) return null;
    if (stat7.size > 100 * 1024) return null;
    return await fs10.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
async function loadSkills(skillPaths, cwd) {
  const skills = [];
  const seen = /* @__PURE__ */ new Set();
  const configPaths = skillPaths.map(
    (p) => path4.isAbsolute(p) ? p : path4.resolve(cwd, p)
  );
  const standardGlobs = [
    path4.join(cwd, ".nexus", "skills", "**", "SKILL.md"),
    path4.join(cwd, ".nexus", "skills", "**", "*.md"),
    path4.join(cwd, ".agents", "skills", "**", "*.md"),
    path4.join(os5.homedir(), ".nexus", "skills", "**", "SKILL.md"),
    path4.join(os5.homedir(), ".nexus", "skills", "**", "*.md"),
    path4.join(os5.homedir(), ".agents", "skills", "**", "*.md")
  ];
  for (const cfgPath of configPaths) {
    await collectSkillFiles(cfgPath, seen, skills);
  }
  for (const pattern of standardGlobs) {
    let files;
    try {
      files = await glob(pattern, { absolute: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      const skill = await loadSkillFile(file);
      if (skill) skills.push(skill);
    }
  }
  const byName = /* @__PURE__ */ new Map();
  for (const skill of skills) {
    if (!byName.has(skill.name)) {
      byName.set(skill.name, skill);
    }
  }
  return Array.from(byName.values());
}
async function collectSkillFiles(cfgPath, seen, skills, cwd) {
  if (cfgPath.includes("*")) {
    const files = await glob(cfgPath, { absolute: true }).catch(() => []);
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      const skill = await loadSkillFile(file);
      if (skill) skills.push(skill);
    }
    return;
  }
  const stat7 = await fs10.stat(cfgPath).catch(() => null);
  if (!stat7) return;
  if (stat7.isFile()) {
    if (seen.has(cfgPath)) return;
    seen.add(cfgPath);
    const skill = await loadSkillFile(cfgPath);
    if (skill) skills.push(skill);
    return;
  }
  if (stat7.isDirectory()) {
    const candidates = [
      path4.join(cfgPath, "SKILL.md"),
      path4.join(cfgPath, "skill.md"),
      path4.join(cfgPath, "README.md")
    ];
    for (const c of candidates) {
      if (seen.has(c)) continue;
      const cStat = await fs10.stat(c).catch(() => null);
      if (cStat?.isFile()) {
        seen.add(c);
        const skill = await loadSkillFile(c);
        if (skill) {
          skills.push(skill);
          return;
        }
      }
    }
    const files = await glob(path4.join(cfgPath, "*.md"), { absolute: true }).catch(() => []);
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      const skill = await loadSkillFile(file);
      if (skill) skills.push(skill);
    }
  }
}
async function loadSkillFile(filePath, _cwd) {
  try {
    const content = await fs10.readFile(filePath, "utf8");
    if (!content.trim()) return null;
    const dirName = path4.basename(path4.dirname(filePath));
    const fileName = path4.basename(filePath, path4.extname(filePath));
    const name = !["skills", ".nexus", ".agents"].includes(dirName.toLowerCase()) ? dirName : fileName;
    const lines = content.split("\n").filter((l) => l.trim());
    const headingLine = lines.find((l) => l.startsWith("#"));
    const summaryLine = headingLine ? headingLine.replace(/^#+\s*/, "") : lines.find((l) => !l.startsWith("#")) ?? "";
    const summary = summaryLine.replace(/^[-*]\s*/, "").slice(0, 120);
    return { name, path: filePath, summary, content };
  } catch {
    return null;
  }
}
var MAX_FILE_SIZE = 200 * 1024;
var MAX_LINES = 3e3;
var schema = z.object({
  path: z.string().describe("Relative or absolute path to the file"),
  start_line: z.number().int().positive().optional().describe("Start line (1-indexed)"),
  end_line: z.number().int().positive().optional().describe("End line (1-indexed, inclusive)")
});
var readFileTool = {
  name: "read_file",
  description: `Read the contents of a file.
Returns the file content with line numbers prefixed as "LINE_NUM|CONTENT".
For large files, use start_line and end_line to read specific sections.
Binary files return metadata only (size, type).
Maximum: ${MAX_FILE_SIZE / 1024}KB or ${MAX_LINES} lines per read.`,
  parameters: schema,
  readOnly: true,
  async execute({ path: filePath, start_line, end_line }, ctx) {
    const absPath = path4.resolve(ctx.cwd, filePath);
    let stat7;
    try {
      stat7 = await fs10.stat(absPath);
    } catch {
      return { success: false, output: `File not found: ${filePath}` };
    }
    if (stat7.isDirectory()) {
      return { success: false, output: `Path is a directory, not a file: ${filePath}. Use list_files instead.` };
    }
    if (await isBinaryFile(absPath)) {
      return {
        success: true,
        output: `[Binary file: ${filePath}]
Size: ${formatBytes(stat7.size)}
Cannot read binary content.`
      };
    }
    if (stat7.size > MAX_FILE_SIZE && !start_line) {
      const content2 = await fs10.readFile(absPath, "utf8");
      return truncateWithHeadTail(content2, filePath);
    }
    let content;
    try {
      content = await fs10.readFile(absPath, "utf8");
    } catch (err) {
      return { success: false, output: `Failed to read ${filePath}: ${err.message}` };
    }
    const lines = content.split("\n");
    const totalLines = lines.length;
    const start = start_line ? Math.max(0, start_line - 1) : 0;
    const end = end_line ? Math.min(totalLines, end_line) : totalLines;
    const slicedLines = lines.slice(start, end);
    if (slicedLines.length > MAX_LINES) {
      const head = slicedLines.slice(0, 100);
      const tail = slicedLines.slice(-100);
      const truncated = slicedLines.length - 200;
      const numbered2 = [
        ...head.map((l, i) => `${(start + i + 1).toString().padStart(6)}|${l}`),
        `      |... ${truncated} lines truncated (total: ${slicedLines.length}) ...`,
        ...tail.map((l, i) => `${(end - 100 + i + 1).toString().padStart(6)}|${l}`)
      ].join("\n");
      return {
        success: true,
        output: `<file_content path="${filePath}" lines="${start + 1}-${end}" total="${totalLines}">
${numbered2}
</file_content>`
      };
    }
    const numbered = slicedLines.map((l, i) => `${(start + i + 1).toString().padStart(6)}|${l}`).join("\n");
    return {
      success: true,
      output: `<file_content path="${filePath}" lines="${start + 1}-${Math.min(end, totalLines)}" total="${totalLines}">
${numbered}
</file_content>`
    };
  }
};
async function isBinaryFile(filePath) {
  try {
    const handle = await fs10.open(filePath, "r");
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    await handle.close();
    for (let i = 0; i < bytesRead; i++) {
      const byte = buffer[i];
      if (byte === 0) return true;
      if (byte < 8) return true;
    }
    return false;
  } catch {
    return false;
  }
}
function truncateWithHeadTail(content, filePath) {
  const lines = content.split("\n");
  const total = lines.length;
  const head = lines.slice(0, 100);
  const tail = lines.slice(-100);
  const truncated = total - 200;
  const numbered = [
    ...head.map((l, i) => `${(i + 1).toString().padStart(6)}|${l}`),
    `      |... ${truncated} lines truncated. Use start_line/end_line to read specific sections ...`,
    ...tail.map((l, i) => `${(total - 100 + i + 1).toString().padStart(6)}|${l}`)
  ].join("\n");
  return Promise.resolve({
    success: true,
    output: `<file_content path="${filePath}" lines="1-100..${total - 100}-${total}" total="${total}">
${numbered}
</file_content>`
  });
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
var schema2 = z.object({
  path: z.string().describe("Path to the file to create or overwrite"),
  content: z.string().describe("The complete content to write to the file")
});
var writeFileTool = {
  name: "write_to_file",
  description: `Create a new file or completely overwrite an existing file.
Use this for: creating new files, generating boilerplate, completely restructuring a file.
For small targeted changes to existing files, prefer replace_in_file.
WARNING: This replaces the entire file content. Provide the complete final content.`,
  parameters: schema2,
  requiresApproval: true,
  async execute({ path: filePath, content }, ctx) {
    const absPath = path4.resolve(ctx.cwd, filePath);
    const dirPath = path4.dirname(absPath);
    await fs10.mkdir(dirPath, { recursive: true });
    const tmpPath = `${absPath}.nexus_tmp_${Date.now()}`;
    try {
      await fs10.writeFile(tmpPath, content, "utf8");
      await fs10.rename(tmpPath, absPath);
    } catch (err) {
      try {
        await fs10.unlink(tmpPath);
      } catch {
      }
      return { success: false, output: `Failed to write ${filePath}: ${err.message}` };
    }
    const lines = content.split("\n").length;
    return {
      success: true,
      output: `Successfully wrote ${filePath} (${lines} lines)`
    };
  }
};
var searchReplaceBlock = z.object({
  search: z.string().describe("Exact text to find in the file (must match exactly)"),
  replace: z.string().describe("Text to replace the search block with")
});
var schema3 = z.object({
  path: z.string().describe("Path to the file to modify"),
  diff: z.array(searchReplaceBlock).min(1).describe("One or more search/replace blocks to apply")
});
var replaceInFileTool = {
  name: "replace_in_file",
  description: `Make targeted edits to an existing file using SEARCH/REPLACE blocks.

For each block:
- "search": the EXACT text currently in the file (whitespace and indentation must match)
- "replace": the text to replace it with

You can provide multiple blocks to make several changes in one call.
This is the preferred tool for modifying existing files \u2014 faster and less error-prone than write_to_file.

IMPORTANT:
- Read the file first if you're unsure about the exact content
- The search must match exactly (including whitespace/indentation)
- If the search block appears multiple times, only the first occurrence is replaced
- Blocks are applied top-to-bottom in order`,
  parameters: schema3,
  requiresApproval: true,
  async execute({ path: filePath, diff }, ctx) {
    const absPath = path4.resolve(ctx.cwd, filePath);
    let content;
    try {
      content = await fs10.readFile(absPath, "utf8");
    } catch {
      return { success: false, output: `File not found: ${filePath}` };
    }
    const originalContent = content;
    const results = [];
    for (let i = 0; i < diff.length; i++) {
      const block = diff[i];
      const idx = content.indexOf(block.search);
      if (idx === -1) {
        return {
          success: false,
          output: `Block ${i + 1}: SEARCH text not found in ${filePath}.
Search text:
${block.search.slice(0, 200)}

Hint: Read the file first to verify the exact content.`
        };
      }
      content = content.slice(0, idx) + block.replace + content.slice(idx + block.search.length);
      const line = originalContent.slice(0, idx).split("\n").length;
      results.push(`Block ${i + 1}: replaced at line ~${line}`);
    }
    const tmpPath = `${absPath}.nexus_tmp_${Date.now()}`;
    try {
      await fs10.writeFile(tmpPath, content, "utf8");
      await fs10.rename(tmpPath, absPath);
    } catch (err) {
      try {
        await fs10.unlink(tmpPath);
      } catch {
      }
      return { success: false, output: `Failed to write: ${err.message}` };
    }
    return {
      success: true,
      output: `Successfully updated ${filePath}:
${results.join("\n")}

<updated_content>
${content}
</updated_content>`
    };
  }
};
var schema4 = z.object({
  patch: z.string().describe("Unified diff patch to apply"),
  path: z.string().optional().describe("Override the file path from the patch header"),
  task_progress: z.string().optional()
});
var applyPatchTool = {
  name: "apply_patch",
  description: `Apply a unified diff patch to a file.
The patch must be in standard unified diff format (--- a/file +++ b/file).
Useful when the model generates a patch format naturally.
Prefer replace_in_file for targeted edits \u2014 it's more reliable.`,
  parameters: schema4,
  requiresApproval: true,
  async execute({ patch, path: overridePath }, ctx) {
    let filePath = overridePath;
    if (!filePath) {
      const match = patch.match(/^(?:---|\+\+\+)\s+(?:a\/|b\/)?(.+?)(?:\t.*)?$/m);
      if (match?.[1] && match[1] !== "/dev/null") {
        filePath = match[1];
      }
    }
    if (!filePath) {
      return { success: false, output: "Could not determine target file path from patch" };
    }
    const absPath = path4.resolve(ctx.cwd, filePath);
    let originalContent = "";
    try {
      originalContent = await fs10.readFile(absPath, "utf8");
    } catch {
    }
    const patched = applyPatch(originalContent, patch);
    if (patched === false) {
      return {
        success: false,
        output: `Failed to apply patch to ${filePath}. The patch may not match the current file content. Try replace_in_file instead.`
      };
    }
    const dirPath = path4.dirname(absPath);
    await fs10.mkdir(dirPath, { recursive: true });
    const tmpPath = `${absPath}.nexus_tmp_${Date.now()}`;
    try {
      await fs10.writeFile(tmpPath, patched, "utf8");
      await fs10.rename(tmpPath, absPath);
    } catch (err) {
      try {
        await fs10.unlink(tmpPath);
      } catch {
      }
      return { success: false, output: `Failed to write: ${err.message}` };
    }
    return {
      success: true,
      output: `Successfully applied patch to ${filePath}`
    };
  }
};
var MAX_OUTPUT_BYTES = 50 * 1024;
var PROGRESS_LINE_PATTERN = /[\r\x1b\[2K]/;
var schema5 = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory (defaults to project root)"),
  timeout_seconds: z.number().int().positive().max(600).optional().describe("Timeout in seconds (default: 120)"),
  task_progress: z.string().optional().describe("Updated todo list in markdown checklist format")
});
var executeCommandTool = {
  name: "execute_command",
  description: `Execute a shell command in the project directory.
Returns stdout, stderr, and exit code.
Output is capped at 50KB (head + tail shown if larger).
Progress bars and ANSI escape sequences are stripped.
Timeout default: 120 seconds (max: 600).

Best practices:
- Use for: running tests, build tools, installing packages, git operations
- Prefer other tools when available (read_file, write_to_file, search_files)
- For long-running servers, check if they start successfully then stop monitoring
- Chain commands with && for sequential execution`,
  parameters: schema5,
  requiresApproval: true,
  async execute({ command, cwd: cmdCwd, timeout_seconds }, ctx) {
    const workingDir = cmdCwd ? cmdCwd.startsWith("/") ? cmdCwd : `${ctx.cwd}/${cmdCwd}` : ctx.cwd;
    const timeout = (timeout_seconds ?? 120) * 1e3;
    let result;
    try {
      const proc = await execa(command, {
        cwd: workingDir,
        shell: true,
        timeout,
        all: true,
        reject: false
      });
      result = {
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? "",
        exitCode: proc.exitCode ?? 0
      };
    } catch (err) {
      const e = err;
      if (e.code === "ETIMEDOUT" || err.message?.includes("timed out")) {
        return {
          success: false,
          output: `Command timed out after ${timeout_seconds ?? 120}s: ${command}`
        };
      }
      result = {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? err.message,
        exitCode: e.exitCode ?? 1
      };
    }
    const fullOutput = sanitizeOutput(result.stdout + (result.stderr ? `
[stderr]
${result.stderr}` : ""));
    const truncated = truncateOutput(fullOutput);
    const success = result.exitCode === 0;
    const header = `$ ${command}
[exit: ${result.exitCode}]
`;
    return {
      success,
      output: header + truncated
    };
  }
};
function sanitizeOutput(raw) {
  let cleaned = stripAnsi(raw);
  cleaned = cleaned.split("\n").map((line) => {
    if (PROGRESS_LINE_PATTERN.test(line)) {
      const frames = line.split("\r");
      return frames[frames.length - 1]?.trim() ?? "";
    }
    return line;
  }).join("\n");
  return cleaned;
}
function truncateOutput(output) {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes <= MAX_OUTPUT_BYTES) return output;
  const lines = output.split("\n");
  const total = lines.length;
  const headLines = lines.slice(0, 100);
  const tailLines = lines.slice(-100);
  const truncatedCount = total - 200;
  return [
    ...headLines,
    `[... ${truncatedCount} lines truncated ...]`,
    ...tailLines
  ].join("\n");
}
var MAX_RESULTS = 500;
var MAX_OUTPUT_CHARS = 1e5;
var searchSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z.string().optional().describe("Directory or file to search in (relative to project root)"),
  include: z.string().optional().describe("File glob pattern to include, e.g. '*.ts' or '**/*.{ts,tsx}'"),
  exclude: z.string().optional().describe("File glob pattern to exclude"),
  context_lines: z.number().int().min(0).max(10).optional().describe("Lines of context around matches (0-10)"),
  case_sensitive: z.boolean().optional().describe("Case sensitive search (default: false)"),
  task_progress: z.string().optional()
});
var searchFilesTool = {
  name: "search_files",
  description: `Search file contents using regex patterns (powered by ripgrep).
Returns matching lines with file path and line numbers.
Maximum ${MAX_RESULTS} results.

Examples:
- Find all TODO comments: pattern="TODO|FIXME"
- Find function definitions: pattern="^(export )?function \\w+", include="*.ts"
- Find class usages: pattern="new MyClass\\("`,
  parameters: searchSchema,
  readOnly: true,
  async execute({ pattern, path: searchPath, include, exclude, context_lines, case_sensitive }, ctx) {
    const searchDir = searchPath ? path4.resolve(ctx.cwd, searchPath) : ctx.cwd;
    const args = [
      "--json",
      "--max-count",
      "1",
      "-e",
      pattern
    ];
    if (!case_sensitive) args.push("--ignore-case");
    if (include) args.push("--glob", include);
    if (exclude) args.push("--glob", `!${exclude}`);
    if (context_lines) {
      args.push("--context", String(context_lines));
    }
    args.push(searchDir);
    try {
      const { stdout } = await execa("rg", args, {
        cwd: ctx.cwd,
        reject: false
      });
      if (!stdout) {
        return { success: true, output: `No matches found for pattern: ${pattern}` };
      }
      const lines = stdout.split("\n").filter(Boolean);
      const results = [];
      let matchCount = 0;
      for (const line of lines) {
        if (matchCount >= MAX_RESULTS) break;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "match") {
            const data = obj.data;
            const relPath = path4.relative(ctx.cwd, data.path.text);
            results.push(`${relPath}:${data.line_number}:${data.lines.text.trimEnd()}`);
            matchCount++;
          }
        } catch {
        }
      }
      if (results.length === 0) {
        return { success: true, output: `No matches found for pattern: ${pattern}` };
      }
      let output = results.join("\n");
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) + `
... (truncated, ${matchCount} total matches)`;
      }
      return {
        success: true,
        output: `Found ${matchCount} matches for /${pattern}/:

${output}`
      };
    } catch (err) {
      return {
        success: false,
        output: `Search failed: ${err.message}. Install ripgrep (rg) for search support.`
      };
    }
  }
};
var listSchema = z.object({
  path: z.string().optional().describe("Directory to list (relative to project root, default: root)"),
  recursive: z.boolean().optional().describe("List recursively (default: false for top-level, true for subdirs)"),
  include: z.string().optional().describe("Glob pattern to filter files"),
  max_entries: z.number().int().positive().max(5e3).optional().describe("Max entries (default: 200)"),
  task_progress: z.string().optional()
});
var listFilesTool = {
  name: "list_files",
  description: `List files and directories.
Shows a tree-like structure with files and subdirectories.
Use recursive=true to list all files in a directory tree.
Maximum 2000 entries.`,
  parameters: listSchema,
  readOnly: true,
  async execute({ path: listPath, recursive, include, max_entries }, ctx) {
    const targetDir = listPath ? path4.resolve(ctx.cwd, listPath) : ctx.cwd;
    const maxEntries = max_entries ?? 200;
    const maxActual = Math.min(maxEntries, 2e3);
    try {
      const { readdir: readdir4, stat: stat7 } = await import('fs/promises');
      const ignoreMod = await import('ignore');
      const ignoreFactory = ignoreMod.default ?? ignoreMod;
      let ig = ignoreFactory();
      try {
        const gitignoreContent = await import('fs/promises').then(
          (f) => f.readFile(path4.join(ctx.cwd, ".gitignore"), "utf8").catch(() => "")
        );
        ig = ig.add(gitignoreContent);
      } catch {
      }
      ig.add([".git", "node_modules", ".nexus/index", ".nexus/checkpoints"]);
      const entries = [];
      async function walk(dir, prefix, depth) {
        if (entries.length >= maxActual) return;
        if (depth > (recursive ? 10 : 1)) return;
        const items = await readdir4(dir).catch(() => []);
        for (const item of items.sort()) {
          if (entries.length >= maxActual) break;
          const fullPath = path4.join(dir, item);
          const relPath = path4.relative(ctx.cwd, fullPath);
          if (ig.ignores(relPath)) continue;
          if (include) {
            const { minimatch } = await import('minimatch');
          }
          const itemStat = await stat7(fullPath).catch(() => null);
          if (!itemStat) continue;
          if (itemStat.isDirectory()) {
            entries.push(`${prefix}${item}/`);
            if (recursive || depth === 0) {
              await walk(fullPath, prefix + "  ", depth + 1);
            }
          } else {
            entries.push(`${prefix}${item}`);
          }
        }
      }
      await walk(targetDir, "", 0);
      if (entries.length === 0) {
        return { success: true, output: `Empty directory: ${listPath ?? "."}` };
      }
      const header = `${listPath ?? "."} (${entries.length} entries${entries.length >= maxActual ? ", truncated" : ""}):`;
      return {
        success: true,
        output: `${header}
${entries.join("\n")}`
      };
    } catch (err) {
      return { success: false, output: `Failed to list ${listPath}: ${err.message}` };
    }
  }
};
var schema6 = z.object({
  path: z.string().describe("File or directory to extract code definitions from"),
  task_progress: z.string().optional()
});
var listDefinitionsTool = {
  name: "list_code_definitions",
  description: `Extract top-level code definitions (classes, functions, methods, interfaces, types) from a file or directory.
Returns a compact view of the code structure without full implementation details.
Supports: TypeScript, JavaScript, Python, Rust, Go, Java, C, C++.
Useful for understanding codebase structure before diving into details.`,
  parameters: schema6,
  readOnly: true,
  async execute({ path: targetPath }, ctx) {
    const absPath = path4.resolve(ctx.cwd, targetPath);
    try {
      const stat7 = await fs10.stat(absPath);
      if (stat7.isDirectory()) {
        return extractFromDirectory(absPath, ctx.cwd);
      }
      return extractFromFile(absPath, ctx.cwd);
    } catch {
      return { success: false, output: `Path not found: ${targetPath}` };
    }
  }
};
async function extractFromFile(absPath, cwd) {
  const relPath = path4.relative(cwd, absPath);
  const ext = path4.extname(absPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return { success: true, output: `${relPath}: unsupported file type (${ext})` };
  }
  let content;
  try {
    content = await fs10.readFile(absPath, "utf8");
  } catch {
    return { success: false, output: `Cannot read ${relPath}` };
  }
  const definitions = extractDefinitions(content, ext);
  if (definitions.length === 0) {
    return { success: true, output: `${relPath}: no top-level definitions found` };
  }
  const output = `${relPath}:
${definitions.map((d) => `  ${d}`).join("\n")}`;
  return { success: true, output };
}
async function extractFromDirectory(absDir, cwd) {
  const { readdir: readdir4 } = await import('fs/promises');
  const results = [];
  const ignoreMod = await import('ignore');
  const ignoreFactory = ignoreMod.default ?? ignoreMod;
  let ig = ignoreFactory();
  try {
    const gi = await fs10.readFile(path4.join(cwd, ".gitignore"), "utf8").catch(() => "");
    ig = ignoreFactory().add(gi);
  } catch {
  }
  ig.add([".git", "node_modules", "dist", "build"]);
  async function processDir(dir, depth) {
    if (depth > 3) return;
    const items = await readdir4(dir).catch(() => []);
    for (const item of items.sort()) {
      const fullPath = path4.join(dir, item);
      const relPath = path4.relative(cwd, fullPath);
      if (ig.ignores(relPath)) continue;
      const st = await fs10.stat(fullPath).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        await processDir(fullPath, depth + 1);
      } else {
        const ext = path4.extname(item).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          const r = await extractFromFile(fullPath, cwd);
          if (r.success && r.output && !r.output.includes("no top-level")) {
            results.push(r.output);
          }
        }
      }
    }
  }
  await processDir(absDir, 0);
  if (results.length === 0) {
    return { success: true, output: "No code definitions found" };
  }
  return { success: true, output: results.join("\n\n") };
}
var SUPPORTED_EXTENSIONS = /* @__PURE__ */ new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp"]);
function extractDefinitions(content, ext) {
  const defs = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const def = extractDefinitionFromLine(line, ext, i + 1);
    if (def) defs.push(def);
  }
  return defs;
}
function extractDefinitionFromLine(line, ext, lineNum) {
  const stripped = line.trim();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    let m = stripped.match(/^(export\s+)?(abstract\s+)?class\s+(\w+)/);
    if (m) return `class ${m[3]} (L${lineNum})`;
    m = stripped.match(/^(export\s+)?(async\s+)?function\s+(\w+)/);
    if (m) return `function ${m[3]} (L${lineNum})`;
    m = stripped.match(/^(export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/);
    if (m) return `const ${m[2]} (L${lineNum})`;
    m = stripped.match(/^(export\s+)?interface\s+(\w+)/);
    if (m) return `interface ${m[2]} (L${lineNum})`;
    m = stripped.match(/^(export\s+)?type\s+(\w+)\s*=/);
    if (m) return `type ${m[2]} (L${lineNum})`;
    m = stripped.match(/^(export\s+)?(?:const\s+)?enum\s+(\w+)/);
    if (m) return `enum ${m[2]} (L${lineNum})`;
  }
  if (ext === ".py") {
    let m = stripped.match(/^class\s+(\w+)/);
    if (m) return `class ${m[1]} (L${lineNum})`;
    m = stripped.match(/^(async\s+)?def\s+(\w+)/);
    if (m) return `def ${m[2]} (L${lineNum})`;
  }
  if (ext === ".rs") {
    let m = stripped.match(/^pub\s+(?:async\s+)?fn\s+(\w+)/);
    if (m) return `fn ${m[1]} (L${lineNum})`;
    m = stripped.match(/^pub\s+struct\s+(\w+)/);
    if (m) return `struct ${m[1]} (L${lineNum})`;
    m = stripped.match(/^pub\s+trait\s+(\w+)/);
    if (m) return `trait ${m[1]} (L${lineNum})`;
    m = stripped.match(/^pub\s+enum\s+(\w+)/);
    if (m) return `enum ${m[1]} (L${lineNum})`;
  }
  if (ext === ".go") {
    let m = stripped.match(/^func\s+(?:\([\w\s*]+\)\s+)?(\w+)/);
    if (m) return `func ${m[1]} (L${lineNum})`;
    m = stripped.match(/^type\s+(\w+)\s+struct/);
    if (m) return `struct ${m[1]} (L${lineNum})`;
    m = stripped.match(/^type\s+(\w+)\s+interface/);
    if (m) return `interface ${m[1]} (L${lineNum})`;
  }
  return null;
}
var schema7 = z.object({
  query: z.string().describe("Semantic search query (natural language description of what you're looking for)"),
  kind: z.enum(["class", "function", "method", "interface", "type", "enum", "const", "any"]).optional().describe("Filter by symbol type"),
  limit: z.number().int().positive().max(50).optional().describe("Max results (default: 10)"),
  task_progress: z.string().optional()
});
var codebaseSearchTool = {
  name: "codebase_search",
  description: `Search the indexed codebase by semantic meaning or keyword.
Finds relevant classes, functions, methods, types, and code sections.
Searches by symbol name, docstrings, and content.
If vector search is enabled, uses semantic similarity.
Requires the codebase to be indexed (runs automatically on startup).`,
  parameters: schema7,
  readOnly: true,
  async execute({ query, kind, limit }, ctx) {
    if (!ctx.indexer) {
      return {
        success: false,
        output: "Codebase indexing is not enabled or not ready. Enable it in .nexus/nexus.yaml (indexing.enabled: true)."
      };
    }
    const status = ctx.indexer.status();
    if (status.state === "idle") {
      return { success: false, output: "Codebase index is not yet built. Wait for indexing to complete." };
    }
    if (status.state === "error") {
      return { success: false, output: `Index error: ${status.error}` };
    }
    try {
      const results = await ctx.indexer.search(query, {
        limit: limit ?? 10,
        kind: kind === "any" ? void 0 : kind,
        semantic: true
      });
      if (results.length === 0) {
        return { success: true, output: `No results found for: "${query}"` };
      }
      const formatted = results.map((r, i) => {
        const loc = r.startLine ? `:${r.startLine}` : "";
        const parent = r.parent ? ` (in ${r.parent})` : "";
        const kindStr = r.kind ? `[${r.kind}]` : "";
        return `${i + 1}. ${r.path}${loc} ${kindStr}${parent}
   ${r.content.slice(0, 200).replace(/\n/g, " ")}`;
      }).join("\n\n");
      return {
        success: true,
        output: `Found ${results.length} results for "${query}":

${formatted}`
      };
    } catch (err) {
      return { success: false, output: `Search failed: ${err.message}` };
    }
  }
};
var MAX_CONTENT_BYTES = 100 * 1024;
var FETCH_TIMEOUT = 3e4;
var schema8 = z.object({
  url: z.string().url().describe("URL to fetch"),
  max_length: z.number().int().positive().max(2e5).optional().describe("Max content length in characters (default: 100000)"),
  task_progress: z.string().optional()
});
var webFetchTool = {
  name: "web_fetch",
  description: `Fetch and read content from a URL.
HTML pages are converted to clean markdown.
JSON/text/code is returned as-is.
Maximum 100KB content.
Useful for: reading documentation, fetching API specs, checking URLs.`,
  parameters: schema8,
  readOnly: true,
  async execute({ url, max_length }, _ctx) {
    const maxLen = max_length ?? MAX_CONTENT_BYTES;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "NexusCode/1.0 (AI coding assistant)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8"
        }
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        return {
          success: false,
          output: `HTTP ${response.status} ${response.statusText}: ${url}`
        };
      }
      const contentType = response.headers.get("content-type") ?? "";
      let text = await response.text();
      if (text.length > maxLen) {
        text = text.slice(0, maxLen) + `

[... content truncated at ${maxLen} chars ...]`;
      }
      if (contentType.includes("text/html")) {
        text = htmlToMarkdown(text);
        if (text.length > maxLen) {
          text = text.slice(0, maxLen) + `

[... truncated ...]`;
        }
      }
      return {
        success: true,
        output: `URL: ${url}
Content-Type: ${contentType}

${text}`
      };
    } catch (err) {
      const msg = err.message;
      if (msg.includes("aborted") || msg.includes("timeout")) {
        return { success: false, output: `Request timed out for: ${url}` };
      }
      return { success: false, output: `Failed to fetch ${url}: ${msg}` };
    }
  }
};
function htmlToMarkdown(html) {
  try {
    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-"
    });
    return td.turndown(html);
  } catch {
    return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}
var webSearchSchema = z.object({
  query: z.string().describe("Search query"),
  max_results: z.number().int().positive().max(10).optional().describe("Max results (default: 5)"),
  task_progress: z.string().optional()
});
var webSearchTool = {
  name: "web_search",
  description: `Search the web using Brave Search or Serper API.
Returns titles, URLs, and snippets for the top results.
Requires BRAVE_API_KEY or SERPER_API_KEY environment variable.
Use web_fetch to read full content of specific results.`,
  parameters: webSearchSchema,
  readOnly: true,
  async execute({ query, max_results }, _ctx) {
    const braveKey = process.env["BRAVE_API_KEY"];
    const serperKey = process.env["SERPER_API_KEY"];
    if (!braveKey && !serperKey) {
      return {
        success: false,
        output: "Web search requires BRAVE_API_KEY or SERPER_API_KEY environment variable."
      };
    }
    const limit = max_results ?? 5;
    if (braveKey) {
      return searchWithBrave(query, limit, braveKey);
    }
    return searchWithSerper(query, limit, serperKey);
  }
};
async function searchWithBrave(query, limit, apiKey) {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": apiKey
      }
    });
    if (!response.ok) {
      return { success: false, output: `Brave Search error: ${response.status}` };
    }
    const data = await response.json();
    const results = data.web?.results ?? [];
    if (results.length === 0) {
      return { success: true, output: `No results found for: "${query}"` };
    }
    const formatted = results.slice(0, limit).map((r, i) => `${i + 1}. **${r.title}**
   ${r.url}
   ${r.description ?? ""}`).join("\n\n");
    return { success: true, output: `Search results for "${query}":

${formatted}` };
  } catch (err) {
    return { success: false, output: `Brave search error: ${err.message}` };
  }
}
async function searchWithSerper(query, limit, apiKey) {
  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey
      },
      body: JSON.stringify({ q: query, num: limit })
    });
    if (!response.ok) {
      return { success: false, output: `Serper error: ${response.status}` };
    }
    const data = await response.json();
    const results = data.organic ?? [];
    if (results.length === 0) {
      return { success: true, output: `No results found for: "${query}"` };
    }
    const formatted = results.slice(0, limit).map((r, i) => `${i + 1}. **${r.title}**
   ${r.link}
   ${r.snippet ?? ""}`).join("\n\n");
    return { success: true, output: `Search results for "${query}":

${formatted}` };
  } catch (err) {
    return { success: false, output: `Serper search error: ${err.message}` };
  }
}
var schema9 = z.object({
  skill: z.string().describe("Name of the skill to activate"),
  task_progress: z.string().optional()
});
var useSkillTool = {
  name: "use_skill",
  description: `Read and activate a skill to gain specialized knowledge or capabilities.
Skills are markdown files with instructions, patterns, and domain knowledge.
Use when the task requires specialized knowledge documented in a skill.`,
  parameters: schema9,
  readOnly: true,
  async execute({ skill }, ctx) {
    const skills = ctx.config.skills;
    [...skills];
    const { readFile: readFile12 } = await import('fs/promises');
    const { resolve: resolve9, basename: basename3, join: join12 } = await import('path');
    const { glob: glob3 } = await import('glob');
    const allSkillFiles = await glob3(skills.length > 0 ? skills : [".nexus/skills/**/*.md", "~/.nexus/skills/**/*.md"], {
      cwd: ctx.cwd,
      absolute: true
    });
    const standardPaths = [
      join12(ctx.cwd, ".nexus", "skills", skill, "SKILL.md"),
      join12(ctx.cwd, ".nexus", "skills", `${skill}.md`)
    ];
    let skillContent = null;
    let skillPath = null;
    for (const p of [...standardPaths, ...allSkillFiles]) {
      const name = basename3(p, ".md").toLowerCase();
      const parentDir = basename3(resolve9(p, "..")).toLowerCase();
      if (name === skill.toLowerCase() || parentDir === skill.toLowerCase()) {
        try {
          skillContent = await readFile12(p, "utf8");
          skillPath = p;
          break;
        } catch {
        }
      }
    }
    if (!skillContent) {
      return {
        success: false,
        output: `Skill "${skill}" not found. Available skill locations: .nexus/skills/, ~/.nexus/skills/`
      };
    }
    return {
      success: true,
      output: `<skill name="${skill}">
${skillContent}
</skill>`
    };
  }
};
var browserSchema = z.object({
  action: z.enum([
    "launch",
    "screenshot",
    "click",
    "type",
    "scroll",
    "navigate",
    "close",
    "get_content"
  ]).describe("Browser action to perform"),
  url: z.string().optional().describe("URL to navigate to (for 'launch' and 'navigate')"),
  selector: z.string().optional().describe("CSS selector or element description (for 'click', 'type', 'scroll')"),
  text: z.string().optional().describe("Text to type (for 'type')"),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
  scroll_amount: z.number().optional(),
  task_progress: z.string().optional()
});
var browserActionTool = {
  name: "browser_action",
  description: `Control a headless browser for web automation and testing.
Actions: launch (open URL), navigate, click, type, scroll, screenshot, get_content, close.
Screenshots are returned as base64 images.
Requires puppeteer to be installed: npm install puppeteer`,
  parameters: browserSchema,
  requiresApproval: true,
  async execute({ action, url, selector, text, scroll_direction, scroll_amount }, ctx) {
    let puppeteer = null;
    try {
      puppeteer = await import('puppeteer');
    } catch {
      return {
        success: false,
        output: "Browser actions require puppeteer. Install with: npm install puppeteer"
      };
    }
    if (action === "launch") {
      if (!url) return { success: false, output: "URL required for launch action" };
      let browser = null;
      try {
        browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "networkidle0", timeout: 3e4 });
        const title = await page.title();
        const screenshot = await page.screenshot({ encoding: "base64", type: "png" });
        const screenshotKB = Math.round(Buffer.from(screenshot, "base64").length / 1024);
        if (screenshotKB > 1024) {
          return {
            success: true,
            output: `Launched browser at: ${url}
Page title: ${title}
Screenshot too large (${screenshotKB}KB), use get_content instead.`
          };
        }
        return {
          success: true,
          output: `Launched browser at: ${url}
Page title: ${title}`,
          attachments: [{ type: "image", content: screenshot, mimeType: "image/png" }]
        };
      } finally {
        await browser?.close();
      }
    }
    return { success: false, output: `Action '${action}' requires an active browser session.` };
  }
};
var schema10 = z.object({
  result: z.string().describe("Summary of what was accomplished"),
  command: z.string().optional().describe("Optional command to run to demonstrate the result (e.g., 'npm run dev', 'open index.html')"),
  task_progress: z.string().optional()
});
var attemptCompletionTool = {
  name: "attempt_completion",
  description: `Signal that the task is complete and present the result to the user.
Call this when you have finished the task and want to present the outcome.
Include a clear summary of what was accomplished.
Optionally include a command that demonstrates the result.
This ends the current agent loop.`,
  parameters: schema10,
  async execute({ result, command }, ctx) {
    let output = result;
    if (command) {
      output += `

To see the result, run:
\`\`\`
${command}
\`\`\``;
    }
    return { success: true, output };
  }
};
var askSchema = z.object({
  question: z.string().describe("The question to ask the user"),
  options: z.array(z.string()).optional().describe("Optional list of suggested answers"),
  task_progress: z.string().optional()
});
var askFollowupTool = {
  name: "ask_followup_question",
  description: `Ask the user a clarifying question when you need more information to proceed.
Use this sparingly \u2014 only when you genuinely cannot proceed without the information.
Don't ask obvious questions. Don't ask multiple questions in one call.`,
  parameters: askSchema,
  async execute({ question, options }, ctx) {
    const optionsStr = options && options.length > 0 ? `

Options:
${options.map((o) => `- ${o}`).join("\n")}` : "";
    const formatted = `${question}${optionsStr}`;
    const result = await ctx.host.showApprovalDialog({
      type: "read",
      tool: "ask_followup_question",
      description: formatted
    });
    return {
      success: true,
      output: result.approved ? "User acknowledged the question." : "User declined to answer."
    };
  }
};
var todoSchema = z.object({
  todo: z.string().describe("Complete todo list in markdown checklist format:\n- [x] Completed item\n- [ ] Pending item")
});
var updateTodoTool = {
  name: "update_todo_list",
  description: `Update the current task's todo/checklist.
Use markdown format: "- [ ] item" for pending, "- [x] item" for done.
Update this frequently to show your progress.
Keep it concise \u2014 focus on meaningful milestones, not micro-steps.`,
  parameters: todoSchema,
  async execute({ todo }, ctx) {
    ctx.session.updateTodo(todo);
    return { success: true, output: "Todo list updated." };
  }
};
var createRuleSchema = z.object({
  content: z.string().describe("Rule content in markdown format"),
  filename: z.string().optional().describe("Filename (default: rule-{timestamp}.md)"),
  global: z.boolean().optional().describe("Save to global rules (~/.nexus/rules/) instead of project")
});
var createRuleTool = {
  name: "create_rule",
  description: `Create a new rule in .nexus/rules/ to guide future interactions.
Rules are automatically loaded in future sessions.
Use this to codify project conventions, preferences, or important context.`,
  parameters: createRuleSchema,
  async execute({ content, filename, global: isGlobal }, ctx) {
    const { writeFile: writeFile6, mkdir: mkdir6 } = await import('fs/promises');
    const { join: join12 } = await import('path');
    const { homedir: homedir7 } = await import('os');
    const dir = isGlobal ? join12(homedir7(), ".nexus", "rules") : join12(ctx.cwd, ".nexus", "rules");
    await mkdir6(dir, { recursive: true });
    const name = filename ?? `rule-${Date.now()}.md`;
    const filePath = join12(dir, name);
    await writeFile6(filePath, content, "utf8");
    return { success: true, output: `Created rule: ${filePath}` };
  }
};

// src/tools/built-in/index.ts
function getAllBuiltinTools() {
  return [
    // Always available
    attemptCompletionTool,
    askFollowupTool,
    updateTodoTool,
    // Read group
    readFileTool,
    listFilesTool,
    listDefinitionsTool,
    // Write group
    writeFileTool,
    replaceInFileTool,
    applyPatchTool,
    createRuleTool,
    // Execute group
    executeCommandTool,
    // Search group
    searchFilesTool,
    codebaseSearchTool,
    webFetchTool,
    webSearchTool,
    // Browser group
    browserActionTool,
    // Skills group
    useSkillTool
  ];
}

// src/tools/registry.ts
var ToolRegistry = class {
  tools = /* @__PURE__ */ new Map();
  constructor() {
    for (const tool of getAllBuiltinTools()) {
      this.tools.set(tool.name, tool);
    }
  }
  register(tool) {
    this.tools.set(tool.name, tool);
  }
  getAll() {
    return Array.from(this.tools.values());
  }
  get(name) {
    return this.tools.get(name);
  }
  getByNames(names) {
    return names.flatMap((n) => {
      const t = this.tools.get(n);
      return t ? [t] : [];
    });
  }
  /**
   * Get tools for a given mode.
   * Built-in tools for the mode are always included.
   * Additional MCP/custom tools are returned separately for optional classification.
   */
  getForMode(mode) {
    const builtinNames = new Set(getBuiltinToolsForMode(mode));
    const builtin = [];
    const dynamic = [];
    for (const tool of this.tools.values()) {
      if (builtinNames.has(tool.name)) {
        builtin.push(tool);
      } else {
        dynamic.push(tool);
      }
    }
    return { builtin, dynamic };
  }
  /**
   * Load custom tools from JS/TS files.
   * Custom tools export a default ToolDef or array of ToolDef.
   */
  async loadFromDirectory(dir) {
    try {
      const { readdir: readdir4 } = await import('fs/promises');
      const { join: join12 } = await import('path');
      const files = await readdir4(dir).catch(() => []);
      for (const file of files) {
        if (!file.endsWith(".js") && !file.endsWith(".ts")) continue;
        try {
          const mod = await import(join12(dir, file));
          const exported = mod.default ?? mod;
          if (Array.isArray(exported)) {
            for (const tool of exported) {
              if (isToolDef(tool)) this.register(tool);
            }
          } else if (isToolDef(exported)) {
            this.register(exported);
          }
        } catch (err) {
          console.warn(`[nexus] Failed to load custom tool ${file}:`, err);
        }
      }
    } catch {
    }
  }
};
function isToolDef(obj) {
  return typeof obj === "object" && obj !== null && typeof obj.name === "string" && typeof obj.description === "string" && typeof obj.execute === "function";
}

// src/agent/parallel.ts
var ParallelAgentManager = class {
  running = /* @__PURE__ */ new Map();
  async spawn(description, mode = "agent", config, cwd, signal, maxParallel) {
    while (this.running.size >= maxParallel) {
      await Promise.race([...this.running.values()]);
      for (const [id, promise] of this.running) {
        await Promise.race([promise, Promise.resolve(null)]).catch(() => null);
      }
    }
    const task = this.runSubAgent(description, mode, config, cwd, signal);
    const sessionId = `subagent_${Date.now()}`;
    this.running.set(sessionId, task);
    try {
      const result = await task;
      return result;
    } finally {
      this.running.delete(sessionId);
    }
  }
  async runSubAgent(description, mode, config, cwd, signal) {
    const session = Session.create(cwd);
    session.addMessage({ role: "user", content: description });
    const client = createLLMClient(config.model);
    const maxModeClient = config.maxMode.enabled ? createLLMClient(config.maxMode) : void 0;
    const toolRegistry = new ToolRegistry();
    toolRegistry.getAll();
    const { builtin: tools } = toolRegistry.getForMode(mode);
    const rulesContent = await loadRules(cwd, config.rules.files).catch(() => "");
    const skills = await loadSkills(config.skills, cwd).catch(() => []);
    const compaction = createCompaction();
    let output = "";
    const mockHost = {
      cwd,
      async readFile(p) {
        return (await import('fs/promises')).readFile(p, "utf8");
      },
      async writeFile(p, c) {
        return (await import('fs/promises')).writeFile(p, c, "utf8");
      },
      async deleteFile(p) {
        return (await import('fs/promises')).unlink(p);
      },
      async exists(p) {
        return (await import('fs/promises')).access(p).then(() => true).catch(() => false);
      },
      async showDiff() {
        return true;
      },
      async runCommand(cmd, wd) {
        const { execa: execa3 } = await import('execa');
        const r = await execa3(cmd, { shell: true, cwd: wd, reject: false });
        return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
      },
      async showApprovalDialog() {
        return { approved: true };
      },
      emit(event) {
        if (event.type === "text_delta" && event.delta) {
          output += event.delta;
        }
      }
    };
    try {
      await runAgentLoop({
        session,
        client,
        maxModeClient,
        host: mockHost,
        config,
        mode,
        tools,
        skills,
        rulesContent,
        compaction,
        signal
      });
      return { sessionId: session.id, success: true, output };
    } catch (err) {
      return {
        sessionId: session.id,
        success: false,
        output: output || "",
        error: err.message
      };
    }
  }
};
var spawnSchema = z.object({
  description: z.string().describe("What should the sub-agent do? Provide a clear, self-contained task description."),
  mode: z.enum(["agent", "plan", "debug", "ask"]).optional().describe("Mode for the sub-agent (default: agent)"),
  task_progress: z.string().optional()
});
function createSpawnAgentTool(manager, config) {
  return {
    name: "spawn_agent",
    description: `Launch a parallel sub-agent to work on a specific task concurrently.
Use for independent subtasks that don't depend on each other.
The sub-agent has full capabilities based on the specified mode.
Returns the sub-agent's final output when done.
Max ${config.parallelAgents.maxParallel} agents running simultaneously.`,
    parameters: spawnSchema,
    modes: ["agent"],
    async execute(args, ctx) {
      const { description, mode } = args;
      const result = await manager.spawn(
        description,
        mode ?? "agent",
        ctx.config,
        ctx.cwd,
        ctx.signal,
        ctx.config.parallelAgents.maxParallel
      );
      if (result.error) {
        return { success: false, output: `Sub-agent failed: ${result.error}
Partial output: ${result.output}` };
      }
      return { success: true, output: `Sub-agent completed:

${result.output}` };
    }
  };
}
var FTSIndex = class {
  db;
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.setupSchema();
  }
  setupSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS symbols USING fts5(
        path UNINDEXED,
        name,
        kind UNINDEXED,
        parent UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED,
        docstring,
        content,
        tokenize = 'unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        path UNINDEXED,
        offset UNINDEXED,
        content,
        tokenize = 'unicode61'
      );
    `);
  }
  isFileIndexed(filePath, mtime, hash) {
    const row = this.db.prepare(
      "SELECT hash, mtime FROM files WHERE path = ?"
    ).get(filePath);
    return row !== void 0 && row.hash === hash && row.mtime === mtime;
  }
  upsertFile(filePath, mtime, hash) {
    this.db.prepare("DELETE FROM symbols WHERE path = ?").run(filePath);
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(filePath);
    this.db.prepare(
      "INSERT OR REPLACE INTO files (path, mtime, hash, indexed_at) VALUES (?, ?, ?, ?)"
    ).run(filePath, mtime, hash, Date.now());
  }
  insertSymbol(entry) {
    this.db.prepare(`
      INSERT INTO symbols (path, name, kind, parent, start_line, end_line, docstring, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.path,
      entry.name,
      entry.kind,
      entry.parent ?? "",
      entry.startLine,
      entry.endLine,
      entry.docstring ?? "",
      entry.content
    );
  }
  insertChunk(entry) {
    this.db.prepare(
      "INSERT INTO chunks (path, offset, content) VALUES (?, ?, ?)"
    ).run(entry.path, entry.offset, entry.content);
  }
  deleteFile(filePath) {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
    this.db.prepare("DELETE FROM symbols WHERE path = ?").run(filePath);
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(filePath);
  }
  searchSymbols(query, limit, kind) {
    let sql;
    let params;
    if (kind) {
      sql = `
        SELECT path, name, kind, parent, start_line, end_line, docstring, content,
          rank as score
        FROM symbols
        WHERE symbols MATCH ? AND kind = ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [escapeQuery(query), kind, limit];
    } else {
      sql = `
        SELECT path, name, kind, parent, start_line, end_line, docstring, content,
          rank as score
        FROM symbols
        WHERE symbols MATCH ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [escapeQuery(query), limit];
    }
    try {
      const rows = this.db.prepare(sql).all(...params);
      return rows.map((r) => ({
        path: r.path,
        name: r.name,
        kind: r.kind,
        parent: r.parent || void 0,
        startLine: r.start_line,
        endLine: r.end_line,
        content: `${r.docstring ? r.docstring + "\n" : ""}${r.content}`,
        score: r.score
      }));
    } catch {
      return [];
    }
  }
  searchChunks(query, limit) {
    try {
      const rows = this.db.prepare(`
        SELECT path, offset, content, rank as score
        FROM chunks
        WHERE chunks MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(escapeQuery(query), limit);
      return rows.map((r) => ({
        path: r.path,
        startLine: r.offset,
        content: r.content,
        score: r.score
      }));
    } catch {
      return [];
    }
  }
  getStats() {
    const files = this.db.prepare("SELECT COUNT(*) as n FROM files").get().n;
    const symbols = this.db.prepare("SELECT COUNT(*) as n FROM symbols").get().n;
    const chunks = this.db.prepare("SELECT COUNT(*) as n FROM chunks").get().n;
    return { files, symbols, chunks };
  }
  close() {
    this.db.close();
  }
  getFilesWithHashes() {
    const rows = this.db.prepare("SELECT path, mtime, hash FROM files").all();
    const map = /* @__PURE__ */ new Map();
    for (const row of rows) {
      map.set(row.path, { mtime: row.mtime, hash: row.hash });
    }
    return map;
  }
};
function escapeQuery(query) {
  return query.replace(/["]/g, '""').replace(/[*]/g, "").split(/\s+/).filter(Boolean).map((word) => `"${word}"`).join(" ");
}
var VectorIndex = class {
  client;
  collectionName;
  embeddings;
  initialized = false;
  dimensions;
  constructor(url, projectHash, embeddings) {
    this.client = new QdrantClient({ url });
    this.collectionName = `nexus_${projectHash}`;
    this.embeddings = embeddings;
    this.dimensions = embeddings.dimensions;
  }
  async init() {
    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some((c) => c.name === this.collectionName);
      if (!exists) {
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: this.dimensions,
            distance: "Cosine"
          }
        });
      }
      this.initialized = true;
    } catch (err) {
      throw new Error(`Failed to initialize Qdrant collection: ${err.message}`);
    }
  }
  async upsertSymbols(symbols) {
    if (!this.initialized || symbols.length === 0) return;
    try {
      const texts = symbols.map(
        (s) => [s.name, s.kind ?? "", s.parent ?? "", s.content.slice(0, 500)].filter(Boolean).join(" ")
      );
      const vectors = await this.embeddings.embed(texts);
      const points = symbols.map((s, i) => ({
        id: stringToUint(s.id),
        vector: vectors[i],
        payload: {
          path: s.path,
          name: s.name,
          kind: s.kind ?? "chunk",
          parent: s.parent ?? null,
          startLine: s.startLine ?? 0,
          content: s.content.slice(0, 1e3)
        }
      }));
      await this.client.upsert(this.collectionName, { points });
    } catch (err) {
      console.warn("[nexus] Vector upsert failed:", err);
    }
  }
  async deleteByPath(filePath) {
    if (!this.initialized) return;
    try {
      await this.client.delete(this.collectionName, {
        filter: { must: [{ key: "path", match: { value: filePath } }] }
      });
    } catch {
    }
  }
  async search(query, limit, kind) {
    if (!this.initialized) return [];
    try {
      const [vector] = await this.embeddings.embed([query]);
      if (!vector) return [];
      const filter = kind ? { must: [{ key: "kind", match: { value: kind } }] } : void 0;
      const results = await this.client.search(this.collectionName, {
        vector,
        limit,
        filter,
        with_payload: true
      });
      return results.map((r) => ({
        path: r.payload?.["path"] ?? "",
        name: r.payload?.["name"],
        kind: r.payload?.["kind"],
        parent: r.payload?.["parent"],
        startLine: r.payload?.["startLine"],
        content: r.payload?.["content"] ?? "",
        score: r.score
      }));
    } catch (err) {
      console.warn("[nexus] Vector search failed:", err);
      return [];
    }
  }
  async healthCheck() {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }
};
function stringToUint(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}
var SUPPORTED_EXTENSIONS2 = /* @__PURE__ */ new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".json",
  ".toml"
]);
var DEFAULT_EXCLUDE = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".nuxt/**",
  "coverage/**",
  "*.lock",
  ".nexus/index/**",
  ".nexus/checkpoints/**",
  "**/*.min.js",
  "**/*.bundle.js",
  "**/*.map"
];
async function* walkDir(root, excludePatterns = []) {
  const ig = ignore();
  ig.add(DEFAULT_EXCLUDE);
  ig.add(excludePatterns);
  try {
    const gitignoreContent = await fs10.readFile(path4.join(root, ".gitignore"), "utf8");
    ig.add(gitignoreContent);
  } catch {
  }
  try {
    const nexusignoreContent = await fs10.readFile(path4.join(root, ".nexusignore"), "utf8");
    ig.add(nexusignoreContent);
  } catch {
  }
  async function* walkInternal(dir) {
    let entries;
    try {
      entries = await fs10.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const absPath = path4.join(dir, entry);
      const relPath = path4.relative(root, absPath);
      if (ig.ignores(relPath)) continue;
      let stat7;
      try {
        stat7 = await fs10.stat(absPath);
      } catch {
        continue;
      }
      if (stat7.isSymbolicLink()) continue;
      if (stat7.isDirectory()) {
        yield* walkInternal(absPath);
      } else if (stat7.isFile()) {
        const ext = path4.extname(entry).toLowerCase();
        if (!SUPPORTED_EXTENSIONS2.has(ext)) continue;
        if (stat7.size > 1024 * 1024) continue;
        const hash = await hashFile(absPath, stat7.size);
        yield {
          path: relPath,
          absPath,
          ext,
          mtime: stat7.mtimeMs,
          hash,
          size: stat7.size
        };
      }
    }
  }
  yield* walkInternal(root);
}
async function hashFile(filePath, size) {
  if (size < 8192) {
    try {
      const content = await fs10.readFile(filePath);
      return crypto.createHash("md5").update(content).digest("hex");
    } catch {
      return `${size}_0`;
    }
  }
  try {
    const fd = await fs10.open(filePath, "r");
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fd.read(buf, 0, 4096, 0);
    await fd.close();
    return crypto.createHash("md5").update(buf.subarray(0, bytesRead)).digest("hex");
  } catch {
    return `${size}_error`;
  }
}

// src/indexer/ast-extractor.ts
function extractSymbols(content, filePath, ext) {
  const lower = ext.toLowerCase();
  switch (lower) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return extractTypeScriptSymbols(content, filePath);
    case ".py":
      return extractPythonSymbols(content, filePath);
    case ".rs":
      return extractRustSymbols(content, filePath);
    case ".go":
      return extractGoSymbols(content, filePath);
    case ".java":
      return extractJavaSymbols(content, filePath);
    default:
      return extractChunks(content, filePath);
  }
}
function extractTypeScriptSymbols(content, filePath) {
  const symbols = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const lineNum = i + 1;
    const docstring = extractJsDoc(lines, i);
    let m = stripped.match(/^(export\s+)?(default\s+)?(abstract\s+)?class\s+(\w+)/);
    if (m) {
      const name = m[4];
      const endLine = findClosingBrace(lines, i);
      symbols.push({
        path: filePath,
        name,
        kind: "class",
        startLine: lineNum,
        endLine,
        docstring,
        content: extractBlock(lines, i, Math.min(endLine - lineNum, 10))
      });
      continue;
    }
    m = stripped.match(/^(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)/);
    if (m) {
      const name = m[4];
      const endLine = findClosingBrace(lines, i);
      symbols.push({
        path: filePath,
        name,
        kind: "function",
        startLine: lineNum,
        endLine,
        docstring,
        content: extractBlock(lines, i, Math.min(endLine - lineNum, 5))
      });
      continue;
    }
    m = stripped.match(/^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(/);
    if (m) {
      const name = m[3];
      const endLine = findClosingBrace(lines, i);
      symbols.push({
        path: filePath,
        name,
        kind: "arrow",
        startLine: lineNum,
        endLine,
        docstring,
        content: extractBlock(lines, i, 3)
      });
      continue;
    }
    m = stripped.match(/^(export\s+)?interface\s+(\w+)/);
    if (m) {
      const name = m[2];
      const endLine = findClosingBrace(lines, i);
      symbols.push({
        path: filePath,
        name,
        kind: "interface",
        startLine: lineNum,
        endLine,
        docstring,
        content: extractBlock(lines, i, Math.min(endLine - lineNum, 15))
      });
      continue;
    }
    m = stripped.match(/^(export\s+)?type\s+(\w+)\s*(<[^>]*>)?\s*=/);
    if (m) {
      const name = m[2];
      symbols.push({
        path: filePath,
        name,
        kind: "type",
        startLine: lineNum,
        endLine: lineNum + 3,
        docstring,
        content: stripped
      });
      continue;
    }
    m = stripped.match(/^(export\s+)?(const\s+)?enum\s+(\w+)/);
    if (m) {
      const name = m[3];
      const endLine = findClosingBrace(lines, i);
      symbols.push({
        path: filePath,
        name,
        kind: "enum",
        startLine: lineNum,
        endLine,
        docstring,
        content: extractBlock(lines, i, Math.min(endLine - lineNum, 10))
      });
      continue;
    }
    m = stripped.match(/^(public|private|protected|static|async|override)?\s*(public|private|protected|static|async|override)?\s*(\w+)\s*\(/);
    if (m && i > 0 && isInsideClass(lines, i)) {
      const name = m[3];
      if (name !== "if" && name !== "for" && name !== "while" && name !== "switch") {
        const endLine = findClosingBrace(lines, i);
        symbols.push({
          path: filePath,
          name,
          kind: "method",
          parent: findContainingClass(lines, i),
          startLine: lineNum,
          endLine,
          docstring,
          content: extractBlock(lines, i, 3)
        });
      }
      continue;
    }
  }
  if (symbols.length === 0) return extractChunks(content, filePath);
  return symbols;
}
function extractPythonSymbols(content, filePath) {
  const symbols = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const lineNum = i + 1;
    let m = stripped.match(/^class\s+(\w+)/);
    if (m) {
      const name = m[1];
      const endLine = findPythonBlockEnd(lines, i);
      const docstring = extractPythonDocstring(lines, i + 1);
      symbols.push({ path: filePath, name, kind: "class", startLine: lineNum, endLine, docstring, content: line });
      continue;
    }
    m = stripped.match(/^(async\s+)?def\s+(\w+)/);
    if (m) {
      const name = m[2];
      const endLine = findPythonBlockEnd(lines, i);
      const docstring = extractPythonDocstring(lines, i + 1);
      const indent = line.length - line.trimStart().length;
      const parent = indent > 0 ? findPythonParentClass(lines, i) : void 0;
      symbols.push({ path: filePath, name, kind: parent ? "method" : "function", parent, startLine: lineNum, endLine, docstring, content: line });
    }
  }
  return symbols.length > 0 ? symbols : extractChunks(content, filePath);
}
function extractRustSymbols(content, filePath) {
  const symbols = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const lineNum = i + 1;
    let m = stripped.match(/^pub(?:\(.*?\))?\s+struct\s+(\w+)/);
    if (!m) m = stripped.match(/^struct\s+(\w+)/);
    if (m) {
      const endLine = findClosingBrace(lines, i);
      symbols.push({ path: filePath, name: m[1], kind: "class", startLine: lineNum, endLine, content: stripped });
      continue;
    }
    m = stripped.match(/^pub(?:\(.*?\))?\s+(?:async\s+)?fn\s+(\w+)/);
    if (!m) m = stripped.match(/^(?:async\s+)?fn\s+(\w+)/);
    if (m) {
      const endLine = findClosingBrace(lines, i);
      symbols.push({ path: filePath, name: m[1], kind: "function", startLine: lineNum, endLine, content: stripped });
      continue;
    }
    m = stripped.match(/^pub(?:\(.*?\))?\s+trait\s+(\w+)/);
    if (m) {
      const endLine = findClosingBrace(lines, i);
      symbols.push({ path: filePath, name: m[1], kind: "interface", startLine: lineNum, endLine, content: stripped });
      continue;
    }
  }
  return symbols.length > 0 ? symbols : extractChunks(content, filePath);
}
function extractGoSymbols(content, filePath) {
  const symbols = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const lineNum = i + 1;
    let m = stripped.match(/^func\s+(?:\((\w+\s+\*?\w+)\)\s+)?(\w+)/);
    if (m) {
      const receiver = m[1];
      const name = m[2];
      const endLine = findClosingBrace(lines, i);
      symbols.push({ path: filePath, name, kind: receiver ? "method" : "function", parent: receiver, startLine: lineNum, endLine, content: stripped });
      continue;
    }
    m = stripped.match(/^type\s+(\w+)\s+struct/);
    if (m) {
      const endLine = findClosingBrace(lines, i);
      symbols.push({ path: filePath, name: m[1], kind: "class", startLine: lineNum, endLine, content: stripped });
      continue;
    }
    m = stripped.match(/^type\s+(\w+)\s+interface/);
    if (m) {
      const endLine = findClosingBrace(lines, i);
      symbols.push({ path: filePath, name: m[1], kind: "interface", startLine: lineNum, endLine, content: stripped });
    }
  }
  return symbols.length > 0 ? symbols : extractChunks(content, filePath);
}
function extractJavaSymbols(content, filePath) {
  const symbols = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    const lineNum = i + 1;
    let m = stripped.match(/(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)/);
    if (m) {
      const endLine = findClosingBrace(lines, i);
      symbols.push({ path: filePath, name: m[1], kind: "class", startLine: lineNum, endLine, content: stripped });
      continue;
    }
    m = stripped.match(/(?:public|private|protected)?\s*interface\s+(\w+)/);
    if (m) {
      const endLine = findClosingBrace(lines, i);
      symbols.push({ path: filePath, name: m[1], kind: "interface", startLine: lineNum, endLine, content: stripped });
    }
  }
  return symbols.length > 0 ? symbols : extractChunks(content, filePath);
}
var CHUNK_SIZE = 50;
function extractChunks(content, filePath) {
  const lines = content.split("\n");
  const chunks = [];
  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    const chunkLines = lines.slice(i, i + CHUNK_SIZE);
    chunks.push({
      path: filePath,
      name: `chunk_${i + 1}`,
      kind: "chunk",
      startLine: i + 1,
      endLine: Math.min(i + CHUNK_SIZE, lines.length),
      content: chunkLines.join("\n")
    });
  }
  return chunks;
}
function findClosingBrace(lines, startLine) {
  let depth = 0;
  let found = false;
  for (let i = startLine; i < lines.length && i < startLine + 500; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        found = true;
      }
      if (ch === "}") {
        depth--;
        if (found && depth === 0) return i + 1;
      }
    }
  }
  return Math.min(startLine + 50, lines.length);
}
function findPythonBlockEnd(lines, startLine) {
  const baseIndent = lines[startLine].length - lines[startLine].trimStart().length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) return i;
  }
  return lines.length;
}
function findPythonParentClass(lines, lineIdx) {
  const currentIndent = lines[lineIdx].length - lines[lineIdx].trimStart().length;
  for (let i = lineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent < currentIndent) {
      const m = line.trim().match(/^class\s+(\w+)/);
      if (m) return m[1];
      return void 0;
    }
  }
  return void 0;
}
function extractPythonDocstring(lines, startLine) {
  const line = lines[startLine]?.trim() ?? "";
  if (line.startsWith('"""') || line.startsWith("'''")) {
    const quote = line.startsWith('"""') ? '"""' : "'''";
    const endIdx = line.indexOf(quote, 3);
    if (endIdx > -1) return line.slice(3, endIdx);
    let ds = line.slice(3);
    for (let i = startLine + 1; i < startLine + 5 && i < lines.length; i++) {
      const l = lines[i];
      const end = l.indexOf(quote);
      if (end > -1) {
        ds += " " + l.slice(0, end);
        break;
      }
      ds += " " + l.trim();
    }
    return ds.trim();
  }
  return "";
}
function extractJsDoc(lines, symbolLine) {
  let i = symbolLine - 1;
  if (i < 0) return "";
  while (i >= 0 && lines[i]?.trim() === "") i--;
  if (i < 0 || !lines[i]?.trim().endsWith("*/")) return "";
  const docLines = [];
  let j = i;
  while (j >= 0) {
    const l = lines[j].trim();
    docLines.unshift(l.replace(/^\/?\*+\/?/, "").trim());
    if (l.startsWith("/**") || l.startsWith("/*")) break;
    j--;
  }
  return docLines.filter(Boolean).join(" ");
}
function extractBlock(lines, start, maxLines) {
  return lines.slice(start, Math.min(start + maxLines, lines.length)).join("\n");
}
function isInsideClass(lines, lineIdx) {
  const indent = lines[lineIdx].length - lines[lineIdx].trimStart().length;
  if (indent === 0) return false;
  for (let i = lineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) {
      return /class\s+\w+/.test(line.trim());
    }
  }
  return false;
}
function findContainingClass(lines, lineIdx) {
  const indent = lines[lineIdx].length - lines[lineIdx].trimStart().length;
  for (let i = lineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) {
      const m = line.trim().match(/class\s+(\w+)/);
      return m?.[1];
    }
  }
  return void 0;
}
var REGISTRY_PATH = path4.join(os5.homedir(), ".nexus", "projects.json");
var INDEX_BASE_DIR = path4.join(os5.homedir(), ".nexus", "index");
var MAX_PROJECTS = 10;
var ProjectRegistry = class _ProjectRegistry {
  projects = /* @__PURE__ */ new Map();
  static async load() {
    const registry = new _ProjectRegistry();
    try {
      const content = await fs10.readFile(REGISTRY_PATH, "utf8");
      const data = JSON.parse(content);
      for (const p of data) {
        registry.projects.set(p.root, p);
      }
    } catch {
    }
    return registry;
  }
  async registerProject(root) {
    const existing = this.projects.get(root);
    if (existing) {
      existing.lastAccessed = Date.now();
      await this.save();
      return existing;
    }
    const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 16);
    const indexDir = path4.join(INDEX_BASE_DIR, hash);
    await fs10.mkdir(indexDir, { recursive: true });
    const info = {
      root,
      hash,
      lastAccessed: Date.now(),
      indexDir
    };
    this.projects.set(root, info);
    if (this.projects.size > MAX_PROJECTS) {
      await this.evictOldest();
    }
    await this.save();
    return info;
  }
  getProject(root) {
    return this.projects.get(root);
  }
  listProjects() {
    return Array.from(this.projects.values()).sort((a, b) => b.lastAccessed - a.lastAccessed);
  }
  async removeProject(root) {
    const info = this.projects.get(root);
    if (info) {
      try {
        await fs10.rm(info.indexDir, { recursive: true, force: true });
      } catch {
      }
      this.projects.delete(root);
      await this.save();
    }
  }
  async evictOldest() {
    const sorted = this.listProjects();
    const toEvict = sorted.slice(MAX_PROJECTS);
    for (const p of toEvict) {
      await this.removeProject(p.root);
    }
  }
  async save() {
    try {
      const dir = path4.dirname(REGISTRY_PATH);
      await fs10.mkdir(dir, { recursive: true });
      await fs10.writeFile(REGISTRY_PATH, JSON.stringify(this.listProjects(), null, 2), "utf8");
    } catch {
    }
  }
};
function getIndexDir(projectRoot) {
  const hash = crypto.createHash("sha1").update(projectRoot).digest("hex").slice(0, 16);
  return path4.join(INDEX_BASE_DIR, hash);
}

// src/indexer/index.ts
var SUPPORTED_CODE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp"
]);
var CodebaseIndexer = class {
  constructor(projectRoot, config, embeddingClient, vectorUrl, projectHash) {
    this.projectRoot = projectRoot;
    this.config = config;
    const indexDir = getIndexDir(projectRoot);
    mkdirSync(indexDir, { recursive: true });
    this.fts = new FTSIndex(path4.join(indexDir, "fts.db"));
    if (config.vectorDb?.enabled && embeddingClient && vectorUrl && projectHash) {
      this.vector = new VectorIndex(vectorUrl, projectHash, embeddingClient);
    }
  }
  fts;
  vector;
  _status = { state: "idle" };
  indexing = false;
  abortController;
  debounceTimers = /* @__PURE__ */ new Map();
  status() {
    return this._status;
  }
  async startIndexing() {
    if (this.indexing) return;
    this.indexing = true;
    this.abortController = new AbortController();
    if (this.vector) {
      try {
        await this.vector.init();
      } catch (err) {
        console.warn("[nexus] Vector index init failed:", err);
        this.vector = void 0;
      }
    }
    this._status = { state: "indexing", progress: 0, total: 0 };
    this.indexInBackground().catch((err) => {
      console.warn("[nexus] Indexing error:", err);
      this._status = { state: "error", error: err.message };
      this.indexing = false;
    });
  }
  async indexInBackground() {
    const existing = this.fts.getFilesWithHashes();
    const seen = /* @__PURE__ */ new Set();
    let processed = 0;
    let total = 0;
    for await (const _ of walkDir(this.projectRoot, this.config.indexing.excludePatterns)) {
      total++;
      if (this.abortController?.signal.aborted) break;
    }
    this._status = { state: "indexing", progress: 0, total };
    const batchSize = this.config.indexing.batchSize;
    let batch = [];
    for await (const file of walkDir(this.projectRoot, this.config.indexing.excludePatterns)) {
      if (this.abortController?.signal.aborted) break;
      seen.add(file.path);
      batch.push(file);
      if (batch.length >= batchSize) {
        await this.processBatch(batch);
        processed += batch.length;
        this._status = { state: "indexing", progress: processed, total };
        batch = [];
        await new Promise((r) => setImmediate(r));
      }
    }
    if (batch.length > 0) {
      await this.processBatch(batch);
      processed += batch.length;
    }
    for (const [filePath] of existing) {
      if (!seen.has(filePath)) {
        this.fts.deleteFile(filePath);
        await this.vector?.deleteByPath(filePath);
      }
    }
    const stats = this.fts.getStats();
    this._status = { state: "ready", files: stats.files, symbols: stats.symbols };
    this.indexing = false;
  }
  async processBatch(files) {
    const vectorEntries = [];
    for (const file of files) {
      if (this.fts.isFileIndexed(file.path, file.mtime, file.hash)) continue;
      let content;
      try {
        content = await fs10.readFile(file.absPath, "utf8");
      } catch {
        continue;
      }
      this.fts.upsertFile(file.path, file.mtime, file.hash);
      if (SUPPORTED_CODE_EXTENSIONS.has(file.ext) && this.config.indexing.symbolExtract) {
        const symbols = extractSymbols(content, file.path, file.ext);
        for (const sym of symbols) {
          this.fts.insertSymbol(sym);
          if (this.vector && this.config.indexing.vector) {
            const id = `${file.hash}_${sym.startLine}`;
            vectorEntries.push({
              id,
              path: file.path,
              name: sym.name,
              kind: sym.kind,
              parent: sym.parent,
              startLine: sym.startLine,
              content: sym.content
            });
          }
        }
      } else {
        const chunks = extractChunks(content, file.path);
        for (const chunk of chunks) {
          this.fts.insertChunk({ path: chunk.path, offset: chunk.startLine, content: chunk.content });
        }
      }
    }
    if (vectorEntries.length > 0) {
      await this.vector?.upsertSymbols(vectorEntries);
    }
  }
  async refreshFile(filePath) {
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath);
      await this.processBatch([
        await buildFileInfo(filePath, this.projectRoot).catch(() => null)
      ].filter(Boolean));
    }, this.config.indexing.debounceMs);
    this.debounceTimers.set(filePath, timer);
  }
  async search(query, opts) {
    const limit = opts?.limit ?? 10;
    const kind = opts?.kind;
    const results = [];
    if (this.config.indexing.fts) {
      const symbolResults = this.fts.searchSymbols(query, limit, kind);
      results.push(...symbolResults);
      if (results.length < limit) {
        const chunkResults = this.fts.searchChunks(query, limit - results.length);
        results.push(...chunkResults);
      }
    }
    if (this.vector && this.config.indexing.vector && opts?.semantic !== false) {
      const vecResults = await this.vector.search(query, limit, kind);
      const seen = new Set(results.map((r) => `${r.path}:${r.startLine}`));
      for (const r of vecResults) {
        const key = `${r.path}:${r.startLine}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(r);
        }
      }
    }
    return results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }
  stop() {
    this.abortController?.abort();
  }
};
async function buildFileInfo(absPath, root) {
  try {
    const { stat: stat7, readFile: readFile12 } = await import('fs/promises');
    const { createHash: createHash4 } = await import('crypto');
    const { extname: extname4, relative: relative6 } = await import('path');
    const s = await stat7(absPath);
    const content = await readFile12(absPath);
    const hash = createHash4("md5").update(content).digest("hex");
    return {
      path: relative6(root, absPath),
      absPath,
      ext: extname4(absPath).toLowerCase(),
      mtime: s.mtimeMs,
      hash,
      size: s.size
    };
  } catch {
    return null;
  }
}
var MENTION_REGEX = /@(file|folder|url|problems|git|terminal):([^\s]+)|@(problems|git|terminal)/g;
async function parseMentions(text, cwd, host) {
  const mentions = [];
  const regex = new RegExp(MENTION_REGEX.source, "g");
  let match;
  while ((match = regex.exec(text)) !== null) {
    const type = match[1] ?? match[3] ?? "";
    const arg = match[2] ?? "";
    const resolved = await resolveMention(type, arg, cwd, host);
    if (resolved) {
      mentions.push({ original: match[0], type, content: resolved });
    }
  }
  if (mentions.length === 0) return { text, contextBlocks: [] };
  let processedText = text;
  const contextBlocks = [];
  for (const mention of mentions) {
    `mention_${mention.type}`;
    processedText = processedText.replace(mention.original, `[${mention.type} context below]`);
    contextBlocks.push(mention.content);
  }
  return { text: processedText, contextBlocks };
}
async function resolveMention(type, arg, cwd, host) {
  switch (type) {
    case "file": {
      const absPath = path4.resolve(cwd, arg);
      try {
        const content = await fs10.readFile(absPath, "utf8");
        const lines = content.split("\n");
        const truncated = lines.length > 200 ? lines.slice(0, 200).join("\n") + "\n[...truncated]" : content;
        const relPath = path4.relative(cwd, absPath);
        return `<file path="${relPath}">
${truncated}
</file>`;
      } catch {
        return `<file path="${arg}" error="not found"/>`;
      }
    }
    case "folder": {
      const absPath = path4.resolve(cwd, arg);
      try {
        const entries = await listDirRecursive(absPath, cwd, 50);
        const relPath = path4.relative(cwd, absPath);
        return `<folder path="${relPath}">
${entries.join("\n")}
</folder>`;
      } catch {
        return `<folder path="${arg}" error="not found"/>`;
      }
    }
    case "url": {
      try {
        const response = await fetch(arg, {
          headers: { "User-Agent": "NexusCode/1.0" },
          signal: AbortSignal.timeout(15e3)
        });
        const text = await response.text();
        const truncated = text.length > 5e4 ? text.slice(0, 5e4) + "\n[...truncated]" : text;
        return `<url href="${arg}">
${truncated}
</url>`;
      } catch {
        return `<url href="${arg}" error="fetch failed"/>`;
      }
    }
    case "problems": {
      if (!host?.getProblems) return null;
      try {
        const problems = await host.getProblems();
        if (problems.length === 0) return `<problems>No diagnostics found.</problems>`;
        const formatted = problems.slice(0, 50).map(
          (p) => `[${p.severity.toUpperCase()}] ${p.file}:${p.line} \u2014 ${p.message}`
        ).join("\n");
        return `<problems>
${formatted}
</problems>`;
      } catch {
        return null;
      }
    }
    case "git": {
      try {
        const { execa: execa3 } = await import('execa');
        const { stdout } = await execa3("git", ["diff", "--stat", "HEAD"], { cwd });
        const status = await execa3("git", ["status", "--short"], { cwd });
        return `<git_state>
${status.stdout}

${stdout}
</git_state>`;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
async function listDirRecursive(dir, cwd, maxEntries) {
  const entries = [];
  async function walk(d, prefix) {
    if (entries.length >= maxEntries) return;
    const items = await fs10.readdir(d).catch(() => []);
    for (const item of items) {
      if (entries.length >= maxEntries) break;
      if (item === "node_modules" || item === ".git") continue;
      const full = path4.join(d, item);
      path4.relative(cwd, full);
      const st = await fs10.stat(full).catch(() => null);
      if (!st) continue;
      entries.push(prefix + item + (st.isDirectory() ? "/" : ""));
      if (st.isDirectory()) await walk(full, prefix + "  ");
    }
  }
  await walk(dir, "");
  return entries;
}
var McpClient = class {
  clients = /* @__PURE__ */ new Map();
  tools = /* @__PURE__ */ new Map();
  async connect(config) {
    try {
      const client = new Client({
        name: "nexuscode",
        version: "0.1.0"
      });
      let transport;
      if (config.url) {
        transport = new SSEClientTransport(new URL(config.url));
      } else if (config.command) {
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...process.env, ...config.env }
        });
      } else {
        throw new Error(`MCP server "${config.name}" requires either command or url`);
      }
      await client.connect(transport);
      const toolsResponse = await client.listTools();
      for (const tool of toolsResponse.tools) {
        this.tools.set(`${config.name}__${tool.name}`, {
          name: `${config.name}__${tool.name}`,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
          serverName: config.name
        });
      }
      this.clients.set(config.name, client);
    } catch (err) {
      console.warn(`[nexus] Failed to connect MCP server "${config.name}":`, err);
    }
  }
  async connectAll(configs) {
    await Promise.all(configs.map((c) => this.connect(c)));
  }
  getTools() {
    return Array.from(this.tools.values()).map((mcpTool) => {
      const schema11 = buildZodSchema(mcpTool.inputSchema);
      const serverName = mcpTool.serverName;
      return {
        name: mcpTool.name,
        description: `[MCP: ${serverName}] ${mcpTool.description}`,
        parameters: schema11,
        readOnly: false,
        async execute(args, _ctx) {
          const client = McpClientRegistry.instance.clients.get(serverName);
          if (!client) {
            return { success: false, output: `MCP server "${serverName}" not connected` };
          }
          try {
            const toolName = mcpTool.name.replace(`${serverName}__`, "");
            const result = await client.callTool({
              name: toolName,
              arguments: args
            });
            const output = result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
            return { success: !result.isError, output };
          } catch (err) {
            return { success: false, output: `MCP error: ${err.message}` };
          }
        }
      };
    });
  }
  getStatus() {
    const status = {};
    for (const [name, client] of this.clients) {
      status[name] = "connected";
    }
    return status;
  }
  async disconnectAll() {
    for (const [, client] of this.clients) {
      try {
        await client.close();
      } catch {
      }
    }
    this.clients.clear();
    this.tools.clear();
  }
};
var McpClientRegistryClass = class {
  instance = null;
};
var McpClientRegistry = new McpClientRegistryClass();
function setMcpClientInstance(client) {
  McpClientRegistry.instance = client;
}
function buildZodSchema(inputSchema) {
  const properties = inputSchema["properties"] ?? {};
  const required = inputSchema["required"] ?? [];
  const shape = {};
  for (const [key, prop] of Object.entries(properties)) {
    let fieldSchema = z.string();
    if (prop.type === "number" || prop.type === "integer") fieldSchema = z.number();
    if (prop.type === "boolean") fieldSchema = z.boolean();
    if (prop.type === "array") fieldSchema = z.array(z.unknown());
    if (prop.type === "object") fieldSchema = z.record(z.unknown());
    if (prop.description) fieldSchema = fieldSchema.describe(prop.description);
    if (!required.includes(key)) fieldSchema = fieldSchema.optional();
    shape[key] = fieldSchema;
  }
  if (Object.keys(shape).length === 0) {
    return z.record(z.unknown()).optional().default({});
  }
  return z.object(shape);
}
var CHECKPOINT_WARN_MS = 7e3;
var CheckpointTracker = class {
  constructor(taskId, workspaceRoot) {
    this.taskId = taskId;
    this.workspaceRoot = workspaceRoot;
    this.shadowRoot = path4.join(os5.homedir(), ".nexus", "checkpoints", taskId);
    this.git = simpleGit(this.shadowRoot);
  }
  git;
  shadowRoot;
  initialized = false;
  entries = [];
  /**
   * Initialize the shadow git repository.
   * Returns false if workspace is too large or git unavailable.
   */
  async init(timeoutMs = 15e3) {
    if (this.initialized) return true;
    const warnTimer = setTimeout(() => {
      console.warn("[nexus] Checkpoints are taking longer than expected to initialize. Large repo?");
    }, CHECKPOINT_WARN_MS);
    try {
      await Promise.race([
        this.initInternal(),
        new Promise(
          (_, reject) => setTimeout(() => reject(new Error("Checkpoint init timed out")), timeoutMs)
        )
      ]);
      this.initialized = true;
      return true;
    } catch (err) {
      console.warn("[nexus] Checkpoint init failed:", err.message);
      return false;
    } finally {
      clearTimeout(warnTimer);
    }
  }
  async initInternal() {
    await fs10.mkdir(this.shadowRoot, { recursive: true });
    try {
      await this.git.status();
    } catch {
      await this.git.init();
      await this.git.addConfig("user.email", "nexus@local");
      await this.git.addConfig("user.name", "NexusCode");
    }
    await this.syncWorkspace();
    await this.git.add(".");
    try {
      await this.git.commit("initial checkpoint", { "--allow-empty": null });
    } catch {
    }
  }
  async commit(description) {
    if (!this.initialized) {
      await this.init();
    }
    if (!this.initialized) throw new Error("Checkpoint not initialized");
    await this.syncWorkspace();
    await this.git.add(".");
    let hash;
    try {
      const result = await this.git.commit(description ?? `checkpoint ${Date.now()}`, { "--allow-empty": null });
      hash = result.commit;
    } catch {
      hash = await this.git.revparse(["HEAD"]);
    }
    this.entries.push({ hash: hash.trim(), ts: Date.now(), description, messageId: "" });
    return hash.trim();
  }
  async resetHead(hash) {
    if (!this.initialized) throw new Error("Checkpoint not initialized");
    await this.git.checkout([hash, "--", "."]);
    await this.restoreToWorkspace();
  }
  async getDiff(fromHash, toHash) {
    if (!this.initialized) return [];
    try {
      const diff = await this.git.diff([
        "--name-status",
        fromHash,
        toHash ?? "HEAD"
      ]);
      const files = [];
      for (const line of diff.split("\n").filter(Boolean)) {
        const [status, ...parts] = line.split("	");
        const filePath = parts[0];
        if (!filePath || !status) continue;
        let before = "";
        let after = "";
        try {
          before = await this.git.show([`${fromHash}:${filePath}`]).catch(() => "");
        } catch {
        }
        try {
          after = await this.git.show([`${toHash ?? "HEAD"}:${filePath}`]).catch(() => "");
        } catch {
        }
        files.push({
          path: filePath,
          before,
          after,
          status: status === "A" ? "added" : status === "D" ? "deleted" : "modified"
        });
      }
      return files;
    } catch {
      return [];
    }
  }
  getEntries() {
    return [...this.entries];
  }
  async syncWorkspace() {
    const { cp } = await import('fs/promises');
    const ignore2 = /* @__PURE__ */ new Set([".git", "node_modules", ".nexus"]);
    await copyDir(this.workspaceRoot, this.shadowRoot, ignore2);
  }
  async restoreToWorkspace() {
    const ignore2 = /* @__PURE__ */ new Set([".git", "node_modules", ".nexus"]);
    await copyDir(this.shadowRoot, this.workspaceRoot, ignore2);
  }
};
async function copyDir(src, dest, ignoreNames) {
  const { readdir: readdir4, copyFile, mkdir: mkdir6, stat: stat7 } = await import('fs/promises');
  await mkdir6(dest, { recursive: true });
  const items = await readdir4(src).catch(() => []);
  await Promise.all(
    items.map(async (item) => {
      if (ignoreNames.has(item)) return;
      const srcPath = path4.join(src, item);
      const destPath = path4.join(dest, item);
      const itemStat = await stat7(srcPath).catch(() => null);
      if (!itemStat) return;
      if (itemStat.isDirectory()) {
        await copyDir(srcPath, destPath, ignoreNames);
      } else if (itemStat.isFile()) {
        await copyFile(srcPath, destPath).catch(() => {
        });
      }
    })
  );
}

export { CheckpointTracker, CodebaseIndexer, MODE_TOOL_GROUPS, McpClient, NexusConfigSchema, ParallelAgentManager, ProjectRegistry, READ_ONLY_TOOLS, Session, TOOL_GROUP_MEMBERS, ToolRegistry, buildSystemPrompt, classifySkills, classifyTools, createCompaction, createEmbeddingClient, createLLMClient, createSpawnAgentTool, ensureGlobalConfigDir, estimateTokens, generateSessionId, getAllBuiltinTools, getBuiltinToolsForMode, getGlobalConfigDir, getIndexDir, listSessions, loadConfig, loadRules, loadSkills, parseMentions, runAgentLoop, setMcpClientInstance, writeConfig };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map