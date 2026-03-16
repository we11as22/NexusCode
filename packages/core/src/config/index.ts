import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { NexusConfigSchema, type NexusConfigInput } from "./schema.js"
import type { NexusConfig } from "../types.js"
import {
  applySecretsToConfig,
  stripSecretsFromConfig,
  stripProfileSecrets,
  type NexusSecretsStore,
} from "./secrets.js"

import * as yaml from "js-yaml"
function getYaml() { return yaml }

const CONFIG_FILE_NAMES = [".nexus/nexus.yaml", ".nexus/nexus.yml", ".nexusrc.yaml", ".nexusrc.yml"]
const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".nexus")
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, "nexus.yaml")
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
const DEFAULT_FREE_MODELS_BASE_URL = "https://api.kilo.ai/api/openrouter"

/**
 * Load config by walking up from cwd.
 * Merges project config over global config.
 * Applies env overrides, then optional secrets store (API keys).
 */
export async function loadConfig(
  cwd?: string,
  options?: { secrets?: NexusSecretsStore }
): Promise<NexusConfig> {
  const startDir = cwd ?? process.cwd()
  loadEnvFileFromTree(startDir)

  // 1. Load global config
  const globalRaw = readConfigFile(GLOBAL_CONFIG_PATH)

  // 2. Walk up and find project config
  let projectRaw: NexusConfigInput | null = null
  let projectDir: string | null = null
  let dir = startDir
  let maxUp = 20
  while (maxUp-- > 0) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(dir, name)
      const raw = readConfigFile(candidate)
      if (raw) {
        projectRaw = raw
        projectDir = dir
        break
      }
    }
    if (projectRaw) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // 3. Merge global + project
  const merged = deepMerge(globalRaw ?? {}, projectRaw ?? {})

  // 3b. If project has .nexus/mcp-servers.json, use it for mcp.servers
  if (projectDir) {
    const mcpJsonPath = path.join(projectDir, ".nexus", "mcp-servers.json")
    if (fs.existsSync(mcpJsonPath)) {
      try {
        const mcpContent = fs.readFileSync(mcpJsonPath, "utf8")
        const mcpData = JSON.parse(mcpContent)
        const servers = Array.isArray(mcpData) ? mcpData : (mcpData?.servers ?? mcpData?.mcp?.servers)
        if (Array.isArray(servers) && servers.length > 0) {
          (merged as Record<string, unknown>).mcp = { ...(merged.mcp as object), servers }
        }
      } catch {
        // ignore
      }
    }
  }

  // 4. Apply env overrides
  applyEnvOverrides(merged)
  normalizeProviderAliases(merged)

  // 5. Apply secrets store (API keys) if provided — after env so env takes precedence
  if (options?.secrets) {
    await applySecretsToConfig(merged as Record<string, unknown>, options.secrets)
  }

  // 6. Parse and validate
  const result = NexusConfigSchema.safeParse(merged)
  if (!result.success) {
    console.warn("[nexus] Config validation warnings:", result.error.issues.map(i => i.message).join(", "))
    return normalizeToNexusConfig(NexusConfigSchema.parse({}) as Record<string, unknown>)
  }
  return normalizeToNexusConfig(result.data as Record<string, unknown>)
}

function normalizeToNexusConfig(parsed: Record<string, unknown>): NexusConfig {
  const rawSkills = (parsed.skills as (string | { path: string; enabled?: boolean })[]) ?? []
  const skillsConfig: Array<{ path: string; enabled: boolean }> = rawSkills.map(
    (item: string | { path: string; enabled?: boolean }) => {
      if (typeof item === "string") return { path: item, enabled: true }
      return { path: item.path, enabled: item.enabled !== false }
    }
  )
  const skills = skillsConfig.filter((s) => s.enabled).map((s) => s.path)
  return {
    ...parsed,
    skillsConfig,
    skills,
    mcp: (parsed.mcp as NexusConfig["mcp"]) ?? { servers: [] },
  } as NexusConfig
}

function loadEnvFileFromTree(startDir: string): void {
  let dir = startDir
  let maxUp = 20
  while (maxUp-- > 0) {
    const envPath = path.join(dir, ".env")
    if (fs.existsSync(envPath)) {
      loadEnvFile(envPath)
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

function loadEnvFile(filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, "utf8")
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith("#")) continue
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!m) continue
      const key = m[1]!
      if (process.env[key] !== undefined) continue
      let value = m[2] ?? ""
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      process.env[key] = value
    }
  } catch {
    // Ignore malformed or unreadable .env
  }
}

function readConfigFile(filePath: string): NexusConfigInput | null {
  try {
    if (!fs.existsSync(filePath)) return null
    let content = fs.readFileSync(filePath, "utf8")
    // KiloCode-style env substitution: {env:VAR_NAME} → process.env.VAR_NAME
    content = content.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, varName: string) => {
      return process.env[varName] ?? ""
    })
    // KiloCode-style file substitution: {file:path} → contents of file (path relative to config dir or ~/...)
    const fileMatches = content.match(/\{file:[^}]+\}/g)
    if (fileMatches) {
      const configDir = path.dirname(filePath)
      for (const match of fileMatches) {
        let filePathRel = match.replace(/^\{file:/, "").replace(/\}$/, "").trim()
        if (filePathRel.startsWith("~/")) {
          filePathRel = path.join(os.homedir(), filePathRel.slice(2))
        } else if (!path.isAbsolute(filePathRel)) {
          filePathRel = path.resolve(configDir, filePathRel)
        }
        try {
          const fileContent = fs.readFileSync(filePathRel, "utf8").trim()
          const escaped = JSON.stringify(fileContent).slice(1, -1)
          content = content.replace(match, () => escaped)
        } catch {
          content = content.replace(match, "")
        }
      }
    }
    if (filePath.endsWith(".json")) {
      return JSON.parse(content)
    }
    return getYaml().load(content) as NexusConfigInput
  } catch {
    return null
  }
}

// Map of provider name → env var name for API keys
const PROVIDER_API_KEY_ENV: Record<string, string[]> = {
  anthropic:    ["ANTHROPIC_API_KEY"],
  openai:       ["OPENAI_API_KEY"],
  "openai-compatible": ["OPENAI_API_KEY", "OPENROUTER_API_KEY"],
  google:       ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  openrouter:   ["OPENROUTER_API_KEY"],
  azure:        ["AZURE_OPENAI_API_KEY"],
  bedrock:      ["AWS_ACCESS_KEY_ID"],
  groq:         ["GROQ_API_KEY"],
  mistral:      ["MISTRAL_API_KEY"],
  xai:          ["XAI_API_KEY"],
  deepinfra:    ["DEEPINFRA_API_KEY"],
  cerebras:     ["CEREBRAS_API_KEY"],
  cohere:       ["COHERE_API_KEY"],
  togetherai:   ["TOGETHER_AI_API_KEY", "TOGETHERAI_API_KEY"],
  perplexity:   ["PERPLEXITY_API_KEY"],
  minimax:      ["MINIMAX_API_KEY"],
}

// Map of provider name → env var for model ID (e.g. OPENROUTER_MODEL)
const PROVIDER_MODEL_ENV: Record<string, string[]> = {
  "openai-compatible": ["OPENAI_MODEL", "OPENROUTER_MODEL"],
  openrouter:   ["OPENROUTER_MODEL"],
  anthropic:    ["ANTHROPIC_MODEL"],
  openai:       ["OPENAI_MODEL"],
  groq:         ["GROQ_MODEL"],
  mistral:      ["MISTRAL_MODEL"],
  google:       ["GOOGLE_MODEL", "GEMINI_MODEL"],
  xai:          ["XAI_MODEL"],
  cerebras:     ["CEREBRAS_MODEL"],
  minimax:      ["MINIMAX_MODEL"],
}

function applyEnvOverrides(config: Record<string, unknown>) {
  if (!config.model || typeof config.model !== "object") config.model = {}
  const model = config.model as Record<string, unknown>

  // When nothing is configured in project (and no global model), use same defaults as schema
  // so we can fill apiKey from env (OPENROUTER_API_KEY etc.) — like OpenCode/KiloCode "works out of the box"
  if (!isNonEmptyString(model["provider"]) && !isNonEmptyString(model["id"])) {
    model["provider"] = "openai-compatible"
    model["id"] = "minimax/minimax-m2.5:free"
    model["baseUrl"] = DEFAULT_FREE_MODELS_BASE_URL
  }

  // Universal NEXUS_API_KEY
  const nexusKey = process.env["NEXUS_API_KEY"]
  if (nexusKey && !model["apiKey"]) model["apiKey"] = nexusKey

  // Provider-specific API key from env
  if (!model["apiKey"]) {
    const provider = String(model["provider"] ?? "")
    const envVars = PROVIDER_API_KEY_ENV[provider] ?? []
    for (const envVar of envVars) {
      const v = process.env[envVar]
      if (v) { model["apiKey"] = v; break }
    }
  }

  // Provider-specific model from env (e.g. OPENROUTER_MODEL=qwen/qwen3-coder-next)
  if (!model["id"] || model["id"] === "") {
    const provider = String(model["provider"] ?? "")
    const envVars = PROVIDER_MODEL_ENV[provider] ?? []
    for (const envVar of envVars) {
      const v = process.env[envVar]
      if (v) { model["id"] = v; break }
    }
  }

  // NEXUS_MODEL override: provider/model-name or just model-name
  const nexusModel = process.env["NEXUS_MODEL"]
  if (nexusModel) {
    const slashIdx = nexusModel.indexOf("/")
    if (slashIdx > 0) {
      model["provider"] = nexusModel.slice(0, slashIdx)
      model["id"] = nexusModel.slice(slashIdx + 1)
    } else {
      model["id"] = nexusModel
    }
  }

  // NEXUS_BASE_URL override
  if (process.env["NEXUS_BASE_URL"]) {
    model["baseUrl"] = process.env["NEXUS_BASE_URL"]
  }

  // NEXUS_TEMPERATURE override
  const tempRaw = process.env["NEXUS_TEMPERATURE"]
  if (tempRaw) {
    const t = Number(tempRaw)
    if (Number.isFinite(t) && t >= 0 && t <= 2) {
      model["temperature"] = t
    }
  }

  // NEXUS_MAX_MODE / NEXUS_MAX_TOKEN_MULTIPLIER removed (max mode feature removed)
}

function normalizeProviderAliases(config: Record<string, unknown>): void {
  const model = asRecord(config["model"])
  if (model) {
    const provider = String(model["provider"] ?? "")
    if (provider === "openrouter") {
      model["provider"] = "openai-compatible"
      if (!isNonEmptyString(model["baseUrl"])) model["baseUrl"] = OPENROUTER_BASE_URL
      if (!isNonEmptyString(model["apiKey"]) && process.env["OPENROUTER_API_KEY"]) {
        model["apiKey"] = process.env["OPENROUTER_API_KEY"]
      }
      if (!isNonEmptyString(model["id"]) && process.env["OPENROUTER_MODEL"]) {
        model["id"] = process.env["OPENROUTER_MODEL"]
      }
    }

    if (provider === "openai-compatible" && isOpenRouterBaseUrl(model["baseUrl"])) {
      if (!isNonEmptyString(model["apiKey"]) && process.env["OPENROUTER_API_KEY"]) {
        model["apiKey"] = process.env["OPENROUTER_API_KEY"]
      }
      if (!isNonEmptyString(model["id"]) && process.env["OPENROUTER_MODEL"]) {
        model["id"] = process.env["OPENROUTER_MODEL"]
      }
    }
    const normalizedProvider = String(model["provider"] ?? "")
    const normalizedId = String(model["id"] ?? "")
    const baseUrl = String(model["baseUrl"] ?? "")
    if (
      normalizedProvider === "openai-compatible" &&
      normalizedId.endsWith(":free") &&
      (!isNonEmptyString(baseUrl) || isOpenRouterBaseUrl(baseUrl))
    ) {
      model["baseUrl"] = DEFAULT_FREE_MODELS_BASE_URL
    }
  }

  const embeddings = asRecord(config["embeddings"])
  if (embeddings) {
    if (String(embeddings["provider"] ?? "") === "openrouter") {
      if (!isNonEmptyString(embeddings["baseUrl"])) embeddings["baseUrl"] = OPENROUTER_BASE_URL
      if (!isNonEmptyString(embeddings["apiKey"]) && process.env["OPENROUTER_API_KEY"]) {
        embeddings["apiKey"] = process.env["OPENROUTER_API_KEY"]
      }
    }
    if (String(embeddings["provider"] ?? "") === "openai-compatible" && isOpenRouterBaseUrl(embeddings["baseUrl"])) {
      if (!isNonEmptyString(embeddings["apiKey"]) && process.env["OPENROUTER_API_KEY"]) {
        embeddings["apiKey"] = process.env["OPENROUTER_API_KEY"]
      }
    }
  }

  const profiles = asRecord(config["profiles"])
  if (profiles) {
    for (const value of Object.values(profiles)) {
      const profile = asRecord(value)
      if (!profile) continue
      if (String(profile["provider"] ?? "") === "openrouter") {
        profile["provider"] = "openai-compatible"
        if (!isNonEmptyString(profile["baseUrl"])) profile["baseUrl"] = OPENROUTER_BASE_URL
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

function isOpenRouterBaseUrl(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false
  return value.toLowerCase().includes("openrouter.ai")
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, val] of Object.entries(override)) {
    if (val && typeof val === "object" && !Array.isArray(val) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>)
    } else {
      result[key] = val
    }
  }
  return result
}

/**
 * Write config to project .nexus/nexus.yaml.
 * By default strips API keys so they are never persisted to YAML (use secrets store instead).
 */
export function writeConfig(
  config: Partial<NexusConfig>,
  cwd?: string,
  options?: { stripSecrets?: boolean }
): void {
  const stripSecrets = options?.stripSecrets !== false
  const toWrite = stripSecrets
    ? stripSecretsFromConfig(config as Record<string, unknown>)
    : (config as Record<string, unknown>)
  const dir = path.join(cwd ?? process.cwd(), ".nexus")
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, "nexus.yaml")
  const content = getYaml().dump(toWrite, { indent: 2, lineWidth: 120 })
  fs.writeFileSync(filePath, content, "utf8")
}

/**
 * Persist profiles to global ~/.nexus/nexus.yaml so they are available across all projects.
 * Strips apiKey from each profile so keys are never written to YAML (use secrets store).
 */
export function writeGlobalProfiles(profiles: Record<string, unknown>): void {
  ensureGlobalConfigDir()
  const current = (readConfigFile(GLOBAL_CONFIG_PATH) ?? {}) as Record<string, unknown>
  current["profiles"] = stripProfileSecrets(profiles)
  const content = getYaml().dump(current, { indent: 2, lineWidth: 120 })
  fs.writeFileSync(GLOBAL_CONFIG_PATH, content, "utf8")
}

/**
 * Get the global config directory
 */
export function getGlobalConfigDir(): string {
  return GLOBAL_CONFIG_DIR
}

/**
 * Ensure global config directory exists with defaults
 */
export function ensureGlobalConfigDir() {
  if (!fs.existsSync(GLOBAL_CONFIG_DIR)) {
    fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
  }
  const skillsDir = path.join(GLOBAL_CONFIG_DIR, "skills")
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true })
  }
  const rulesDir = path.join(GLOBAL_CONFIG_DIR, "rules")
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true })
  }
}

export { NexusConfigSchema }
export type { NexusConfig }
export {
  applySecretsToConfig,
  stripSecretsFromConfig,
  stripProfileSecrets,
  getSecretsPayloadFromConfig,
  persistSecretsFromConfig,
  createFileSecretsStore,
  NEXUS_SECRETS_STORAGE_KEY,
} from "./secrets.js"
export type { NexusSecretsStore, NexusSecretsPayload } from "./secrets.js"

/** Format like .claude: { permissions: { allow: string[], deny: string[], ask: string[] } } */
export interface ProjectSettings {
  permissions?: {
    allow?: string[]
    deny?: string[]
    ask?: string[]
    allowedMcpTools?: string[]
  }
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))]
}

function readSettingsFile(filePath: string): ProjectSettings {
  try {
    if (!fs.existsSync(filePath)) return {}
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"))
    if (raw && typeof raw === "object") return raw as ProjectSettings
  } catch {
    // ignore
  }
  return {}
}

function mergeSettings(...layers: ProjectSettings[]): ProjectSettings {
  const allow: string[] = []
  const deny: string[] = []
  const ask: string[] = []
  const allowedMcpTools: string[] = []
  for (const layer of layers) {
    allow.push(...(layer.permissions?.allow ?? []))
    deny.push(...(layer.permissions?.deny ?? []))
    ask.push(...(layer.permissions?.ask ?? []))
    allowedMcpTools.push(...(layer.permissions?.allowedMcpTools ?? []))
  }
  return {
    permissions: {
      allow: uniqueNonEmpty(allow),
      deny: uniqueNonEmpty(deny),
      ask: uniqueNonEmpty(ask),
      allowedMcpTools: uniqueNonEmpty(allowedMcpTools),
    },
  }
}

/**
 * Load global ~/.nexus/settings.json and ~/.nexus/settings.local.json.
 * Same structure as .claude: permissions.allow, permissions.deny, permissions.ask.
 */
export function loadGlobalSettings(): ProjectSettings {
  const globalBase = readSettingsFile(path.join(GLOBAL_CONFIG_DIR, "settings.json"))
  const globalLocal = readSettingsFile(path.join(GLOBAL_CONFIG_DIR, "settings.local.json"))
  return mergeSettings(globalBase, globalLocal)
}

/**
 * Load .nexus/settings.json and .nexus/settings.local.json (local overrides), merge with global settings.
 * Layer order: global base → global local → project base → project local (later overrides earlier).
 */
export function loadProjectSettings(cwd: string): ProjectSettings {
  const globalBase = readSettingsFile(path.join(GLOBAL_CONFIG_DIR, "settings.json"))
  const globalLocal = readSettingsFile(path.join(GLOBAL_CONFIG_DIR, "settings.local.json"))
  const projectBase = readSettingsFile(path.join(cwd, ".nexus", "settings.json"))
  const projectLocal = readSettingsFile(path.join(cwd, ".nexus", "settings.local.json"))
  return mergeSettings(globalBase, globalLocal, projectBase, projectLocal)
}

/**
 * Write project settings to .nexus/settings.json.
 */
export function writeProjectSettings(cwd: string, settings: ProjectSettings): void {
  const dir = path.join(cwd, ".nexus")
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2), "utf8")
}

/**
 * Write global settings to ~/.nexus/settings.json.
 */
export function writeGlobalSettings(settings: ProjectSettings): void {
  ensureGlobalConfigDir()
  fs.writeFileSync(path.join(GLOBAL_CONFIG_DIR, "settings.json"), JSON.stringify(settings, null, 2), "utf8")
}
