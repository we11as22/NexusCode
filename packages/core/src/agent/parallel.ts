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

const spawnSchema = z.object({
  description: z.string().describe("What should the sub-agent do? Provide a clear, self-contained task description."),
  context_summary: z.string().optional().describe("Optional summarized context (new_task style) to give the sub-agent before the task. Use when the subtask benefits from brief background (e.g. what we're building, which files matter)."),
  mode: z.enum(["agent", "plan", "ask", "search", "explore"]).optional().describe("Mode for the sub-agent (default: agent). 'search'/'explore' map to ask mode."),
  task_progress: z.string().optional(),
})

export function createSpawnAgentTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef {
  return {
    name: "spawn_agent",
    description: `Launch a parallel sub-agent to work on a specific task concurrently.
Use for independent subtasks that don't depend on each other.
Optionally pass \`context_summary\` (new_task style) to give the sub-agent brief background before the task.
The sub-agent has full capabilities based on the specified mode.
**The sub-agent must call attempt_completion when the task is done**; its result is returned to you.
Max ${config.parallelAgents.maxParallel} agents running simultaneously (currently ${manager.activeCount} active).`,
    parameters: spawnSchema,
    modes: ["agent"],

    async execute(args: { description: string; context_summary?: string; mode?: Mode | "search" | "explore"; task_progress?: string }, ctx: ToolContext) {
      const { description, context_summary } = args
      const normalizedMode: Mode = args.mode === "search" || args.mode === "explore"
        ? "ask"
        : ((args.mode ?? "agent") as Mode)
      const result = await manager.spawn(
        description,
        normalizedMode,
        ctx.config,
        ctx.cwd,
        ctx.signal,
        ctx.config.parallelAgents.maxParallel,
        (event) => ctx.host.emit(event),
        context_summary,
      )

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
