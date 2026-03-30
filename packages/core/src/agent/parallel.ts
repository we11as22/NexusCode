import * as crypto from "node:crypto"
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
} from "../types.js"
import { Session } from "../session/index.js"
import { loadRules } from "../context/rules.js"
import { loadSkills } from "../skills/manager.js"
import { ToolRegistry } from "../tools/registry.js"
import { createCompaction } from "../session/compaction.js"
import { createLLMClient } from "../provider/index.js"
import { runAgentLoop } from "./loop.js"

export interface SubAgentResult {
  subagentId: string
  sessionId: string
  success: boolean
  output: string
  error?: string
  /** Write/Edit tool parts from the sub-agent session (merged into parent for session diff). */
  fileEditParts?: ToolPart[]
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

function mergeSubagentFileEditsIntoParentSession(
  parent: ISession,
  spawnToolPartId: string | undefined,
  parts: ToolPart[],
  fallbackAssistantMessageId?: string,
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
    parent.addToolPart(msgId, clone)
  }
}

type SubAgentStatus = "running" | "completed" | "error"

interface SubAgentSnapshot {
  subagentId: string
  sessionId: string
  status: SubAgentStatus
  output: string
  error?: string
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
  private history: string[] = []
  private static readonly HISTORY_CAP = 100
  /** Recent spawn task keys (normalized) to prevent infinite restart / duplicate spawns. */
  private recentSpawnTasks: string[] = []
  private static readonly RECENT_SPAWN_CAP = 3
  private static readonly TASK_KEY_LEN = 80

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
  ): Promise<{ subagentId: string; task: Promise<SubAgentResult> }> {
    return (async () => {
      // Wait for a concurrency slot
      while (this.running.size >= maxParallel) {
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

      const localController = new AbortController()
      this.controllers.set(subagentId, localController)
      signal.addEventListener("abort", () => localController.abort(), { once: true })

      emit?.({ type: "subagent_start", subagentId, mode, task: description, parentPartId })

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
      ).finally(() => {
        this.running.delete(subagentId)
        this.controllers.delete(subagentId)
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
    spawnOptions?: { skipDuplicateCheck?: boolean },
  ): Promise<SubAgentResult> {
    if (!spawnOptions?.skipDuplicateCheck) {
      const taskKey = description.trim().slice(0, ParallelAgentManager.TASK_KEY_LEN).toLowerCase()
      const isDuplicate = this.recentSpawnTasks.some(
        (t) => t === taskKey || taskKey.startsWith(t) || t.startsWith(taskKey)
      )
      if (isDuplicate) {
        return {
          subagentId: `skip_${Date.now()}`,
          sessionId: "",
          success: true,
          output:
            "Sub-agent for this or a very similar task was already run recently. Continue in the main agent using the results above; do not call SpawnAgent again for the same task.",
        }
      }
      this.recentSpawnTasks.push(taskKey)
      if (this.recentSpawnTasks.length > ParallelAgentManager.RECENT_SPAWN_CAP) {
        this.recentSpawnTasks.shift()
      }
    }

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
  ): Promise<{ subagentId: string }> {
    const taskKey = description.trim().slice(0, ParallelAgentManager.TASK_KEY_LEN).toLowerCase()
    const isDuplicate = this.recentSpawnTasks.some(
      (t) => t === taskKey || taskKey.startsWith(t) || t.startsWith(taskKey)
    )
    if (isDuplicate) {
      const subagentId = `skip_${Date.now()}`
      this.rememberId(subagentId)
      this.sessions.set(subagentId, "")
      this.outputById.set(
        subagentId,
        "Sub-agent for this or a very similar task was already run recently. Continue in the main agent using the results above; do not call SpawnAgent again for the same task.",
      )
      this.statusById.set(subagentId, "completed")
      this.errorById.set(subagentId, undefined)
      return { subagentId }
    }
    this.recentSpawnTasks.push(taskKey)
    if (this.recentSpawnTasks.length > ParallelAgentManager.RECENT_SPAWN_CAP) {
      this.recentSpawnTasks.shift()
    }

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
    )
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
    ctrl.abort()
    return true
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
  ): Promise<SubAgentResult> {
    const session = Session.createEphemeral(cwd)
    this.sessions.set(subagentId, session.id)
    const userContent = contextSummary?.trim()
      ? `${contextSummary}\n\n---\n\nTask: ${description}`
      : description
    session.addMessage({ role: "user", content: userContent })

    const client = createLLMClient(config.model)

    const toolRegistry = new ToolRegistry()
    const { builtin: tools } = toolRegistry.getForMode(mode)

    const rulesContent = await loadRules(cwd, config.rules.files).catch(() => "")
    const skills = await loadSkills(config.skills, cwd, config.skillsUrls).catch(() => [])
    const compaction = createCompaction()

    let output = ""
    const manager = this

    const mockHost = {
      cwd,
      async readFile(p: string) {
        return (await import("node:fs/promises")).readFile(p, "utf8")
      },
      async writeFile(p: string, c: string) {
        return (await import("node:fs/promises")).writeFile(p, c, "utf8")
      },
      async deleteFile(p: string) {
        return (await import("node:fs/promises")).unlink(p)
      },
      async exists(p: string) {
        return (await import("node:fs/promises")).access(p).then(() => true).catch(() => false)
      },
      async showDiff() { return true },
      async runCommand(cmd: string, wd: string) {
        const { execa } = await import("execa")
        const r = await execa(cmd, { shell: true, cwd: wd, reject: false })
        return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 }
      },
      async showApprovalDialog() { return { approved: true } },
      emit(event: AgentEvent) {
        if (event.type === "text_delta" && event.delta) {
          output += event.delta
          manager.outputById.set(subagentId, output)
        }
        if (event.type === "tool_start") {
          emit?.({
            type: "subagent_tool_start",
            subagentId,
            tool: event.tool,
            input: event.input,
            parentPartId,
          })
        }
        if (event.type === "tool_end") {
          emit?.({ type: "subagent_tool_end", subagentId, tool: event.tool, success: event.success, parentPartId })
        }
      },
    }

    try {
      await runAgentLoop({
        session,
        client,
        host: mockHost as any,
        config,
        mode,
        tools,
        skills,
        rulesContent,
        compaction,
        signal,
      })
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
      const fileEditParts = collectCompletedWriteEditParts(session.messages)
      return {
        subagentId,
        sessionId: session.id,
        success: true,
        output,
        fileEditParts,
      }
    } catch (err) {
      const error = (err as Error).message
      emit?.({
        type: "subagent_done",
        subagentId,
        success: false,
        outputPreview: output.slice(0, 300),
        error,
        parentPartId,
      })
      this.outputById.set(subagentId, output || "")
      this.statusById.set(subagentId, "error")
      this.errorById.set(subagentId, error)
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

export function createSpawnAgentTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef {
  const schema = spawnSchema

  return {
    name: "SpawnAgent",
    description: `Launch exactly one sub-agent for a focused task.

⚡ PARALLEL EXECUTION: To run multiple sub-agents CONCURRENTLY use SpawnAgentsParallel (simpler) or Parallel+SpawnAgent:
  SpawnAgentsParallel({agents: [{description: "task1"}, {description: "task2"}]})
Calling SpawnAgent multiple times in a row is SEQUENTIAL (slow). Use SpawnAgentsParallel for concurrent execution.
NEVER call SpawnAgent multiple times in a row when parallel execution is desired.

**When the main agent is in plan, ask, or review mode**, sub-agents always run with ask (read-only) permissions.
**When the main agent is in agent/debug mode**, sub-agents can run in agent/plan/ask/debug/review per \`mode\`.
Set \`run_in_background: true\` for non-blocking execution and poll with \`SpawnAgentOutput\`.
Each sub-agent must end with a clear text summary.
Max ${config.parallelAgents.maxParallel} agents running simultaneously (currently ${manager.activeCount} active).`,
    parameters: schema,
    // Available in all modes; sub-agent permissions follow parent (plan/ask/review → ask, agent/debug → requested mode)

    async execute(
      args: {
        description: string
        context_summary?: string
        mode?: Mode | "search" | "explore"
        run_in_background?: boolean
        task_progress?: string
      },
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
      const emit = (event: AgentEvent) => ctx.host.emit(event)

      const runOne = (description: string, contextSummary?: string, mode?: Mode | "search" | "explore") =>
        manager.spawn(
          description,
          normalizeMode(mode),
          ctx.config,
          ctx.cwd,
          ctx.signal,
          maxParallel,
          emit,
          contextSummary,
          ctx.partId,
          {
            skipDuplicateCheck:
              ctx.skipSubagentDuplicateCheck === true,
          },
        )

      if (args.run_in_background) {
        const started = await manager.spawnInBackground(
          args.description,
          normalizeMode(args.mode),
          ctx.config,
          ctx.cwd,
          ctx.signal,
          maxParallel,
          emit,
          args.context_summary,
          ctx.partId,
        )
        return {
          success: true,
          output: `Sub-agent ${started.subagentId} started in background. Use SpawnAgentOutput with subagent_id=${started.subagentId} to monitor.`,
          metadata: { subagent_id: started.subagentId, status: "running", background: true },
        }
      }

      const result = await runOne(args.description, args.context_summary, args.mode)
      if (result.fileEditParts?.length) {
        mergeSubagentFileEditsIntoParentSession(
          ctx.session,
          ctx.partId,
          result.fileEditParts,
          ctx.toolExecutionMessageId,
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
    description: `Get output/status from a background SpawnAgent task.
- Pass subagent_id returned by SpawnAgent(run_in_background: true).
- block=true (DEFAULT): blocks until the agent finishes, then returns the final output. Use this in the common case — one call is all you need.
- block=false: returns current status immediately (running/completed/error). Only use this when you have other independent work to do first; then call again with block=true when ready. NEVER call block=false in a loop with no other work between calls — that is a wasted polling loop.
- Returns status, output (partial if still running, final if done), and error if any.`,
    parameters: spawnOutputSchema,
    readOnly: true,
    async execute({ subagent_id, block }, _ctx: ToolContext) {
      const shouldBlock = block ?? true
      const snapshot = shouldBlock ? await manager.waitFor(subagent_id) : manager.getSnapshot(subagent_id)
      if (!snapshot) {
        return {
          success: false,
          output: `Unknown sub-agent id: ${subagent_id}.`,
        }
      }
      const statusLine = `[Sub-agent status: ${snapshot.status}]`
      const body = snapshot.output?.trim() ? snapshot.output : "(no output yet)"
      const errLine = snapshot.error ? `\nError: ${snapshot.error}` : ""
      return {
        success: snapshot.status !== "error",
        output: `${statusLine}\n${body}${errLine}`,
        metadata: {
          subagent_id: snapshot.subagentId,
          status: snapshot.status,
          session_id: snapshot.sessionId,
          ...(snapshot.error ? { error: snapshot.error } : {}),
        },
      }
    },
  }
}

export function createSpawnAgentStopTool(manager: ParallelAgentManager): ToolDef<z.infer<typeof spawnStopSchema>> {
  return {
    name: "SpawnAgentStop",
    description: "Stop a running background sub-agent started via SpawnAgent(run_in_background: true).",
    parameters: spawnStopSchema,
    async execute({ subagent_id }, _ctx: ToolContext) {
      const stopped = manager.stop(subagent_id)
      if (!stopped) {
        return { success: false, output: `No active background sub-agent with id ${subagent_id}.` }
      }
      return { success: true, output: `Stop signal sent to ${subagent_id}.` }
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
    description: `Launch multiple sub-agents CONCURRENTLY in a single call. Simpler alternative to Parallel(SpawnAgent).

Use this whenever you need 2+ sub-agents running at the same time.
Each agent in the \`agents\` array starts immediately and runs in parallel.
Results are returned only after ALL agents finish.

Example:
  SpawnAgentsParallel({agents: [
    {description: "Explore API routes and middleware"},
    {description: "Explore data store and types"}
  ]})

Max ${config.parallelAgents.maxParallel} agents running simultaneously (currently ${manager.activeCount} active).`,
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
            { skipDuplicateCheck: true },
          )
        )
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
    description:
      `${base.description}\n\n[Deprecated alias] Use SpawnAgent instead.`,
  }
}
