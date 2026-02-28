#!/usr/bin/env node
import { render } from "ink"
import React from "react"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import * as path from "node:path"
import * as os from "node:os"
import {
  loadConfig, Session, createLLMClient, ToolRegistry, loadSkills,
  loadRules, McpClient, setMcpClientInstance, createCompaction,
  ParallelAgentManager, createSpawnAgentTool, runAgentLoop,
  CodebaseIndexer, listSessions,
  type Mode, type AgentEvent,
} from "@nexuscode/core"
import { App } from "./tui/App.js"
import { CliHost } from "./host.js"

const argv = await yargs(hideBin(process.argv))
  .usage("$0 [mode] [message]")
  .positional("mode", {
    describe: "Agent mode: agent | plan | debug | ask",
    type: "string",
    choices: ["agent", "plan", "debug", "ask"] as const,
    default: "agent",
  })
  .option("model", {
    alias: "m",
    type: "string",
    describe: "Provider/model (e.g. anthropic/claude-sonnet-4-5, openai/gpt-4o)",
  })
  .option("max-mode", {
    type: "boolean",
    default: false,
    describe: "Enable max mode (deeper analysis with more capable model)",
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
  .option("no-index", {
    type: "boolean",
    default: false,
    describe: "Disable codebase indexing",
  })
  .option("session", {
    alias: "s",
    type: "string",
    describe: "Session ID to resume",
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
  .option("version", {
    alias: "v",
    type: "boolean",
    describe: "Show version",
  })
  .help("help")
  .alias("help", "h")
  .argv

// Handle version
if (argv.version) {
  console.log("nexus 0.1.0")
  process.exit(0)
}

const cwd = argv.project ? path.resolve(argv.project) : process.cwd()

// Load config
let config = await loadConfig(cwd)

// Apply --model override
if (argv.model) {
  const parts = argv.model.split("/")
  if (parts.length === 2) {
    config.model.provider = parts[0] as any
    config.model.id = parts[1]!
  } else {
    config.model.id = parts[0]!
  }
}

// Apply profile override
if (argv.profile && config.profiles[argv.profile]) {
  config.model = { ...config.model, ...config.profiles[argv.profile] } as any
}

// Apply max mode
if (argv["max-mode"]) {
  config.maxMode.enabled = true
}

// Determine mode
const mode = (argv._[0] as Mode) ?? "agent"
const isPrintMode = argv.print

// Get message from positional args
const messageArgs = argv._.slice(1)
const initialMessage = messageArgs.join(" ").trim() || undefined

// Init session
let session: Session
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

// Non-interactive mode
if (isPrintMode && initialMessage) {
  session.addMessage({ role: "user", content: initialMessage })

  const client = createLLMClient(config.model)
  const toolRegistry = new ToolRegistry()
  const compaction = createCompaction()
  const abortController = new AbortController()

  const host = new CliHost(cwd, (event: AgentEvent) => {
    if (event.type === "text_delta" && event.delta) {
      process.stdout.write(event.delta)
    }
    if (event.type === "error") {
      console.error(`\nError: ${event.error}`)
    }
  }, argv.auto)

  const rulesContent = await loadRules(cwd, config.rules.files).catch(() => "")
  const skills = await loadSkills(config.skills, cwd).catch(() => [])
  const { builtin: tools, dynamic } = toolRegistry.getForMode(mode)

  process.on("SIGINT", () => abortController.abort())

  await runAgentLoop({
    session,
    client,
    host,
    config,
    mode,
    tools: [...tools, ...dynamic],
    skills,
    rulesContent,
    compaction,
    signal: abortController.signal,
  })

  await session.save().catch(() => {})
  process.exit(0)
}

// Interactive TUI mode
const events = createEventStream()

const client = createLLMClient(config.model)
const maxModeClient = config.maxMode.enabled ? createLLMClient(config.maxMode) : undefined
const toolRegistry = new ToolRegistry()
const mcpClient = new McpClient()
setMcpClientInstance(mcpClient)

if (config.mcp.servers.length > 0) {
  await mcpClient.connectAll(config.mcp.servers)
  for (const tool of mcpClient.getTools()) {
    toolRegistry.register(tool)
  }
}

const parallelManager = new ParallelAgentManager()
toolRegistry.register(createSpawnAgentTool(parallelManager, config))

const rulesContent = await loadRules(cwd, config.rules.files).catch(() => "")
const skills = await loadSkills(config.skills, cwd).catch(() => [])
const compaction = createCompaction()

let indexer: CodebaseIndexer | undefined
if (config.indexing.enabled && !argv["no-index"]) {
  indexer = new CodebaseIndexer(cwd, config)
  indexer.startIndexing().catch(console.warn)
}

let currentAbortController: AbortController | null = null

const { builtin: builtinTools, dynamic: dynamicTools } = toolRegistry.getForMode(mode)
const allTools = [...builtinTools, ...dynamicTools]

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

const { push: pushEvent, iterable: eventIterable } = createEventStream()

const host = new CliHost(cwd, pushEvent, argv.auto)

async function runMessage(content: string, msgMode: Mode) {
  session.addMessage({ role: "user", content })
  currentAbortController = new AbortController()

  try {
    await runAgentLoop({
      session,
      client,
      maxModeClient,
      host,
      config,
      mode: msgMode,
      tools: allTools,
      skills,
      rulesContent,
      indexer,
      compaction,
      signal: currentAbortController.signal,
    })
    await session.save().catch(() => {})
  } catch (err) {
    if ((err as Error).message !== "AbortError") {
      pushEvent({ type: "error", error: (err as Error).message })
    }
  }
}

// If initial message provided, run it
let started = false
const startMessage = initialMessage

// Render TUI
const { unmount } = render(
  React.createElement(App, {
    onMessage: (content, msgMode) => {
      runMessage(content, msgMode).catch(console.error)
    },
    onAbort: () => currentAbortController?.abort(),
    onCompact: async () => {
      if (config) {
        const llmClient = createLLMClient(config.model)
        await compaction.compact(session, llmClient)
      }
    },
    onModeChange: (newMode) => {
      // Mode is managed in the App state
    },
    onMaxModeChange: (enabled) => {
      config.maxMode.enabled = enabled
    },
    events: eventIterable,
    initialModel: config.model.id,
    initialProvider: config.model.provider,
    initialMode: mode,
    initialMaxMode: config.maxMode.enabled,
  }),
  { exitOnCtrlC: false }
)

// Auto-run initial message
if (startMessage) {
  setTimeout(() => {
    runMessage(startMessage, mode).catch(console.error)
  }, 100)
}

process.on("SIGINT", () => {
  currentAbortController?.abort()
  setTimeout(() => {
    unmount()
    process.exit(0)
  }, 200)
})
