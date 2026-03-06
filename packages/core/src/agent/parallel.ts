import { z } from "zod"
import type { ToolDef, ToolContext, NexusConfig, Mode, AgentEvent } from "../types.js"
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
  /** Recent spawn task keys (normalized) to prevent infinite restart / duplicate spawns (Cline-style guard). */
  private recentSpawnTasks: string[] = []
  private static readonly RECENT_SPAWN_CAP = 3
  private static readonly TASK_KEY_LEN = 80

  async spawn(
    description: string,
    mode: Mode = "agent",
    config: NexusConfig,
    cwd: string,
    signal: AbortSignal,
    maxParallel: number,
    emit?: (event: AgentEvent) => void,
    contextSummary?: string,
  ): Promise<SubAgentResult> {
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
          "Sub-agent for this or a very similar task was already run recently. Continue in the main agent using the results above; do not call spawn_agent again for the same task.",
      }
    }
    this.recentSpawnTasks.push(taskKey)
    if (this.recentSpawnTasks.length > ParallelAgentManager.RECENT_SPAWN_CAP) {
      this.recentSpawnTasks.shift()
    }

    // Wait for a concurrency slot
    while (this.running.size >= maxParallel) {
      await Promise.race([...this.running.values()]).catch(() => {})
      // Flush the microtask queue so .finally() cleanup handlers run
      // before we re-check .size
      await Promise.resolve()
    }

    const subagentId = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    emit?.({ type: "subagent_start", subagentId, mode, task: description })

    // The task self-removes from the map when it settles (success or error).
    // This is what makes the while-loop above eventually terminate.
    const task = this.runSubAgent(subagentId, description, mode, config, cwd, signal, emit, contextSummary).finally(() => {
      this.running.delete(subagentId)
    })

    this.running.set(subagentId, task)

    return task
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
  ): Promise<SubAgentResult> {
    const session = Session.create(cwd)
    const userContent = contextSummary?.trim()
      ? `${contextSummary}\n\n---\n\nTask: ${description}`
      : description
    session.addMessage({ role: "user", content: userContent })

    const client = createLLMClient(config.model)

    const toolRegistry = new ToolRegistry()
    const { builtin: tools } = toolRegistry.getForMode(mode)

    const rulesContent = await loadRules(cwd, config.rules.files).catch(() => "")
    const skills = await loadSkills(config.skills, cwd).catch(() => [])
    const compaction = createCompaction()

    let output = ""

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
        }
        if (event.type === "tool_start") {
          emit?.({ type: "subagent_tool_start", subagentId, tool: event.tool })
        }
        if (event.type === "tool_end") {
          emit?.({ type: "subagent_tool_end", subagentId, tool: event.tool, success: event.success })
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
      })
      return { subagentId, sessionId: session.id, success: true, output }
    } catch (err) {
      const error = (err as Error).message
      emit?.({
        type: "subagent_done",
        subagentId,
        success: false,
        outputPreview: output.slice(0, 300),
        error,
      })
      return {
        subagentId,
        sessionId: session.id,
        success: false,
        output: output || "",
        error,
      }
    }
  }

  /** How many agents are currently running */
  get activeCount(): number {
    return this.running.size
  }
}

const taskItemSchema = z.object({
  description: z.string().describe("Clear, self-contained task description for this sub-agent."),
  context_summary: z.string().optional().describe("Optional brief context for this task (e.g. background, relevant files)."),
  mode: z.enum(["agent", "plan", "ask", "debug", "search", "explore"]).optional().describe("Mode for this sub-agent (default: agent). 'search'/'explore' → ask."),
})

const spawnSchema = (maxTasksPerCall: number) => z.object({
  description: z.string().optional().describe("Single task: what should the sub-agent do? (Use when launching one sub-agent.)"),
  context_summary: z.string().optional().describe("Optional context for the single task (used only when tasks is not provided)."),
  mode: z.enum(["agent", "plan", "ask", "debug", "search", "explore"]).optional().describe("Mode for the single sub-agent (default: agent)."),
  task_progress: z.string().optional(),
  tasks: z.array(taskItemSchema).max(maxTasksPerCall).optional().describe(
    `Optional list of tasks to run in parallel (up to ${maxTasksPerCall} per call). When provided, all run concurrently; omit or use single \`description\` for one task.`,
  ),
}).refine(
  (data) => (data.tasks != null && data.tasks.length > 0) || (typeof data.description === "string" && data.description.trim().length > 0),
  { message: "Provide either description (single task) or non-empty tasks array." },
)

export function createSpawnAgentTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef {
  const maxTasksPerCall = config.parallelAgents?.maxTasksPerCall ?? 12
  const schema = spawnSchema(maxTasksPerCall)

  return {
    name: "SpawnAgent",
    description: `Launch one or more parallel sub-agents. Use for independent subtasks that don't depend on each other.
**Single task:** pass \`description\` (and optional \`context_summary\`, \`mode\`).
**Multiple tasks:** pass \`tasks\` array with up to ${maxTasksPerCall} items; each has \`description\` and optional \`context_summary\`, \`mode\`. All tasks in one call run in parallel (subject to max concurrent limit).
**When the main agent is in plan or ask mode**, sub-agents always run with ask (read-only) permissions.
**When the main agent is in agent/debug mode**, sub-agents can run in agent/plan/ask/debug per \`mode\`.
Each sub-agent must call final_report_to_user when done; results are returned in order.
Max ${config.parallelAgents.maxParallel} agents running simultaneously (currently ${manager.activeCount} active).`,
    parameters: schema,
    // Available in all modes; sub-agent permissions follow parent (plan/ask → ask, agent → agent/plan/ask)

    async execute(
      args: {
        description?: string
        context_summary?: string
        mode?: Mode | "search" | "explore"
        task_progress?: string
        tasks?: Array<{ description: string; context_summary?: string; mode?: Mode | "search" | "explore" }>
      },
      ctx: ToolContext,
    ) {
      const parentMode = ctx.mode ?? "agent"
      const normalizeMode = (m?: Mode | "search" | "explore"): Mode =>
        parentMode === "plan" || parentMode === "ask"
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
        )

      if (args.tasks != null && args.tasks.length > 0) {
        const results = await Promise.all(
          args.tasks.map((t) => runOne(t.description, t.context_summary, t.mode)),
        )
        const outputs: string[] = []
        let allSuccess = true
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const label = args.tasks[i].description.slice(0, 50) + (args.tasks[i].description.length > 50 ? "…" : "")
          if (r.error) {
            allSuccess = false
            outputs.push(`[${i + 1}] ${label}\nSub-agent ${r.subagentId} failed: ${r.error}\nPartial: ${r.output.slice(0, 400)}`)
          } else {
            outputs.push(`[${i + 1}] ${label}\nSub-agent ${r.subagentId} completed:\n${r.output}`)
          }
        }
        return {
          success: allSuccess,
          output: outputs.join("\n\n---\n\n"),
        }
      }

      if (typeof args.description !== "string" || !args.description.trim()) {
        return { success: false, output: "Provide description or non-empty tasks array." }
      }

      const result = await runOne(args.description, args.context_summary, args.mode)
      if (result.error) {
        return {
          success: false,
          output: `Sub-agent ${result.subagentId} failed: ${result.error}\nPartial output: ${result.output}`,
        }
      }
      return { success: true, output: `Sub-agent ${result.subagentId} completed:\n\n${result.output}` }
    },
  }
}
