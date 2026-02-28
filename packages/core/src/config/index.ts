import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { NexusConfigSchema, type NexusConfigInput } from "./schema.js"
import type { NexusConfig } from "../types.js"

import * as yaml from "js-yaml"
function getYaml() { return yaml }

const CONFIG_FILE_NAMES = [".nexus/nexus.yaml", ".nexus/nexus.yml", ".nexusrc.yaml", ".nexusrc.yml"]
const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".nexus")
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, "nexus.yaml")

/**
 * Load config by walking up from cwd.
 * Merges project config over global config.
 * Applies env overrides.
 */
export async function loadConfig(cwd?: string): Promise<NexusConfig> {
  const startDir = cwd ?? process.cwd()

  // 1. Load global config
  const globalRaw = readConfigFile(GLOBAL_CONFIG_PATH)

  // 2. Walk up and find project config
  let projectRaw: NexusConfigInput | null = null
  let dir = startDir
  let maxUp = 20
  while (maxUp-- > 0) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(dir, name)
      const raw = readConfigFile(candidate)
      if (raw) {
        projectRaw = raw
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

  // 4. Apply env overrides
  applyEnvOverrides(merged)

  // 5. Parse and validate
  const result = NexusConfigSchema.safeParse(merged)
  if (!result.success) {
    console.warn("[nexus] Config validation warnings:", result.error.issues.map(i => i.message).join(", "))
    // Return with defaults on validation error
    return NexusConfigSchema.parse({})
  }

  return result.data as NexusConfig
}

function readConfigFile(filePath: string): NexusConfigInput | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const content = fs.readFileSync(filePath, "utf8")
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
}

// Map of provider name → env var for model ID (e.g. OPENROUTER_MODEL)
const PROVIDER_MODEL_ENV: Record<string, string[]> = {
  openrouter:   ["OPENROUTER_MODEL"],
  anthropic:    ["ANTHROPIC_MODEL"],
  openai:       ["OPENAI_MODEL"],
  groq:         ["GROQ_MODEL"],
  mistral:      ["MISTRAL_MODEL"],
  google:       ["GOOGLE_MODEL", "GEMINI_MODEL"],
  xai:          ["XAI_MODEL"],
  cerebras:     ["CEREBRAS_MODEL"],
}

function applyEnvOverrides(config: Record<string, unknown>) {
  if (!config.model || typeof config.model !== "object") config.model = {}
  const model = config.model as Record<string, unknown>

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

  // NEXUS_MAX_MODE
  if (process.env["NEXUS_MAX_MODE"] === "1" || process.env["NEXUS_MAX_MODE"] === "true") {
    if (!config.maxMode || typeof config.maxMode !== "object") config.maxMode = {}
    ;(config.maxMode as Record<string, unknown>)["enabled"] = true
  }

  // Apply same provider key logic for maxMode if it has a provider set
  if (config.maxMode && typeof config.maxMode === "object") {
    const mm = config.maxMode as Record<string, unknown>
    if (!mm["apiKey"] && mm["provider"]) {
      const provider = String(mm["provider"])
      const envVars = PROVIDER_API_KEY_ENV[provider] ?? []
      for (const envVar of envVars) {
        const v = process.env[envVar]
        if (v) { mm["apiKey"] = v; break }
      }
    }
  }
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
 * Write config to project .nexus/nexus.yaml
 */
export function writeConfig(config: Partial<NexusConfig>, cwd?: string) {
  const dir = path.join(cwd ?? process.cwd(), ".nexus")
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, "nexus.yaml")
  const content = getYaml().dump(config, { indent: 2, lineWidth: 120 })
  fs.writeFileSync(filePath, content, "utf8")
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
