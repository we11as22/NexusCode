import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { NexusConfigSchema, type NexusConfigInput } from "./schema.js"
import type { NexusConfig } from "../types.js"

// YAML parsing — lazy load to avoid adding yaml as a hard dep at module load
let yaml: typeof import("js-yaml") | null = null
function getYaml() {
  if (!yaml) yaml = require("js-yaml") as typeof import("js-yaml")
  return yaml
}

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

function applyEnvOverrides(config: Record<string, unknown>) {
  // NEXUS_API_KEY or provider-specific keys
  const nexusKey = process.env["NEXUS_API_KEY"]
  const anthropicKey = process.env["ANTHROPIC_API_KEY"]
  const openaiKey = process.env["OPENAI_API_KEY"]
  const googleKey = process.env["GOOGLE_API_KEY"] ?? process.env["GEMINI_API_KEY"]

  if (!config.model || typeof config.model !== "object") config.model = {}
  const model = config.model as Record<string, unknown>

  if (nexusKey && !model["apiKey"]) model["apiKey"] = nexusKey
  if (!model["apiKey"]) {
    const provider = model["provider"] as string
    if (provider === "anthropic" && anthropicKey) model["apiKey"] = anthropicKey
    if (provider === "openai" && openaiKey) model["apiKey"] = openaiKey
    if (provider === "google" && googleKey) model["apiKey"] = googleKey
    if (provider === "openrouter" && process.env["OPENROUTER_API_KEY"]) {
      model["apiKey"] = process.env["OPENROUTER_API_KEY"]
    }
  }

  // NEXUS_MODEL override
  if (process.env["NEXUS_MODEL"]) {
    const [provider, ...rest] = process.env["NEXUS_MODEL"].split("/")
    if (rest.length > 0) {
      model["provider"] = provider
      model["id"] = rest.join("/")
    } else {
      model["id"] = provider
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
