/**
 * Secrets store abstraction for hosts that support it.
 * API keys are never written to YAML; they are stored in a secure store and
 * applied at load time after env overrides.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { EmbeddingConfig, ProviderConfig } from "../types.js"
import {
  atomicWriteFile,
  withFileLock,
} from "../storage/durable-fs.js"
import {
  canonicalizeCredentialDestination,
  credentialIdentityKey,
  getEmbeddingCredentialIdentity,
  getProviderCredentialIdentity,
  mergeProviderConfigSafely,
  resolveEmbeddingCredential,
  resolveProviderCredential,
  selectProviderProfile,
  type CredentialIdentity,
} from "../provider/credential-identity.js"

const NEXUS_SECRETS_KEY = "nexuscode_api"
const SCOPED_ENVIRONMENT_MARKER = Symbol.for(
  "@nexuscode/config/scoped-environment",
)

/** Key used in secrets store (VS Code secretStorage or file) for API keys payload. */
export const NEXUS_SECRETS_STORAGE_KEY = NEXUS_SECRETS_KEY

export interface NexusBoundSecret extends CredentialIdentity {
  secret: string
}

export interface NexusLegacyUnboundSecrets {
  model?: string
  embeddings?: string
  profiles?: Record<string, string>
}

export interface NexusSecretsPayload {
  version: 2
  credentials: Record<string, NexusBoundSecret>
  /**
   * Compatibility binding for named local profiles. The remote protocol still
   * needs stable profile IDs; names are never treated as credential identity.
   */
  profileCredentials?: Record<string, NexusBoundSecret>
  /**
   * V1 values had no destination identity. They remain available for explicit
   * migration UI, but are never attached to a request automatically.
   */
  legacyUnbound?: NexusLegacyUnboundSecrets
  /** Qdrant / vector DB API key (same store as other keys; never written to YAML). */
  qdrantApiKey?: string
}

export interface NexusSecretsStore {
  getSecret(key: string): Promise<string | undefined>
  setSecret(key: string, value: string): Promise<void>
  /**
   * Optional atomic read-modify-write primitive. File-backed stores implement
   * this under one cross-process lock; hosts without it are serialized by an
   * in-process per-store queue.
   */
  updateSecret?(
    key: string,
    update: (
      current: string | undefined,
    ) => string | undefined | Promise<string | undefined>,
  ): Promise<void>
}

export interface FinalizeConfigCredentialsOptions {
  /**
   * A named profile has an independent credential binding even when it points
   * at the same provider destination as another profile or the base model.
   */
  profileName?: string
  /**
   * Immutable host-scoped environment captured while loading config. Passing
   * it avoids relying on global process mutation for project-local `.env`.
   */
  environment?: Readonly<Record<string, string | undefined>>
}

export interface ProfileCredentialRemoval {
  name: string
  /** The previously resolved profile model whose binding must be removed. */
  model: ProviderConfig
}

export interface SecretsRemoval {
  /** `true` targets config.model; a config value can target an old scope. */
  model?: true | ProviderConfig
  /** `true` targets config.embeddings; a config value can target an old scope. */
  embeddings?: true | EmbeddingConfig
  /**
   * Remove a named binding only when it still matches this old identity.
   * This lets an endpoint change replace the key atomically.
   */
  profileBindings?: ProfileCredentialRemoval[]
  /** Unconditional user-requested deletion by profile name. */
  profileNames?: string[]
  qdrant?: boolean
}

export interface PersistSecretsOptions {
  remove?: SecretsRemoval
}

export class UnsupportedSecretsVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`Unsupported secrets payload version: ${String(version)}`)
    this.name = "UnsupportedSecretsVersionError"
  }
}

export type SecretsCorruptionReason =
  | "invalid-json"
  | "invalid-root"
  | "missing-credentials"
  | "invalid-credentials"
  | "invalid-credential"
  | "credential-key-mismatch"
  | "invalid-profile-credentials"
  | "invalid-profile-credential"
  | "profile-name-collision"
  | "invalid-legacy-payload"
  | "invalid-qdrant-key"

export class SecretsCorruptionError extends Error {
  constructor(readonly reason: SecretsCorruptionReason, cause?: unknown) {
    super(
      `Secrets payload is corrupt (${reason}); stored bytes were preserved and the payload is quarantined until repaired`,
      cause === undefined ? undefined : { cause },
    )
    this.name = "SecretsCorruptionError"
  }
}

export class ProfileCredentialCollisionError extends Error {
  constructor(readonly canonicalName: string) {
    super(
      `Profile credential names collide after canonicalization: ${canonicalName}`,
    )
    this.name = "ProfileCredentialCollisionError"
  }
}

const secretsStoreQueues = new WeakMap<NexusSecretsStore, Promise<void>>()

async function updateStoreSecret(
  store: NexusSecretsStore,
  key: string,
  update: (
    current: string | undefined,
  ) => string | undefined | Promise<string | undefined>,
): Promise<void> {
  if (store.updateSecret) {
    await store.updateSecret(key, update)
    return
  }

  const previous = secretsStoreQueues.get(store) ?? Promise.resolve()
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await store.getSecret(key)
      const next = await update(current)
      await store.setSecret(key, next ?? "")
    })
  secretsStoreQueues.set(
    store,
    operation.then(
      () => undefined,
      () => undefined,
    ),
  )
  await operation
}

/**
 * Resolve secure-store credentials only after a host has finished selecting the
 * effective model, endpoint, profile, preset and embedding configuration.
 *
 * The input is never mutated. Raw profiles remain secretless: only the final
 * runtime model receives a named profile credential.
 */
export async function finalizeConfigCredentials<
  T extends Record<string, unknown>,
>(
  config: T,
  store: NexusSecretsStore,
  options: FinalizeConfigCredentialsOptions = {},
): Promise<T> {
  const scopedEnvironment =
    options.environment ??
    (config as {
      [SCOPED_ENVIRONMENT_MARKER]?: Readonly<
        Record<string, string | undefined>
      >
    })[SCOPED_ENVIRONMENT_MARKER]
  const explicitModel = readSectionSecret(config["model"], "apiKey")
  const explicitEmbeddings = readSectionSecret(config["embeddings"], "apiKey")
  const explicitQdrant = readSectionSecret(config["vectorDb"], "apiKey")
  const runtime = stripSecretsFromConfig(config)
  const payload = await readSecretsPayload(store)

  const model = asRecord(runtime["model"])
  if (model) {
    if (explicitModel) {
      model["apiKey"] = explicitModel
    } else if (
      scopedEnvironment &&
      applyProviderEnvironmentSecret(model, scopedEnvironment)
    ) {
      // Environment credentials intentionally precede secure-store fallback.
    } else if (payload) {
      applyBoundProviderSecret(model, payload, options.profileName)
    }
  }

  const embeddings = asRecord(runtime["embeddings"])
  if (embeddings) {
    if (explicitEmbeddings) {
      embeddings["apiKey"] = explicitEmbeddings
    } else if (
      scopedEnvironment &&
      applyEmbeddingEnvironmentSecret(embeddings, scopedEnvironment)
    ) {
      // Environment credentials intentionally precede secure-store fallback.
    } else if (payload) {
      applyBoundEmbeddingSecret(embeddings, payload)
    }
  }

  const vectorDb = asRecord(runtime["vectorDb"])
  if (vectorDb) {
    const qdrantApiKey =
      explicitQdrant ??
      nonEmpty(
        (scopedEnvironment ?? process.env)["QDRANT_API_KEY"],
      ) ??
      nonEmpty(payload?.qdrantApiKey)
    if (qdrantApiKey) vectorDb["apiKey"] = qdrantApiKey
  }

  return runtime
}

/**
 * Backward-compatible in-place finalization for older hosts. New host code
 * should use finalizeConfigCredentials after all selection overrides.
 */
export async function applySecretsToConfig(
  config: Record<string, unknown>,
  store: NexusSecretsStore,
): Promise<void> {
  const runtime = await finalizeConfigCredentials(config, store)
  for (const key of Object.keys(config)) delete config[key]
  Object.assign(config, runtime)
}

/**
 * Strip all known provider credentials from credential-bearing config sections.
 * MCP environment/header values are deliberately outside this sanitizer because
 * they have their own secure integration lifecycle.
 */
export function stripSecretsFromConfig<T extends Record<string, unknown>>(config: T): T {
  const out = JSON.parse(JSON.stringify(config)) as T
  for (const section of ["model", "embeddings", "vectorDb", "profiles"]) {
    if (Object.prototype.hasOwnProperty.call(out, section)) {
      ;(out as Record<string, unknown>)[section] =
        sanitizeCredentialValue(
          (out as Record<string, unknown>)[section],
          undefined,
          true,
        )
    }
  }
  return out
}

/**
 * Strip apiKey from each profile for writing to global YAML (~/.nexus/nexus.yaml).
 * Call before writeGlobalProfiles so profile keys are never persisted in plain text.
 */
export function stripProfileSecrets(profiles: Record<string, unknown>): Record<string, unknown> {
  return sanitizeCredentialValue(
    JSON.parse(JSON.stringify(profiles)),
    undefined,
    true,
  ) as Record<string, unknown>
}

/**
 * Build payload from current config (model.apiKey, embeddings.apiKey, vectorDb.apiKey, profile apiKeys) for persisting to secrets store.
 */
export function getSecretsPayloadFromConfig(config: Record<string, unknown>): NexusSecretsPayload {
  const payload: NexusSecretsPayload = {
    version: 2,
    credentials: {},
  }
  if (config.model && typeof config.model === "object") {
    addProviderCredential(payload, config.model as Record<string, unknown>)
  }
  if (config.embeddings && typeof config.embeddings === "object") {
    addEmbeddingCredential(payload, config.embeddings as Record<string, unknown>)
  }
  if (config.vectorDb && typeof config.vectorDb === "object") {
    const apiKey = (config.vectorDb as Record<string, unknown>)["apiKey"]
    if (typeof apiKey === "string" && apiKey.trim()) payload.qdrantApiKey = apiKey.trim()
  }
  if (config.profiles && typeof config.profiles === "object") {
    const canonicalNames = new Map<string, string>()
    const baseModel = config.model && typeof config.model === "object"
      ? asProviderConfig(config.model as Record<string, unknown>)
      : null
    for (const [name, profile] of Object.entries(
      config.profiles as Record<string, Record<string, unknown>>,
    )) {
      const canonicalName = canonicalProfileName(name)
      if (!canonicalName) continue
      const existingName = canonicalNames.get(canonicalName)
      if (existingName !== undefined && existingName !== name) {
        throw new ProfileCredentialCollisionError(canonicalName)
      }
      canonicalNames.set(canonicalName, name)
      if (baseModel) {
        if (profile && typeof profile === "object") {
          try {
            const resolved = selectProviderProfile(
              baseModel,
              profile as Partial<ProviderConfig>,
            )
            addProfileCredential(payload, canonicalName, resolved)
          } catch {
            // Invalid/incomplete profiles cannot produce a credential binding.
          }
        }
      }
    }
  }
  return payload
}

/**
 * Persist model and embeddings API keys from config into the secrets store.
 * Call after merging user config; then persist config with stripSecretsFromConfig.
 */
export async function persistSecretsFromConfig(
  config: Record<string, unknown>,
  store: NexusSecretsStore,
  options: PersistSecretsOptions = {},
): Promise<void> {
  const current = getSecretsPayloadFromConfig(config)
  await updateStoreSecret(store, NEXUS_SECRETS_KEY, (existingRaw) => {
    const parsedExisting = existingRaw?.trim()
      ? parseSecretsPayload(existingRaw)
      : undefined
    if (parsedExisting?.status === "unsupported") {
      throw new UnsupportedSecretsVersionError(parsedExisting.version)
    }
    const existing = parsedExisting?.status === "ok"
      ? parsedExisting.payload
      : undefined
    const payload: NexusSecretsPayload = {
      version: 2,
      credentials: {
        ...(existing?.credentials ?? {}),
        ...current.credentials,
      },
      ...((existing?.profileCredentials || current.profileCredentials)
        ? {
            profileCredentials: {
              ...(existing?.profileCredentials ?? {}),
              ...(current.profileCredentials ?? {}),
            },
          }
        : {}),
      ...(existing?.legacyUnbound
        ? { legacyUnbound: existing.legacyUnbound }
        : {}),
      ...(current.qdrantApiKey
        ? { qdrantApiKey: current.qdrantApiKey }
        : existing?.qdrantApiKey
          ? { qdrantApiKey: existing.qdrantApiKey }
          : {}),
    }
    applySecretTombstones(payload, config, options.remove)

    if (
      payload.profileCredentials &&
      Object.keys(payload.profileCredentials).length === 0
    ) {
      delete payload.profileCredentials
    }
    const hasContent =
      Object.keys(payload.credentials).length > 0 ||
      (payload.profileCredentials !== undefined &&
        Object.keys(payload.profileCredentials).length > 0) ||
      payload.legacyUnbound !== undefined ||
      payload.qdrantApiKey !== undefined
    return hasContent ? JSON.stringify(payload) : undefined
  })
}

function parseSecretsPayload(
  raw: string,
):
  | { status: "ok"; payload: NexusSecretsPayload; migrated: boolean }
  | { status: "unsupported"; version: unknown } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new SecretsCorruptionError("invalid-json", error)
  }
  if (!isRecord(value)) {
    throw new SecretsCorruptionError("invalid-root")
  }

  const version = value["version"]
  if (version !== undefined && version !== 1 && version !== 2) {
    return { status: "unsupported", version }
  }

  if (version === 2) {
    if (value["credentials"] === undefined) {
      throw new SecretsCorruptionError("missing-credentials")
    }
    if (!isRecord(value["credentials"])) {
      throw new SecretsCorruptionError("invalid-credentials")
    }
    const credentials: Record<string, NexusBoundSecret> = {}
    for (const [key, entry] of Object.entries(value["credentials"])) {
      const bound = parseBoundSecret(entry, "invalid-credential")
      let expectedKey: string
      try {
        expectedKey = credentialIdentityKey(bound)
      } catch (error) {
        throw new SecretsCorruptionError("invalid-credential", error)
      }
      if (key !== expectedKey) {
        throw new SecretsCorruptionError("credential-key-mismatch")
      }
      credentials[key] = bound
    }

    const profileCredentials: Record<string, NexusBoundSecret> = {}
    if (value["profileCredentials"] !== undefined) {
      if (!isRecord(value["profileCredentials"])) {
        throw new SecretsCorruptionError("invalid-profile-credentials")
      }
      const canonicalNames = new Map<string, string>()
      for (const [name, entry] of Object.entries(value["profileCredentials"])) {
        const canonicalName = canonicalProfileName(name)
        if (!canonicalName) {
          throw new SecretsCorruptionError("invalid-profile-credential")
        }
        const previous = canonicalNames.get(canonicalName)
        if (previous !== undefined && previous !== name) {
          throw new SecretsCorruptionError("profile-name-collision")
        }
        canonicalNames.set(canonicalName, name)
        const bound = parseBoundSecret(
          entry,
          "invalid-profile-credential",
        )
        if (bound.purpose !== "chat") {
          throw new SecretsCorruptionError("invalid-profile-credential")
        }
        profileCredentials[canonicalName] = bound
      }
    }

    const legacyUnbound =
      value["legacyUnbound"] === undefined
        ? undefined
        : parseLegacyUnbound(value["legacyUnbound"])
    const qdrantApiKey =
      value["qdrantApiKey"] === undefined
        ? undefined
        : parseQdrantKey(value["qdrantApiKey"])
    return {
      status: "ok",
      payload: {
        version: 2,
        credentials,
        ...(Object.keys(profileCredentials).length > 0
          ? { profileCredentials }
          : {}),
        ...(legacyUnbound ? { legacyUnbound } : {}),
        ...(qdrantApiKey ? { qdrantApiKey } : {}),
      },
      migrated: false,
    }
  }

  const legacyUnbound = parseLegacyUnbound({
    model: value["model"],
    embeddings: value["embeddings"],
    profiles: value["profiles"],
  })
  const qdrantApiKey =
    value["qdrantApiKey"] === undefined
      ? undefined
      : parseQdrantKey(value["qdrantApiKey"])
  return {
    status: "ok",
    payload: {
      version: 2,
      credentials: {},
      ...(legacyUnbound ? { legacyUnbound } : {}),
      ...(qdrantApiKey ? { qdrantApiKey } : {}),
    },
    migrated: true,
  }
}

function parseBoundSecret(
  value: unknown,
  reason: "invalid-credential" | "invalid-profile-credential",
): NexusBoundSecret {
  if (!isBoundSecret(value)) {
    throw new SecretsCorruptionError(reason)
  }
  const provider = value.provider.trim()
  let destination: string
  try {
    destination = canonicalizeCredentialDestination(value.destination)
  } catch (error) {
    throw new SecretsCorruptionError(reason, error)
  }
  if (
    provider !== value.provider ||
    provider !== provider.toLowerCase() ||
    destination !== value.destination
  ) {
    throw new SecretsCorruptionError(reason)
  }
  return {
    purpose: value.purpose,
    provider,
    destination,
    secret: value.secret.trim(),
  }
}

function parseLegacyUnbound(value: unknown): NexusLegacyUnboundSecrets | undefined {
  if (!isRecord(value)) {
    throw new SecretsCorruptionError("invalid-legacy-payload")
  }
  for (const key of ["model", "embeddings"] as const) {
    if (
      value[key] !== undefined &&
      !isNonEmptyString(value[key])
    ) {
      throw new SecretsCorruptionError("invalid-legacy-payload")
    }
  }
  const profiles: Record<string, string> = {}
  if (value["profiles"] !== undefined) {
    if (!isRecord(value["profiles"])) {
      throw new SecretsCorruptionError("invalid-legacy-payload")
    }
    const canonicalNames = new Map<string, string>()
    for (const [name, secret] of Object.entries(value["profiles"])) {
      const canonicalName = canonicalProfileName(name)
      if (!canonicalName || !isNonEmptyString(secret)) {
        throw new SecretsCorruptionError("invalid-legacy-payload")
      }
      const previous = canonicalNames.get(canonicalName)
      if (previous !== undefined && previous !== name) {
        throw new SecretsCorruptionError("profile-name-collision")
      }
      canonicalNames.set(canonicalName, name)
      profiles[canonicalName] = secret.trim()
    }
  }
  const result: NexusLegacyUnboundSecrets = {
    ...(isNonEmptyString(value["model"])
      ? { model: value["model"].trim() }
      : {}),
    ...(isNonEmptyString(value["embeddings"])
      ? { embeddings: value["embeddings"].trim() }
      : {}),
    ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function parseQdrantKey(value: unknown): string {
  if (!isNonEmptyString(value)) {
    throw new SecretsCorruptionError("invalid-qdrant-key")
  }
  return value.trim()
}

async function readSecretsPayload(
  store: NexusSecretsStore,
): Promise<NexusSecretsPayload | undefined> {
  const raw = await store.getSecret(NEXUS_SECRETS_KEY)
  if (!raw?.trim()) return undefined
  const parsed = parseSecretsPayload(raw)
  if (parsed.status === "unsupported") {
    throw new UnsupportedSecretsVersionError(parsed.version)
  }
  return parsed.payload
}

function applyProviderEnvironmentSecret(
  target: Record<string, unknown>,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (isNonEmptyString(target["apiKey"])) return true
  const config = asProviderConfig(target)
  if (!config) return false
  try {
    const resolved = resolveProviderCredential(
      config,
      environment as NodeJS.ProcessEnv,
    )
    if (
      resolved.source === "environment" &&
      isNonEmptyString(resolved.apiKey)
    ) {
      target["apiKey"] = resolved.apiKey.trim()
      return true
    }
  } catch {
    // A missing/invalid ambient credential falls through to the bound store.
  }
  return false
}

function applyEmbeddingEnvironmentSecret(
  target: Record<string, unknown>,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (isNonEmptyString(target["apiKey"])) return true
  const config = asEmbeddingConfig(target)
  if (!config) return false
  try {
    const resolved = resolveEmbeddingCredential(
      config,
      environment as NodeJS.ProcessEnv,
    )
    if (
      resolved.source === "environment" &&
      isNonEmptyString(resolved.apiKey)
    ) {
      target["apiKey"] = resolved.apiKey.trim()
      return true
    }
  } catch {
    // A missing/invalid ambient credential falls through to the bound store.
  }
  return false
}

function applyBoundProviderSecret(
  target: Record<string, unknown>,
  payload: NexusSecretsPayload,
  profileName?: string,
): void {
  if (isNonEmptyString(target["apiKey"])) return
  const config = asProviderConfig(target)
  if (!config) return
  try {
    const identity = getProviderCredentialIdentity(config)
    const bound = profileName?.trim()
      ? payload.profileCredentials?.[profileName.trim()]
      : payload.credentials[credentialIdentityKey(identity)]
    if (bound && sameIdentity(bound, identity) && isNonEmptyString(bound.secret)) {
      target["apiKey"] = bound.secret.trim()
    }
  } catch {
    // Invalid destinations remain keyless and fail closed.
  }
}

function applyBoundEmbeddingSecret(
  target: Record<string, unknown>,
  payload: NexusSecretsPayload,
): void {
  if (isNonEmptyString(target["apiKey"])) return
  const config = asEmbeddingConfig(target)
  if (!config) return
  try {
    const identity = getEmbeddingCredentialIdentity(config)
    const bound = payload.credentials[credentialIdentityKey(identity)]
    if (bound && sameIdentity(bound, identity) && isNonEmptyString(bound.secret)) {
      target["apiKey"] = bound.secret.trim()
    }
  } catch {
    // Invalid destinations remain keyless and fail closed.
  }
}

function applySecretTombstones(
  payload: NexusSecretsPayload,
  config: Record<string, unknown>,
  removal: SecretsRemoval | undefined,
): void {
  if (!removal) return

  const modelTarget = removal.model === true
    ? asRecord(config["model"])
    : removal.model
      ? removal.model as unknown as Record<string, unknown>
      : null
  const modelConfig = modelTarget ? asProviderConfig(modelTarget) : null
  if (modelConfig) {
    try {
      const identity = getProviderCredentialIdentity(modelConfig)
      delete payload.credentials[credentialIdentityKey(identity)]
    } catch {
      // Invalid scopes cannot match a persisted bound credential.
    }
  }

  const embeddingTarget = removal.embeddings === true
    ? asRecord(config["embeddings"])
    : removal.embeddings
      ? removal.embeddings as unknown as Record<string, unknown>
      : null
  const embeddingConfig = embeddingTarget
    ? asEmbeddingConfig(embeddingTarget)
    : null
  if (embeddingConfig) {
    try {
      const identity = getEmbeddingCredentialIdentity(embeddingConfig)
      delete payload.credentials[credentialIdentityKey(identity)]
    } catch {
      // Invalid scopes cannot match a persisted bound credential.
    }
  }

  if (payload.profileCredentials) {
    for (const binding of removal.profileBindings ?? []) {
      const name = binding.name.trim()
      if (!name) continue
      const stored = payload.profileCredentials[name]
      if (!stored) continue
      try {
        const identity = getProviderCredentialIdentity(binding.model)
        if (sameIdentity(stored, identity)) {
          delete payload.profileCredentials[name]
        }
      } catch {
        // Invalid old scopes cannot match a persisted bound credential.
      }
    }
    for (const name of removal.profileNames ?? []) {
      if (name.trim()) delete payload.profileCredentials[name.trim()]
    }
  }
  if (removal.qdrant) delete payload.qdrantApiKey
}

const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "accesskeyid",
  "secretaccesskey",
  "sessiontoken",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "auth",
  "token",
  "bearertoken",
  "password",
  "clientsecret",
  "privatekey",
  "credential",
  "credentials",
])

const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "xapikey",
])

function sanitizeCredentialValue(
  value: unknown,
  parentKey?: string,
  preserveEmptyObject = false,
): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeCredentialValue(entry))
      .filter((entry) => entry !== undefined)
  }
  if (!isRecord(value)) return value

  const out: Record<string, unknown> = {}
  const inHeaders = normalizeSecretFieldName(parentKey) === "headers"
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeSecretFieldName(key)
    if (
      SECRET_FIELD_NAMES.has(normalized) ||
      (inHeaders && SECRET_HEADER_NAMES.has(normalized))
    ) {
      continue
    }
    const sanitized = sanitizeCredentialValue(entry, key)
    if (sanitized === undefined) continue
    out[key] = sanitized
  }
  return Object.keys(out).length > 0 || preserveEmptyObject
    ? out
    : undefined
}

function normalizeSecretFieldName(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]/g, "")
    : ""
}

function readSectionSecret(
  value: unknown,
  key: string,
): string | undefined {
  return nonEmpty(asRecord(value)?.[key])
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function addProviderCredential(
  payload: NexusSecretsPayload,
  value: Record<string, unknown>,
): void {
  const apiKey = value["apiKey"]
  const config = asProviderConfig(value)
  if (!config || !isNonEmptyString(apiKey)) return
  try {
    const identity = getProviderCredentialIdentity(config)
    payload.credentials[credentialIdentityKey(identity)] = {
      ...identity,
      secret: apiKey.trim(),
    }
  } catch {
    // Never persist an unbound provider secret as if it were safe.
  }
}

function addEmbeddingCredential(
  payload: NexusSecretsPayload,
  value: Record<string, unknown>,
): void {
  const apiKey = value["apiKey"]
  const config = asEmbeddingConfig(value)
  if (!config || !isNonEmptyString(apiKey)) return
  try {
    const identity = getEmbeddingCredentialIdentity(config)
    payload.credentials[credentialIdentityKey(identity)] = {
      ...identity,
      secret: apiKey.trim(),
    }
  } catch {
    // Never persist an unbound embedding secret as if it were safe.
  }
}

function addProfileCredential(
  payload: NexusSecretsPayload,
  name: string,
  config: ProviderConfig,
): void {
  const canonicalName = canonicalProfileName(name)
  if (!isNonEmptyString(config.apiKey) || !canonicalName) return
  try {
    const identity = getProviderCredentialIdentity(config)
    payload.profileCredentials ??= {}
    payload.profileCredentials[canonicalName] = {
      ...identity,
      secret: config.apiKey.trim(),
    }
  } catch {
    // Never persist an unbound profile secret as if it were safe.
  }
}

function canonicalProfileName(name: string): string {
  return name.trim()
}

function asProviderConfig(value: Record<string, unknown>): ProviderConfig | null {
  return isNonEmptyString(value["provider"]) && isNonEmptyString(value["id"])
    ? value as unknown as ProviderConfig
    : null
}

function asEmbeddingConfig(value: Record<string, unknown>): EmbeddingConfig | null {
  return isNonEmptyString(value["provider"]) && isNonEmptyString(value["model"])
    ? value as unknown as EmbeddingConfig
    : null
}

function sameIdentity(
  left: CredentialIdentity,
  right: CredentialIdentity,
): boolean {
  return (
    left.purpose === right.purpose &&
    left.provider === right.provider &&
    left.destination === right.destination
  )
}

function isBoundSecret(value: unknown): value is NexusBoundSecret {
  return (
    isRecord(value) &&
    (value["purpose"] === "chat" || value["purpose"] === "embeddings") &&
    isNonEmptyString(value["provider"]) &&
    isNonEmptyString(value["destination"]) &&
    isNonEmptyString(value["secret"])
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

function nonEmpty(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined
}

/**
 * File-based secrets store for CLI (single file with mode 0o600).
 * Path: {globalConfigDir}/secrets.json
 */
export function createFileSecretsStore(globalConfigDir: string): NexusSecretsStore {
  const secretsPath = path.join(globalConfigDir, "secrets.json")
  const FILE_MODE = 0o600

  const readStore = (): Record<string, string> => {
    if (!fs.existsSync(secretsPath)) return {}
    try {
      if (fs.lstatSync(secretsPath).isSymbolicLink()) {
        throw new Error("refusing to follow a symbolic-link credential store")
      }
      const value = JSON.parse(fs.readFileSync(secretsPath, "utf8")) as unknown
      if (!isRecord(value)) throw new Error("expected a JSON object")
      const entries = Object.entries(value)
      if (entries.some(([, entry]) => typeof entry !== "string")) {
        throw new Error("expected string credential values")
      }
      return Object.fromEntries(entries) as Record<string, string>
    } catch (error) {
      throw new Error(
        `Failed to read secrets: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const updateSecret: NonNullable<NexusSecretsStore["updateSecret"]> = async (
    key,
    update,
  ) => {
    try {
      await withFileLock(secretsPath, async () => {
        const data = readStore()
        const next = await update(data[key])
        if (next) {
          data[key] = next
        } else {
          delete data[key]
        }
        await atomicWriteFile(
          secretsPath,
          `${JSON.stringify(data, null, 2)}\n`,
          { mode: FILE_MODE },
        )
      })
    } catch (error) {
      if (
        error instanceof SecretsCorruptionError ||
        error instanceof UnsupportedSecretsVersionError ||
        error instanceof ProfileCredentialCollisionError
      ) {
        throw error
      }
      throw new Error(
        `Failed to update secrets: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
  }

  return {
    async getSecret(key: string): Promise<string | undefined> {
      return readStore()[key]
    },

    async setSecret(key: string, value: string): Promise<void> {
      await updateSecret(key, () => value || undefined)
    },

    updateSecret,
  }
}
