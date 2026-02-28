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
 * Each sub-agent runs its own session and agent loop.
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
    // Limit concurrency
    while (this.running.size >= maxParallel) {
      await Promise.race([...this.running.values()])
      // Clean up completed
      for (const [id, promise] of this.running) {
        await Promise.race([promise, Promise.resolve(null)]).catch(() => null)
      }
    }

    const task = this.runSubAgent(description, mode, config, cwd, signal)
    const sessionId = `subagent_${Date.now()}`
    this.running.set(sessionId, task)

    try {
      const result = await task
      return result
    } finally {
      this.running.delete(sessionId)
    }
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
    const allTools = toolRegistry.getAll()
    const { builtin: tools } = toolRegistry.getForMode(mode)

    const rulesContent = await loadRules(cwd, config.rules.files).catch(() => "")
    const skills = await loadSkills(config.skills, cwd).catch(() => [])
    const compaction = createCompaction()

    let output = ""
    const events: string[] = []

    const mockHost = {
      cwd,
      async readFile(p: string) { return (await import("node:fs/promises")).readFile(p, "utf8") },
      async writeFile(p: string, c: string) { return (await import("node:fs/promises")).writeFile(p, c, "utf8") },
      async deleteFile(p: string) { return (await import("node:fs/promises")).unlink(p) },
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
Max ${config.parallelAgents.maxParallel} agents running simultaneously.`,
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
