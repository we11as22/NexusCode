import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { NexusConfigSchema, type NexusConfigInput } from "./schema.js"
import type { McpServerConfig, NexusConfig } from "../types.js"
import type { EmbeddingConfig, ProviderConfig, ProviderName } from "../types.js"
import type { ClaudeCompatibilityOptions } from "../compat/claude.js"
import {
  canonicalizeCredentialDestination,
  mergeEmbeddingConfigSafely,
  mergeProviderConfigSafely,
  mergeProviderConfigPartialSafely,
} from "../provider/credential-identity.js"
import {
  stripSecretsFromConfig,
  stripProfileSecrets,
  type NexusSecretsStore,
} from "./secrets.js"
import {
  ConfigFileError,
  ConfigSubstitutionError,
  loadScopedEnvironment,
  patchRawConfigFile,
  readConfigLayerFile,
  readRawConfigFile,
  writeAtomicTextFileSync,
  writeRawConfigFileSync,
} from "./layered-io.js"
import {
  createPendingProjectAuthorityRequest,
  getPendingProjectAuthorityRequests,
  partitionProjectAuthority,
  type ProjectAuthorityPayloadByKind,
} from "./project-authority.js"

const CONFIG_FILE_NAMES = [".nexus/nexus.yaml", ".nexus/nexus.yml", ".nexusrc.yaml", ".nexusrc.yml"]
const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".nexus")
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, "nexus.yaml")
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
const DEFAULT_FREE_MODELS_BASE_URL = "https://api.kilo.ai/api/openrouter"
const EFFECTIVE_CONFIG_MARKER = Symbol("nexus.effective-config")
const SCOPED_ENVIRONMENT_MARKER = Symbol.for(
  "@nexuscode/config/scoped-environment",
)

type MarkedEffectiveConfig = NexusConfig & {
  [EFFECTIVE_CONFIG_MARKER]?: true
  [SCOPED_ENVIRONMENT_MARKER]?: Readonly<
    Record<string, string | undefined>
  >
}

export class UnsafeConfigWriteError extends Error {
  constructor() {
    super(
      "Refusing to write a resolved/effective config. Use patchProjectConfig() with an explicit raw project-layer patch.",
    )
    this.name = "UnsafeConfigWriteError"
  }
}

export class ConfigValidationError extends Error {
  readonly issues: readonly {
    path: readonly (string | number)[]
    message: string
  }[]

  constructor(
    readonly sources: readonly string[],
    issues: readonly {
      path: readonly (string | number)[]
      message: string
    }[],
  ) {
    super(
      `Config validation failed${
        sources.length > 0 ? ` (${sources.join(", ")})` : ""
      }: ${issues
        .map((issue) =>
          `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`,
        )
        .join("; ")}`,
    )
    this.name = "ConfigValidationError"
    this.issues = issues
  }
}

function readMcpServersFromJsonFile(
  filePath: string,
  workspaceRoot?: string,
): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return []
  try {
    const canonicalPath = fs.realpathSync(filePath)
    if (workspaceRoot) {
      const canonicalRoot = fs.realpathSync(workspaceRoot)
      const relative = path.relative(canonicalRoot, canonicalPath)
      if (
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      ) {
        throw new ConfigFileError(
          filePath,
          "project MCP config resolves outside the canonical workspace",
        )
      }
    }
    const mcpData = JSON.parse(fs.readFileSync(canonicalPath, "utf8")) as unknown
    const servers = Array.isArray(mcpData)
      ? mcpData
      : (mcpData as { servers?: unknown; mcp?: { servers?: unknown } })?.servers ??
        (mcpData as { mcp?: { servers?: unknown } })?.mcp?.servers
    if (!Array.isArray(servers)) {
      throw new ConfigFileError(
        filePath,
        "MCP config must contain a server array",
      )
    }
    if (
      servers.some(
        (server) =>
          server === null ||
          typeof server !== "object" ||
          Array.isArray(server),
      )
    ) {
      throw new ConfigFileError(
        filePath,
        "MCP server entries must be objects",
      )
    }
    return servers as Record<string, unknown>[]
  } catch (error) {
    if (error instanceof ConfigFileError) throw error
    throw new ConfigFileError(filePath, "MCP config is malformed", error)
  }
}

/** Later layers override earlier by `name`. */
function mergeMcpServerLayers(...layers: Record<string, unknown>[][]): Record<string, unknown>[] {
  const byName = new Map<string, Record<string, unknown>>()
  for (const layer of layers) {
    for (const s of layer) {
      const name = typeof s.name === "string" ? s.name.trim() : ""
      if (name) byName.set(name, s)
    }
  }
  return [...byName.values()]
}

export interface PendingProjectMcpServer {
  source: "project"
  origin: "project-config" | "project-mcp-json"
  status: "pending"
  config: McpServerConfig
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry),
      )
    : []
}

function asPendingProjectMcpServers(
  value: unknown,
): PendingProjectMcpServer[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is PendingProjectMcpServer =>
      asRecord(entry)?.["source"] === "project" &&
      (
        asRecord(entry)?.["origin"] === "project-config" ||
        asRecord(entry)?.["origin"] === "project-mcp-json"
      ) &&
      asRecord(entry)?.["status"] === "pending" &&
      asRecord(asRecord(entry)?.["config"]) !== null,
  )
}

function mergePendingProjectMcpServers(
  ...layers: PendingProjectMcpServer[][]
): PendingProjectMcpServer[] {
  const byName = new Map<string, PendingProjectMcpServer>()
  for (const layer of layers) {
    for (const request of layer) {
      const name =
        typeof request.config["name"] === "string"
          ? request.config["name"].trim()
          : ""
      if (name) byName.set(name, request)
    }
  }
  return [...byName.values()]
}

export function getPendingProjectMcpServers(
  config: NexusConfig,
): readonly PendingProjectMcpServer[] {
  const mcp = config.mcp as unknown as Record<string, unknown>
  return asPendingProjectMcpServers(mcp["pendingProjectServers"])
}

/**
 * Load config by walking up from cwd.
 * Merges project config over global config.
 * Applies non-secret environment selection overrides. Secure-store credentials
 * are deliberately resolved later by the host, after its final selection.
 */
export async function loadConfig(
  cwd?: string,
  options?: {
    /** @deprecated Secure credentials are finalized by the host. */
    secrets?: NexusSecretsStore
    /**
     * Remote hosts set false to load metadata without consulting the local
     * environment or resolving `{env:...}` / `{file:...}` substitutions.
     */
    loadEnv?: boolean
    /**
     * Override the global config path for embedded hosts/tests. `false`
     * explicitly disables the global layer.
     */
    globalConfigPath?: string | false
  }
): Promise<NexusConfig> {
  const startDir = path.resolve(cwd ?? process.cwd())
  const useLocalEnvironment = options?.loadEnv !== false
  const ambientEnvironment = Object.freeze({ ...process.env })
  const scopedEnvironment = useLocalEnvironment
    ? loadScopedEnvironment(startDir, ambientEnvironment)
    : ambientEnvironment

  // 1. Load global config
  const globalConfigPath =
    options?.globalConfigPath === false
      ? null
      : options?.globalConfigPath ?? GLOBAL_CONFIG_PATH
  const globalRaw = globalConfigPath
    ? readConfigLayerFile(globalConfigPath, {
        layer: "global",
        resolveExternalValues: useLocalEnvironment,
        environment: ambientEnvironment,
      })
    : null

  // 2. Walk up and find project config
  let projectRaw: NexusConfigInput | null = null
  let projectDir: string | null = null
  let projectConfigPath: string | null = null
  let dir = startDir
  let maxUp = 20
  while (maxUp-- > 0) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) {
        projectRaw = readConfigLayerFile(candidate, {
          layer: "project",
          resolveExternalValues: useLocalEnvironment,
          environment: scopedEnvironment,
          workspaceRoot: dir,
        })
        projectDir = dir
        projectConfigPath = candidate
        break
      }
    }
    if (projectRaw) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // 3. Merge global + project
  let merged: Record<string, unknown>
  try {
    merged = mergeNexusConfigLayers(
      globalRaw ?? {},
      projectRaw ?? {},
      { projectRoot: projectDir ?? undefined },
    )
  } catch (error) {
    const issues = (
      error &&
      typeof error === "object" &&
      Array.isArray((error as { issues?: unknown }).issues)
    )
      ? (error as {
          issues: Array<{
            path?: Array<string | number>
            message?: string
          }>
        }).issues
      : null
    if (issues) {
      throw new ConfigValidationError(
        [globalRaw === null ? null : globalConfigPath, projectConfigPath]
          .filter((source): source is string => source !== null),
        issues.map((issue) => ({
          path: issue.path ?? [],
          message: issue.message ?? "Invalid project authority request",
        })),
      )
    }
    throw error
  }

  // 3b. Global MCP definitions are trusted configuration. Project definitions
  // are retained as pending requests and never enter the auto-start list.
  const mergedMcp = asRecord(merged.mcp) ?? {}
  const yamlServers = asRecordArray(mergedMcp["servers"])
  const yamlPendingServers = asPendingProjectMcpServers(
    mergedMcp["pendingProjectServers"],
  )
  const globalMcpPath = globalConfigPath
    ? path.join(path.dirname(globalConfigPath), "mcp-servers.json")
    : null
  const globalServers = globalMcpPath
    ? readMcpServersFromJsonFile(globalMcpPath)
    : []
  const projectMcpPath = projectDir ? path.join(projectDir, ".nexus", "mcp-servers.json") : ""
  const projectServers = projectMcpPath
    ? readMcpServersFromJsonFile(projectMcpPath, projectDir ?? undefined)
    : []
  const mergedMcpServers = mergeMcpServerLayers(yamlServers, globalServers)
  const pendingProjectServers = mergePendingProjectMcpServers(
    yamlPendingServers,
    projectServers.map((config) => ({
      source: "project" as const,
      origin: "project-mcp-json" as const,
      status: "pending" as const,
      config: config as unknown as McpServerConfig,
    })),
  )
  ;(merged as Record<string, unknown>).mcp = {
    ...mergedMcp,
    servers: mergedMcpServers,
    pendingProjectServers,
  }

  // 4. Apply env overrides
  if (useLocalEnvironment) {
    applyEnvOverrides(merged, scopedEnvironment, ambientEnvironment)
  }
  normalizeProviderAliases(
    merged,
    useLocalEnvironment ? scopedEnvironment : undefined,
  )
  const sanitized = stripSecretsFromConfig(merged)

  // 5. Parse a completely non-secret configuration.
  const result = NexusConfigSchema.safeParse(sanitized)
  if (!result.success) {
    throw new ConfigValidationError(
      [globalRaw === null ? null : globalConfigPath, projectConfigPath].filter(
        (source): source is string => source !== null,
      ),
      result.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    )
  }

  return markEffectiveConfig(
    normalizeToNexusConfig(result.data as Record<string, unknown>),
    useLocalEnvironment ? scopedEnvironment : Object.freeze({}),
  )
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
  const parsedMcp =
    (parsed.mcp as NexusConfig["mcp"]) ?? { servers: [] }
  const activeMcpFingerprints = new Set(
    parsedMcp.servers.map((server) => stableConfigValue(server)),
  )
  const pendingProjectServers = (
    parsedMcp.pendingProjectServers ?? []
  ).filter(
    (pending) =>
      !activeMcpFingerprints.has(stableConfigValue(pending.config)),
  )
  return {
    ...parsed,
    skillsConfig,
    skills,
    mcp: {
      ...parsedMcp,
      pendingProjectServers,
    },
  } as unknown as NexusConfig
}

function stableConfigValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableConfigValue).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableConfigValue(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function markEffectiveConfig(
  config: NexusConfig,
  scopedEnvironment?: Readonly<Record<string, string | undefined>>,
): NexusConfig {
  Object.defineProperty(config, EFFECTIVE_CONFIG_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  })
  if (scopedEnvironment) {
    Object.defineProperty(config, SCOPED_ENVIRONMENT_MARKER, {
      configurable: false,
      enumerable: false,
      value: scopedEnvironment,
      writable: false,
    })
  }
  return config
}

export function getConfigEnvironment(
  config: NexusConfig,
): Readonly<Record<string, string | undefined>> | undefined {
  return (config as MarkedEffectiveConfig)[SCOPED_ENVIRONMENT_MARKER]
}

function assertRawConfigWrite(config: Record<string, unknown>): void {
  const marked = (config as unknown as MarkedEffectiveConfig)[
    EFFECTIVE_CONFIG_MARKER
  ]
  // `skillsConfig` is a runtime-only derived field added by loadConfig. The
  // structural check deliberately survives object spread and structuredClone,
  // both of which may discard the non-enumerable symbol marker.
  const normalizedEffectiveFields = [
    "modes",
    "indexing",
    "permissions",
    "retry",
    "checkpoint",
    "mcp",
    "skills",
    "tools",
    "summarization",
    "parallelAgents",
  ]
  const looksLikeNormalizedEffectiveConfig = normalizedEffectiveFields.every(
    (field) => Object.prototype.hasOwnProperty.call(config, field),
  )
  if (
    marked === true ||
    Object.prototype.hasOwnProperty.call(config, "skillsConfig") ||
    looksLikeNormalizedEffectiveConfig
  ) {
    throw new UnsafeConfigWriteError()
  }
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
  minimax:      ["MINIMAX_MODEL"],
}

function applyEnvOverrides(
  config: Record<string, unknown>,
  environment: Readonly<Record<string, string | undefined>>,
  hostEnvironment: Readonly<Record<string, string | undefined>>,
) {
  if (!config.model || typeof config.model !== "object") config.model = {}
  const model = config.model as Record<string, unknown>

  // When nothing is configured in project (and no global model), use same defaults as schema
  // so we can fill apiKey from env (OPENROUTER_API_KEY etc.) — like OpenCode/KiloCode "works out of the box"
  if (!isNonEmptyString(model["provider"]) && !isNonEmptyString(model["id"])) {
    model["provider"] = "openai-compatible"
    model["id"] = "minimax/minimax-m2.5:free"
    model["baseUrl"] = DEFAULT_FREE_MODELS_BASE_URL
  }

  // Provider-specific model from env (e.g. OPENROUTER_MODEL=qwen/qwen3-coder-next)
  if (!model["id"] || model["id"] === "") {
    const provider = String(model["provider"] ?? "")
    const envVars = modelEnvironmentKeys(provider, model["baseUrl"])
    for (const envVar of envVars) {
      const v = environment[envVar]
      if (v) { model["id"] = v; break }
    }
    if (
      !isNonEmptyString(model["id"]) &&
      provider === "openai-compatible" &&
      isKiloBaseUrl(model["baseUrl"])
    ) {
      model["id"] = "minimax/minimax-m2.5:free"
    }
  }

  // NEXUS_MODEL override: provider/model-name or just model-name
  const nexusModel = environment["NEXUS_MODEL"]
  if (nexusModel) {
    const slashIdx = nexusModel.indexOf("/")
    if (slashIdx > 0) {
      const requestedProvider = nexusModel.slice(0, slashIdx)
      const id = nexusModel.slice(slashIdx + 1)
      if (environmentValueComesFromProject(
        "NEXUS_MODEL",
        environment,
        hostEnvironment,
      )) {
        model["id"] = id
        const endpoint =
          requestedProvider === "openrouter"
            ? {
                provider: "openai-compatible" as const,
                baseUrl: OPENROUTER_BASE_URL,
              }
            : { provider: requestedProvider as ProviderName }
        replacePendingModelEndpoint(config, endpoint)
      } else {
        replaceModelSelection(config, {
          provider: requestedProvider as ProviderName,
          id,
        })
      }
    } else {
      model["id"] = nexusModel
    }
  }

  // NEXUS_BASE_URL override
  if (environment["NEXUS_BASE_URL"]) {
    if (environmentValueComesFromProject(
      "NEXUS_BASE_URL",
      environment,
      hostEnvironment,
    )) {
      replacePendingModelEndpoint(config, {
        baseUrl: environment["NEXUS_BASE_URL"],
      })
    } else {
      replaceModelSelection(config, {
        baseUrl: environment["NEXUS_BASE_URL"],
      })
    }
  }

  // NEXUS_TEMPERATURE override
  const tempRaw = environment["NEXUS_TEMPERATURE"]
  if (tempRaw) {
    const t = Number(tempRaw)
    if (Number.isFinite(t) && t >= 0 && t <= 2) {
      const effectiveModel = asRecord(config["model"])
      if (effectiveModel) effectiveModel["temperature"] = t
    }
  }

  // NEXUS_MAX_MODE / NEXUS_MAX_TOKEN_MULTIPLIER removed (max mode feature removed)
}

function environmentValueComesFromProject(
  key: string,
  effective: Readonly<Record<string, string | undefined>>,
  host: Readonly<Record<string, string | undefined>>,
): boolean {
  return effective[key] !== undefined && effective[key] !== host[key]
}

function replacePendingModelEndpoint(
  config: Record<string, unknown>,
  patch: ProjectAuthorityPayloadByKind["model-endpoint"]["model"],
): void {
  const pending = Array.isArray(config["pendingProjectAuthority"])
    ? config["pendingProjectAuthority"]
    : []
  const existing = pending.find(
    (entry) =>
      asRecord(entry)?.["kind"] === "model-endpoint",
  )
  const existingModel = asRecord(asRecord(existing)?.["payload"])?.["model"]
  const previous = asRecord(existingModel) ?? {}
  const providerChanged =
    patch.provider !== undefined &&
    patch.provider !== previous["provider"]
  const nextModel = providerChanged
    ? { provider: patch.provider }
    : { ...previous }
  Object.assign(nextModel, patch)
  const request = createPendingProjectAuthorityRequest(
    "model-endpoint",
    { model: nextModel },
  )
  config["pendingProjectAuthority"] = [
    ...pending.filter(
      (entry) => asRecord(entry)?.["kind"] !== "model-endpoint",
    ),
    request,
  ]
}

function normalizeProviderAliases(
  config: Record<string, unknown>,
  environment?: Readonly<Record<string, string | undefined>>,
): void {
  const model = asRecord(config["model"])
  if (model) {
    const provider = String(model["provider"] ?? "")
    if (provider === "openrouter") {
      model["provider"] = "openai-compatible"
      if (!isNonEmptyString(model["baseUrl"])) model["baseUrl"] = OPENROUTER_BASE_URL
      if (
        environment &&
        !isNonEmptyString(model["id"]) &&
        environment["OPENROUTER_MODEL"]
      ) {
        model["id"] = environment["OPENROUTER_MODEL"]
      }
    }

    if (provider === "openai-compatible" && isOpenRouterBaseUrl(model["baseUrl"])) {
      if (
        environment &&
        !isNonEmptyString(model["id"]) &&
        environment["OPENROUTER_MODEL"]
      ) {
        model["id"] = environment["OPENROUTER_MODEL"]
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
      replaceModelSelection(config, { baseUrl: DEFAULT_FREE_MODELS_BASE_URL })
    }
  }

  const embeddings = asRecord(config["embeddings"])
  if (embeddings) {
    if (String(embeddings["provider"] ?? "") === "openrouter") {
      if (!isNonEmptyString(embeddings["baseUrl"])) embeddings["baseUrl"] = OPENROUTER_BASE_URL
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
  try {
    return canonicalizeCredentialDestination(value) === OPENROUTER_BASE_URL
  } catch {
    return false
  }
}

function isKiloBaseUrl(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false
  try {
    const url = new URL(canonicalizeCredentialDestination(value))
    return (
      url.protocol === "https:" &&
      url.hostname === "api.kilo.ai" &&
      (
        url.pathname === "/api/openrouter" ||
        url.pathname.startsWith("/api/organizations/")
      )
    )
  } catch {
    return false
  }
}

function modelEnvironmentKeys(
  provider: string,
  baseUrl: unknown,
): string[] {
  if (provider === "openai-compatible") {
    if (isKiloBaseUrl(baseUrl)) return ["KILO_MODEL"]
    if (isOpenRouterBaseUrl(baseUrl)) return ["OPENROUTER_MODEL"]
    if (isNonEmptyString(baseUrl)) {
      try {
        if (
          canonicalizeCredentialDestination(baseUrl) ===
          "https://api.openai.com/v1"
        ) {
          return ["OPENAI_MODEL"]
        }
      } catch {
        return []
      }
    }
    return []
  }
  return PROVIDER_MODEL_ENV[provider] ?? []
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

const PROJECT_PERMISSION_GRANT_KEYS = new Set([
  "allowedCommands",
  "allowCommandPatterns",
  "allowedMcpTools",
])

function neutralizeProjectAuthority(
  project: Record<string, unknown>,
  options: {
    projectRoot?: string
    hostAllowsClaudeGlobalDirectory?: boolean
  } = {},
): Record<string, unknown> {
  const partitioned = partitionProjectAuthority(
    stripSecretsFromConfig(deepMerge({}, project)),
    options,
  )
  const safe = partitioned.safeProject
  safe["pendingProjectAuthority"] = partitioned.pending

  const permissions = asRecord(safe["permissions"])
  if (permissions) {
    for (const key of Object.keys(permissions)) {
      const value = permissions[key]
      const isExplicitRestriction =
        value === false || (Array.isArray(value) && value.length === 0)
      if (
        (key.startsWith("autoApprove") ||
          PROJECT_PERMISSION_GRANT_KEYS.has(key)) &&
        !isExplicitRestriction
      ) {
        delete permissions[key]
      }
    }
    if (Array.isArray(permissions["rules"])) {
      permissions["rules"] = permissions["rules"].filter((rule) => {
        const action = asRecord(rule)?.["action"]
        return action === "deny" || action === "ask"
      })
    }
  }

  const modes = asRecord(safe["modes"])
  if (modes) {
    for (const value of Object.values(modes)) {
      const mode = asRecord(value)
      if (
        mode &&
        Array.isArray(mode["autoApprove"]) &&
        mode["autoApprove"].length > 0
      ) {
        delete mode["autoApprove"]
      }
    }
  }

  const plugins = asRecord(safe["plugins"])
  if (
    plugins &&
    Array.isArray(plugins["trusted"]) &&
    plugins["trusted"].length > 0
  ) {
    delete plugins["trusted"]
  }
  if (plugins?.["enabled"] === true) {
    delete plugins["enabled"]
  }
  if (plugins?.["enableHooks"] === true) {
    delete plugins["enableHooks"]
  }

  const mcp = asRecord(safe["mcp"])
  if (mcp) {
    const projectServers = asRecordArray(mcp["servers"])
    delete mcp["servers"]
    delete mcp["pendingProjectServers"]
    mcp["pendingProjectServers"] = projectServers.map((config) => ({
      source: "project",
      origin: "project-config",
      status: "pending",
      config,
    }))
  }

  return safe
}

function mergeUniqueArrayValues(
  base: unknown,
  project: unknown,
): unknown[] {
  const combined = [
    ...(Array.isArray(base) ? base : []),
    ...(Array.isArray(project) ? project : []),
  ]
  return [...new Set(combined)]
}

function mergeProjectRestrictions(
  result: Record<string, unknown>,
  base: Record<string, unknown>,
  project: Record<string, unknown>,
): void {
  const resultPermissions = asRecord(result["permissions"])
  const basePermissions = asRecord(base["permissions"])
  const projectPermissions = asRecord(project["permissions"])
  if (resultPermissions && (basePermissions || projectPermissions)) {
    for (const key of [
      "denyCommandPatterns",
      "askCommandPatterns",
      "denyPatterns",
    ]) {
      if (
        Array.isArray(basePermissions?.[key]) ||
        Array.isArray(projectPermissions?.[key])
      ) {
        resultPermissions[key] = mergeUniqueArrayValues(
          basePermissions?.[key],
          projectPermissions?.[key],
        )
      }
    }
    if (
      Array.isArray(basePermissions?.["rules"]) ||
      Array.isArray(projectPermissions?.["rules"])
    ) {
      const markAuthority = (
        rules: unknown,
        authority: "host" | "project",
      ): unknown[] => (
        Array.isArray(rules)
          ? rules.map((rule) => {
              const record = asRecord(rule)
              return record ? { ...record, authority } : rule
            })
          : []
      )
      resultPermissions["rules"] = [
        ...markAuthority(projectPermissions?.["rules"], "project"),
        ...markAuthority(basePermissions?.["rules"], "host"),
      ]
    }
  }

  const resultPlugins = asRecord(result["plugins"])
  const basePlugins = asRecord(base["plugins"])
  const projectPlugins = asRecord(project["plugins"])
  if (
    resultPlugins &&
    (Array.isArray(basePlugins?.["blocked"]) ||
      Array.isArray(projectPlugins?.["blocked"]))
  ) {
    resultPlugins["blocked"] = mergeUniqueArrayValues(
      basePlugins?.["blocked"],
      projectPlugins?.["blocked"],
    )
  }
}

/**
 * Merge config layers without allowing a secret or provider-specific field to
 * hitchhike when the higher layer changes provider or destination.
 */
export function mergeNexusConfigLayers(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
  options: { projectRoot?: string } = {},
): Record<string, unknown> {
  const trustedBase = deepMerge({}, base)
  if (!asProviderConfig(trustedBase["model"])) {
    trustedBase["model"] = {
      provider: "openai-compatible",
      id: "minimax/minimax-m2.5:free",
      baseUrl: DEFAULT_FREE_MODELS_BASE_URL,
    }
  }
  const trustedClaude = asRecord(
    asRecord(trustedBase["compatibility"])?.["claude"],
  )
  const safeOverride = neutralizeProjectAuthority(override, {
    ...options,
    hostAllowsClaudeGlobalDirectory:
      trustedClaude?.["enabled"] === true &&
      trustedClaude["includeGlobalDir"] !== false,
  })
  const result = deepMerge(trustedBase, safeOverride)
  const trustedVectorDb = asRecord(trustedBase["vectorDb"])
  const resultVectorDb = asRecord(result["vectorDb"])
  if (
    !trustedVectorDb &&
    resultVectorDb &&
    !Object.prototype.hasOwnProperty.call(resultVectorDb, "autoStart")
  ) {
    resultVectorDb["autoStart"] = false
  }
  mergeProjectRestrictions(result, trustedBase, safeOverride)
  const baseModel = asProviderConfig(trustedBase["model"])
  const modelPatch = asRecord(safeOverride["model"])
  if (baseModel && modelPatch) {
    result["model"] = mergeProviderConfigSafely(
      baseModel,
      modelPatch as Partial<ProviderConfig>,
    ) as unknown as Record<string, unknown>
  }

  const baseEmbeddings = asEmbeddingConfig(trustedBase["embeddings"])
  const embeddingPatch = asRecord(safeOverride["embeddings"])
  if (baseEmbeddings && embeddingPatch) {
    result["embeddings"] = mergeEmbeddingConfigSafely(
      baseEmbeddings,
      embeddingPatch as Partial<EmbeddingConfig>,
    ) as unknown as Record<string, unknown>
  }

  const baseProfiles = asRecord(trustedBase["profiles"])
  const overrideProfiles = asRecord(safeOverride["profiles"])
  if (baseProfiles && overrideProfiles) {
    const profiles = { ...baseProfiles }
    for (const [name, value] of Object.entries(overrideProfiles)) {
      const current = asRecord(baseProfiles[name])
      const patch = asRecord(value)
      profiles[name] = current && patch
        ? mergeProviderConfigPartialSafely(
            current,
            patch as Partial<ProviderConfig>,
          ) as unknown as Record<string, unknown>
        : value
    }
    result["profiles"] = profiles
  }
  return result
}

function replaceModelSelection(
  config: Record<string, unknown>,
  patch: Partial<ProviderConfig>,
): void {
  const current = asProviderConfig(config["model"])
  if (!current) {
    const model = asRecord(config["model"]) ?? {}
    config["model"] = { ...model, ...patch }
    return
  }
  config["model"] = mergeProviderConfigSafely(current, patch)
}

function asProviderConfig(value: unknown): ProviderConfig | null {
  const record = asRecord(value)
  return record &&
    isNonEmptyString(record["provider"]) &&
    isNonEmptyString(record["id"])
    ? record as unknown as ProviderConfig
    : null
}

function asEmbeddingConfig(value: unknown): EmbeddingConfig | null {
  const record = asRecord(value)
  return record &&
    isNonEmptyString(record["provider"]) &&
    isNonEmptyString(record["model"])
    ? record as unknown as EmbeddingConfig
    : null
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
  assertRawConfigWrite(config as Record<string, unknown>)
  if (options?.stripSecrets === false) {
    throw new UnsafeConfigWriteError()
  }
  const toWrite = stripSecretsFromConfig(config as Record<string, unknown>)
  const dir = path.join(cwd ?? process.cwd(), ".nexus")
  const filePath = path.join(dir, "nexus.yaml")
  writeRawConfigFileSync(filePath, toWrite)
}

function stripSecretsFromConfigPatch(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const undefinedPaths: string[][] = []
  const visit = (value: unknown, currentPath: string[]): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const childPath = [...currentPath, key]
      if (child === undefined) undefinedPaths.push(childPath)
      else visit(child, childPath)
    }
  }
  visit(patch, [])

  const sanitized = stripSecretsFromConfig(patch)
  for (const valuePath of undefinedPaths) {
    let target = sanitized
    for (const segment of valuePath.slice(0, -1)) {
      const child = target[segment]
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        target[segment] = {}
      }
      target = target[segment] as Record<string, unknown>
    }
    target[valuePath.at(-1)!] = undefined
  }
  return sanitized
}

/**
 * Atomically merge an explicit patch into the raw project layer.
 *
 * Existing unknown fields and substitution tokens stay as raw values. Only the
 * supplied patch is credential-sanitized; no global/default/effective config is
 * ever serialized into the project file.
 */
export async function patchProjectConfig(
  patch: Record<string, unknown>,
  cwd?: string,
): Promise<void> {
  assertRawConfigWrite(patch)
  const projectDirectory = path.resolve(cwd ?? process.cwd())
  const configPath = path.join(projectDirectory, ".nexus", "nexus.yaml")
  const safePatch = stripSecretsFromConfigPatch(patch)
  await patchRawConfigFile(configPath, safePatch)
}

export interface GlobalConfigPatchOptions {
  /**
   * Override the host-owned global config path for an embedded host/test.
   * Production callers normally omit this and use ~/.nexus/nexus.yaml.
   */
  configPath?: string
}

/**
 * Atomically patch the host-owned global layer.
 *
 * Unlike project patches, authority-bearing permissions, trusted plugins and
 * MCP servers are allowed here because this file is outside repository
 * control. Credentials are still stripped and effective configs are rejected.
 */
export async function patchGlobalConfig(
  patch: Record<string, unknown>,
  options: GlobalConfigPatchOptions = {},
): Promise<void> {
  assertRawConfigWrite(patch)
  const configPath = path.resolve(options.configPath ?? GLOBAL_CONFIG_PATH)
  const safePatch = stripSecretsFromConfigPatch(patch)
  await patchRawConfigFile(configPath, safePatch)
}

/**
 * Persist profiles to global ~/.nexus/nexus.yaml so they are available across all projects.
 * Strips apiKey from each profile so keys are never written to YAML (use secrets store).
 */
export function writeGlobalProfiles(profiles: Record<string, unknown>): void {
  ensureGlobalConfigDir()
  const current = stripSecretsFromConfig(
    readRawConfigFile(GLOBAL_CONFIG_PATH) ?? {},
  )
  current["profiles"] = stripProfileSecrets(profiles)
  writeRawConfigFileSync(GLOBAL_CONFIG_PATH, current)
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
  createPendingProjectAuthorityRequest,
  fingerprintProjectAuthorityPayload,
  getPendingProjectAuthorityRequests,
  isValidPendingProjectAuthorityRequest,
  PROJECT_AUTHORITY_REQUEST_KINDS,
} from "./project-authority.js"
export type {
  PendingProjectAuthorityRequest,
  ProjectAuthorityPayloadByKind,
  ProjectAuthorityRequestKind,
} from "./project-authority.js"
export {
  ConfigFileError,
  ConfigSubstitutionError,
} from "./layered-io.js"
export {
  applySecretsToConfig,
  finalizeConfigCredentials,
  stripSecretsFromConfig,
  stripProfileSecrets,
  getSecretsPayloadFromConfig,
  persistSecretsFromConfig,
  createFileSecretsStore,
  NEXUS_SECRETS_STORAGE_KEY,
  ProfileCredentialCollisionError,
  SecretsCorruptionError,
  UnsupportedSecretsVersionError,
} from "./secrets.js"
export type {
  FinalizeConfigCredentialsOptions,
  NexusSecretsStore,
  NexusSecretsPayload,
  PersistSecretsOptions,
  ProfileCredentialRemoval,
  SecretsCorruptionReason,
  SecretsRemoval,
} from "./secrets.js"

/** Format like .claude: { permissions: { allow: string[], deny: string[], ask: string[] } } */
export interface ProjectSettings {
  permissions?: {
    allow?: string[]
    deny?: string[]
    ask?: string[]
    allowedMcpTools?: string[]
  }
}

function shouldLoadClaudeCompatibility(opts?: { compatibility?: ClaudeCompatibilityOptions }): boolean {
  return opts?.compatibility?.enabled === true && opts.compatibility.includeSettings
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))]
}

function readSettingsFile(filePath: string): ProjectSettings {
  if (!fs.existsSync(filePath)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"))
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as ProjectSettings
    }
    throw new ConfigFileError(filePath, "settings root must be an object")
  } catch (error) {
    if (error instanceof ConfigFileError) throw error
    throw new ConfigFileError(filePath, "settings document is malformed", error)
  }
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

function projectSettingsRestrictionsOnly(
  settings: ProjectSettings,
): ProjectSettings {
  return {
    permissions: {
      deny: settings.permissions?.deny ?? [],
      ask: settings.permissions?.ask ?? [],
    },
  }
}

/**
 * Load global ~/.nexus/settings.json and ~/.nexus/settings.local.json.
 * Same structure as .claude: permissions.allow, permissions.deny, permissions.ask.
 */
export function loadGlobalSettings(options?: { compatibility?: ClaudeCompatibilityOptions }): ProjectSettings {
  const globalBase = readSettingsFile(path.join(GLOBAL_CONFIG_DIR, "settings.json"))
  const globalLocal = readSettingsFile(path.join(GLOBAL_CONFIG_DIR, "settings.local.json"))
  if (!shouldLoadClaudeCompatibility(options)) {
    return mergeSettings(globalBase, globalLocal)
  }
  const claudeBase = readSettingsFile(path.join(os.homedir(), ".claude", "settings.json"))
  const claudeLocal = readSettingsFile(path.join(os.homedir(), ".claude", "settings.local.json"))
  return mergeSettings(globalBase, globalLocal, claudeBase, claudeLocal)
}

/**
 * Load .nexus/settings.json and .nexus/settings.local.json (local overrides), merge with global settings.
 * Layer order: global base → global local → project base → project local (later overrides earlier).
 */
export function loadProjectSettings(cwd: string, options?: { compatibility?: ClaudeCompatibilityOptions }): ProjectSettings {
  const globalBase = readSettingsFile(path.join(GLOBAL_CONFIG_DIR, "settings.json"))
  const globalLocal = readSettingsFile(path.join(GLOBAL_CONFIG_DIR, "settings.local.json"))
  const projectBase = readSettingsFile(path.join(cwd, ".nexus", "settings.json"))
  const projectLocal = readSettingsFile(path.join(cwd, ".nexus", "settings.local.json"))
  if (!shouldLoadClaudeCompatibility(options)) {
    return mergeSettings(
      globalBase,
      globalLocal,
      projectSettingsRestrictionsOnly(projectBase),
      projectSettingsRestrictionsOnly(projectLocal),
    )
  }
  const claudeGlobalBase = readSettingsFile(path.join(os.homedir(), ".claude", "settings.json"))
  const claudeGlobalLocal = readSettingsFile(path.join(os.homedir(), ".claude", "settings.local.json"))
  const claudeProjectBase = readSettingsFile(path.join(cwd, ".claude", "settings.json"))
  const claudeProjectLocal = readSettingsFile(path.join(cwd, ".claude", "settings.local.json"))
  return mergeSettings(
    globalBase,
    globalLocal,
    claudeGlobalBase,
    claudeGlobalLocal,
    projectSettingsRestrictionsOnly(projectBase),
    projectSettingsRestrictionsOnly(projectLocal),
    projectSettingsRestrictionsOnly(claudeProjectBase),
    projectSettingsRestrictionsOnly(claudeProjectLocal),
  )
}

/**
 * Write project settings to .nexus/settings.json.
 */
export function writeProjectSettings(cwd: string, settings: ProjectSettings): void {
  writeAtomicTextFileSync(
    path.join(cwd, ".nexus", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  )
}

/**
 * Write global settings to ~/.nexus/settings.json.
 */
export function writeGlobalSettings(settings: ProjectSettings): void {
  ensureGlobalConfigDir()
  writeAtomicTextFileSync(
    path.join(GLOBAL_CONFIG_DIR, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  )
}
