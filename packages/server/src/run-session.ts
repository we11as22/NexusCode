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
  ParallelAgentManager,
  createCodebaseIndexer,
  McpClient,
  setMcpClientInstance,
  resolveBundledMcpServers,
  CheckpointTracker,
  NexusConfigSchema,
} from "@nexuscode/core"
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

  const host = new ServerHost(cwd, onEvent)
  session.addMessage({ role: "user", content })

  const client = createLLMClient(config.model)
  const toolRegistry = new ToolRegistry()

  let mcpClient: McpClient | undefined
  const mcpPromise = (async (): Promise<McpClient | undefined> => {
    try {
      const mc = new McpClient()
      setMcpClientInstance(mc)
      await mc.disconnectAll().catch(() => {})
      if (config.mcp.servers.length > 0) {
        const resolved = resolveBundledMcpServers(config.mcp.servers, { cwd, nexusRoot: NEXUS_ROOT })
        process.env.CLAUDE_PROJECT_DIR = cwd
        await mc.connectAll(resolved).catch(() => {})
      }
      return mc
    } catch {
      return undefined
    }
  })()
  const mcpWithTimeout =
    config.mcp.servers.length > 0
      ? Promise.race([
          mcpPromise,
          new Promise<undefined>((r) => setTimeout(() => r(undefined), MCP_CONNECT_TIMEOUT_MS)),
        ])
      : mcpPromise

  const rulesAndSkillsPromise = Promise.all([
    loadRules(cwd, config.rules.files).catch(() => ""),
    loadSkills(config.skills, cwd).catch(() => []),
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
  toolRegistry.register(createSpawnAgentTool(parallelManager, config))
  const { builtin: tools, dynamic } = toolRegistry.getForMode(mode)
  const allTools = [...tools, ...dynamic]
  // mode and allTools match; runAgentLoop builds system prompt and tool set from this mode

  const compaction = createCompaction()

  let checkpoint: CheckpointTracker | undefined
  if (config.checkpoint.enabled) {
    checkpoint = new CheckpointTracker(session.id, cwd)
    void checkpoint.init(config.checkpoint.timeoutMs).catch(() => {})
  }

  let indexer: Awaited<ReturnType<typeof createCodebaseIndexer>> | undefined
  if (config.indexing.enabled) {
    indexer = await Promise.race([
      createCodebaseIndexer(cwd, config, {
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
    config,
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
