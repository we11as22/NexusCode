import * as fs from "node:fs"
import * as path from "node:path"
import {
  credentialIdentityKey,
  getEmbeddingCredentialIdentity,
  getProviderCredentialIdentity,
  mergeEmbeddingConfigSafely,
  mergeProviderConfigSafely,
  mergeProviderConfigPartialSafely,
  selectProviderProfile,
  type NexusConfig,
  type SecretsRemoval,
} from "@nexuscode/core"

export type ExplicitSettingReader = <T>(key: string) => T | undefined

export interface ConfigPersistencePartition {
  projectPatch: Record<string, unknown>
  globalPatch: Record<string, unknown>
}

export interface RepositoryAgentPreset {
  vector: boolean
  skills: string[]
  mcpServers: string[]
  rulesFiles: string[]
  modelProvider?: string
  modelId?: string
}

const HOST_PERMISSION_FIELDS = new Set([
  "autoApproveRead",
  "autoApproveWrite",
  "autoApproveCommand",
  "autoApproveMcp",
  "autoApproveBrowser",
  "autoApproveSkillLoad",
  "autoApproveReadPatterns",
  "allowedCommands",
  "allowCommandPatterns",
  "allowedMcpTools",
])

const NO_CONFIG_CHANGE = Symbol("no-config-change")

const MODEL_PROVIDERS = new Set<string>([
  "anthropic",
  "openai",
  "google",
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
  "perplexity",
  "minimax",
])

const EMBEDDING_PROVIDERS = new Set<NonNullable<NexusConfig["embeddings"]>["provider"]>([
  "openai",
  "openai-compatible",
  "openrouter",
  "ollama",
  "google",
  "mistral",
  "bedrock",
  "local",
])

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number > 0 ? Math.floor(number) : undefined
}

function configuredBoolean(
  read: ExplicitSettingReader,
  key: string,
): boolean | undefined {
  const value = read<boolean>(key)
  return typeof value === "boolean" ? value : undefined
}

/**
 * Merge only settings explicitly written at global/workspace/folder scope.
 *
 * VS Code contribution defaults are presentation defaults, not a second
 * configuration source: applying them would silently overwrite nexus.yaml on
 * every launch. Keeping this function independent of `vscode` makes the
 * precedence and validation rules executable in ordinary unit tests.
 */
export function applyExplicitConfigOverrides(
  config: NexusConfig,
  read: ExplicitSettingReader,
  readHostAuthority: ExplicitSettingReader = read,
): void {
  const providerValue = nonEmptyString(readHostAuthority<string>("provider"))
  const baseUrl = nonEmptyString(readHostAuthority<string>("baseUrl"))
  const modelPatch: Partial<NexusConfig["model"]> = {}
  if (providerValue === "openrouter") {
    modelPatch.provider = "openai-compatible"
    modelPatch.baseUrl = baseUrl ?? OPENROUTER_BASE_URL
  } else if (providerValue && MODEL_PROVIDERS.has(providerValue)) {
    modelPatch.provider = providerValue as NexusConfig["model"]["provider"]
    if (baseUrl) modelPatch.baseUrl = baseUrl
  } else if (baseUrl) {
    modelPatch.baseUrl = baseUrl
  }

  const model = nonEmptyString(read<string>("model"))
  if (model) modelPatch.id = model
  const temperature = finiteNumber(read<number>("temperature"))
  if (temperature !== undefined) {
    modelPatch.temperature = Math.max(0, Math.min(2, temperature))
  }
  const reasoningEffort = nonEmptyString(read<string>("reasoningEffort"))
  if (reasoningEffort) modelPatch.reasoningEffort = reasoningEffort
  const contextWindow = positiveInteger(read<number>("contextWindow"))
  if (contextWindow !== undefined) modelPatch.contextWindow = contextWindow
  if (Object.keys(modelPatch).length > 0) {
    config.model = mergeProviderConfigSafely(config.model, modelPatch)
  }

  const enableCheckpoints = configuredBoolean(read, "enableCheckpoints")
  if (enableCheckpoints !== undefined) config.checkpoint.enabled = enableCheckpoints
  const autoApproveRead = configuredBoolean(
    readHostAuthority,
    "autoApproveRead",
  )
  if (autoApproveRead !== undefined) config.permissions.autoApproveRead = autoApproveRead
  const autoApproveWrite = configuredBoolean(
    readHostAuthority,
    "autoApproveWrite",
  )
  if (autoApproveWrite !== undefined) config.permissions.autoApproveWrite = autoApproveWrite
  const autoApproveCommand = configuredBoolean(
    readHostAuthority,
    "autoApproveCommand",
  )
  if (autoApproveCommand !== undefined) config.permissions.autoApproveCommand = autoApproveCommand
  const autoApproveMcp = configuredBoolean(
    readHostAuthority,
    "autoApproveMcp",
  )
  if (autoApproveMcp !== undefined) config.permissions.autoApproveMcp = autoApproveMcp
  const autoApproveBrowser = configuredBoolean(
    readHostAuthority,
    "autoApproveBrowser",
  )
  if (autoApproveBrowser !== undefined) config.permissions.autoApproveBrowser = autoApproveBrowser

  const enableIndexing = configuredBoolean(read, "enableIndexing")
  if (enableIndexing !== undefined) config.indexing.enabled = enableIndexing
  const enableVectorIndex = configuredBoolean(read, "enableVectorIndex")
  if (enableVectorIndex !== undefined) config.indexing.vector = enableVectorIndex
  const embeddingBatchSize = positiveInteger(read<number>("embeddingBatchSize"))
  if (embeddingBatchSize !== undefined) config.indexing.embeddingBatchSize = embeddingBatchSize
  const embeddingConcurrency = positiveInteger(read<number>("embeddingConcurrency"))
  if (embeddingConcurrency !== undefined) config.indexing.embeddingConcurrency = embeddingConcurrency

  const enableVectorDb = configuredBoolean(read, "enableVectorDb")
  const vectorDbUrl = nonEmptyString(
    readHostAuthority<string>("vectorDbUrl"),
  )
  const vectorDbAutoStart = configuredBoolean(
    readHostAuthority,
    "vectorDbAutoStart",
  )
  if (
    !config.vectorDb &&
    (enableVectorDb !== undefined || vectorDbUrl || vectorDbAutoStart !== undefined)
  ) {
    config.vectorDb = {
      enabled: false,
      url: "http://127.0.0.1:6333",
      collection: "nexus",
      autoStart: vectorDbAutoStart === true,
    }
  }
  if (config.vectorDb && enableVectorDb !== undefined) config.vectorDb.enabled = enableVectorDb
  if (config.vectorDb && vectorDbUrl) config.vectorDb.url = vectorDbUrl
  if (config.vectorDb && vectorDbAutoStart !== undefined) config.vectorDb.autoStart = vectorDbAutoStart

  const embeddingProviderValue = nonEmptyString(
    readHostAuthority<string>("embeddingsProvider"),
  )
  const embeddingProvider =
    embeddingProviderValue && EMBEDDING_PROVIDERS.has(
      embeddingProviderValue as NonNullable<NexusConfig["embeddings"]>["provider"],
    )
      ? embeddingProviderValue as NonNullable<NexusConfig["embeddings"]>["provider"]
      : undefined
  const embeddingModel = nonEmptyString(read<string>("embeddingsModel"))
  if (!config.embeddings && embeddingProvider && (embeddingModel || embeddingProvider === "local")) {
    config.embeddings = {
      provider: embeddingProvider,
      model: embeddingModel ?? "feature-hashing-v1",
    }
  }
  const embeddingsBaseUrl = nonEmptyString(
    readHostAuthority<string>("embeddingsBaseUrl"),
  )
  const embeddingsDimensions = positiveInteger(read<number>("embeddingsDimensions"))
  if (config.embeddings) {
    const embeddingPatch: Partial<NonNullable<NexusConfig["embeddings"]>> = {}
    if (embeddingProvider) embeddingPatch.provider = embeddingProvider
    if (embeddingModel) embeddingPatch.model = embeddingModel
    if (embeddingsBaseUrl) embeddingPatch.baseUrl = embeddingsBaseUrl
    if (embeddingsDimensions !== undefined) {
      embeddingPatch.dimensions = embeddingsDimensions
    }
    if (Object.keys(embeddingPatch).length > 0) {
      config.embeddings = mergeEmbeddingConfigSafely(
        config.embeddings,
        embeddingPatch,
      )
    }
  }
}

/**
 * Apply a repository-owned, per-message preset without granting it host
 * authority. A preset may narrow already active MCP/path selections and choose
 * another model id inside the current endpoint, but it cannot switch provider,
 * retarget a URL, or introduce an external path.
 */
export function applyRepositoryAgentPreset(
  base: NexusConfig,
  preset: RepositoryAgentPreset,
  projectRoot: string,
): NexusConfig {
  const selectedServers = (base.mcp?.servers ?? []).filter((server) => {
    const name = typeof server.name === "string" ? server.name.trim() : ""
    return name.length > 0 && preset.mcpServers.includes(name)
  })
  const skills = selectRepositoryPaths(
    preset.skills,
    base.skills,
    projectRoot,
  )
  const selectedRules = selectRepositoryPaths(
    preset.rulesFiles,
    base.rules.files,
    projectRoot,
  )
  const rules = selectedRules.length > 0
    ? selectedRules
    : ["NEXUS.md", "AGENTS.md", "CLAUDE.md"]
  const next: NexusConfig = {
    ...base,
    indexing: { ...base.indexing, vector: preset.vector },
    skills,
    mcp: { ...base.mcp, servers: selectedServers },
    rules: { ...base.rules, files: rules },
  }

  const modelId = nonEmptyString(preset.modelId)
  if (
    modelId &&
    repositoryPresetProviderMatches(
      base.model,
      preset.modelProvider,
    )
  ) {
    next.model = mergeProviderConfigSafely(base.model, { id: modelId })
  }
  return next
}

function repositoryPresetProviderMatches(
  current: NexusConfig["model"],
  requested: string | undefined,
): boolean {
  const provider = nonEmptyString(requested)?.toLowerCase()
  if (!provider) return true
  if (provider === "openrouter") {
    return current.provider === "openai-compatible" &&
      normalizeEndpoint(current.baseUrl) === OPENROUTER_BASE_URL
  }
  return provider === current.provider
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  const normalized = nonEmptyString(value)
  return normalized?.replace(/\/+$/u, "")
}

function selectRepositoryPaths(
  requested: string[],
  hostSelected: string[],
  projectRoot: string,
): string[] {
  const trusted = new Set(
    hostSelected
      .map((value) => value.trim())
      .filter(Boolean),
  )
  const selected: string[] = []
  const seen = new Set<string>()
  for (const raw of requested) {
    const value = raw.trim()
    if (
      !value ||
      seen.has(value) ||
      (!trusted.has(value) && !isProjectContainedPath(value, projectRoot))
    ) {
      continue
    }
    seen.add(value)
    selected.push(value)
  }
  return selected
}

function isProjectContainedPath(
  configuredPath: string,
  projectRoot: string,
): boolean {
  if (configuredPath.startsWith("~")) return false
  const canonicalRoot = tryRealpath(projectRoot) ?? path.resolve(projectRoot)
  const prefix = nonGlobPrefix(configuredPath) || "."
  const candidate = path.isAbsolute(prefix)
    ? path.resolve(prefix)
    : path.resolve(canonicalRoot, prefix)
  if (!pathWithin(canonicalRoot, candidate)) return false
  const canonicalCandidate = tryRealpath(candidate)
  return canonicalCandidate
    ? pathWithin(canonicalRoot, canonicalCandidate)
    : true
}

function nonGlobPrefix(value: string): string {
  const globIndex = value.search(/[*?[\]{}()!]/u)
  return globIndex < 0 ? value : value.slice(0, globIndex)
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return !(
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  )
}

function tryRealpath(candidate: string): string | undefined {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return undefined
  }
}

/**
 * Save-path merge with replace semantics for credential-bearing sections.
 * Generic deep merge is safe for ordinary preferences but would leave omitted
 * apiKey/baseUrl fields behind after a provider switch.
 */
export function mergeConfigPatchSafely(
  current: NexusConfig,
  patch: Partial<NexusConfig>,
): NexusConfig {
  const next = deepMergeConfig(
    current as unknown as Record<string, unknown>,
    patch as unknown as Record<string, unknown>,
  ) as unknown as NexusConfig
  if (patch.model) {
    next.model = mergeProviderConfigSafely(current.model, patch.model)
  }
  if (patch.embeddings) {
    next.embeddings = current.embeddings
      ? mergeEmbeddingConfigSafely(current.embeddings, patch.embeddings)
      : { ...patch.embeddings }
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, "profiles") &&
    patch.profiles &&
    typeof patch.profiles === "object"
  ) {
    const profiles: NexusConfig["profiles"] = {}
    for (const [name, incoming] of Object.entries(patch.profiles)) {
      if (!incoming || typeof incoming !== "object") continue
      const currentProfile = current.profiles[name]
      profiles[name] = mergeProviderConfigPartialSafely(
        currentProfile ?? {},
        incoming,
      )
    }
    next.profiles = profiles
  }
  return next
}

/**
 * Determine which old secure-store bindings must be explicitly removed after
 * applying a save patch. Omitted redacted fields are not deletions; scope
 * changes and profile-map replacement are.
 */
export function getCredentialRemovalsForConfigPatch(
  current: NexusConfig,
  next: NexusConfig,
  patch: Partial<NexusConfig>,
): SecretsRemoval {
  const removal: SecretsRemoval = {}
  if (
    patch.model &&
    providerScopeKey(current.model) !== providerScopeKey(next.model)
  ) {
    removal.model = current.model
  }
  if (
    patch.embeddings &&
    current.embeddings &&
    next.embeddings &&
    embeddingScopeKey(current.embeddings) !==
      embeddingScopeKey(next.embeddings)
  ) {
    removal.embeddings = current.embeddings
  }

  const replacesProfiles =
    Object.prototype.hasOwnProperty.call(patch, "profiles") &&
    patch.profiles &&
    typeof patch.profiles === "object"
  if (patch.model || replacesProfiles) {
    const profileNames = new Set<string>()
    const profileBindings = new Map<
      string,
      NonNullable<SecretsRemoval["profileBindings"]>[number]
    >()
    for (const name of Object.keys(current.profiles)) {
      const oldProfile = current.profiles[name]
      const newProfile = next.profiles[name]
      if (!newProfile) {
        profileNames.add(name)
        continue
      }
      try {
        const oldResolved = selectProviderProfile(current.model, oldProfile ?? {})
        const newResolved = selectProviderProfile(next.model, newProfile)
        if (providerScopeKey(oldResolved) !== providerScopeKey(newResolved)) {
          profileBindings.set(name, {
            name,
            model: oldResolved,
          })
        }
      } catch {
        // Invalid or incomplete profile transitions fail closed.
        profileNames.add(name)
      }
    }
    if (profileBindings.size > 0) {
      removal.profileBindings = [...profileBindings.values()]
    }
    if (profileNames.size > 0) {
      removal.profileNames = [...profileNames]
    }
  }
  return removal
}

/**
 * Reduce a webview save payload to the fields the user actually changed, then
 * split repository preferences/restrictions from host-owned authority.
 *
 * The webview intentionally sends a complete settings form. Persisting that
 * object wholesale would materialize defaults, resolved substitutions and
 * global authority into `.nexus/nexus.yaml`.
 */
export function partitionConfigPatchForPersistence(
  current: NexusConfig,
  patch: Partial<NexusConfig>,
): ConfigPersistencePartition {
  const changed = diffConfigObject(
    current as unknown as Record<string, unknown>,
    patch as unknown as Record<string, unknown>,
  )
  const projectPatch: Record<string, unknown> = { ...changed }
  const globalPatch: Record<string, unknown> = {}

  delete projectPatch["profiles"]
  if (Object.prototype.hasOwnProperty.call(patch, "profiles")) {
    const currentProfiles = asPlainRecord(current.profiles)
    const nextProfiles = asPlainRecord(patch.profiles)
    if (currentProfiles && nextProfiles) {
      const profilePatch = diffCompleteConfigMap(
        currentProfiles,
        nextProfiles,
      )
      if (Object.keys(profilePatch).length > 0) {
        globalPatch["profiles"] = profilePatch
      }
    }
  }

  const skillsConfig = projectPatch["skillsConfig"]
  if (Array.isArray(skillsConfig)) {
    projectPatch["skills"] = skillsConfig.map((entry) => {
      const skill = entry as { path: string; enabled?: boolean }
      return skill.enabled === false
        ? { path: skill.path, enabled: false }
        : skill.path
    })
  }
  delete projectPatch["skillsConfig"]

  partitionPermissions(projectPatch, globalPatch)
  partitionModes(projectPatch, globalPatch)
  partitionPlugins(projectPatch, globalPatch)
  partitionMcp(projectPatch, globalPatch)

  return { projectPatch, globalPatch }
}

/**
 * Diff a replacement-style map while preserving tombstones for removed keys.
 * `patchGlobalConfig()` serializes `undefined` as deletion, so profile removal
 * participates in the same locked, atomic global-config update as every other
 * host-owned setting.
 */
function diffCompleteConfigMap(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {}
  for (const key of new Set([
    ...Object.keys(current),
    ...Object.keys(next),
  ])) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      changed[key] = undefined
      continue
    }
    const difference = diffConfigValue(current[key], next[key])
    if (difference !== NO_CONFIG_CHANGE) changed[key] = difference
  }
  return changed
}

function partitionPermissions(
  projectPatch: Record<string, unknown>,
  globalPatch: Record<string, unknown>,
): void {
  const permissions = asPlainRecord(projectPatch["permissions"])
  if (!permissions) return
  delete projectPatch["permissions"]
  const projectPermissions: Record<string, unknown> = {}
  const globalPermissions: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(permissions)) {
    if (key === "rules" && Array.isArray(value)) {
      const hostRules = value.filter(
        (rule) => asPlainRecord(rule)?.["action"] === "allow",
      )
      const projectRules = value.filter((rule) => {
        const action = asPlainRecord(rule)?.["action"]
        return action === "deny" || action === "ask"
      })
      if (hostRules.length > 0) globalPermissions[key] = hostRules
      if (projectRules.length > 0) projectPermissions[key] = projectRules
    } else if (HOST_PERMISSION_FIELDS.has(key)) {
      globalPermissions[key] = value
    } else {
      projectPermissions[key] = value
    }
  }

  if (Object.keys(projectPermissions).length > 0) {
    projectPatch["permissions"] = projectPermissions
  }
  if (Object.keys(globalPermissions).length > 0) {
    globalPatch["permissions"] = globalPermissions
  }
}

function partitionModes(
  projectPatch: Record<string, unknown>,
  globalPatch: Record<string, unknown>,
): void {
  const modes = asPlainRecord(projectPatch["modes"])
  if (!modes) return
  delete projectPatch["modes"]
  const projectModes: Record<string, unknown> = {}
  const globalModes: Record<string, unknown> = {}

  for (const [modeName, value] of Object.entries(modes)) {
    const mode = asPlainRecord(value)
    if (!mode) continue
    const { autoApprove, ...projectMode } = mode
    if (autoApprove !== undefined) {
      globalModes[modeName] = { autoApprove }
    }
    if (Object.keys(projectMode).length > 0) {
      projectModes[modeName] = projectMode
    }
  }

  if (Object.keys(projectModes).length > 0) projectPatch["modes"] = projectModes
  if (Object.keys(globalModes).length > 0) globalPatch["modes"] = globalModes
}

function partitionPlugins(
  projectPatch: Record<string, unknown>,
  globalPatch: Record<string, unknown>,
): void {
  const plugins = asPlainRecord(projectPatch["plugins"])
  if (!plugins) return
  delete projectPatch["plugins"]
  const projectPlugins: Record<string, unknown> = {}
  const globalPlugins: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(plugins)) {
    if (key === "blocked") projectPlugins[key] = value
    else globalPlugins[key] = value
  }
  if (Object.keys(projectPlugins).length > 0) {
    projectPatch["plugins"] = projectPlugins
  }
  if (Object.keys(globalPlugins).length > 0) {
    globalPatch["plugins"] = globalPlugins
  }
}

function partitionMcp(
  projectPatch: Record<string, unknown>,
  globalPatch: Record<string, unknown>,
): void {
  const mcp = asPlainRecord(projectPatch["mcp"])
  if (!mcp) return
  delete projectPatch["mcp"]
  if (Object.prototype.hasOwnProperty.call(mcp, "servers")) {
    globalPatch["mcp"] = { servers: mcp["servers"] }
  }
}

function diffConfigObject(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {}
  for (const [key, patchValue] of Object.entries(patch)) {
    const difference = diffConfigValue(current[key], patchValue)
    if (difference !== NO_CONFIG_CHANGE) changed[key] = difference
  }
  return changed
}

function diffConfigValue(
  current: unknown,
  patch: unknown,
): unknown | typeof NO_CONFIG_CHANGE {
  if (Object.is(current, patch)) return NO_CONFIG_CHANGE
  if (Array.isArray(current) && Array.isArray(patch)) {
    if (
      current.length === patch.length &&
      current.every(
        (value, index) =>
          diffConfigValue(value, patch[index]) === NO_CONFIG_CHANGE,
      )
    ) {
      return NO_CONFIG_CHANGE
    }
    return cloneConfigValue(patch)
  }
  const currentRecord = asPlainRecord(current)
  const patchRecord = asPlainRecord(patch)
  if (currentRecord && patchRecord) {
    const nested = diffConfigObject(currentRecord, patchRecord)
    return Object.keys(nested).length > 0 ? nested : NO_CONFIG_CHANGE
  }
  return cloneConfigValue(patch)
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneConfigValue)
  const record = asPlainRecord(value)
  if (!record) return value
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      cloneConfigValue(entry),
    ]),
  )
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function providerScopeKey(
  config: NexusConfig["model"],
): string {
  try {
    return credentialIdentityKey(getProviderCredentialIdentity(config))
  } catch {
    return JSON.stringify([
      config.provider,
      config.baseUrl ?? "",
      config.resourceName ?? "",
      config.extra?.["region"] ?? "",
    ])
  }
}

function embeddingScopeKey(
  config: NonNullable<NexusConfig["embeddings"]>,
): string {
  try {
    return credentialIdentityKey(getEmbeddingCredentialIdentity(config))
  } catch {
    return JSON.stringify([
      config.provider,
      config.baseUrl ?? "",
      config.region ?? "",
    ])
  }
}

function deepMergeConfig(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    const previous = next[key]
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      previous &&
      typeof previous === "object" &&
      !Array.isArray(previous)
    ) {
      next[key] = deepMergeConfig(
        previous as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    } else if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}
