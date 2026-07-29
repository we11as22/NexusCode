/**
 * Nexus bootstrap: load config, session, and build config snapshot for the REPL.
 * Keeps our agent's config (model, modes, index, checkpoints) in sync with the CLI.
 */
import * as path from 'node:path'
import {
  loadConfig,
  writeConfig,
  loadProjectSettings,
  Session,
  createLLMClient,
  ToolRegistry,
  loadSkills,
  loadAgentInstructionBundle,
  McpClient,
  resolveBundledMcpServers,
  resolveConfiguredAndPluginMcpServers,
  createCompaction,
  OrchestrationRuntime,
  createNexusRunServices,
  closeNexusRunServices,
  scheduleToolOutputMaintenance,
  listSessions,
  deleteSession as coreDeleteSession,
  readCheckpointEntries,
  getGlobalConfigDir,
  createFileSecretsStore,
  finalizeConfigCredentials,
  getConfigEnvironment,
  persistSecretsFromConfig,
  createCodebaseIndexer,
  MODES,
  type Mode,
  type NexusConfig,
  type IndexStatus,
  type NexusRunServices,
  canonicalProjectRoot,
  FileChangeSetStore,
  GitService,
  hashWorkspaceIdentity,
  getClaudeCompatibilityOptions,
  loadSlashCommands,
  renderSlashCommandPrompt,
  resolveSlashCommand,
  NexusServerClient,
  getNexusServerTokenSecretKey,
  hydrateWorkspaceAuthority,
  isLoopbackNexusServerDestination,
  NEXUS_SERVER_TOKEN_SECRET_KEY,
  mergeProviderConfigSafely,
  selectProviderProfile,
  getSessionModeForResume,
  type WorkspaceAuthorityStoreOptions,
} from '@nexuscode/core'
import type { CodebaseIndexer } from '@nexuscode/core'
import { fileURLToPath } from 'node:url'
import {
  resolveRuntimeServerUrl,
  selectSession,
} from './session-selection.js'
import { createCliRemoteTurnCursorStore } from './remote-turn-cursor-store.js'
import type { RemoteTurnCursorStore } from './remote-turn.js'
import {
  resolveMcpPromptCommand,
  resolveRemoteMcpPromptCommand,
} from './mcp-prompts.js'
import { CliHost } from './host.js'
import {
  createCliMcpRemoteRequestAuthorizer,
  createCliRunContext,
  type CliRunContext,
} from './run-context.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NEXUS_ROOT = path.resolve(__dirname, '..', '..', '..')

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const NEXUS_GATEWAY_BASE_URL = 'https://api.kilo.ai/api/openrouter'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isOpenRouterBaseUrl(value: unknown): boolean {
  return isNonEmptyString(value) && value.toLowerCase().includes('openrouter.ai')
}

export function normalizeModelConfig<T extends { provider?: unknown; id?: unknown; baseUrl?: unknown }>(model: T): T {
  let next = { ...model } as T & { provider?: unknown; id?: unknown; baseUrl?: unknown }
  const provider = String(next.provider ?? '')
  if (provider === 'openrouter') {
    next.provider = 'openai-compatible'
    if (!isNonEmptyString(next.baseUrl)) next.baseUrl = OPENROUTER_BASE_URL
  }
  const modelId = String(next.id ?? '')
  if (next.provider === 'openai-compatible' && modelId.endsWith(':free')) {
    if (!isNonEmptyString(next.baseUrl) || isOpenRouterBaseUrl(next.baseUrl)) {
      next = mergeProviderConfigSafely(
        next as unknown as NexusConfig['model'],
        { baseUrl: NEXUS_GATEWAY_BASE_URL },
      ) as unknown as typeof next
    }
  }
  return next as T
}

export interface CliModelSelection {
  modelOverride?: string
  temperatureOverride?: number
  reasoningEffortOverride?: string
  profileOverride?: string
}

/**
 * Apply CLI selection as one credential-safe transaction. This same function
 * is replayed after live config reloads so bootstrap overrides reach the
 * actual createLLMClient call.
 */
export function applyCliModelSelection(
  config: NexusConfig,
  selection: CliModelSelection,
): void {
  const {
    modelOverride,
    temperatureOverride,
    reasoningEffortOverride,
    profileOverride,
  } = selection

  if (modelOverride) {
    const slashIdx = modelOverride.indexOf('/')
    if (slashIdx > 0) {
      const provider = modelOverride.slice(0, slashIdx)
      const modelId = modelOverride.slice(slashIdx + 1)
      const patch = provider === 'openrouter'
        ? {
            provider: 'openai-compatible' as const,
            id: modelId,
            baseUrl: OPENROUTER_BASE_URL,
          }
        : {
            provider: provider as NexusConfig['model']['provider'],
            id: modelId,
          }
      config.model = mergeProviderConfigSafely(config.model, patch)
    } else {
      config.model = mergeProviderConfigSafely(config.model, {
        id: modelOverride,
      })
    }
    config.model = normalizeModelConfig(config.model)
  }

  if (typeof temperatureOverride === 'number' && Number.isFinite(temperatureOverride)) {
    config.model.temperature = Math.max(0, Math.min(2, temperatureOverride))
  }

  if (typeof reasoningEffortOverride === 'string') {
    const trimmed = reasoningEffortOverride.trim()
    if (trimmed.length > 0) config.model.reasoningEffort = trimmed
  }

  if (profileOverride) {
    const profile = config.profiles?.[profileOverride]
    if (!profile) throw new Error(`Profile not found: ${profileOverride}`)
    config.model = selectProviderProfile(config.model, profile)
    config.model = normalizeModelConfig(config.model)
  }
}

export type ConfigSnapshot = {
  model: { provider: string; id: string; temperature?: number; reasoningEffort?: string }
  embeddings?: { provider: string; model: string; dimensions?: number }
  indexing: { enabled: boolean; vector: boolean }
  vectorDb?: { enabled: boolean; url: string }
  mcp: { servers: unknown[] }
  tools: {
    parallelReads: boolean
    maxParallelReads: number
    deferredLoadingMode?: "auto" | "always" | "never"
    deferredLoadingThresholdPercent?: number
    deferredLoadingMinimumTools?: number
  }
  skills: string[]
  skillsConfig?: Array<{ path: string; enabled: boolean }>
  rules: { files: string[] }
  permissions?: {
    autoApproveRead: boolean
    autoApproveWrite: boolean
    autoApproveCommand: boolean
    autoApproveMcp?: boolean
    autoApproveBrowser?: boolean
    autoApproveReadPatterns?: string[]
    allowedCommands?: string[]
    allowCommandPatterns?: string[]
    askCommandPatterns?: string[]
    denyCommandPatterns?: string[]
    allowedMcpTools?: string[]
  }
  modes: {
    agent?: { customInstructions?: string }
    plan?: { customInstructions?: string }
    ask?: { customInstructions?: string }
    debug?: { customInstructions?: string }
    review?: { customInstructions?: string }
  }
  profiles: Record<string, unknown>
}

export function buildConfigSnapshot(conf: NexusConfig): ConfigSnapshot {
  return {
    model: {
      provider: conf.model.provider,
      id: conf.model.id,
      temperature: conf.model.temperature,
      reasoningEffort: conf.model.reasoningEffort,
    },
    embeddings: conf.embeddings
      ? {
          provider: conf.embeddings.provider,
          model: conf.embeddings.model,
          dimensions: conf.embeddings.dimensions,
        }
      : undefined,
    indexing: { enabled: conf.indexing.enabled, vector: conf.indexing.vector },
    vectorDb: conf.vectorDb ? { enabled: conf.vectorDb.enabled, url: conf.vectorDb.url } : undefined,
    mcp: { servers: (conf.mcp?.servers ?? []) as unknown[] },
    tools: {
      parallelReads: conf.tools.parallelReads,
      maxParallelReads: conf.tools.maxParallelReads,
      deferredLoadingMode: conf.tools.deferredLoadingMode,
      deferredLoadingThresholdPercent:
        conf.tools.deferredLoadingThresholdPercent,
      deferredLoadingMinimumTools: conf.tools.deferredLoadingMinimumTools,
    },
    skills: conf.skills ?? [],
    skillsConfig: conf.skillsConfig,
    rules: { files: conf.rules?.files ?? [] },
    permissions: conf.permissions
      ? {
          autoApproveRead: conf.permissions.autoApproveRead,
          autoApproveWrite: conf.permissions.autoApproveWrite,
          autoApproveCommand: conf.permissions.autoApproveCommand,
          autoApproveMcp: conf.permissions.autoApproveMcp ?? false,
          autoApproveBrowser: conf.permissions.autoApproveBrowser ?? false,
          autoApproveReadPatterns: conf.permissions.autoApproveReadPatterns ?? [],
          allowedCommands: conf.permissions.allowedCommands ?? [],
          allowCommandPatterns: conf.permissions.allowCommandPatterns ?? [],
          askCommandPatterns: conf.permissions.askCommandPatterns ?? [],
          denyCommandPatterns: conf.permissions.denyCommandPatterns ?? [],
          allowedMcpTools: conf.permissions.allowedMcpTools ?? [],
        }
      : undefined,
    modes: {
      agent: { customInstructions: conf.modes?.agent?.customInstructions },
      plan: { customInstructions: conf.modes?.plan?.customInstructions },
      ask: { customInstructions: conf.modes?.ask?.customInstructions },
      debug: { customInstructions: conf.modes?.debug?.customInstructions },
      review: { customInstructions: conf.modes?.review?.customInstructions },
    },
    profiles: (conf as unknown as { profiles?: Record<string, unknown> }).profiles ?? {},
  }
}

export interface CliWorkspaceConfigOptions {
  loadEnv: boolean
  globalConfigPath?: string | false
  hostAuthority: boolean
  authorityStoreOptions?: WorkspaceAuthorityStoreOptions
}

/**
 * Load one CLI runtime config with its two distinct policy sources:
 * repository settings may only deny/ask, while persistent grants come from
 * the host-owned store bound to this exact canonical workspace identity.
 */
export async function loadCliWorkspaceConfig(
  cwd: string,
  options: CliWorkspaceConfigOptions,
): Promise<NexusConfig> {
  const config = await loadConfig(cwd, {
    loadEnv: options.loadEnv,
    ...(options.globalConfigPath !== undefined
      ? { globalConfigPath: options.globalConfigPath }
      : {}),
  })
  try {
    const settings = loadProjectSettings(cwd, {
      compatibility: getClaudeCompatibilityOptions(config),
    })
    const permissions = settings.permissions
    if (permissions) {
      if (Array.isArray(permissions.deny)) {
        config.permissions.denyCommandPatterns = permissions.deny
      }
      if (Array.isArray(permissions.ask)) {
        config.permissions.askCommandPatterns = permissions.ask
      }
    }
  } catch {
    // Missing/invalid compatibility settings do not weaken config policy.
  }
  if (options.hostAuthority) {
    await hydrateWorkspaceAuthority(
      config,
      cwd,
      options.authorityStoreOptions,
    )
  }
  return config
}

export interface NexusBootstrapResult {
  cwd: string
  config: NexusConfig
  session: Session
  mode: Mode
  indexEnabled: boolean
  configSnapshot: ConfigSnapshot
  secretsStore: ReturnType<typeof createFileSecretsStore>
  toolRegistry: ToolRegistry
  createRunContext: (
    authorityConfig: NexusConfig,
    runtimeConfig: NexusConfig,
  ) => Promise<CliRunContext>
  reconcileMcpServers: (authorityConfig: NexusConfig) => Promise<void>
  mcpClient: McpClient
  services: NexusRunServices
  rulesContent: string
  skills: Awaited<ReturnType<typeof loadSkills>>
  compaction: ReturnType<typeof createCompaction>
  indexer: CodebaseIndexer | undefined
  serverUrl: string | null
  /** Authenticated protocol client used by explicit remote review actions. */
  remoteClient: NexusServerClient | null
  remoteTurnCursorStore: RemoteTurnCursorStore | undefined
  sessionStore: {
    list: () => Promise<Array<{ id: string; ts: number; title?: string; messageCount: number }>>
    load: (sessionId: string) => Promise<Session | null>
    create: () => Promise<Session>
    delete: (sessionId: string) => Promise<boolean>
  }
  nexusRoot: string
  cliModelSelection: CliModelSelection
  resolvePromptCommand: (
    name: string,
    args: string,
  ) => Promise<
    | { status: 'resolved'; prompt: string }
    | { status: 'ambiguous'; candidates: string[] }
    | { status: 'not-found' }
      >
  /** Idempotently drains workspace-owned live services for this CLI runtime. */
  close: () => Promise<void>
}

export async function bootstrapNexus(opts: {
  cwd: string
  mode?: Mode
  indexEnabled?: boolean
  sessionId?: string | null
  continue?: boolean
  serverUrl?: string | null
  modelOverride?: string
  temperatureOverride?: number
  reasoningEffortOverride?: string
  profileOverride?: string
}): Promise<NexusBootstrapResult> {
  const {
    cwd: cwdRaw,
    mode: modeArg,
    indexEnabled = true,
    sessionId: sessionIdOpt,
    continue: continueFlag,
    serverUrl: serverUrlOption = null,
    modelOverride,
    temperatureOverride,
    reasoningEffortOverride,
    profileOverride,
  } = opts

  const cwd = canonicalProjectRoot(cwdRaw)
  const serverUrl = resolveRuntimeServerUrl(
    serverUrlOption,
    process.env.NEXUS_SERVER_URL,
  )
  const remoteTurnCursorStore = serverUrl
    ? createCliRemoteTurnCursorStore({
        rootDir: getGlobalConfigDir(),
        serverUrl,
        cwd,
      })
    : undefined
  if (
    serverUrl &&
    (
      isNonEmptyString(modelOverride) ||
      temperatureOverride !== undefined ||
      isNonEmptyString(reasoningEffortOverride) ||
      isNonEmptyString(profileOverride)
    )
  ) {
    throw new Error(
      'Remote protocol v2 is required for --model, --profile, --temperature, or --reasoning-effort overrides',
    )
  }

  const secretsStore = createFileSecretsStore(getGlobalConfigDir())
  let config = await loadCliWorkspaceConfig(cwd, {
    loadEnv: !serverUrl,
    hostAuthority: !serverUrl,
  })

  const cliModelSelection: CliModelSelection = {
    modelOverride,
    temperatureOverride,
    reasoningEffortOverride,
    profileOverride,
  }
  applyCliModelSelection(config, cliModelSelection)
  const runtimeConfig = serverUrl
    ? config
    : await finalizeConfigCredentials(
      config as unknown as Record<string, unknown>,
      secretsStore,
      {
        profileName: profileOverride,
        environment: getConfigEnvironment(config),
      },
    ) as unknown as NexusConfig

  const mcpAuthorizationHost = new CliHost(cwd, () => {})
  const mcpClient = new McpClient({
    remoteRequestAuthorizer:
      createCliMcpRemoteRequestAuthorizer(mcpAuthorizationHost),
  })
  let mcpConfigFingerprint = "[]"
  const allowedMcpServerNames = new Set<string>()

  const reconcileMcpServers = async (
    authorityConfig: NexusConfig,
  ): Promise<void> => {
    if (serverUrl) return
    const pluginMcp = await resolveConfiguredAndPluginMcpServers(
      cwd,
      authorityConfig,
    )
    for (const diagnostic of pluginMcp.diagnostics) {
      console.warn(`[nexus] plugin MCP ${diagnostic.pluginName}: ${diagnostic.message}`)
    }
    process.env.CLAUDE_PROJECT_DIR = cwd
    const resolved = resolveBundledMcpServers(pluginMcp.servers, {
      cwd,
      nexusRoot: NEXUS_ROOT,
    })
    allowedMcpServerNames.clear()
    for (const server of resolved) {
      if (server.enabled !== false) allowedMcpServerNames.add(server.name)
    }
    const fingerprint = JSON.stringify(resolved)
    if (fingerprint === mcpConfigFingerprint) return
    const statuses = await mcpClient.connectAll(resolved)
    mcpConfigFingerprint = fingerprint
    for (const status of Object.values(statuses)) {
      if (status.state !== "connected" && status.state !== "disabled") {
        console.warn(`[nexus] MCP ${status.name}: ${status.error ?? status.state}`)
      }
    }
  }
  await reconcileMcpServers(config)

  const workspaceId = hashWorkspaceIdentity(cwd)
  const services = createNexusRunServices({
    orchestrationRuntime: new OrchestrationRuntime(cwd),
    mcpClient,
    ...(!serverUrl
      ? {
          changeSets: {
            workspaceId,
            store: new FileChangeSetStore(workspaceId, {
              rootDir: getGlobalConfigDir(),
            }),
          },
          git: new GitService(cwd),
        }
      : {}),
  })
  const toolOutputMaintenance = scheduleToolOutputMaintenance({
    cwd,
    services,
    onResult(result) {
      for (const diagnostic of result.errors) {
        console.warn(`[nexus] tool-output maintenance: ${diagnostic}`)
      }
    },
  })
  void toolOutputMaintenance?.promise.catch((error) => {
    console.warn("[nexus] tool-output maintenance failed:", error)
  })
  const createRunContext = (
    authorityConfig: NexusConfig,
    effectiveRuntimeConfig: NexusConfig,
  ) => createCliRunContext({
    cwd,
    authorityConfig,
    runtimeConfig: effectiveRuntimeConfig,
    services,
    allowedMcpServerNames,
    remote: Boolean(serverUrl),
  })
  const initialRunContext = await createRunContext(config, runtimeConfig)
  for (const diagnostic of initialRunContext.toolContributionDiagnostics) {
    console.warn(
      `[nexus] ${diagnostic.sourceId}: ${diagnostic.message}`,
    )
  }
  const toolRegistry = initialRunContext.toolRegistry

  const claudeCompatibility = getClaudeCompatibilityOptions(config)
  const rulesContent = serverUrl
    ? ""
    : await loadAgentInstructionBundle(cwd, config.rules.files, config, claudeCompatibility)
  const skills = serverUrl
    ? []
    : await loadSkills(
        config.skills,
        cwd,
        config.skillsUrls,
        claudeCompatibility,
        config,
      ).catch(() => [])

  const remoteClient = serverUrl
    ? new NexusServerClient({
        baseUrl: serverUrl,
        directory: cwd,
        token:
          process.env.NEXUS_SERVER_TOKEN?.trim() ||
          await secretsStore.getSecret(getNexusServerTokenSecretKey(serverUrl)) ||
          (isLoopbackNexusServerDestination(serverUrl)
            ? await secretsStore.getSecret(NEXUS_SERVER_TOKEN_SECRET_KEY)
            : null) ||
          "",
      })
    : null
  const loadRemoteSession = async (sessionId: string): Promise<Session | null> => {
    if (!remoteClient) return null
    try {
      const meta = await remoteClient.getSession(sessionId)
      const messages = await remoteClient.getRecentMessages(sessionId)
      return new Session(
        meta.id,
        cwd,
        messages,
        undefined,
        true,
        null,
        0,
        null,
        meta.mode ?? null,
      )
    } catch (error) {
      if (error instanceof Error && /\b404\b/.test(error.message)) return null
      throw error
    }
  }
  const createRemoteSession = async (): Promise<Session> => {
    if (!remoteClient) throw new Error("Remote session client is not configured")
    const meta = await remoteClient.createSession()
    return new Session(meta.id, cwd, [], undefined, true)
  }
  const sessionStore: NexusBootstrapResult["sessionStore"] = remoteClient
    ? {
        list: () => remoteClient.listSessions(),
        load: loadRemoteSession,
        create: createRemoteSession,
        delete: (sessionId) => remoteClient.deleteSession(sessionId),
      }
    : {
        list: () => listSessions(cwd),
        load: (sessionId) => Session.resume(sessionId, cwd),
        create: async () => Session.create(cwd),
        delete: (sessionId) => coreDeleteSession(sessionId, cwd),
      }
  const session = await selectSession({
    sessionId: sessionIdOpt,
    continueSession: Boolean(continueFlag),
    list: sessionStore.list,
    load: sessionStore.load,
    create: sessionStore.create,
  })
  const mode: Mode =
    modeArg ?? getSessionModeForResume(session, 'agent')

  let indexer: CodebaseIndexer | undefined
  if (
    !serverUrl &&
    indexEnabled &&
    config.indexing.enabled &&
    config.indexing.vector &&
    config.vectorDb?.enabled
  ) {
    indexer = await createCodebaseIndexer(cwd, runtimeConfig, {
      onWarning: (msg) => console.warn(msg),
      onProgress: (msg) => console.warn("[nexus]", msg),
    }).catch(() => undefined)
    indexer?.startIndexing().catch(() => {})
  }

  const compaction = createCompaction()
  const configSnapshot = buildConfigSnapshot(config)
  const resolvePromptCommand: NexusBootstrapResult['resolvePromptCommand'] = async (
    name,
    args,
  ) => {
    if (remoteClient) {
      const mcpPrompt = await resolveRemoteMcpPromptCommand(
        remoteClient,
        session.id,
        name,
        args,
      )
      if (mcpPrompt.status !== "not-found") return mcpPrompt
    } else {
      const mcpPrompt = await resolveMcpPromptCommand(
        mcpClient,
        name,
        args,
      )
      if (mcpPrompt.status !== "not-found") return mcpPrompt
    }
    const liveConfig = await loadCliWorkspaceConfig(cwd, {
      loadEnv: !serverUrl,
      hostAuthority: !serverUrl,
    })
    const commands = await loadSlashCommands(
      cwd,
      getClaudeCompatibilityOptions(liveConfig),
      liveConfig,
    )
    const resolved = resolveSlashCommand(commands, name)
    if (resolved.status !== 'resolved') return resolved
    return {
      status: 'resolved',
      prompt: renderSlashCommandPrompt(resolved.command, args),
    }
  }

  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      const errors: unknown[] = []
      try {
        // Delegated agents may still be using MCP, so drain shared services first.
        await closeNexusRunServices(services)
      } catch (error) {
        errors.push(error)
      }
      try {
        await mcpClient.disconnectAll()
      } catch (error) {
        errors.push(error)
      }
      try {
        indexer?.close()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(errors, "Failed to close Nexus CLI runtime")
      }
    })()
    return closePromise
  }

  return {
    cwd,
    config,
    session,
    mode,
    indexEnabled,
    configSnapshot,
    secretsStore,
    toolRegistry,
    createRunContext,
    reconcileMcpServers,
    mcpClient,
    services,
    rulesContent,
    skills,
    compaction,
    indexer,
    serverUrl,
    remoteClient,
    remoteTurnCursorStore,
    sessionStore,
    nexusRoot: NEXUS_ROOT,
    cliModelSelection,
    resolvePromptCommand,
    close,
  }
}

export { MODES, listSessions, coreDeleteSession, readCheckpointEntries, getGlobalConfigDir, writeConfig, persistSecretsFromConfig }
export type { NexusConfig, Mode }
