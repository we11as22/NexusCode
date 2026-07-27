import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  shell_id: z.string().describe("The ID of the background shell to kill"),
})

export const killBashTool: ToolDef<z.infer<typeof schema>> = {
  name: "KillBash",
  hiddenFromAgent: true,
  description: `Kill a running background bash shell by its ID.

- Takes shell_id (same value as bash_id returned by Bash when run_in_background: true).
- Sends SIGTERM to the process and removes it from the background job registry.
- Returns success or failure. Use when you need to terminate a long-running command (server, watcher, build, etc.).
- Background shell IDs can be found in the Environment block under "Active Background Bash Jobs", or from the bash_id returned when you started the command with run_in_background: true.`,
  parameters: schema,
  approval: {
    capability: "execute",
    alwaysPrompt: true,
    description({ shell_id }) {
      return `Terminate background shell: ${shell_id}`
    },
    content({ shell_id }) {
      return shell_id
    },
  },

  async execute({ shell_id }, ctx: ToolContext) {
    const runtime = ctx.services.orchestrationRuntime
    const backgroundTask = await runtime.getBackgroundTask(shell_id)
    if (
      !backgroundTask ||
      backgroundTask.kind !== "bash" ||
      backgroundTask.sessionId !== ctx.session.id
    ) {
      return {
        success: false,
        output: `No background bash job found for shell_id: ${shell_id}.`,
      }
    }
    const liveJob = ctx.services.backgroundProcesses.get(shell_id, {
      workspace: ctx.cwd,
      sessionId: ctx.session.id,
    })
    const processIdentity = backgroundTask.metadata?.processIdentity
    if (
      !liveJob ||
      typeof processIdentity !== "string" ||
      liveJob.processIdentity !== processIdentity
    ) {
      if (
        backgroundTask.status === "running" ||
        backgroundTask.status === "pending"
      ) {
        await runtime.setBackgroundTaskStatus(shell_id, "failed", {
          error:
            "Background shell task has no matching live runtime-owned process identity; its persisted PID was not trusted.",
          metadata: {
            ...(backgroundTask.metadata ?? {}),
            reconciliation: "missing_live_process_identity",
          },
        })
      }
      return {
        success: false,
        output:
          `No live runtime-owned background bash job found for shell_id: ${shell_id}. ` +
          "Refusing to signal a persisted PID because it may have been reused.",
      }
    }
    try {
      const stopped = await ctx.services.backgroundProcesses.stop(
        shell_id,
        {
          workspace: ctx.cwd,
          sessionId: ctx.session.id,
        },
        {
          processIdentity,
          reason: "requested",
        },
      )
      if (!stopped) {
        return {
          success: false,
          output:
            `Background bash job ${shell_id} no longer has its matching live handle.`,
        }
      }
      const task = await runtime.getBackgroundTask(shell_id)
      if (task?.status !== "killed") {
        return {
          success: false,
          output:
            `Background bash job ${shell_id} reached terminal status ` +
            `${task?.status ?? "unknown"} before stop completed.`,
        }
      }
      return {
        success: true,
        output:
          `Stopped process ${liveJob.pid} (shell_id: ${shell_id}); ` +
          "terminal state and log are finalized.",
      }
    } catch (err) {
      return {
        success: false,
        output: `Failed to kill process ${liveJob.pid}: ${(err as Error).message}`,
      }
    }
  },
}
