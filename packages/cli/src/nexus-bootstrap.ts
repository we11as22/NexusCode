/**
 * Nexus bootstrap: load config, session, and build config snapshot for the REPL.
 * Keeps our agent's config (model, modes, index, checkpoints) in sync with the CLI.
 */
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import {
  loadConfig,
  writeConfig,
  loadProjectSettings,
  Session,
  createLLMClient,
  ToolRegistry,
  loadSkills,
  loadRules,
  McpClient,
  setMcpClientInstance,
  resolveBundledMcpServers,
  createCompaction,
  ParallelAgentManager,
  createSpawnAgentTool,
  createSpawnAgentOutputTool,
  createSpawnAgentStopTool,
  createSpawnAgentsParallelTool,
  listSessions,
  deleteSession as coreDeleteSession,
  readCheckpointEntries,
  getGlobalConfigDir,
  createFileSecretsStore,
  persistSecretsFromConfig,
  createCodebaseIndexer,
  MODES,
  type Mode,
  type NexusConfig,
  type IndexStatus,
  canonicalProjectRoot,
} from '@nexuscode/core'
import type { CodebaseIndexer } from '@nexuscode/core'
import { fileURLToPath } from 'node:url'

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
  const next = { ...model } as T & { provider?: unknown; id?: unknown; baseUrl?: unknown }
  const provider = String(next.provider ?? '')
  if (provider === 'openrouter') {
    next.provider = 'openai-compatible'
    if (!isNonEmptyString(next.baseUrl)) next.baseUrl = OPENROUTER_BASE_URL
  }
  const modelId = String(next.id ?? '')
  if (next.provider === 'openai-compatible' && modelId.endsWith(':free')) {
    if (!isNonEmptyString(next.baseUrl) || isOpenRouterBaseUrl(next.baseUrl)) {
      next.baseUrl = NEXUS_GATEWAY_BASE_URL
    }
  }
  return next as T
}

export type ConfigSnapshot = {
  model: { provider: string; id: string; temperature?: number; reasoningEffort?: string }
  embeddings?: { provider: string; model: string; dimensions?: number }
  indexing: { enabled: boolean; vector: boolean }
  vectorDb?: { enabled: boolean; url: string }
  mcp: { servers: unknown[] }
  tools: {
    classifyToolsEnabled: boolean
    classifyThreshold: number
    parallelReads: boolean
    maxParallelReads: number
  }
  skillClassifyEnabled: boolean
  skillClassifyThreshold: number
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
      classifyToolsEnabled: conf.tools.classifyToolsEnabled,
      classifyThreshold: conf.tools.classifyThreshold,
      parallelReads: conf.tools.parallelReads,
      maxParallelReads: conf.tools.maxParallelReads,
    },
    skillClassifyEnabled: conf.skillClassifyEnabled,
    skillClassifyThreshold: conf.skillClassifyThreshold,
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

export interface NexusBootstrapResult {
  cwd: string
  config: NexusConfig
  session: Session
  mode: Mode
  indexEnabled: boolean
  configSnapshot: ConfigSnapshot
  secretsStore: ReturnType<typeof createFileSecretsStore>
  toolRegistry: ToolRegistry
  mcpClient: McpClient
  rulesContent: string
  skills: Awaited<ReturnType<typeof loadSkills>>
  compaction: ReturnType<typeof createCompaction>
  indexer: CodebaseIndexer | undefined
  serverUrl: string | null
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
    serverUrl = null,
    modelOverride,
    temperatureOverride,
    reasoningEffortOverride,
    profileOverride,
  } = opts

  const cwd = canonicalProjectRoot(cwdRaw)

  const secretsStore = createFileSecretsStore(getGlobalConfigDir())
  let config = await loadConfig(cwd, { secrets: secretsStore })

  // Merge .nexus/allowed-commands.json
  try {
    const allowPath = path.join(cwd, '.nexus', 'allowed-commands.json')
    const raw = await fs.readFile(allowPath, 'utf8')
    const parsed = JSON.parse(raw) as { commands?: string[] }
    if (Array.isArray(parsed?.commands)) {
      config.permissions.allowedCommands = parsed.commands
    }
  } catch {
    // ignore
  }

  // Merge .nexus/settings.json + settings.local.json
  try {
    const settings = loadProjectSettings(cwd)
    const perms = settings.permissions
    if (perms) {
      if (Array.isArray(perms.allow)) config.permissions.allowCommandPatterns = perms.allow
      if (Array.isArray(perms.deny)) config.permissions.denyCommandPatterns = perms.deny
      if (Array.isArray(perms.ask)) config.permissions.askCommandPatterns = perms.ask
      if (Array.isArray(perms.allowedMcpTools)) {
        config.permissions.allowedMcpTools = perms.allowedMcpTools
      }
    }
  } catch {
    // ignore
  }

  // Apply --model override
  if (modelOverride) {
    const slashIdx = modelOverride.indexOf('/')
    if (slashIdx > 0) {
      const provider = modelOverride.slice(0, slashIdx)
      const modelId = modelOverride.slice(slashIdx + 1)
      if (provider === 'openrouter') {
        config.model.provider = 'openai-compatible'
        config.model.baseUrl = config.model.baseUrl || OPENROUTER_BASE_URL
      } else {
        (config.model as Record<string, unknown>).provider = provider
      }
      config.model.id = modelId
    } else {
      config.model.id = modelOverride
    }
    config.model = normalizeModelConfig(config.model)
  }

  if (typeof temperatureOverride === 'number' && Number.isFinite(temperatureOverride)) {
    config.model.temperature = Math.max(0, Math.min(2, temperatureOverride))
  }

  if (typeof reasoningEffortOverride === 'string') {
    const trimmed = reasoningEffortOverride.trim()
    if (trimmed.length > 0) {
      config.model.reasoningEffort = trimmed
    }
  }

  if (profileOverride && (config as unknown as { profiles?: Record<string, unknown> }).profiles?.[profileOverride]) {
    const profile = (config as unknown as { profiles: Record<string, unknown> }).profiles[profileOverride] as Record<string, unknown>
    config.model = { ...config.model, ...profile } as NexusConfig['model']
    config.model = normalizeModelConfig(config.model)
  }

  const mode: Mode = modeArg ?? 'agent'
  const toolRegistry = new ToolRegistry()
  const mcpClient = new McpClient()
  setMcpClientInstance(mcpClient)

  if (config.mcp.servers.length > 0) {
    process.env.CLAUDE_PROJECT_DIR = cwd
    const resolved = resolveBundledMcpServers(config.mcp.servers, { cwd, nexusRoot: NEXUS_ROOT })
    await mcpClient.connectAll(resolved).catch(() => {})
    for (const tool of mcpClient.getTools()) {
      toolRegistry.register(tool)
    }
  }

  const parallelManager = new ParallelAgentManager()
  toolRegistry.register(createSpawnAgentTool(parallelManager, config))
  toolRegistry.register(createSpawnAgentsParallelTool(parallelManager, config))
  toolRegistry.register(createSpawnAgentOutputTool(parallelManager))
  toolRegistry.register(createSpawnAgentStopTool(parallelManager))

  const rulesContent = await loadRules(cwd, config.rules.files).catch(() => '')
  const skills = await loadSkills(config.skills, cwd).catch(() => [])

  let session: Session
  if (continueFlag) {
    const sessions = await listSessions(cwd)
    const last = sessions[0]
    if (last) {
      session = (await Session.resume(last.id, cwd)) ?? Session.create(cwd)
    } else {
      session = Session.create(cwd)
    }
  } else if (sessionIdOpt) {
    session = (await Session.resume(sessionIdOpt, cwd)) ?? Session.create(cwd)
  } else {
    session = Session.create(cwd)
  }

  let indexer: CodebaseIndexer | undefined
  if (indexEnabled && config.indexing.enabled) {
    indexer = await createCodebaseIndexer(cwd, config, {
      onWarning: (msg) => console.warn(msg),
      onProgress: (msg) => console.warn("[nexus]", msg),
    }).catch(() => undefined)
    indexer?.startIndexing().catch(() => {})
  }

  const compaction = createCompaction()
  const configSnapshot = buildConfigSnapshot(config)

  return {
    cwd,
    config,
    session,
    mode,
    indexEnabled,
    configSnapshot,
    secretsStore,
    toolRegistry,
    mcpClient,
    rulesContent,
    skills,
    compaction,
    indexer,
    serverUrl,
  }
}

export { MODES, listSessions, coreDeleteSession, readCheckpointEntries, getGlobalConfigDir, writeConfig, persistSecretsFromConfig }
export type { NexusConfig, Mode }
