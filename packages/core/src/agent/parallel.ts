import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { z } from "zod"
import type {
  ToolDef,
  ToolContext,
  NexusConfig,
  Mode,
  AgentEvent,
  ISession,
  SessionMessage,
  ToolPart,
  IHost,
} from "../types.js"
import { Session } from "../session/index.js"
import { loadAgentInstructionBundle } from "../context/agent-instructions.js"
import { loadSkills } from "../skills/manager.js"
import { getClaudeCompatibilityOptions } from "../compat/claude.js"
import { ToolRegistry } from "../tools/registry.js"
import { createCompaction } from "../session/compaction.js"
import { createLLMClient } from "../provider/index.js"
import { runAgentLoop } from "./loop.js"
import { getOrchestrationRuntime, getRuntimeDir } from "../orchestration/runtime.js"
import { loadAgentDefinitions } from "../orchestration/agents.js"
import { runScopedHooks } from "../plugins/runtime.js"
import { ensureTeamMemberForTask, handleCompletedTaskSideEffects } from "../orchestration/task-lifecycle.js"
import { inheritSpillRegistryForMergedToolPart, registerToolOutputSpill } from "../context/tool-output-registry.js"
import type { NexusRunServices } from "./run-services.js"
import { atomicWriteJson } from "../storage/durable-fs.js"

export interface SubAgentResult {
  subagentId: string
  sessionId: string
  success: boolean
  output: string
  error?: string
  /** Write/Edit tool parts from the sub-agent session (merged into parent for session diff). */
  fileEditParts?: ToolPart[]
}

interface ResumeAgentOptions {
  followupInstruction?: string
  fork?: boolean
  runInBackground?: boolean
}

interface AgentSpawnOptions {
  modelOverride?: string
  taskName?: string
}

export interface SubAgentRuntimeContext {
  host: IHost
  services: NexusRunServices
}

/**
 * Delegate every capability to the owning surface. Only cwd and event routing
 * change; approvals, command policy, auth, LSP, checkpoints, and file access
 * remain under the parent host's security boundary.
 */
export function createDelegatedHost(
  parent: IHost,
  cwd: string,
  onEvent: (event: AgentEvent) => void,
): IHost {
  return new Proxy(parent, {
    get(target, property, receiver) {
      if (property === "cwd") return cwd
      if (property === "emit") return onEvent
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

async function assertDelegatedCwd(parentCwd: string, childCwd: string): Promise<void> {
  const parent = await fs.realpath(parentCwd).catch(() => path.resolve(parentCwd))
  const child = await fs.realpath(childCwd).catch(() => path.resolve(childCwd))
  const relative = path.relative(parent, child)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Delegated-agent cwd escapes the parent workspace: ${childCwd}. ` +
      "Create an approved in-workspace worktree or switch the parent workspace first.",
    )
  }
}

function findAssistantMessageIdWithToolPart(
  messages: SessionMessage[],
  toolPartId: string,
): string | undefined {
  for (const m of messages) {
    if (m.role !== "assistant") continue
    const c = m.content
    if (!Array.isArray(c)) continue
    for (const p of c) {
      if (p.type === "tool" && (p as ToolPart).id === toolPartId) return m.id
    }
  }
  return undefined
}

function collectCompletedWriteEditParts(messages: SessionMessage[]): ToolPart[] {
  const out: ToolPart[] = []
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const c = msg.content
    if (!Array.isArray(c)) continue
    for (const p of c) {
      if (p.type !== "tool") continue
      const tp = p as ToolPart
      if (
        (tp.tool === "Write" || tp.tool === "Edit") &&
        tp.status === "completed" &&
        tp.path
      ) {
        out.push(tp)
      }
    }
  }
  return out
}

function latestAssistantText(messages: SessionMessage[]): string {
  const message = [...messages].reverse().find((item) => item.role === "assistant")
  if (!message) return ""
  if (typeof message.content === "string") return message.content.trim()
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
}

function mergeSubagentFileEditsIntoParentSession(
  parent: ISession,
  spawnToolPartId: string | undefined,
  parts: ToolPart[],
  fallbackAssistantMessageId?: string,
  /** Ephemeral subagent session id — used to inherit spill registry keys onto cloned part ids. */
  subagentSessionId?: string,
): void {
  if (parts.length === 0) return
  let msgId = spawnToolPartId
    ? findAssistantMessageIdWithToolPart(parent.messages, spawnToolPartId)
    : undefined
  if (!msgId && fallbackAssistantMessageId) {
    const m = parent.messages.find((x) => x.id === fallbackAssistantMessageId)
    if (m?.role === "assistant") msgId = m.id
  }
  if (!msgId) return
  for (const tp of parts) {
    const clone: ToolPart = {
      ...tp,
      id: `part_${crypto.randomBytes(8).toString("hex")}`,
      mergedFromSubagent: true,
    }
    if (subagentSessionId?.trim()) {
      const spill = inheritSpillRegistryForMergedToolPart({
        parentSessionId: parent.id,
        newPartId: clone.id,
        subagentSessionId: subagentSessionId.trim(),
        sourcePartId: tp.id,
        toolName: clone.tool,
        outputSpillPath: clone.outputSpillPath,
      })
      if (spill) clone.outputSpillPath = spill
    } else if (clone.outputSpillPath?.trim()) {
      registerToolOutputSpill({
        sessionId: parent.id,
        partId: clone.id,
        absolutePath: clone.outputSpillPath.trim(),
        toolName: clone.tool,
      })
    }
    parent.addToolPart(msgId, clone)
  }
}

type SubAgentStatus = "running" | "completed" | "error" | "killed"

interface SubAgentSnapshot {
  subagentId: string
  sessionId: string
  status: SubAgentStatus
  output: string
  error?: string
}

async function writeSubagentSnapshot(args: {
  cwd: string
  subagentId: string
  sessionId: string
  description: string
  mode: Mode
  contextSummary?: string
  parentPartId?: string
  depth: number
  parentSubagentId?: string
  success: boolean
  output: string
  error?: string
  messages: SessionMessage[]
}): Promise<string> {
  const dir = path.join(getRuntimeDir(args.cwd), "agent-runs")
  await fs.mkdir(dir, { recursive: true })
  const snapshotPath = path.join(dir, `${args.subagentId}.json`)
  await atomicWriteJson(snapshotPath, {
    subagentId: args.subagentId,
    sessionId: args.sessionId,
    description: args.description,
    mode: args.mode,
    contextSummary: args.contextSummary,
    parentPartId: args.parentPartId,
    depth: args.depth,
    parentSubagentId: args.parentSubagentId,
    success: args.success,
    output: args.output,
    error: args.error,
    messageCount: args.messages.length,
    messages: args.messages,
  })
  return snapshotPath
}

/**
 * Manager for parallel sub-agents.
 * Each sub-agent runs its own isolated session and agent loop.
 *
 * Concurrency model: each promise added to `this.running` removes itself
 * via `.finally()`, so after `await Promise.race(...)` at least one slot
 * is guaranteed to be free (the race resolves in a microtask, `.finally`
 * queues in the next microtask, `await Promise.resolve()` drains them).
 */
export class ParallelAgentManager {
  private running = new Map<string, Promise<SubAgentResult>>()
  private sessions = new Map<string, string>()
  private outputById = new Map<string, string>()
  private statusById = new Map<string, SubAgentStatus>()
  private errorById = new Map<string, string | undefined>()
  private controllers = new Map<string, AbortController>()
  private liveSessions = new Map<string, ISession>()
  private aliases = new Map<string, string>()
  private history: string[] = []
  private static readonly HISTORY_CAP = 100

  private rememberId(subagentId: string): void {
    this.history.push(subagentId)
    if (this.history.length > ParallelAgentManager.HISTORY_CAP) {
      const evict = this.history.shift()
      if (evict) {
        this.sessions.delete(evict)
        this.outputById.delete(evict)
        this.statusById.delete(evict)
        this.errorById.delete(evict)
        this.controllers.delete(evict)
        this.liveSessions.delete(evict)
        for (const [alias, id] of this.aliases) {
          if (id === evict) this.aliases.delete(alias)
        }
      }
    }
  }

  private startTask(
    description: string,
    mode: Mode,
    config: NexusConfig,
    cwd: string,
    signal: AbortSignal,
    maxParallel: number,
    emit?: (event: AgentEvent) => void,
    contextSummary?: string,
    parentPartId?: string,
    agentType?: string,
    spawnOptions?: AgentSpawnOptions,
    runtimeContext?: SubAgentRuntimeContext,
  ): Promise<{ subagentId: string; task: Promise<SubAgentResult> }> {
    return (async () => {
      if (!runtimeContext) {
        throw new Error("Delegated agents require the parent host and run services.")
      }
      if (signal.aborted) {
        throw new Error("Cannot start a delegated agent from an aborted run.")
      }
      await assertDelegatedCwd(runtimeContext.host.cwd, cwd)
      const parentDepth = runtimeContext.services.subagentDepth
      const maxDepth = config.parallelAgents.maxDepth ?? 2
      if (parentDepth >= maxDepth) {
        throw new Error(
          `Delegated-agent depth limit reached (${parentDepth}/${maxDepth}). ` +
          "Finish this task in the current agent or return it to the parent.",
        )
      }
      // Wait for a concurrency slot
      while (this.running.size >= maxParallel) {
        if (parentDepth > 0) {
          throw new Error(
            `No delegated-agent capacity is available (${this.running.size}/${maxParallel}). ` +
            "Nested delegation fails fast to avoid a parent/child pool deadlock.",
          )
        }
        await Promise.race([...this.running.values()]).catch(() => {})
        // Flush the microtask queue so .finally() cleanup handlers run
        // before we re-check .size
        await Promise.resolve()
      }

      const subagentId = `subagent_${crypto.randomUUID()}`
      this.rememberId(subagentId)
      this.outputById.set(subagentId, "")
      this.statusById.set(subagentId, "running")
      this.errorById.set(subagentId, undefined)
      if (spawnOptions?.taskName?.trim()) {
        this.aliases.set(spawnOptions.taskName.trim(), subagentId)
      }

      const localController = new AbortController()
      this.controllers.set(subagentId, localController)
      const abortChild = () => localController.abort()
      if (signal.aborted) abortChild()
      else signal.addEventListener("abort", abortChild, { once: true })

      emit?.({
        type: "subagent_start",
        subagentId,
        mode,
        task: description,
        parentPartId,
        depth: parentDepth + 1,
        ...(runtimeContext.services.subagentId
          ? { parentSubagentId: runtimeContext.services.subagentId }
          : {}),
      })

      // The task self-removes from the map when it settles (success or error).
      // This is what makes the while-loop above eventually terminate.
      const task = this.runSubAgent(
        subagentId,
        description,
        mode,
        config,
        cwd,
        localController.signal,
        emit,
        contextSummary,
        parentPartId,
        agentType,
        spawnOptions,
        runtimeContext,
      ).finally(() => {
        signal.removeEventListener("abort", abortChild)
        this.running.delete(subagentId)
        this.controllers.delete(subagentId)
        this.liveSessions.delete(subagentId)
        for (const [alias, id] of this.aliases) {
          if (id === subagentId) this.aliases.delete(alias)
        }
      })

      this.running.set(subagentId, task)
      return { subagentId, task }
    })()
  }

  async spawn(
    description: string,
    mode: Mode = "agent",
    config: NexusConfig,
    cwd: string,
    signal: AbortSignal,
    maxParallel: number,
    emit?: (event: AgentEvent) => void,
    contextSummary?: string,
    parentPartId?: string,
    agentType?: string,
    spawnOptions?: AgentSpawnOptions,
    runtimeContext?: SubAgentRuntimeContext,
  ): Promise<SubAgentResult> {
    const { task } = await this.startTask(
      description,
      mode,
      config,
      cwd,
      signal,
      maxParallel,
      emit,
      contextSummary,
      parentPartId,
      agentType,
      spawnOptions,
      runtimeContext,
    )
    return task
  }

  async spawnInBackground(
    description: string,
    mode: Mode,
    config: NexusConfig,
    cwd: string,
    signal: AbortSignal,
    maxParallel: number,
    emit?: (event: AgentEvent) => void,
    contextSummary?: string,
    parentPartId?: string,
    agentType?: string,
    spawnOptions?: AgentSpawnOptions,
    runtimeContext?: SubAgentRuntimeContext,
  ): Promise<{ subagentId: string }> {
    const { subagentId } = await this.startTask(
      description,
      mode,
      config,
      cwd,
      signal,
      maxParallel,
      emit,
      contextSummary,
      parentPartId,
      agentType,
      spawnOptions,
      runtimeContext,
    )
    const runtime = await getOrchestrationRuntime(cwd)
    await runtime.registerBackgroundTask({
      id: subagentId,
      kind: "subagent",
      description,
      status: "running",
      metadata: {
        mode,
        ...(agentType ? { agentType } : {}),
        ...(spawnOptions?.modelOverride ? { model: spawnOptions.modelOverride } : {}),
        ...(spawnOptions?.taskName ? { name: spawnOptions.taskName } : {}),
        ...(contextSummary ? { contextSummary } : {}),
        ...(parentPartId ? { parentPartId } : {}),
        depth: (runtimeContext?.services.subagentDepth ?? 0) + 1,
        ...(runtimeContext?.services.subagentId
          ? { parentSubagentId: runtimeContext.services.subagentId }
          : {}),
      },
    })
    emit?.({
      type: "background_task_updated",
      task: (await runtime.getBackgroundTask(subagentId))!,
    })
    return { subagentId }
  }

  getSnapshot(subagentId: string): SubAgentSnapshot | null {
    const sessionId = this.sessions.get(subagentId) ?? ""
    const status = this.statusById.get(subagentId)
    const output = this.outputById.get(subagentId) ?? ""
    const error = this.errorById.get(subagentId)
    if (!status && !this.running.has(subagentId) && !sessionId && !output) return null
    const normalizedStatus: SubAgentStatus = status ?? (this.running.has(subagentId) ? "running" : "completed")
    return {
      subagentId,
      sessionId,
      status: normalizedStatus,
      output,
      ...(error ? { error } : {}),
    }
  }

  async waitFor(subagentId: string): Promise<SubAgentSnapshot | null> {
    const running = this.running.get(subagentId)
    if (running) {
      await running.catch(() => {})
    }
    return this.getSnapshot(subagentId)
  }

  stop(subagentId: string): boolean {
    const ctrl = this.controllers.get(subagentId)
    if (!ctrl) return false
    this.statusById.set(subagentId, "killed")
    this.errorById.set(subagentId, "Stopped by parent agent.")
    ctrl.abort()
    return true
  }

  /** Inject a queued user message into a currently running delegated agent. */
  deliverMessage(target: string, message: string, from = "main"): boolean {
    const resolved = this.aliases.get(target) ?? target
    const session = this.liveSessions.get(resolved)
    if (!session || !message.trim()) return false
    session.addMessage({
      role: "user",
      content: `[Message from ${from.trim() || "main"}]\n${message.trim()}`,
    })
    return true
  }

  async listRuns(cwd: string) {
    const runtime = await getOrchestrationRuntime(cwd)
    return (await runtime.listBackgroundTasks())
      .filter((task) => task.kind === "subagent")
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async resume(
    subagentId: string,
    options: ResumeAgentOptions,
    config: NexusConfig,
    cwd: string,
    signal: AbortSignal,
    maxParallel: number,
    emit?: (event: AgentEvent) => void,
    parentPartId?: string,
    runtimeContext?: SubAgentRuntimeContext,
  ): Promise<SubAgentResult | { subagentId: string; background: true }> {
    const runtime = await getOrchestrationRuntime(cwd)
    const existing = await runtime.getBackgroundTask(subagentId)
    if (!existing || existing.kind !== "subagent") {
      throw new Error(`Sub-agent run not found: ${subagentId}`)
    }
    const mode = ((existing.metadata?.mode as Mode | undefined) ?? "agent")
    const agentType = typeof existing.metadata?.agentType === "string"
      ? existing.metadata.agentType
      : undefined
    const originalDescription = String(existing.description || existing.metadata?.description || "").trim()
    const previousOutput = String(existing.output || "").trim()
    const contextSummary = typeof existing.metadata?.contextSummary === "string"
      ? existing.metadata.contextSummary
      : undefined
    const resumeDescription = [
      options.fork ? "Fork from the following earlier sub-agent run." : "Continue the following earlier sub-agent run.",
      originalDescription ? `Original task:\n${originalDescription}` : "",
      previousOutput ? `Previous output:\n${previousOutput.slice(0, 5000)}` : "",
      options.followupInstruction?.trim()
        ? `New instruction:\n${options.followupInstruction.trim()}`
        : "New instruction:\nReview the previous result, continue from it, and finish the task cleanly.",
    ].filter(Boolean).join("\n\n")

    if (options.runInBackground) {
      const started = await this.spawnInBackground(
        resumeDescription,
        mode,
        config,
        cwd,
        signal,
        maxParallel,
        emit,
        contextSummary,
        parentPartId,
        agentType,
        undefined,
        runtimeContext,
      )
      await runtime.updateBackgroundTask(started.subagentId, {
        metadata: {
          ...(await runtime.getBackgroundTask(started.subagentId))?.metadata,
          ...(options.fork ? { forkOf: subagentId } : { resumeOf: subagentId }),
        },
      }).catch(() => null)
      return { subagentId: started.subagentId, background: true }
    }

    const result = await this.spawn(
      resumeDescription,
      mode,
      config,
      cwd,
      signal,
      maxParallel,
      emit,
      contextSummary,
      parentPartId,
      agentType,
      undefined,
      runtimeContext,
    )
    return result
  }

  private async runSubAgent(
    subagentId: string,
    description: string,
    mode: Mode,
    config: NexusConfig,
    cwd: string,
    signal: AbortSignal,
    emit?: (event: AgentEvent) => void,
    contextSummary?: string,
    parentPartId?: string,
    agentType?: string,
    spawnOptions?: AgentSpawnOptions,
    runtimeContext?: SubAgentRuntimeContext,
  ): Promise<SubAgentResult> {
    if (!runtimeContext) {
      throw new Error("Delegated agents require the parent host and run services.")
    }
    const session = Session.createEphemeral(cwd)
    this.sessions.set(subagentId, session.id)
    this.liveSessions.set(subagentId, session)
    const depth = runtimeContext.services.subagentDepth + 1
    const parentSubagentId = runtimeContext.services.subagentId
    const runtime = await getOrchestrationRuntime(cwd)
    const existingRuntimeTask = await runtime.getBackgroundTask(subagentId)
    if (!existingRuntimeTask) {
      await runtime.registerBackgroundTask({
        id: subagentId,
        kind: "subagent",
        description,
        status: "running",
        metadata: {
          mode,
          ...(agentType ? { agentType } : {}),
          ...(spawnOptions?.modelOverride ? { model: spawnOptions.modelOverride } : {}),
          ...(spawnOptions?.taskName ? { name: spawnOptions.taskName } : {}),
          description,
          ...(contextSummary ? { contextSummary } : {}),
          ...(parentPartId ? { parentPartId } : {}),
          depth,
          ...(parentSubagentId ? { parentSubagentId } : {}),
        },
      })
    }
    await runtime.updateBackgroundTask(subagentId, {
      sessionId: session.id,
      metadata: {
        mode,
        ...(agentType ? { agentType } : {}),
        ...(spawnOptions?.modelOverride ? { model: spawnOptions.modelOverride } : {}),
        ...(spawnOptions?.taskName ? { name: spawnOptions.taskName } : {}),
        description,
        ...(contextSummary ? { contextSummary } : {}),
        ...(parentPartId ? { parentPartId } : {}),
        depth,
        ...(parentSubagentId ? { parentSubagentId } : {}),
      },
    }).catch(() => null)
    let userContent = contextSummary?.trim()
      ? `${contextSummary}\n\n---\n\nTask: ${description}`
      : description

    const taskConfig =
      spawnOptions?.modelOverride
        ? {
            ...config,
            model: {
              ...config.model,
              id: spawnOptions.modelOverride,
            },
          }
        : config

    const client = createLLMClient(taskConfig.model)

    const toolRegistry = new ToolRegistry()
    const services: NexusRunServices = {
      ...runtimeContext.services,
      parallelAgentManager: this,
      subagentDepth: runtimeContext.services.subagentDepth + 1,
      subagentId,
    }
    for (const tool of services.mcpClient?.getTools() ?? []) {
      toolRegistry.registerDynamicOrThrow(tool, "inherited MCP")
    }
    for (const tool of [
      createSpawnAgentTool(this, taskConfig),
      createSpawnAgentsAliasTool(this, taskConfig),
      createSpawnAgentOutputTool(this),
      createSpawnAgentStopTool(this),
      createListAgentRunsTool(this),
      createAgentRunSnapshotTool(this),
      createResumeAgentTool(this, taskConfig),
    ]) {
      toolRegistry.registerDynamicOrThrow(tool, "manager compatibility")
    }
    for (const tool of [
      createTaskCreateBatchTool(this, taskConfig),
      createTaskSnapshotTool(this),
      createTaskResumeTool(this, taskConfig),
    ]) {
      toolRegistry.registerBoundBuiltinOrThrow(tool)
    }
    const claudeCompatibility = getClaudeCompatibilityOptions(taskConfig)
    const agentDefinition = agentType
      ? (await loadAgentDefinitions(cwd, claudeCompatibility, taskConfig))
          .find((candidate) => candidate.agentType.toLowerCase() === agentType.toLowerCase())
      : undefined
    if (agentDefinition?.systemPrompt?.trim()) {
      userContent =
        `${userContent}\n\n---\n\nAgent role (${agentDefinition.agentType}):\n${agentDefinition.systemPrompt.trim()}`
    }
    session.addMessage({ role: "user", content: userContent })

    let { builtin: b, dynamic: d } = toolRegistry.getForMode(mode)
    let tools = toolRegistry.mergeWithHiddenExecutionTools([...b, ...d])
    const parentSurfaceMutationTools = new Set([
      "EnterPlanMode",
      "EnterWorktree",
      "ExitWorktree",
    ])
    tools = tools.filter((tool) => !parentSurfaceMutationTools.has(tool.name))
    if (agentDefinition?.tools?.length) {
      const allow = new Set(agentDefinition.tools)
      tools = tools.filter((tool) => allow.has(tool.name))
    }
    if (agentDefinition?.disallowedTools?.length) {
      const deny = new Set(agentDefinition.disallowedTools)
      tools = tools.filter((tool) => !deny.has(tool.name))
    }

    const rulesContent = await loadAgentInstructionBundle(cwd, taskConfig.rules.files, taskConfig, claudeCompatibility)
    const skills = await loadSkills(
      taskConfig.skills,
      cwd,
      taskConfig.skillsUrls,
      claudeCompatibility,
      taskConfig,
    )
    const compaction = createCompaction()

    let output = ""
    const manager = this
    let lastProgressEmitAt = 0

    const emitTaskProgress = async (preview?: string) => {
      const now = Date.now()
      if (now - lastProgressEmitAt < 1200) return
      lastProgressEmitAt = now
      const latestTask = await runtime.getTask(subagentId)
      if (!latestTask) return
      emit?.({
        type: "task_progress",
        task: latestTask,
        outputPreview: preview ?? latestTask.output?.slice(0, 300),
      })
    }

    const delegatedHost = createDelegatedHost(
      runtimeContext.host,
      cwd,
      (event: AgentEvent) => {
        if (event.type === "text_delta" && event.delta) {
          output += event.delta
          manager.outputById.set(subagentId, output)
          void runtime
            .updateTask(subagentId, { output })
            .then(() => emitTaskProgress(output.slice(-300)))
            .catch(() => null)
        }
        if (event.type === "tool_start") {
          emit?.({
            type: "task_tool_start",
            taskId: subagentId,
            taskKind: "agent",
            tool: event.tool,
            input: event.input,
            parentPartId,
          })
          emit?.({
            type: "subagent_tool_start",
            subagentId,
            tool: event.tool,
            input: event.input,
            parentPartId,
          })
        }
        if (event.type === "tool_end") {
          void emitTaskProgress(output.slice(-300))
          emit?.({
            type: "task_tool_end",
            taskId: subagentId,
            taskKind: "agent",
            tool: event.tool,
            success: event.success,
            parentPartId,
          })
          emit?.({
            type: "subagent_tool_end",
            subagentId,
            tool: event.tool,
            success: event.success,
            parentPartId,
          })
        }
        if (event.type === "error") {
          emit?.({
            type: "error",
            error: `[subagent ${subagentId}] ${event.error}`,
            fatal: event.fatal,
          })
        }
        if (
          event.type === "tool_approval_needed" ||
          event.type === "question_request" ||
          event.type === "plugin_hook"
        ) {
          emit?.(event)
        }
      },
    )

    try {
      if (agentDefinition?.hooks?.length && agentDefinition.sourcePath) {
        const startHookResults = await runScopedHooks(
          cwd,
          delegatedHost,
          "subagent_start",
          {
            subagentId,
            sessionId: session.id,
            description,
            mode,
            agentType: agentDefinition.agentType,
          },
          [{
            name: `agent:${agentDefinition.agentType}`,
            rootDir: path.dirname(agentDefinition.sourcePath),
            hooks: agentDefinition.hooks,
          }],
        )
        const additionalContexts = startHookResults
          .map((result) => result.additionalContext?.trim())
          .filter((value): value is string => Boolean(value))
        if (additionalContexts.length > 0) {
          session.addMessage({ role: "user", content: additionalContexts.join("\n\n") })
        }
      }

      await runAgentLoop({
        session,
        client,
        host: delegatedHost,
        config: taskConfig,
        services,
        mode,
        tools,
        skills,
        rulesContent,
        compaction,
        signal,
      })
      if (signal.aborted) {
        throw new Error("Sub-agent stopped by parent agent.")
      }
      if (!output.trim()) output = latestAssistantText(session.messages)
      emit?.({
        type: "subagent_done",
        subagentId,
        success: true,
        outputPreview: output.slice(0, 300),
        parentPartId,
      })
      this.outputById.set(subagentId, output)
      this.statusById.set(subagentId, "completed")
      this.errorById.set(subagentId, undefined)
      const snapshotFile = await writeSubagentSnapshot({
        cwd,
        subagentId,
        sessionId: session.id,
        description,
        mode,
        contextSummary,
        parentPartId,
        depth,
        parentSubagentId,
        success: true,
        output,
        messages: session.messages,
      })
      const runtimeTask = await runtime.setBackgroundTaskStatus(subagentId, "completed", {
        sessionId: session.id,
        output,
        metadata: {
          ...(existingRuntimeTask?.metadata ?? {}),
          mode,
          ...(agentType ? { agentType } : {}),
          ...(spawnOptions?.modelOverride ? { model: spawnOptions.modelOverride } : {}),
          ...(spawnOptions?.taskName ? { name: spawnOptions.taskName } : {}),
          description,
          ...(contextSummary ? { contextSummary } : {}),
          ...(parentPartId ? { parentPartId } : {}),
          depth,
          ...(parentSubagentId ? { parentSubagentId } : {}),
          snapshotFile,
        },
      }).catch(() => null)
      if (runtimeTask) {
        emit?.({ type: "background_task_updated", task: runtimeTask })
        const unified = await runtime.getTask(subagentId)
        if (unified) {
          await ensureTeamMemberForTask({
            cwd,
            host: delegatedHost,
            task: unified,
            agentId: subagentId,
            agentType,
          })
          emit?.({ type: "task_updated", task: unified })
          emit?.({ type: "task_completed", task: unified, outputPreview: output.slice(0, 300) })
          await handleCompletedTaskSideEffects({
            cwd,
            host: delegatedHost,
            config: taskConfig,
            task: unified,
            outputPreview: output.slice(0, 300),
          })
        }
      }
      if (agentDefinition?.hooks?.length && agentDefinition.sourcePath) {
        await runScopedHooks(
          cwd,
          delegatedHost,
          "subagent_stop",
          {
            subagentId,
            sessionId: session.id,
            description,
            success: true,
            output,
            mode,
            agentType: agentDefinition.agentType,
          },
          [{
            name: `agent:${agentDefinition.agentType}`,
            rootDir: path.dirname(agentDefinition.sourcePath),
            hooks: agentDefinition.hooks,
          }],
        )
      }
      const fileEditParts = collectCompletedWriteEditParts(session.messages)
      return {
        subagentId,
        sessionId: session.id,
        success: true,
        output,
        fileEditParts,
      }
    } catch (err) {
      const killed = signal.aborted || this.statusById.get(subagentId) === "killed"
      const error = killed
        ? "Stopped by parent agent."
        : err instanceof Error
          ? err.message
          : String(err)
      emit?.({
        type: "subagent_done",
        subagentId,
        success: false,
        outputPreview: output.slice(0, 300),
        error,
        parentPartId,
      })
      this.outputById.set(subagentId, output || "")
      this.statusById.set(subagentId, killed ? "killed" : "error")
      this.errorById.set(subagentId, error)
      const snapshotFile = await writeSubagentSnapshot({
        cwd,
        subagentId,
        sessionId: session.id,
        description,
        mode,
        contextSummary,
        parentPartId,
        depth,
        parentSubagentId,
        success: false,
        output: output || "",
        error,
        messages: session.messages,
      })
      const runtimeTask = await runtime.setBackgroundTaskStatus(
        subagentId,
        killed ? "killed" : "failed",
        {
        sessionId: session.id,
        output: output || "",
        error,
        metadata: {
          ...(existingRuntimeTask?.metadata ?? {}),
          mode,
          ...(agentType ? { agentType } : {}),
          ...(spawnOptions?.modelOverride ? { model: spawnOptions.modelOverride } : {}),
          ...(spawnOptions?.taskName ? { name: spawnOptions.taskName } : {}),
          description,
          ...(contextSummary ? { contextSummary } : {}),
          ...(parentPartId ? { parentPartId } : {}),
          depth,
          ...(parentSubagentId ? { parentSubagentId } : {}),
          snapshotFile,
        },
        },
      ).catch(() => null)
      if (runtimeTask) {
        emit?.({ type: "background_task_updated", task: runtimeTask })
        const unified = await runtime.getTask(subagentId)
        if (unified) {
          await ensureTeamMemberForTask({
            cwd,
            host: delegatedHost,
            task: unified,
            agentId: subagentId,
            agentType,
          })
          emit?.({ type: "task_updated", task: unified })
          emit?.({ type: "task_completed", task: unified, outputPreview: output.slice(0, 300) })
          await handleCompletedTaskSideEffects({
            cwd,
            host: delegatedHost,
            config: taskConfig,
            task: unified,
            outputPreview: output.slice(0, 300),
          })
        }
      }
      if (agentDefinition?.hooks?.length && agentDefinition.sourcePath) {
        await runScopedHooks(
          cwd,
          delegatedHost,
          "subagent_stop",
          {
            subagentId,
            sessionId: session.id,
            description,
            success: false,
            output: output || "",
            error,
            mode,
            agentType: agentDefinition.agentType,
          },
          [{
            name: `agent:${agentDefinition.agentType}`,
            rootDir: path.dirname(agentDefinition.sourcePath),
            hooks: agentDefinition.hooks,
          }],
        )
      }
      return {
        subagentId,
        sessionId: session.id,
        success: false,
        output: output || "",
        error,
        fileEditParts: collectCompletedWriteEditParts(session.messages),
      }
    }
  }

  /** How many agents are currently running */
  get activeCount(): number {
    return this.running.size
  }
}

const spawnSchema = z
  .object({
    description: z.string().min(1).describe("Task description for this single sub-agent."),
    agent_type: z.string().optional().describe("Optional named agent definition to apply."),
    context_summary: z.string().optional().describe("Optional brief context for this task (e.g. background, relevant files)."),
    mode: z.enum(["agent", "plan", "ask", "debug", "review", "search", "explore"]).optional().describe("Mode for this sub-agent (default: agent). 'search'/'explore' → ask."),
    run_in_background: z.boolean().optional().describe("Set true to start sub-agent in background and continue immediately. Use SpawnAgentOutput to poll status/output."),
    task_progress: z.string().optional(),
  })
  .strict()

const spawnOutputSchema = z
  .object({
    subagent_id: z.string().min(1).describe("ID returned by SpawnAgent when run_in_background is true."),
    block: z.boolean().optional().describe("When true, wait until the sub-agent finishes; when false, return current status immediately (default: true)."),
  })
  .strict()

const spawnStopSchema = z
  .object({
    subagent_id: z.string().min(1).describe("Background sub-agent ID to stop."),
  })
  .strict()

const listAgentRunsSchema = z.object({
  limit: z.number().int().positive().max(50).optional().describe("Maximum number of runs to show."),
})

const agentRunSnapshotSchema = z.object({
  subagent_id: z.string().min(1).describe("Existing sub-agent id."),
  format: z.enum(["summary", "json"]).optional().describe("Response format. summary is the default."),
})

const resumeAgentSchema = z.object({
  subagent_id: z.string().min(1).describe("Existing sub-agent id to resume or fork."),
  instruction: z.string().optional().describe("Optional follow-up instruction for the resumed agent."),
  fork: z.boolean().optional().describe("When true, fork from the prior run instead of continuing it."),
  run_in_background: z.boolean().optional().describe("Resume in background and return immediately."),
})

const taskResumeSchema = z.object({
  task_id: z.string().min(1).describe("Existing agent task id to resume or fork."),
  instruction: z.string().optional().describe("Optional follow-up instruction for the resumed task."),
  fork: z.boolean().optional().describe("When true, fork from the prior task instead of continuing it."),
  block: z.boolean().optional().describe("When true, wait for the resumed task to finish before returning. Defaults to false."),
})

const taskSnapshotSchema = z.object({
  task_id: z.string().min(1).describe("Existing task id."),
  format: z.enum(["summary", "json"]).optional().describe("Response format. summary is the default."),
})

const taskCreateBatchSchema = z.object({
  tasks: z
    .array(
      z.object({
        description: z.string().min(1).describe("Task description for this delegated agent task."),
        agent_type: z.string().optional().describe("Optional named agent definition to apply."),
        context_summary: z.string().optional().describe("Optional brief context for this task."),
        mode: z.enum(["agent", "plan", "ask", "debug", "review", "search", "explore"]).optional().describe("Mode for this delegated task."),
      }),
    )
    .min(2)
    .describe("Delegated agent tasks to launch concurrently."),
  block: z.boolean().optional().describe("When true, wait for all delegated tasks to finish before returning. Defaults to true."),
})

export function createSpawnAgentTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef {
  const schema = spawnSchema

  return {
    name: "SpawnAgent",
    hiddenFromAgent: true,
    description: `Legacy execution only — hidden from the model. Prefer \`TaskCreate(kind: "agent")\` / \`TaskCreateBatch\` in new work.

Launch one delegated sub-agent (same engine as task runtime).

**When the main agent is in plan, ask, or review mode**, sub-agents run with ask (read-only) permissions.
**When the main agent is in agent/debug mode**, sub-agents follow \`mode\` / agent definition.
\`agent_type\` applies named definitions from \`.nexus/agents/\` or compatible paths.
Background: \`run_in_background: true\` → wait with \`TaskOutput({ taskId, block: true })\` (id matches sub-agent task id).
Max ${config.parallelAgents.maxParallel} concurrent agents (${manager.activeCount} active).`,
    parameters: schema,
    // Available in all modes; sub-agent permissions follow parent (plan/ask/review → ask, agent/debug → requested mode)

    async execute(
      args: {
        description: string
        agent_type?: string
        context_summary?: string
        mode?: Mode | "search" | "explore"
        run_in_background?: boolean
        task_progress?: string
      },
      ctx: ToolContext,
    ) {
      const parentMode = ctx.mode ?? "agent"
      const resolveAgentDefinition = async (requestedAgentType?: string) => {
        if (!requestedAgentType?.trim()) return undefined
        const agents = await loadAgentDefinitions(
          ctx.cwd,
          getClaudeCompatibilityOptions(ctx.config),
          ctx.config,
        ).catch(() => [])
        return agents.find((agent) => agent.agentType.toLowerCase() === requestedAgentType.trim().toLowerCase())
      }
      const normalizeMode = (m?: Mode | "search" | "explore"): Mode =>
        parentMode === "plan" || parentMode === "ask" || parentMode === "review"
          ? "ask"
          : m === "search" || m === "explore"
            ? "ask"
            : ((m ?? "agent") as Mode)

      const maxParallel = ctx.config.parallelAgents.maxParallel
      const emit = (event: AgentEvent) => ctx.host.emit(event)

      const runOne = async (
        description: string,
        contextSummary?: string,
        mode?: Mode | "search" | "explore",
        requestedAgentType?: string,
      ) => {
        const agentDefinition = await resolveAgentDefinition(requestedAgentType)
        return manager.spawn(
          description,
          normalizeMode(agentDefinition?.preferredMode ?? mode),
          ctx.config,
          ctx.cwd,
          ctx.signal,
          maxParallel,
          emit,
          contextSummary,
          ctx.partId,
          agentDefinition?.agentType,
          undefined,
          { host: ctx.host, services: ctx.services },
        )
      }

      if (args.run_in_background) {
        const agentDefinition = await resolveAgentDefinition(args.agent_type)
        const started = await manager.spawnInBackground(
          args.description,
          normalizeMode(agentDefinition?.preferredMode ?? args.mode),
          ctx.config,
          ctx.cwd,
          ctx.signal,
          maxParallel,
          emit,
          args.context_summary,
          ctx.partId,
          agentDefinition?.agentType,
          undefined,
          { host: ctx.host, services: ctx.services },
        )
        return {
          success: true,
          output: `Delegated agent task ${started.subagentId} started in background. Use TaskOutput({ taskId: "${started.subagentId}", block: true }) to wait for completion.`,
          metadata: { subagent_id: started.subagentId, status: "running", background: true },
        }
      }

      const result = await runOne(args.description, args.context_summary, args.mode, args.agent_type)
      if (result.fileEditParts?.length) {
        mergeSubagentFileEditsIntoParentSession(
          ctx.session,
          ctx.partId,
          result.fileEditParts,
          ctx.toolExecutionMessageId,
          result.sessionId,
        )
      }
      if (result.error) {
        return {
          success: false,
          output: `Sub-agent ${result.subagentId} failed: ${result.error}\nPartial output: ${result.output}`,
        }
      }
      return { success: true, output: result.output.trimEnd() }
    },
  }
}

export function createSpawnAgentOutputTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof spawnOutputSchema>> {
  return {
    name: "SpawnAgentOutput",
    hiddenFromAgent: true,
    description: `Get output/status from a background SpawnAgent task.
- Pass subagent_id returned by SpawnAgent(run_in_background: true).
- block=true (DEFAULT): blocks until the agent finishes, then returns the final output. Use this in the common case — one call is all you need.
- block=false: returns current status immediately (running/completed/error). Only use this when you have other independent work to do first; then call again with block=true when ready. NEVER call block=false in a loop with no other work between calls — that is a wasted polling loop.
- Returns status, output (partial if still running, final if done), and error if any.`,
    parameters: spawnOutputSchema,
    readOnly: true,
    async execute({ subagent_id, block }, ctx: ToolContext) {
      const shouldBlock = block ?? true
      const snapshot = shouldBlock ? await manager.waitFor(subagent_id) : manager.getSnapshot(subagent_id)
      const runtime = await getOrchestrationRuntime(ctx.cwd)
      const runtimeTask = await runtime.getBackgroundTask(subagent_id)
      if (!snapshot && !runtimeTask) {
        return {
          success: false,
          output: `Unknown sub-agent id: ${subagent_id}.`,
        }
      }
      const status = snapshot?.status ?? (
        runtimeTask?.status === "running"
          ? "running"
          : runtimeTask?.status === "completed"
            ? "completed"
            : "error"
      )
      const body = snapshot?.output?.trim() || runtimeTask?.output?.trim() || "(no output yet)"
      const error = snapshot?.error ?? runtimeTask?.error
      const sessionId = snapshot?.sessionId ?? runtimeTask?.sessionId ?? ""
      const statusLine = `[Sub-agent status: ${status}]`
      const errLine = error ? `\nError: ${error}` : ""
      return {
        success: status === "running" || status === "completed",
        output: `${statusLine}\n${body}${errLine}`,
        metadata: {
          subagent_id,
          status,
          session_id: sessionId,
          ...(error ? { error } : {}),
        },
      }
    },
  }
}

export function createSpawnAgentStopTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof spawnStopSchema>> {
  return {
    name: "SpawnAgentStop",
    hiddenFromAgent: true,
    description: "Stop a running background sub-agent started via SpawnAgent(run_in_background: true).",
    parameters: spawnStopSchema,
    async execute({ subagent_id }, ctx: ToolContext) {
      const stopped = manager.stop(subagent_id)
      if (!stopped) {
        return { success: false, output: `No active background sub-agent with id ${subagent_id}.` }
      }
      const runtime = await getOrchestrationRuntime(ctx.cwd)
      const task = await runtime.setBackgroundTaskStatus(subagent_id, "killed").catch(() => null)
      if (task) ctx.host.emit({ type: "background_task_updated", task })
      return { success: true, output: `Stop signal sent to ${subagent_id}.` }
    },
  }
}

export function createListAgentRunsTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof listAgentRunsSchema>> {
  return {
    name: "ListAgentRuns",
    hiddenFromAgent: true,
    description: "List recent sub-agent runs with status, original task, and resume/fork lineage.",
    parameters: listAgentRunsSchema,
    readOnly: true,
    async execute({ limit }, ctx: ToolContext) {
      const runs = await manager.listRuns(ctx.cwd)
      const sliced = runs.slice(0, limit ?? 20)
      if (sliced.length === 0) return { success: true, output: "No sub-agent runs found." }
      return {
        success: true,
        output: sliced.map((run) => {
          const lineage = run.metadata?.resumeOf
            ? ` | resumeOf=${String(run.metadata.resumeOf)}`
            : run.metadata?.forkOf
              ? ` | forkOf=${String(run.metadata.forkOf)}`
              : ""
          return `- ${run.id} | ${run.status} | ${run.description}${lineage}`
        }).join("\n"),
        metadata: { runs: sliced },
      }
    },
  }
}

export function createAgentRunSnapshotTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof agentRunSnapshotSchema>> {
  return {
    name: "AgentRunSnapshot",
    hiddenFromAgent: true,
    description: "Read the stored snapshot for a prior sub-agent run, including transcript metadata and final output.",
    parameters: agentRunSnapshotSchema,
    readOnly: true,
    async execute({ subagent_id, format }, ctx: ToolContext) {
      const runtime = await getOrchestrationRuntime(ctx.cwd)
      const task = await runtime.getBackgroundTask(subagent_id)
      const live = manager.getSnapshot(subagent_id)
      const snapshotFile = typeof task?.metadata?.snapshotFile === "string" ? task.metadata.snapshotFile : ""
      let parsed: Record<string, unknown> | null = null
      if (snapshotFile) {
        try {
          parsed = JSON.parse(await fs.readFile(snapshotFile, "utf8")) as Record<string, unknown>
        } catch {
          parsed = null
        }
      }
      if (!task && !live && !parsed) {
        return { success: false, output: `Sub-agent run not found: ${subagent_id}` }
      }
      if (format === "json") {
        return {
          success: true,
          output: JSON.stringify({ task, live, snapshot: parsed }, null, 2),
        }
      }
      const description = String(parsed?.description ?? task?.description ?? "(unknown task)")
      const status = String(live?.status ?? task?.status ?? (parsed?.success === false ? "error" : "completed"))
      const lineage = task?.metadata?.resumeOf
        ? `resumeOf=${String(task.metadata.resumeOf)}`
        : task?.metadata?.forkOf
          ? `forkOf=${String(task.metadata.forkOf)}`
          : ""
      const sessionId = String(parsed?.sessionId ?? live?.sessionId ?? task?.sessionId ?? "")
      const messageCount = typeof parsed?.messageCount === "number" ? parsed.messageCount : undefined
      const output = String(parsed?.output ?? live?.output ?? task?.output ?? "").trim() || "(no output captured)"
      const error = String(parsed?.error ?? live?.error ?? task?.error ?? "").trim()
      return {
        success:
          status !== "error" &&
          status !== "failed" &&
          status !== "killed" &&
          status !== "cancelled",
        output: [
          `Sub-agent: ${subagent_id}`,
          `Status: ${status}`,
          `Task: ${description}`,
          sessionId ? `Session: ${sessionId}` : "",
          messageCount != null ? `Messages: ${messageCount}` : "",
          lineage ? `Lineage: ${lineage}` : "",
          snapshotFile ? `Snapshot: ${snapshotFile}` : "",
          error ? `Error: ${error}` : "",
          "",
          output,
        ].filter(Boolean).join("\n"),
      }
    },
  }
}

export function createResumeAgentTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef<z.infer<typeof resumeAgentSchema>> {
  return {
    name: "ResumeAgent",
    hiddenFromAgent: true,
    description: "Resume or fork from a previous sub-agent run using its stored task and output context.",
    parameters: resumeAgentSchema,
    async execute({ subagent_id, instruction, fork, run_in_background }, ctx: ToolContext) {
      const emit = (event: AgentEvent) => ctx.host.emit(event)
      const resumed = await manager.resume(
        subagent_id,
        {
          ...(instruction ? { followupInstruction: instruction } : {}),
          ...(typeof fork === "boolean" ? { fork } : {}),
          ...(typeof run_in_background === "boolean" ? { runInBackground: run_in_background } : {}),
        },
        config,
        ctx.cwd,
        ctx.signal,
        ctx.config.parallelAgents.maxParallel,
        emit,
        ctx.partId,
        { host: ctx.host, services: ctx.services },
      )
      if ("background" in resumed) {
        return {
          success: true,
          output: `Resumed sub-agent ${subagent_id} in background as ${resumed.subagentId}.`,
          metadata: { subagent_id: resumed.subagentId, background: true },
        }
      }
      if (resumed.fileEditParts?.length) {
        mergeSubagentFileEditsIntoParentSession(
          ctx.session,
          ctx.partId,
          resumed.fileEditParts,
          ctx.toolExecutionMessageId,
          resumed.sessionId,
        )
      }
      return {
        success: resumed.success,
        output: resumed.error
          ? `Resumed sub-agent ${subagent_id} failed: ${resumed.error}\n${resumed.output}`
          : resumed.output,
        metadata: { subagent_id: resumed.subagentId, resumedFrom: subagent_id },
      }
    },
  }
}

export function createTaskResumeTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef<z.infer<typeof taskResumeSchema>> {
  return {
    name: "TaskResume",
    description: "Resume or fork a prior delegated agent task using its stored output, lineage, and snapshot context. Use this when prior delegated work is relevant and you want continuity instead of starting a fresh agent task.",
    parameters: taskResumeSchema,
    async execute({ task_id, instruction, fork, block }, ctx: ToolContext) {
      const emit = (event: AgentEvent) => ctx.host.emit(event)
      const resumed = await manager.resume(
        task_id,
        {
          ...(instruction ? { followupInstruction: instruction } : {}),
          ...(typeof fork === "boolean" ? { fork } : {}),
          runInBackground: block === false,
        },
        config,
        ctx.cwd,
        ctx.signal,
        ctx.config.parallelAgents.maxParallel,
        emit,
        ctx.partId,
        { host: ctx.host, services: ctx.services },
      )
      if ("background" in resumed) {
        const runtime = await getOrchestrationRuntime(ctx.cwd)
        const task = await runtime.getTask(resumed.subagentId)
        if (task) {
          await ensureTeamMemberForTask({ cwd: ctx.cwd, host: ctx.host, task, agentId: resumed.subagentId })
          ctx.host.emit({ type: "task_created", task })
        }
        return {
          success: true,
          output: `Resumed task ${task_id} as ${resumed.subagentId}.`,
          metadata: { task_id: resumed.subagentId, background: true },
        }
      }
      if (resumed.fileEditParts?.length) {
        mergeSubagentFileEditsIntoParentSession(
          ctx.session,
          ctx.partId,
          resumed.fileEditParts,
          ctx.toolExecutionMessageId,
          resumed.sessionId,
        )
      }
      const runtime = await getOrchestrationRuntime(ctx.cwd)
      const task = await runtime.getTask(resumed.subagentId)
      if (task) {
        await ensureTeamMemberForTask({ cwd: ctx.cwd, host: ctx.host, task, agentId: resumed.subagentId })
        ctx.host.emit({ type: "task_completed", task, outputPreview: resumed.output.slice(0, 500) })
        await handleCompletedTaskSideEffects({
          cwd: ctx.cwd,
          host: ctx.host,
          config: ctx.config,
          task,
          outputPreview: resumed.output.slice(0, 500),
        })
      }
      return {
        success: resumed.success,
        output: resumed.error ? `Resumed task ${task_id} failed: ${resumed.error}\n${resumed.output}` : resumed.output,
        metadata: { task_id: resumed.subagentId, resumedFrom: task_id },
      }
    },
  }
}

export function createTaskSnapshotTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof taskSnapshotSchema>> {
  return {
    name: "TaskSnapshot",
    description: "Read the stored snapshot or execution summary for a delegated or background task. Use this to inspect prior task context before resuming, debugging, or summarizing its result.",
    parameters: taskSnapshotSchema,
    readOnly: true,
    async execute({ task_id, format }, ctx: ToolContext) {
      const runtime = await getOrchestrationRuntime(ctx.cwd)
      const task = await runtime.getTask(task_id)
      if (!task) return { success: false, output: `Task not found: ${task_id}` }
      if (task.kind === "agent") {
        return createAgentRunSnapshotTool(manager).execute({ subagent_id: task_id, format }, ctx)
      }
      if (format === "json") {
        return { success: true, output: JSON.stringify(task, null, 2), metadata: { task } }
      }
      return {
        success: task.status !== "failed" && task.status !== "killed",
        output: [
          `Task: ${task.id}`,
          `Kind: ${task.kind}`,
          `Status: ${task.status}`,
          `Subject: ${task.subject}`,
          task.command ? `Command: ${task.command}` : "",
          task.sessionId ? `Session: ${task.sessionId}` : "",
          task.snapshotFile ? `Snapshot: ${task.snapshotFile}` : "",
          task.error ? `Error: ${task.error}` : "",
          "",
          (task.output ?? "(no output captured)").trim() || "(no output captured)",
        ].filter(Boolean).join("\n"),
        metadata: { task },
      }
    },
  }
}

export function createTaskCreateBatchTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef<z.infer<typeof taskCreateBatchSchema>> {
  return {
    name: "TaskCreateBatch",
    description: "Create multiple delegated agent tasks and run them concurrently as one coordinated batch. Use this for independent delegated work items that can safely run in parallel without touching the same files.",
    parameters: taskCreateBatchSchema,
    async execute({ tasks, block }, ctx: ToolContext) {
      const parentMode = ctx.mode ?? "agent"
      const shouldBlock = block ?? true
      const runtime = await getOrchestrationRuntime(ctx.cwd)
      const normalizeMode = (m?: Mode | "search" | "explore"): Mode =>
        parentMode === "plan" || parentMode === "ask" || parentMode === "review"
          ? "ask"
          : m === "search" || m === "explore"
            ? "ask"
            : ((m ?? "agent") as Mode)
      const resolveAgentDefinition = async (requestedAgentType?: string) => {
        if (!requestedAgentType?.trim()) return undefined
        const agents = await loadAgentDefinitions(
          ctx.cwd,
          getClaudeCompatibilityOptions(ctx.config),
          ctx.config,
        )
        return agents.find((agent) => agent.agentType.toLowerCase() === requestedAgentType.trim().toLowerCase())
      }
      const maxTasksPerCall = config.parallelAgents.maxTasksPerCall ?? 12
      if (tasks.length > maxTasksPerCall) {
        return {
          success: false,
          output:
            `TaskCreateBatch received ${tasks.length} tasks; the configured limit is ` +
            `${maxTasksPerCall}. Split the work into smaller waves.`,
          metadata: { taskCount: tasks.length, maxTasksPerCall },
        }
      }

      if (!shouldBlock) {
        const started: Array<{ id: string; description: string }> = []
        for (const item of tasks) {
          const agentDefinition = await resolveAgentDefinition(item.agent_type)
          const { subagentId } = await manager.spawnInBackground(
            item.description,
            normalizeMode(agentDefinition?.preferredMode ?? item.mode),
            ctx.config,
            ctx.cwd,
            ctx.signal,
            config.parallelAgents.maxParallel,
            (event) => ctx.host.emit(event),
            item.context_summary,
            ctx.partId,
            agentDefinition?.agentType,
            undefined,
            { host: ctx.host, services: ctx.services },
          )
          const task = await runtime.getTask(subagentId)
          if (task) {
            await ensureTeamMemberForTask({ cwd: ctx.cwd, host: ctx.host, task, agentId: subagentId })
            ctx.host.emit({ type: "task_created", task })
          }
          started.push({ id: subagentId, description: item.description })
        }
        return {
          success: true,
          output: `Created ${started.length} delegated tasks.\n` + started.map((task) => `- ${task.id} | ${task.description}`).join("\n"),
          metadata: { tasks: started },
        }
      }

      const results = await Promise.all(tasks.map(async (item) => {
        const agentDefinition = await resolveAgentDefinition(item.agent_type)
        const result = await manager.spawn(
          item.description,
          normalizeMode(agentDefinition?.preferredMode ?? item.mode),
          ctx.config,
          ctx.cwd,
          ctx.signal,
          config.parallelAgents.maxParallel,
          (event) => ctx.host.emit(event),
          item.context_summary,
          ctx.partId,
          agentDefinition?.agentType,
          undefined,
          { host: ctx.host, services: ctx.services },
        )
        const task = await runtime.getTask(result.subagentId)
        if (task) {
          await ensureTeamMemberForTask({ cwd: ctx.cwd, host: ctx.host, task, agentId: result.subagentId })
          ctx.host.emit({ type: "task_completed", task, outputPreview: result.output.slice(0, 500) })
          await handleCompletedTaskSideEffects({
            cwd: ctx.cwd,
            host: ctx.host,
            config: ctx.config,
            task,
            outputPreview: result.output.slice(0, 500),
          })
        }
        return result
      }))

      for (const result of results) {
        if (result.fileEditParts?.length) {
          mergeSubagentFileEditsIntoParentSession(
            ctx.session,
            ctx.partId,
            result.fileEditParts,
            ctx.toolExecutionMessageId,
            result.sessionId,
          )
        }
      }
      const allOk = results.every((result) => !result.error)
      return {
        success: allOk,
        output: `Ran ${results.length} delegated tasks.\n\n${results.map((result, index) => {
          const label = `Task ${index + 1}: ${tasks[index]?.description.slice(0, 60) ?? result.subagentId}`
          return result.error
            ? `## ${label}\n[failed] ${result.error}\nPartial output: ${result.output}`
            : `## ${label}\n${result.output}`
        }).join("\n\n")}`,
      }
    },
  }
}

const spawnParallelSchema = z.object({
  agents: z
    .array(
      z.object({
        description: z.string().min(1).describe("Task description for this sub-agent."),
        mode: z
          .enum(["agent", "plan", "ask", "debug", "review", "search", "explore"])
          .optional()
          .describe("Mode for this sub-agent (default: agent). 'search'/'explore' → ask."),
        context_summary: z
          .string()
          .optional()
          .describe("Optional brief context for this agent."),
      })
    )
    .min(2)
    .describe("List of sub-agents to run concurrently. Min 2."),
})

/**
 * SpawnAgentsParallel — simple alternative to Parallel+SpawnAgent for concurrent sub-agent launch.
 * Flat schema: no recipient_name/parameters wrapping needed.
 */
export function createSpawnAgentsParallelTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef {
  return {
    name: "SpawnAgentsParallel",
    hiddenFromAgent: true,
    description: `Legacy — hidden from the model. Use \`TaskCreateBatch\` for concurrent delegated agents.

Runs multiple sub-agents in parallel; results after all finish.

Max ${config.parallelAgents.maxParallel} agents (${manager.activeCount} active).`,
    parameters: spawnParallelSchema,

    async execute(
      args: z.infer<typeof spawnParallelSchema>,
      ctx: ToolContext,
    ) {
      const parentMode = ctx.mode ?? "agent"
      const normalizeMode = (m?: Mode | "search" | "explore"): Mode =>
        parentMode === "plan" || parentMode === "ask" || parentMode === "review"
          ? "ask"
          : m === "search" || m === "explore"
            ? "ask"
            : ((m ?? "agent") as Mode)

      const maxParallel = ctx.config.parallelAgents.maxParallel
      const maxTasksPerCall = config.parallelAgents.maxTasksPerCall ?? 12
      if (args.agents.length > maxTasksPerCall) {
        return {
          success: false,
          output:
            `SpawnAgentsParallel received ${args.agents.length} agents; the configured limit is ` +
            `${maxTasksPerCall}. Split the work into smaller waves.`,
          metadata: { agentCount: args.agents.length, maxTasksPerCall },
        }
      }
      const emit = (event: AgentEvent) => ctx.host.emit(event)

      const results = await Promise.all(
        args.agents.map((agent) =>
          manager.spawn(
            agent.description,
            normalizeMode(agent.mode),
            ctx.config,
            ctx.cwd,
            ctx.signal,
            maxParallel,
            emit,
            agent.context_summary,
            ctx.partId,
            undefined,
            undefined,
            { host: ctx.host, services: ctx.services },
          ),
        ),
      )

      const parts = results.map((r, i) => {
        const label = `Agent ${i + 1}: ${args.agents[i]!.description.slice(0, 60)}`
        if (r.error) return `## ${label}\n[failed] ${r.error}\nPartial output: ${r.output}`
        return `## ${label}\n${r.output}`
      })

      const allOk = results.every((r) => !r.error)
      for (const r of results) {
        if (r.fileEditParts?.length) {
          mergeSubagentFileEditsIntoParentSession(
            ctx.session,
            ctx.partId,
            r.fileEditParts,
            ctx.toolExecutionMessageId,
            r.sessionId,
          )
        }
      }
      return {
        success: allOk,
        output: `Ran ${results.length} sub-agents in parallel.\n\n${parts.join("\n\n")}`,
      }
    },
  }
}

/**
 * Backward-compatible alias for old sessions/prompts that still call SpawnAgents.
 * Runtime behavior is identical to SpawnAgent (single sub-agent per call).
 */
export function createSpawnAgentsAliasTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef {
  const base = createSpawnAgentTool(manager, config)
  return {
    ...base,
    name: "SpawnAgents",
    hiddenFromAgent: true,
    description:
      `${base.description}\n\n[Deprecated alias] Use TaskCreate(kind: "agent") instead.`,
  }
}
