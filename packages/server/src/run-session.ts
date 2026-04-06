import type { Session, NexusConfig, Mode } from "@nexuscode/core"
import type { AgentEvent } from "@nexuscode/core"
import { runAgentLoop } from "@nexuscode/core"
import {
  loadConfig,
  getGlobalConfigDir,
  createFileSecretsStore,
  createLLMClient,
  ToolRegistry,
  loadRules,
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
  setParallelAgentManager,
  ParallelAgentManager,
  createCodebaseIndexer,
  McpClient,
  setMcpClientInstance,
  resolveBundledMcpServers,
  CheckpointTracker,
  NexusConfigSchema,
  getClaudeCompatibilityOptions,
} from "@nexuscode/core"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { ServerHost } from "./host.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NEXUS_ROOT = path.resolve(__dirname, "..", "..")

/** Max ms to wait for MCP connect before first message (avoids long delay when vector is off). */
const MCP_CONNECT_TIMEOUT_MS = 2500
/** Max ms to wait for loadRules + loadSkills; beyond this we start with empty rules/skills so first message is not delayed. */
const RULES_SKILLS_LOAD_TIMEOUT_MS = 2000

export interface RunSessionOptions {
  session: Session
  cwd: string
  content: string
  mode: Mode
  onEvent: (event: AgentEvent) => void
  signal: AbortSignal
  configOverride?: Record<string, unknown>
}

/**
 * Run the agent loop for one message; all events are forwarded via onEvent.
 */
export async function runSession(opts: RunSessionOptions): Promise<void> {
  const { session, cwd, content, mode, onEvent, signal, configOverride } = opts

  const secretsStore = createFileSecretsStore(getGlobalConfigDir())
  let config = await loadConfig(cwd, { secrets: secretsStore }).catch(() => undefined)
  if (!config) config = await loadConfig(process.cwd(), { secrets: secretsStore }).catch(() => undefined)
  if (!config) config = NexusConfigSchema.parse({}) as NexusConfig

  const presetName =
    configOverride && typeof (configOverride as { presetName?: unknown }).presetName === "string"
      ? String((configOverride as { presetName?: string }).presetName).trim()
      : ""
  const configForRun = presetName ? await applyPresetForRun(config, cwd, presetName) : config

  const host = new ServerHost(cwd, onEvent)
  session.addMessage({ role: "user", content, presetName: presetName || "Default" })

  const client = createLLMClient(configForRun.model)
  const toolRegistry = new ToolRegistry()

  let mcpClient: McpClient | undefined
  const mcpPromise = (async (): Promise<McpClient | undefined> => {
    try {
      const mc = new McpClient()
      setMcpClientInstance(mc)
      await mc.disconnectAll().catch(() => {})
      if (configForRun.mcp.servers.length > 0) {
        const resolved = resolveBundledMcpServers(configForRun.mcp.servers, { cwd, nexusRoot: NEXUS_ROOT })
        process.env.CLAUDE_PROJECT_DIR = cwd
        await mc.connectAll(resolved).catch(() => {})
      }
      return mc
    } catch {
      return undefined
    }
  })()
  const mcpWithTimeout =
    configForRun.mcp.servers.length > 0
      ? Promise.race([
          mcpPromise,
          new Promise<undefined>((r) => setTimeout(() => r(undefined), MCP_CONNECT_TIMEOUT_MS)),
        ])
      : mcpPromise

  const rulesAndSkillsPromise = Promise.all([
    loadRules(cwd, configForRun.rules.files, getClaudeCompatibilityOptions(configForRun)).catch(() => ""),
    loadSkills(configForRun.skills, cwd, configForRun.skillsUrls, getClaudeCompatibilityOptions(configForRun)).catch(() => []),
  ]).then(([rulesContent, skills]) => ({ type: "ok" as const, rulesContent, skills }))
  const rulesAndSkillsWithTimeout = Promise.race([
    rulesAndSkillsPromise,
    new Promise<{ type: "timeout" }>((r) =>
      setTimeout(() => r({ type: "timeout" }), RULES_SKILLS_LOAD_TIMEOUT_MS)
    ),
  ])

  const [mcpResult, rulesAndSkillsResult] = await Promise.all([mcpWithTimeout, rulesAndSkillsWithTimeout])

  const rulesContent =
    rulesAndSkillsResult.type === "ok" ? rulesAndSkillsResult.rulesContent : ""
  const skills = rulesAndSkillsResult.type === "ok" ? rulesAndSkillsResult.skills : []
  mcpClient = mcpResult ?? undefined
  if (mcpClient) {
    for (const tool of mcpClient.getTools()) toolRegistry.register(tool)
  }

  const parallelManager = new ParallelAgentManager()
  setParallelAgentManager(parallelManager)
  toolRegistry.register(createSpawnAgentTool(parallelManager, configForRun))
  toolRegistry.register(createSpawnAgentsAliasTool(parallelManager, configForRun))
  toolRegistry.register(createSpawnAgentOutputTool(parallelManager))
  toolRegistry.register(createSpawnAgentStopTool(parallelManager))
  toolRegistry.register(createListAgentRunsTool(parallelManager))
  toolRegistry.register(createAgentRunSnapshotTool(parallelManager))
  toolRegistry.register(createResumeAgentTool(parallelManager, configForRun))
  toolRegistry.register(createTaskCreateBatchTool(parallelManager, configForRun))
  toolRegistry.register(createTaskSnapshotTool(parallelManager))
  toolRegistry.register(createTaskResumeTool(parallelManager, configForRun))
  const { builtin: tools, dynamic } = toolRegistry.getForMode(mode)
  const allTools = [...tools, ...dynamic]
  // mode and allTools match; runAgentLoop builds system prompt and tool set from this mode

  const compaction = createCompaction()

  let checkpoint: CheckpointTracker | undefined
  if (configForRun.checkpoint.enabled) {
    checkpoint = new CheckpointTracker(session.id, cwd)
    void checkpoint.init(configForRun.checkpoint.timeoutMs).catch(() => {})
  }

  let indexer: Awaited<ReturnType<typeof createCodebaseIndexer>> | undefined
  if (configForRun.indexing.enabled) {
    indexer = await Promise.race([
      createCodebaseIndexer(cwd, configForRun, {
        onWarning: () => {},
        maxQdrantWaitMs: 2500,
      }),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500)),
    ])
    if (indexer) indexer.startIndexing().catch(() => {})
  }

  await runAgentLoop({
    session,
    client,
    host,
    config: configForRun,
    mode,
    tools: allTools,
    skills,
    rulesContent,
    indexer,
    compaction,
    signal,
    checkpoint,
  })
}

async function applyPresetForRun(base: NexusConfig, cwd: string, presetName: string): Promise<NexusConfig> {
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
    const provider =
      preset.modelProvider === "openrouter"
        ? "openai-compatible"
        : (preset.modelProvider as NexusConfig["model"]["provider"])
    next.model = { ...base.model, provider, id: preset.modelId }
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
