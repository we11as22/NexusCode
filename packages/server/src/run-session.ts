import type {
  Session,
  NexusConfig,
  Mode,
  ModeChangeResult,
} from "@nexuscode/core"
import type {
  AgentEvent,
  ApprovalAction,
  CodebaseIndexer,
  McpServerConfig,
  NexusRunServices,
  PermissionResult,
} from "@nexuscode/core"
import { runAgentLoop } from "@nexuscode/core"
import {
  loadConfig,
  getGlobalConfigDir,
  createFileSecretsStore,
  finalizeConfigCredentials,
  getConfigEnvironment,
  createLLMClient,
  ToolRegistry,
  loadAgentInstructionBundle,
  loadSkills,
  createCompaction,
  createSpawnAgentTool,
  createSpawnAgentsAliasTool,
  createSpawnAgentOutputTool,
  createSpawnAgentStopTool,
  createListAgentRunsTool,
  createAgentRunSnapshotTool,
  createResumeAgentTool,
  createTaskCreateBatchTool,
  createTaskResumeTool,
  createTaskSnapshotTool,
  createSpawnAgentsParallelTool,
  createNexusRunServices,
  closeNexusRunServices,
  scheduleToolOutputMaintenance,
  OrchestrationRuntime,
  McpClient,
  resolveBundledMcpServers,
  resolveConfiguredAndPluginMcpServers,
  CheckpointTracker,
  getClaudeCompatibilityOptions,
  mergeModelPresetSelection,
  selectProviderProfile,
  hydrateWorkspaceAuthority,
  type WorkspaceAuthorityStoreOptions,
} from "@nexuscode/core"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { ServerHost } from "./host.js"
import { serverIndexerCache } from "./indexer-cache.js"
import {
  createServerMcpClient,
  prepareServerToolContributions,
  registerServerMcpCapabilities,
} from "./server-capabilities.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export function resolveServerNexusRoot(moduleDirectory: string): string {
  return path.resolve(moduleDirectory, "..", "..", "..")
}
const NEXUS_ROOT = resolveServerNexusRoot(__dirname)

export async function resolveServerMcpServers(
  cwd: string,
  config: NexusConfig,
): Promise<{
  servers: McpServerConfig[]
  diagnostics: Awaited<
    ReturnType<typeof resolveConfiguredAndPluginMcpServers>
  >["diagnostics"]
}> {
  const configured = await resolveConfiguredAndPluginMcpServers(cwd, config)
  return {
    servers: resolveBundledMcpServers(configured.servers, {
      cwd,
      nexusRoot: NEXUS_ROOT,
    }),
    diagnostics: configured.diagnostics,
  }
}

/** Max ms to wait for each rules/skills dependency; startup continues in a degraded state after this deadline. */
const RULES_SKILLS_LOAD_TIMEOUT_MS = 2000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bound optional runtime dependencies without leaving timeout handles alive.
 * The underlying loader may still settle later, but its result is deliberately
 * ignored once the server has entered the degraded startup path.
 */
export async function settleRuntimeDependency<T>(
  label: string,
  work: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onDiagnostic: (message: string) => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<{ type: "timeout" }>((resolve) => {
    timeout = setTimeout(() => resolve({ type: "timeout" }), timeoutMs)
    timeout.unref?.()
  })
  try {
    const result = await Promise.race([
      work.then(
        (value) => ({ type: "ok" as const, value }),
        (error) => ({ type: "error" as const, error }),
      ),
      deadline,
    ])
    if (result.type === "ok") return result.value
    if (result.type === "timeout") {
      onDiagnostic(
        `[${label} runtime] loading timed out after ${timeoutMs}ms; continuing without it`,
      )
      return fallback
    }
    onDiagnostic(
      `[${label} runtime] ${errorMessage(result.error)}; continuing without it`,
    )
    return fallback
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export interface RunSessionOptions {
  session: Session
  cwd: string
  content: string
  mode: Mode
  onEvent: (event: AgentEvent) => void
  signal: AbortSignal
  configOverride?: Record<string, unknown>
  requestApproval?: (action: ApprovalAction) => Promise<PermissionResult>
  requestModeChange?: (
    mode: Mode,
    reason?: string,
  ) => Promise<ModeChangeResult>
  /**
   * Workspace-owned live services. Server protocol turns must reuse this
   * object so delegated agents and background process handles survive across
   * messages and are drained only when the workspace runtime closes.
   */
  services?: NexusRunServices
  /** The transport durably admitted the user message before starting execution. */
  userMessageAdmitted?: boolean
  /** Stable protocol-v2 profile selected for this immutable turn. */
  profileName?: string
}

export async function loadServerWorkspaceConfig(
  cwd: string,
  options: {
    loadEnv?: boolean
    globalConfigPath?: string | false
    authorityStoreOptions?: WorkspaceAuthorityStoreOptions
  } = {},
): Promise<NexusConfig> {
  const config = await loadConfig(cwd, {
    loadEnv: options.loadEnv ?? true,
    ...(options.globalConfigPath !== undefined
      ? { globalConfigPath: options.globalConfigPath }
      : {}),
  })
  await hydrateWorkspaceAuthority(
    config,
    cwd,
    options.authorityStoreOptions,
  )
  return config
}

export function assertSupportedRemoteConfigOverride(
  configOverride: Record<string, unknown> | undefined,
): void {
  if (!configOverride) return
  const unsupported = Object.keys(configOverride).filter(
    (key) => key !== "presetName",
  )
  if (unsupported.length > 0) {
    throw new Error(
      `Remote protocol v2 is required for config overrides: ${unsupported.join(", ")}`,
    )
  }
}

/**
 * Server runs never inherit local auto-approval grants. The authenticated
 * transport may still approve one pending action explicitly by run + part id.
 */
export function enforceServerPermissionBoundary(
  config: NexusConfig,
): NexusConfig {
  const modes = Object.fromEntries(
    Object.entries(config.modes ?? {}).map(([name, modeConfig]) => [
      name,
      modeConfig
        ? {
            ...modeConfig,
            autoApprove: modeConfig.autoApprove?.filter(
              (action) => action === "read" || action === "search",
            ),
          }
        : modeConfig,
    ]),
  ) as NexusConfig["modes"]

  return {
    ...config,
    modes,
    permissions: {
      ...config.permissions,
      autoApproveWrite: false,
      autoApproveCommand: false,
      autoApproveMcp: false,
      autoApproveBrowser: false,
      allowedCommands: [],
      allowCommandPatterns: [],
      allowedMcpTools: [],
      rules: config.permissions.rules.filter((rule) => rule.action !== "allow"),
    },
  }
}

/**
 * Run the agent loop for one message; all events are forwarded via onEvent.
 */
export async function runSession(opts: RunSessionOptions): Promise<void> {
  const {
    session,
    cwd,
    content,
    mode,
    onEvent,
    signal,
    configOverride,
    requestApproval,
    requestModeChange,
    services: workspaceServices,
    userMessageAdmitted = false,
    profileName,
  } = opts

  assertSupportedRemoteConfigOverride(configOverride)
  const secretsStore = createFileSecretsStore(getGlobalConfigDir())
  // A malformed workspace config must fail closed. Falling back to the
  // server process cwd can silently run with another repository's model,
  // integrations, permissions, and executable plugin declarations.
  const config = await loadServerWorkspaceConfig(cwd)
  const configEnvironment = getConfigEnvironment(config)

  const presetName =
    configOverride && typeof (configOverride as { presetName?: unknown }).presetName === "string"
      ? String((configOverride as { presetName?: string }).presetName).trim()
      : ""
  const presetConfig = presetName
    ? await applyPresetForRun(config, cwd, presetName)
    : config
  const selectedConfig = profileName?.trim()
    ? applyProfileForRun(presetConfig, profileName)
    : presetConfig
  const configForRun = enforceServerPermissionBoundary(selectedConfig)

  const host = new ServerHost(cwd, onEvent, {
    requestApproval,
    requestModeChange,
  })
  if (!userMessageAdmitted) {
    session.addMessage({
      role: "user",
      content,
      presetName: presetName || "Default",
    })
  }

  const toolRegistry = new ToolRegistry()

  const configuredMcp = await resolveServerMcpServers(cwd, configForRun)
  for (const diagnostic of configuredMcp.diagnostics) {
    onEvent({
      type: "error",
      error: `[plugin MCP ${diagnostic.pluginName}] ${diagnostic.message}`,
    })
  }
  const runMcpClient =
    workspaceServices?.mcpClient ?? createServerMcpClient(host)
  const ownsMcpClient = workspaceServices?.mcpClient === undefined
  const mcpPromise = (async (): Promise<{
    client: McpClient
    allowedServerNames: ReadonlySet<string>
  }> => {
    try {
      const resolved = configuredMcp.servers
      const allowedServerNames = new Set(
        resolved.map((server) => server.name),
      )
      if (resolved.length > 0) {
        process.env.CLAUDE_PROJECT_DIR = cwd
      }
      const statuses = workspaceServices?.mcpClient
        ? await runMcpClient.ensureConnected(resolved)
        : await runMcpClient.connectAll(resolved)
      for (const status of Object.values(statuses)) {
        if (status.state !== "connected" && status.state !== "disabled") {
          onEvent({
            type: "error",
            error: `[MCP ${status.name}] ${status.error ?? status.state}`,
          })
        }
      }
      return { client: runMcpClient, allowedServerNames }
    } catch (error) {
      onEvent({
        type: "error",
        error: `[MCP runtime] ${error instanceof Error ? error.message : String(error)}`,
      })
      return {
        client: runMcpClient,
        allowedServerNames: new Set<string>(),
      }
    }
  })()

  const compatibility = getClaudeCompatibilityOptions(configForRun)
  const emitDependencyDiagnostic = (error: string) =>
    onEvent({ type: "error", error })
  const rulesPromise = settleRuntimeDependency(
    "rules",
    loadAgentInstructionBundle(
      cwd,
      configForRun.rules.files,
      configForRun,
      compatibility,
    ),
    RULES_SKILLS_LOAD_TIMEOUT_MS,
    "",
    emitDependencyDiagnostic,
  )
  const skillsPromise = settleRuntimeDependency(
    "skills",
    loadSkills(
      configForRun.skills,
      cwd,
      configForRun.skillsUrls,
      compatibility,
      configForRun,
    ),
    RULES_SKILLS_LOAD_TIMEOUT_MS,
    [],
    emitDependencyDiagnostic,
  )

  const [mcpResult, rulesContent, skills] = await Promise.all([
    mcpPromise,
    rulesPromise,
    skillsPromise,
  ])

  const baseServices: NexusRunServices = workspaceServices
    ? {
        ...workspaceServices,
        mcpClient: mcpResult.client,
      }
    : createNexusRunServices({
        orchestrationRuntime: new OrchestrationRuntime(cwd),
        mcpClient: mcpResult.client,
      })
  const contributionServices = await prepareServerToolContributions({
    cwd,
    config: configForRun,
    services: baseServices,
    registry: toolRegistry,
    onDiagnostic: emitDependencyDiagnostic,
  })
  const mcpToolSnapshot = registerServerMcpCapabilities(
    toolRegistry,
    mcpResult.client,
    mcpResult.allowedServerNames,
  )
  const services: NexusRunServices = {
    ...contributionServices,
    mcpToolSnapshot,
  }

  const runtimeConfig = await finalizeConfigCredentials(
    configForRun as unknown as Record<string, unknown>,
    secretsStore,
    {
      environment: configEnvironment,
      ...(profileName?.trim()
        ? { profileName: profileName.trim() }
        : {}),
    },
  ) as unknown as NexusConfig
  const client = createLLMClient(runtimeConfig.model)

  if (!workspaceServices) {
    const maintenance = scheduleToolOutputMaintenance({
      cwd,
      services,
      onResult(result) {
        for (const diagnostic of result.errors) {
          console.warn(`[nexus] tool-output maintenance: ${diagnostic}`)
        }
      },
    })
    void maintenance?.promise.catch((error) => {
      console.warn("[nexus] tool-output maintenance failed:", error)
    })
  }
  const parallelManager = services.parallelAgentManager
  for (const tool of [
    createSpawnAgentTool(parallelManager, runtimeConfig),
    createSpawnAgentsAliasTool(parallelManager, runtimeConfig),
    createSpawnAgentOutputTool(parallelManager),
    createSpawnAgentStopTool(parallelManager),
    createListAgentRunsTool(parallelManager),
    createAgentRunSnapshotTool(parallelManager),
    createResumeAgentTool(parallelManager, runtimeConfig),
    createSpawnAgentsParallelTool(parallelManager, runtimeConfig),
  ]) {
    toolRegistry.registerDynamicOrThrow(tool, "manager compatibility")
  }
  for (const tool of [
    createTaskCreateBatchTool(parallelManager, runtimeConfig),
    createTaskSnapshotTool(parallelManager),
    createTaskResumeTool(parallelManager, runtimeConfig),
  ]) {
    toolRegistry.registerBoundBuiltinOrThrow(tool)
  }
  const { builtin, dynamic } = toolRegistry.getForMode(mode)
  const allTools = toolRegistry.mergeWithHiddenExecutionTools([...builtin, ...dynamic])
  // mode and allTools match; runAgentLoop builds system prompt and tool set from this mode

  const compaction = createCompaction()

  let checkpoint: CheckpointTracker | undefined
  if (configForRun.checkpoint.enabled) {
    checkpoint = new CheckpointTracker(session.id, cwd)
    void checkpoint.init(configForRun.checkpoint.timeoutMs).catch(() => {})
  }

  let indexer: CodebaseIndexer | undefined
  if (
    configForRun.indexing.enabled &&
    configForRun.indexing.vector &&
    configForRun.vectorDb?.enabled
  ) {
    indexer = await serverIndexerCache.get(cwd, runtimeConfig, {
      onWarning: () => {},
      maxQdrantWaitMs: 2500,
    })
  }

  let runError: unknown
  try {
    await runAgentLoop({
      session,
      client,
      host,
      config: configForRun,
      services,
      mode,
      tools: allTools,
      skills,
      rulesContent,
      indexer,
      compaction,
      signal,
      checkpoint,
    })
  } catch (error) {
    runError = error
  }

  const cleanupErrors: unknown[] = []
  if (!workspaceServices) {
    try {
      await closeNexusRunServices(services)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (ownsMcpClient) {
    try {
      await runMcpClient.disconnectAll()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (runError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [runError, ...cleanupErrors],
        "Nexus server run and cleanup both failed",
      )
    }
    throw runError
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      "Failed to close Nexus server run services",
    )
  }
}

export function applyProfileForRun(
  base: NexusConfig,
  profileName: string,
): NexusConfig {
  const name = profileName.trim()
  if (!name) return base
  const profile = base.profiles[name]
  if (!profile) {
    throw new Error(`Unknown model profile "${name}"`)
  }
  return {
    ...base,
    model: selectProviderProfile(base.model, profile),
  }
}

export async function applyPresetForRun(base: NexusConfig, cwd: string, presetName: string): Promise<NexusConfig> {
  const trimmed = presetName.trim()
  if (!trimmed || trimmed === "Default") return base
  const preset = await readPresetFromDisk(cwd, trimmed)
  if (!preset) return base
  const named = (base.mcp?.servers ?? []).map((s: unknown) => ({
    name: (s as { name?: string }).name ?? "",
    server: s,
  }))
  const selectedServers = named
    .filter((it: { name: string; server: unknown }) =>
      it.name && preset.mcpServers.includes(it.name),
    )
    .map((it: { name: string; server: unknown }) => it.server as NexusConfig["mcp"]["servers"][number])
  const next: NexusConfig = {
    ...base,
    indexing: { ...base.indexing, vector: preset.vector },
    skills: preset.skills,
    mcp: { servers: preset.mcpServers.length === 0 ? [] : selectedServers },
    rules: { files: preset.rulesFiles.length > 0 ? preset.rulesFiles : ["NEXUS.md", "AGENTS.md", "CLAUDE.md"] },
  }
  if (preset.modelProvider && preset.modelId) {
    next.model = mergeModelPresetSelection(
      base.model,
      preset.modelProvider,
      preset.modelId,
    )
  }
  return next
}

async function readPresetFromDisk(
  cwd: string,
  presetName: string
): Promise<{ name: string; vector: boolean; skills: string[]; mcpServers: string[]; rulesFiles: string[]; modelProvider?: string; modelId?: string } | null> {
  const filePath = path.join(cwd, ".nexus", "agent-configs.json")
  try {
    const raw = await fs.readFile(filePath, "utf-8")
    const parsed = JSON.parse(raw) as { presets?: unknown[]; configs?: unknown[] } | unknown[]
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { presets?: unknown[] }).presets)
        ? (parsed as { presets: unknown[] }).presets
        : Array.isArray((parsed as { configs?: unknown[] }).configs)
          ? (parsed as { configs: unknown[] }).configs
          : []
    const found = list.find((p) => p && typeof p === "object" && (p as { name?: unknown }).name === presetName) as
      | Record<string, unknown>
      | undefined
    if (!found) return null
    return {
      name: presetName,
      vector: found.vector === true,
      skills: Array.isArray(found.skills) ? (found.skills as unknown[]).filter((s): s is string => typeof s === "string") : [],
      mcpServers: Array.isArray(found.mcpServers) ? (found.mcpServers as unknown[]).filter((s): s is string => typeof s === "string") : [],
      rulesFiles: Array.isArray(found.rulesFiles) ? (found.rulesFiles as unknown[]).filter((s): s is string => typeof s === "string") : [],
      modelProvider: typeof found.modelProvider === "string" ? found.modelProvider : undefined,
      modelId: typeof found.modelId === "string" ? found.modelId : undefined,
    }
  } catch {
    return null
  }
}
