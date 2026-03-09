/**
 * Secrets store abstraction (Roo-Code / Cline best practice).
 * API keys are never written to YAML; they are stored in a secure store and
 * applied at load time after env overrides.
 */

import * as fs from "node:fs"
import * as path from "node:path"

const NEXUS_SECRETS_KEY = "nexuscode_api"

/** Key used in secrets store (VS Code secretStorage or file) for API keys payload. */
export const NEXUS_SECRETS_STORAGE_KEY = NEXUS_SECRETS_KEY

export interface NexusSecretsPayload {
  model?: string
  embeddings?: string
  /** API keys per profile name (global profiles in ~/.nexus/nexus.yaml). */
  profiles?: Record<string, string>
}

export interface NexusSecretsStore {
  getSecret(key: string): Promise<string | undefined>
  setSecret(key: string, value: string): Promise<void>
}

/**
 * Apply secrets from store into config (in-place).
 * Only sets model.apiKey, embeddings.apiKey, and profiles[name].apiKey if not already set (env/config takes precedence).
 */
export async function applySecretsToConfig(
  config: Record<string, unknown>,
  store: NexusSecretsStore
): Promise<void> {
  const raw = await store.getSecret(NEXUS_SECRETS_KEY)
  if (!raw?.trim()) return
  let payload: NexusSecretsPayload
  try {
    payload = JSON.parse(raw) as NexusSecretsPayload
  } catch {
    return
  }
  if (!config.model || typeof config.model !== "object") config.model = {}
  const model = config.model as Record<string, unknown>
  if (payload.model && !isNonEmptyString(model["apiKey"])) {
    model["apiKey"] = payload.model.trim()
  }
  if (config.embeddings && typeof config.embeddings === "object") {
    const emb = config.embeddings as Record<string, unknown>
    if (payload.embeddings && !isNonEmptyString(emb["apiKey"])) {
      emb["apiKey"] = payload.embeddings.trim()
    }
  }
  if (payload.profiles && config.profiles && typeof config.profiles === "object") {
    const profiles = config.profiles as Record<string, Record<string, unknown>>
    for (const [name, key] of Object.entries(payload.profiles)) {
      if (!key || !profiles[name]) continue
      const p = profiles[name]
      if (p && typeof p === "object" && !isNonEmptyString(p["apiKey"])) {
        p["apiKey"] = key.trim()
      }
    }
  }
}

/**
 * Strip secret fields from config for persisting to YAML (never write apiKey to repo).
 * Returns a deep copy with model.apiKey, embeddings.apiKey, and each profiles[name].apiKey removed.
 */
export function stripSecretsFromConfig<T extends Record<string, unknown>>(config: T): T {
  const out = JSON.parse(JSON.stringify(config)) as T
  if (out.model && typeof out.model === "object") {
    const m = out.model as Record<string, unknown>
    delete m["apiKey"]
  }
  if (out.embeddings && typeof out.embeddings === "object") {
    const e = out.embeddings as Record<string, unknown>
    delete e["apiKey"]
  }
  if (out.profiles && typeof out.profiles === "object") {
    for (const p of Object.values(out.profiles as Record<string, Record<string, unknown>>)) {
      if (p && typeof p === "object") delete p["apiKey"]
    }
  }
  return out
}

/**
 * Strip apiKey from each profile for writing to global YAML (~/.nexus/nexus.yaml).
 * Call before writeGlobalProfiles so profile keys are never persisted in plain text.
 */
export function stripProfileSecrets(profiles: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(profiles)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const p = { ...(value as Record<string, unknown>) }
      delete p["apiKey"]
      out[name] = p
    } else {
      out[name] = value
    }
  }
  return out
}

/**
 * Build payload from current config (model.apiKey, embeddings.apiKey, profile apiKeys) for persisting to secrets store.
 */
export function getSecretsPayloadFromConfig(config: Record<string, unknown>): NexusSecretsPayload {
  const payload: NexusSecretsPayload = {}
  if (config.model && typeof config.model === "object") {
    const apiKey = (config.model as Record<string, unknown>)["apiKey"]
    if (typeof apiKey === "string" && apiKey.trim()) payload.model = apiKey.trim()
  }
  if (config.embeddings && typeof config.embeddings === "object") {
    const apiKey = (config.embeddings as Record<string, unknown>)["apiKey"]
    if (typeof apiKey === "string" && apiKey.trim()) payload.embeddings = apiKey.trim()
  }
  if (config.profiles && typeof config.profiles === "object") {
    const profileKeys: Record<string, string> = {}
    for (const [name, p] of Object.entries(config.profiles as Record<string, Record<string, unknown>>)) {
      if (p && typeof p === "object") {
        const k = p["apiKey"]
        if (typeof k === "string" && k.trim()) profileKeys[name] = k.trim()
      }
    }
    if (Object.keys(profileKeys).length > 0) payload.profiles = profileKeys
  }
  return payload
}

/**
 * Persist model and embeddings API keys from config into the secrets store.
 * Call after merging user config; then persist config with stripSecretsFromConfig.
 */
export async function persistSecretsFromConfig(
  config: Record<string, unknown>,
  store: NexusSecretsStore
): Promise<void> {
  const payload = getSecretsPayloadFromConfig(config)
  const value = Object.keys(payload).length > 0 ? JSON.stringify(payload) : ""
  await store.setSecret(NEXUS_SECRETS_KEY, value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/**
 * File-based secrets store for CLI (Cline-style: single file with mode 0o600).
 * Path: {globalConfigDir}/secrets.json
 */
export function createFileSecretsStore(globalConfigDir: string): NexusSecretsStore {
  const secretsPath = path.join(globalConfigDir, "secrets.json")
  const FILE_MODE = 0o600

  return {
    async getSecret(key: string): Promise<string | undefined> {
      try {
        if (!fs.existsSync(secretsPath)) return undefined
        const data = JSON.parse(fs.readFileSync(secretsPath, "utf8")) as Record<string, string>
        return data[key]
      } catch {
        return undefined
      }
    },

    async setSecret(key: string, value: string): Promise<void> {
      try {
        let data: Record<string, string> = {}
        if (fs.existsSync(secretsPath)) {
          try {
            data = JSON.parse(fs.readFileSync(secretsPath, "utf8")) as Record<string, string>
          } catch {
            /* ignore */
          }
        }
        if (value) {
          data[key] = value
        } else {
          delete data[key]
        }
        if (!fs.existsSync(globalConfigDir)) {
          fs.mkdirSync(globalConfigDir, { recursive: true })
        }
        const tmp = `${secretsPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: FILE_MODE })
        fs.renameSync(tmp, secretsPath)
      } catch (err) {
        throw new Error(`Failed to write secrets: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}
