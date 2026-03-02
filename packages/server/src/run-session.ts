import type { Session, NexusConfig } from "@nexuscode/core"
import type { AgentEvent } from "@nexuscode/core"
import { runAgentLoop } from "@nexuscode/core"
import {
  loadConfig,
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
  CheckpointTracker,
  NexusConfigSchema,
} from "@nexuscode/core"
import { ServerHost } from "./host.js"

export interface RunSessionOptions {
  session: Session
  cwd: string
  content: string
  mode: "agent" | "plan" | "ask"
  onEvent: (event: AgentEvent) => void
  signal: AbortSignal
  configOverride?: { maxMode?: { enabled: boolean } }
}

/**
 * Run the agent loop for one message; all events are forwarded via onEvent.
 */
export async function runSession(opts: RunSessionOptions): Promise<void> {
  const { session, cwd, content, mode, onEvent, signal, configOverride } = opts

  let config = await loadConfig(cwd).catch(() => undefined)
  if (!config) config = await loadConfig(process.cwd()).catch(() => undefined)
  if (!config) config = NexusConfigSchema.parse({}) as NexusConfig
  if (configOverride?.maxMode) config.maxMode = configOverride.maxMode!

  const host = new ServerHost(cwd, onEvent)
  session.addMessage({ role: "user", content })

  const client = createLLMClient(config.model)
  const toolRegistry = new ToolRegistry()

  let mcpClient: McpClient | undefined
  try {
    mcpClient = new McpClient()
    setMcpClientInstance(mcpClient)
    await mcpClient.disconnectAll().catch(() => {})
    if (config.mcp.servers.length > 0) {
      await mcpClient.connectAll(config.mcp.servers).catch(() => {})
    }
    if (mcpClient) {
      for (const tool of mcpClient.getTools()) toolRegistry.register(tool)
    }
  } catch {}

  const parallelManager = new ParallelAgentManager()
  toolRegistry.register(createSpawnAgentTool(parallelManager, config))
  const { builtin: tools, dynamic } = toolRegistry.getForMode(mode)
  const allTools = [...tools, ...dynamic]

  const rulesContent = await loadRules(cwd, config.rules.files).catch(() => "")
  const skills = await loadSkills(config.skills, cwd).catch(() => [])
  const compaction = createCompaction()

  let checkpoint: CheckpointTracker | undefined
  if (config.checkpoint.enabled) {
    checkpoint = new CheckpointTracker(session.id, cwd)
    await checkpoint.init(config.checkpoint.timeoutMs).catch(() => {})
  }

  let indexer: Awaited<ReturnType<typeof createCodebaseIndexer>> | undefined
  if (config.indexing.enabled) {
    indexer = await createCodebaseIndexer(cwd, config, { onWarning: () => {} })
    indexer.startIndexing().catch(() => {})
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
