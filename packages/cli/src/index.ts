#!/usr/bin/env bun
// @opentui/core uses bun:ffi — run with Bun (nexus wrapper or: bun path/to/dist/index.js).
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import { execa } from "execa"
import {
  loadConfig, writeConfig, loadProjectSettings, Session, createLLMClient, ToolRegistry, loadSkills,
  loadRules, McpClient, setMcpClientInstance, createCompaction,
  ParallelAgentManager, createSpawnAgentTool, runAgentLoop,
  CodebaseIndexer, createCodebaseIndexer, listSessions,
  type Mode, type AgentEvent, type IndexStatus, type PermissionResult,
} from "@nexuscode/core"
import { CliHost } from "./host.js"
import { NexusServerClient } from "./server-client.js"

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
const FREE_MODELS_BASE_URL = "https://api.kilo.ai/api/gateway"

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isOpenRouterBaseUrl(value: unknown): boolean {
  return isNonEmptyString(value) && value.toLowerCase().includes("openrouter.ai")
}

function normalizeModelConfig<T extends { provider?: unknown; id?: unknown; baseUrl?: unknown }>(model: T): T {
  const next = { ...model } as T & { provider?: unknown; id?: unknown; baseUrl?: unknown }
  const provider = String(next.provider ?? "")
  if (provider === "openrouter") {
    next.provider = "openai-compatible"
    if (!isNonEmptyString(next.baseUrl)) next.baseUrl = OPENROUTER_BASE_URL
  }
  const normalizedProvider = String(next.provider ?? "")
  const modelId = String(next.id ?? "")
  if (normalizedProvider === "openai-compatible" && modelId.endsWith(":free")) {
    if (!isNonEmptyString(next.baseUrl) || isOpenRouterBaseUrl(next.baseUrl)) {
      next.baseUrl = FREE_MODELS_BASE_URL
    }
  }
  return next as T
}

const argv = await yargs(hideBin(process.argv))
  .usage("$0 [mode] [message...]")
  .version(false)
  .option("model", {
    alias: "m",
    type: "string",
    describe: "Provider/model (e.g. anthropic/claude-sonnet-4-5, openai/gpt-4o)",
  })
  .option("temperature", {
    type: "number",
    describe: "Sampling temperature (0-2)",
  })
  .option("auto", {
    type: "boolean",
    default: false,
    describe: "Auto-approve all actions (for CI/CD)",
  })
  .option("project", {
    type: "string",
    describe: "Project directory (default: current directory)",
  })
  .option("index", {
    type: "boolean",
    default: true,
    describe: "Enable codebase indexing (use --no-index to disable)",
  })
  .option("session", {
    alias: "s",
    type: "string",
    describe: "Session ID to resume",
  })
  .option("server", {
    type: "string",
    describe: "NexusCode server URL (e.g. http://127.0.0.1:4097); uses NEXUS_SERVER_URL env if set",
  })
  .option("continue", {
    alias: "c",
    type: "boolean",
    default: false,
    describe: "Continue most recent session",
  })
  .option("print", {
    alias: "p",
    type: "boolean",
    default: false,
    describe: "Non-interactive: print response and exit",
  })
  .option("profile", {
    type: "string",
    describe: "Named profile from nexus.yaml",
  })
  .option("nexus-version", {
    alias: "v",
    type: "boolean",
    describe: "Show version",
  })
  .help("help")
  .alias("help", "h")
  .argv

// Handle version
if (argv["nexus-version"]) {
  console.log("nexus 0.1.0")
  process.exit(0)
}

const cwd = argv.project ? path.resolve(argv.project) : process.cwd()
const indexEnabledFlag = Boolean((argv as Record<string, unknown>)["index"])
const serverUrl = (argv as Record<string, string>)["server"] || process.env.NEXUS_SERVER_URL || ""

// Load config
let config = await loadConfig(cwd)
// Merge project allowlist from .nexus/allowed-commands.json
try {
  const allowPath = path.join(cwd, ".nexus", "allowed-commands.json")
  const raw = await fs.readFile(allowPath, "utf8")
  const parsed = JSON.parse(raw) as { commands?: string[] }
  if (Array.isArray(parsed?.commands)) {
    config.permissions.allowedCommands = parsed.commands
  }
} catch {
  // No file or invalid JSON — keep default []
}

// Merge .nexus/settings.json + settings.local.json (like .claude)
try {
  const settings = loadProjectSettings(cwd)
  const perms = settings.permissions
  if (perms) {
    if (Array.isArray(perms.allow)) config.permissions.allowCommandPatterns = perms.allow
    if (Array.isArray(perms.deny)) config.permissions.denyCommandPatterns = perms.deny
    if (Array.isArray(perms.ask)) config.permissions.askCommandPatterns = perms.ask
  }
} catch {
  // ignore
}

// Apply --model override
if (argv.model) {
  const slashIdx = argv.model.indexOf("/")
  if (slashIdx > 0) {
    const provider = argv.model.slice(0, slashIdx)
    const modelId = argv.model.slice(slashIdx + 1)
    if (provider === "openrouter") {
      config.model.provider = "openai-compatible"
      config.model.baseUrl = config.model.baseUrl || OPENROUTER_BASE_URL
    } else {
      config.model.provider = provider as any
    }
    config.model.id = modelId
  } else {
    config.model.id = argv.model
  }
  config.model = normalizeModelConfig(config.model)
}

if (typeof argv.temperature === "number" && Number.isFinite(argv.temperature)) {
  config.model.temperature = Math.max(0, Math.min(2, argv.temperature))
}

// Apply profile override
if (argv.profile && config.profiles[argv.profile]) {
  config.model = { ...config.model, ...config.profiles[argv.profile] } as any
  config.model = normalizeModelConfig(config.model)
}

// Determine mode
const mode = (argv._[0] as Mode) ?? "agent"
const isPrintMode = argv.print

// Get message from positional args
const messageArgs = argv._.slice(1)
const initialMessage = messageArgs.join(" ").trim() || undefined

// Init session (refs allow switching session and re-rendering TUI)
const PAGE_SIZE = 100
type SessionMessage = { id: string; role: "user" | "assistant" | "system" | "tool"; content: string; ts: number }
const currentSessionIdRef: { current: string } = { current: "" }
let currentMessagesRef: { current: SessionMessage[] } = { current: [] }
let session: Session

if (serverUrl) {
  const serverClient = new NexusServerClient({ baseUrl: serverUrl, directory: cwd })
  let sessionId: string
  if (argv.continue) {
    const sessions = await serverClient.listSessions()
    sessionId = sessions[0]?.id ?? (await serverClient.createSession()).id
  } else if (argv.session) {
    sessionId = argv.session
  } else {
    sessionId = (await serverClient.createSession()).id
  }
  currentSessionIdRef.current = sessionId
  const meta = await serverClient.getSession(sessionId)
  const offset = Math.max(0, meta.messageCount - PAGE_SIZE)
  currentMessagesRef.current = await serverClient.getMessages(sessionId, { limit: PAGE_SIZE, offset })
  session = {
    get id() {
      return currentSessionIdRef.current
    },
    get messages() {
      return currentMessagesRef.current
    },
    addMessage(msg: { role: "user" | "assistant" | "system" | "tool"; content: string }) {
      currentMessagesRef.current.push({
        ...msg,
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
      })
      if (currentMessagesRef.current.length > 120) {
        currentMessagesRef.current = currentMessagesRef.current.slice(-100)
      }
    },
    getTodo: () => "",
    save: async () => {},
  } as unknown as Session
} else {
  if (argv.continue) {
    const sessions = await listSessions(cwd)
    const lastSession = sessions[0]
    if (lastSession) {
      session = await Session.resume(lastSession.id, cwd) ?? Session.create(cwd)
    } else {
      session = Session.create(cwd)
    }
  } else if (argv.session) {
    session = await Session.resume(argv.session, cwd) ?? Session.create(cwd)
  } else {
    session = Session.create(cwd)
  }
}

const sessionRef: { current: Session } = { current: session }

// Non-interactive mode
if (isPrintMode && initialMessage) {
  if (serverUrl) {
    const serverClientPrint = new NexusServerClient({ baseUrl: serverUrl, directory: cwd })
    let suppressToolMarkup = false
    try {
      for await (const event of serverClientPrint.streamMessage(session.id, initialMessage, mode)) {
        if (event.type === "text_delta" && event.delta) {
          const delta = event.delta
          if (!suppressToolMarkup && !delta.includes("<tool_call>") && !delta.includes("<function=")) {
            process.stdout.write(delta)
          }
          if (delta.includes("<tool_call>")) suppressToolMarkup = true
          if (delta.includes("</tool_call>")) suppressToolMarkup = false
        }
        if (event.type === "error") {
          process.stderr.write(`\nError: ${(event as { error: string }).error}\n`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("abort") && !msg.includes("AbortError")) {
        process.stderr.write(`\n[nexus error] ${msg}\n`)
      }
    }
    process.exit(0)
  }

  session.addMessage({ role: "user", content: initialMessage })

  const client = createLLMClient(config.model)
  const toolRegistry = new ToolRegistry()
  const mcpClientNI = new McpClient()
  setMcpClientInstance(mcpClientNI)
  if (config.mcp.servers.length > 0) {
    await mcpClientNI.connectAll(config.mcp.servers).catch(() => {})
    for (const tool of mcpClientNI.getTools()) {
      toolRegistry.register(tool)
    }
  }
  const parallelManagerNI = new ParallelAgentManager()
  toolRegistry.register(createSpawnAgentTool(parallelManagerNI, config))

  let indexer: CodebaseIndexer | undefined
  if (config.indexing.enabled && indexEnabledFlag) {
    indexer = await createCodebaseIndexer(cwd, config, {
      onWarning: (message) => {
        console.error(`\n[indexer] ${message}`)
      },
    }).catch(() => undefined)
    indexer?.startIndexing().catch(() => {})
  }

  const compaction = createCompaction()
  const abortController = new AbortController()
  const timeoutMsNI = 10 * 60_000
  const timeoutNI = setTimeout(() => {
    abortController.abort()
    process.stderr.write(`\n[nexus] timed out after ${Math.round(timeoutMsNI / 60000)} minutes\n`)
  }, timeoutMsNI)

  let suppressToolMarkupOutput = false
  const host = new CliHost(cwd, (event: AgentEvent) => {
    if (event.type === "text_delta" && event.delta) {
      const delta = event.delta
      if (suppressToolMarkupOutput || delta.includes("<tool_call>") || delta.includes("<function=") || delta.includes("<parameter=")) {
        if (delta.includes("<tool_call>")) suppressToolMarkupOutput = true
        if (delta.includes("</tool_call>")) suppressToolMarkupOutput = false
      } else {
        process.stdout.write(delta)
      }
    }
    if (event.type === "reasoning_delta" && event.delta) {
      // Show reasoning progress as dots to stderr so it doesn't pollute output
      process.stderr.write(".")
    }
    if (event.type === "tool_start") {
      process.stderr.write(`\n[tool: ${event.tool}]`)
    }
    if (event.type === "tool_end") {
      process.stderr.write(event.success ? " ✓" : " ✗")
    }
    if (event.type === "subagent_start") {
      process.stderr.write(`\n[subagent: ${event.subagentId.slice(0, 10)} ${event.mode}] ${event.task.slice(0, 80)}`)
    }
    if (event.type === "subagent_tool_start") {
      process.stderr.write(`\n[subagent tool: ${event.tool}]`)
    }
    if (event.type === "subagent_done") {
      process.stderr.write(event.success ? " ✓" : " ✗")
    }
    if (event.type === "error") {
      console.error(`\nError: ${event.error}`)
    }
    if (event.type === "done") {
      process.stderr.write("\n")
    }
  }, argv.auto)

  const rulesContent = await loadRules(cwd, config.rules.files).catch(() => "")
  const skills = await loadSkills(config.skills, cwd).catch(() => [])
  const { builtin: tools, dynamic } = toolRegistry.getForMode(mode)

  process.on("SIGINT", () => abortController.abort())

  try {
    await refreshIndexerFromGit(indexer, cwd).catch(() => {})
    await runAgentLoop({
      session,
      client,
      host,
      config,
      mode,
      tools: [...tools, ...dynamic],
      skills,
      rulesContent,
      indexer,
      compaction,
      signal: abortController.signal,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes("AbortError") && !msg.includes("Aborted")) {
      process.stderr.write(`\n[nexus error] ${msg}\n`)
    }
  } finally {
    clearTimeout(timeoutNI)
  }

  indexer?.close()
  await mcpClientNI.disconnectAll().catch(() => {})
  await session.save().catch(() => {})
  process.exit(0)
}

// Interactive TUI mode
let client = createLLMClient(config.model)
let defaultModelProfile = { ...config.model }
const toolRegistry = new ToolRegistry()
const mcpClient = new McpClient()
setMcpClientInstance(mcpClient)

if (!serverUrl) {
if (config.mcp.servers.length > 0) {
  await mcpClient.connectAll(config.mcp.servers)
  for (const tool of mcpClient.getTools()) {
    toolRegistry.register(tool)
  }
}
}

const parallelManager = new ParallelAgentManager()
if (!serverUrl) {
  toolRegistry.register(createSpawnAgentTool(parallelManager, config))
}

let rulesContent = await loadRules(cwd, config.rules.files).catch(() => "")
let skills = await loadSkills(config.skills, cwd).catch(() => [])
const compaction = createCompaction()
const { push: pushEvent, iterable: eventIterable } = createEventStream()

let indexer: CodebaseIndexer | undefined

async function rebuildIndexer(): Promise<void> {
  indexer?.close()
  indexer = undefined

  if (!config.indexing.enabled || !indexEnabledFlag) {
    pushEvent({ type: "index_update", status: { state: "idle" } })
    return
  }

  indexer = await createCodebaseIndexer(cwd, config, {
    onWarning: (message) => {
      pushEvent({ type: "error", error: message })
    },
  })
  indexer.onStatusChange((status: IndexStatus) => {
    pushEvent({ type: "index_update", status })
  })
  indexer.startIndexing().catch(console.warn)
}

if (!serverUrl) {
  try {
    await rebuildIndexer()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[nexus] Indexer init failed:", msg)
    process.exit(1)
  }
}

// TUI requires an interactive terminal
if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error("[nexus] Interactive TUI requires a TTY. Run 'nexus' from a terminal (not from a pipe or script).")
  process.exit(1)
}

let currentAbortController: AbortController | null = null

function getAllTools(activeMode: Mode) {
  const { builtin, dynamic } = toolRegistry.getForMode(activeMode)
  return [...builtin, ...dynamic]
}

async function reconnectMcpServers(): Promise<void> {
  await mcpClient.disconnectAll().catch(() => {})
  if (config.mcp.servers.length > 0) {
    await mcpClient.connectAll(config.mcp.servers).catch(() => {})
    for (const tool of mcpClient.getTools()) {
      toolRegistry.register(tool)
    }
  }
}

function createEventStream() {
  let resolve: (event: AgentEvent) => void
  let pending: AgentEvent[] = []
  let waiters: Array<(value: IteratorResult<AgentEvent>) => void> = []

  function push(event: AgentEvent) {
    if (waiters.length > 0) {
      const waiter = waiters.shift()!
      waiter({ value: event, done: false })
    } else {
      pending.push(event)
    }
  }

  const iterable: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<AgentEvent>> {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift()!, done: false })
          }
          return new Promise(resolve => waiters.push(resolve))
        },
        return() {
          return Promise.resolve({ value: undefined as any, done: true })
        },
      }
    },
  }

  return { push, iterable }
}

function saveConfig(updates: Partial<typeof config>): void {
  if (updates.model) {
    const nextModel = normalizeModelConfig({ ...config.model, ...updates.model })
    config.model = nextModel
    defaultModelProfile = { ...config.model }
    client = createLLMClient(config.model)
  }
  if (updates.embeddings) {
    const nextEmbeddings = { ...config.embeddings, ...updates.embeddings } as typeof config.embeddings
    if (nextEmbeddings && (nextEmbeddings.provider as unknown as string) === "openrouter") {
      nextEmbeddings.provider = "openai-compatible"
      nextEmbeddings.baseUrl = nextEmbeddings.baseUrl || OPENROUTER_BASE_URL
    }
    config.embeddings = nextEmbeddings
  }
  if (updates.mcp) {
    config.mcp = { ...config.mcp, ...updates.mcp }
    reconnectMcpServers().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      pushEvent({ type: "error", error: `[mcp] ${msg}` })
    })
  }
  if (updates.skills) {
    config.skills = [...updates.skills]
    loadSkills(config.skills, cwd)
      .then((loaded) => {
        skills = loaded
      })
      .catch(() => {})
  }
  if (updates.rules) {
    config.rules = { ...config.rules, ...updates.rules }
    loadRules(cwd, config.rules.files)
      .then((loaded) => {
        rulesContent = loaded
      })
      .catch(() => {})
  }
  if (updates.modes) {
    config.modes = { ...config.modes, ...updates.modes }
  }
  if (updates.profiles) {
    config.profiles = { ...config.profiles, ...updates.profiles }
  }
  if (updates.indexing) config.indexing = { ...config.indexing, ...updates.indexing }
  if (updates.vectorDb) config.vectorDb = config.vectorDb ? { ...config.vectorDb, ...updates.vectorDb } : (updates.vectorDb as any)
  writeConfig(config, cwd)

  if (updates.indexing || updates.vectorDb || updates.embeddings) {
    rebuildIndexer().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      pushEvent({ type: "error", error: `[indexer] ${msg}` })
    })
  }
}

const approvalResolveRef: { current: ((r: PermissionResult) => void) | null } = { current: null }
const host = new CliHost(cwd, pushEvent, argv.auto, approvalResolveRef)

function toErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const onUnhandledRejection = (reason: unknown) => {
  pushEvent({ type: "error", error: `[unhandledRejection] ${toErrMessage(reason)}` })
}
const onUncaughtException = (err: Error) => {
  pushEvent({ type: "error", error: `[uncaughtException] ${toErrMessage(err)}` })
}
process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

async function runMessage(content: string, msgMode: Mode) {
  sessionRef.current.addMessage({ role: "user", content })
  currentAbortController = new AbortController()
  const timeoutMs = 10 * 60_000
  const timeout = setTimeout(() => {
    currentAbortController?.abort()
    pushEvent({ type: "error", error: `Timed out after ${Math.round(timeoutMs / 60000)} minutes.` })
  }, timeoutMs)

  if (serverUrl) {
    const serverClient = new NexusServerClient({ baseUrl: serverUrl, directory: cwd })
    try {
      for await (const event of serverClient.streamMessage(
        sessionRef.current.id,
        content,
        msgMode,
        currentAbortController.signal
      )) {
        pushEvent(event)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("abort") && !msg.includes("AbortError")) {
        pushEvent({ type: "error", error: msg })
      }
    } finally {
      clearTimeout(timeout)
    }
    return
  }

  try {
    await refreshIndexerFromGit(indexer, cwd).catch(() => {})
    await runAgentLoop({
      session: sessionRef.current,
      client,
      host,
      config,
      mode: msgMode,
      tools: getAllTools(msgMode),
      skills,
      rulesContent,
      indexer,
      compaction,
      signal: currentAbortController.signal,
    })
    await sessionRef.current.save().catch(() => {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes("AbortError") && !msg.includes("Aborted")) {
      pushEvent({ type: "error", error: msg })
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function refreshIndexerFromGit(indexer: CodebaseIndexer | undefined, projectCwd: string): Promise<void> {
  if (!indexer?.refreshFileNow) return

  const runGit = async (args: string[]): Promise<string> => {
    const res = await execa("git", ["-C", projectCwd, ...args], { reject: false })
    if (res.exitCode !== 0) return ""
    return (res.stdout ?? "").trim()
  }

  const [changedTracked, changedStaged, untracked, deletedTracked, deletedStaged] = await Promise.all([
    runGit(["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"]),
    runGit(["diff", "--name-only", "--cached", "--diff-filter=ACMRTUXB"]),
    runGit(["ls-files", "--others", "--exclude-standard"]),
    runGit(["diff", "--name-only", "--diff-filter=D", "HEAD"]),
    runGit(["diff", "--name-only", "--cached", "--diff-filter=D"]),
  ])

  const changed = new Set<string>()
  const deleted = new Set<string>()
  for (const line of [changedTracked, changedStaged, untracked].join("\n").split(/\r?\n/)) {
    const p = line.trim()
    if (p) changed.add(p)
  }
  for (const line of [deletedTracked, deletedStaged].join("\n").split(/\r?\n/)) {
    const p = line.trim()
    if (p) deleted.add(p)
  }

  const all = [...changed, ...deleted].slice(0, 512)
  if (all.length === 0) return

  for (let i = 0; i < all.length; i += 16) {
    const chunk = all.slice(i, i + 16)
    await Promise.allSettled(
      chunk.map((relPath) => indexer.refreshFileNow!(path.resolve(projectCwd, relPath)))
    )
  }
}

// If initial message provided, run it
const startMessage = initialMessage

// Render TUI (OpenTUI) — lazy load so Node can run --help/--print without Bun
let renderer: Awaited<ReturnType<typeof import("@opentui/core")["createCliRenderer"]>>
let root: ReturnType<typeof import("@opentui/react")["createRoot"]>
let React: typeof import("react")
let App: typeof import("./tui/App.js").App

try {
  // Load React first so @opentui/react and App use the same instance (avoids "ReactSharedInternals.S" / duplicate React).
  const react = await import("react")
  React = react.default
  const opentuiCore = await import("@opentui/core")
  const opentuiReact = await import("@opentui/react")
  const appModule = await import("./tui/App.js")
  const { createCliRenderer } = opentuiCore
  const { createRoot } = opentuiReact
  App = appModule.App
  renderer = await createCliRenderer({ exitOnCtrlC: false })
  root = createRoot(renderer)
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? err.stack : ""
  console.error("[nexus] TUI failed to start:", msg)
  if (process.env["NEXUS_DEBUG"] && stack) console.error(stack)
  process.exit(1)
}

async function getSessionList(): Promise<Array<{ id: string; ts?: number; title?: string; messageCount: number }>> {
  if (serverUrl) {
    const serverClient = new NexusServerClient({ baseUrl: serverUrl, directory: cwd })
    return serverClient.listSessions()
  }
  return listSessions(cwd)
}

async function onSwitchSession(sessionId: string): Promise<void> {
  if (serverUrl) {
    const serverClient = new NexusServerClient({ baseUrl: serverUrl, directory: cwd })
    const meta = await serverClient.getSession(sessionId)
    const offset = Math.max(0, meta.messageCount - PAGE_SIZE)
    const messages = await serverClient.getMessages(sessionId, { limit: PAGE_SIZE, offset })
    currentSessionIdRef.current = sessionId
    currentMessagesRef.current = messages
    appProps.initialMessages = messages
    appProps.sessionId = sessionId
  } else {
    const newSession = await Session.resume(sessionId, cwd)
    if (!newSession) return
    sessionRef.current = newSession
    appProps.initialMessages = newSession.messages
    appProps.sessionId = newSession.id
  }
  root.render(React.createElement(App, appProps))
}

const appProps = {
  onExit: () => {
    renderer.destroy()
    process.exit(0)
  },
  onMessage: (content: string, msgMode: Mode) => {
    runMessage(content, msgMode).catch(console.error)
  },
  onAbort: () => currentAbortController?.abort(),
  onCompact: async () => {
    if (config) {
      const llmClient = createLLMClient(config.model)
      await compaction.compact(sessionRef.current, llmClient)
    }
  },
  onModeChange: (_newMode: Mode) => {},
  events: eventIterable,
  initialMessages: sessionRef.current.messages,
  initialModel: config.model.id,
  initialProvider: config.model.provider,
  initialMode: mode,
  sessionId: sessionRef.current.id,
  projectDir: cwd,
  profileNames: Object.keys(config.profiles ?? {}),
  onProfileSelect: (profileName?: string) => {
    if (!profileName) {
      config.model = { ...defaultModelProfile }
      client = createLLMClient(config.model)
      return
    }
    const profile = config.profiles?.[profileName]
    if (!profile) return
    config.model = { ...config.model, ...profile } as typeof config.model
    config.model = normalizeModelConfig(config.model)
    client = createLLMClient(config.model)
  },
  noIndex: !indexEnabledFlag || !!serverUrl,
  configSnapshot: {
    model: { provider: config.model.provider, id: config.model.id, temperature: config.model.temperature },
    embeddings: config.embeddings
      ? {
          provider: config.embeddings.provider,
          model: config.embeddings.model,
          dimensions: config.embeddings.dimensions,
        }
      : undefined,
    indexing: { enabled: config.indexing.enabled, vector: config.indexing.vector },
    vectorDb: config.vectorDb ? { enabled: config.vectorDb.enabled, url: config.vectorDb.url } : undefined,
    mcp: { servers: (config.mcp?.servers ?? []) as unknown as Array<Record<string, unknown>> },
    skills: config.skills ?? [],
    rules: { files: config.rules?.files ?? [] },
    modes: {
      agent: { customInstructions: config.modes?.agent?.customInstructions },
      plan: { customInstructions: config.modes?.plan?.customInstructions },
      ask: { customInstructions: config.modes?.ask?.customInstructions },
    },
    profiles: config.profiles ?? {},
  },
  saveConfig,
  onReindex: () => indexer?.reindex(),
  onIndexStop: () => indexer?.stop(),
  onIndexDelete: () => indexer?.deleteIndex(),
  onResolveApproval: (result: PermissionResult) => {
    if (approvalResolveRef.current) {
      approvalResolveRef.current(result)
      approvalResolveRef.current = null
    }
  },
  getSessionList,
  onSwitchSession,
}
root.render(React.createElement(App, appProps))

// Auto-run initial message
if (startMessage) {
  setTimeout(() => {
    runMessage(startMessage, mode).catch(console.error)
  }, 100)
}

process.on("SIGINT", () => {
  currentAbortController?.abort()
  indexer?.close()
  process.off("unhandledRejection", onUnhandledRejection)
  process.off("uncaughtException", onUncaughtException)
  setTimeout(() => {
    renderer.destroy()
    process.exit(0)
  }, 200)
})
