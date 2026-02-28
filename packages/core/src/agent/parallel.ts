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
    maxParallel: number
  ): Promise<SubAgentResult> {
    // Wait for a concurrency slot
    while (this.running.size >= maxParallel) {
      await Promise.race([...this.running.values()]).catch(() => {})
      // Flush the microtask queue so .finally() cleanup handlers run
      // before we re-check .size
      await Promise.resolve()
    }

    const sessionId = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    // The task self-removes from the map when it settles (success or error).
    // This is what makes the while-loop above eventually terminate.
    const task = this.runSubAgent(description, mode, config, cwd, signal).finally(() => {
      this.running.delete(sessionId)
    })

    this.running.set(sessionId, task)

    return task
  }

  private async runSubAgent(
    description: string,
    mode: Mode,
    config: NexusConfig,
    cwd: string,
    signal: AbortSignal
  ): Promise<SubAgentResult> {
    const session = Session.create(cwd)
    session.addMessage({ role: "user", content: description })

    const client = createLLMClient(config.model)
    const maxModeClient = config.maxMode.enabled ? createLLMClient(config.maxMode) : undefined

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
      },
    }

    try {
      await runAgentLoop({
        session,
        client,
        maxModeClient,
        host: mockHost as any,
        config,
        mode,
        tools,
        skills,
        rulesContent,
        compaction,
        signal,
      })
      return { sessionId: session.id, success: true, output }
    } catch (err) {
      return {
        sessionId: session.id,
        success: false,
        output: output || "",
        error: (err as Error).message,
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
  mode: z.enum(["agent", "plan", "debug", "ask"]).optional().describe("Mode for the sub-agent (default: agent)"),
  task_progress: z.string().optional(),
})

export function createSpawnAgentTool(manager: ParallelAgentManager, config: NexusConfig): ToolDef {
  return {
    name: "spawn_agent",
    description: `Launch a parallel sub-agent to work on a specific task concurrently.
Use for independent subtasks that don't depend on each other.
The sub-agent has full capabilities based on the specified mode.
Returns the sub-agent's final output when done.
Max ${config.parallelAgents.maxParallel} agents running simultaneously (currently ${manager.activeCount} active).`,
    parameters: spawnSchema,
    modes: ["agent"],

    async execute(args: { description: string; mode?: Mode; task_progress?: string }, ctx: ToolContext) {
      const { description, mode } = args
      const result = await manager.spawn(
        description,
        (mode ?? "agent") as Mode,
        ctx.config,
        ctx.cwd,
        ctx.signal,
        ctx.config.parallelAgents.maxParallel
      )

      if (result.error) {
        return { success: false, output: `Sub-agent failed: ${result.error}\nPartial output: ${result.output}` }
      }

      return { success: true, output: `Sub-agent completed:\n\n${result.output}` }
    },
  }
}
