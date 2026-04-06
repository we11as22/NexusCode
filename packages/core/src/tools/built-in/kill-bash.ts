import { z } from "zod"
import { kill } from "node:process"
import type { ToolDef, ToolContext } from "../../types.js"
import { backgroundBashJobs } from "./execute-command.js"
import { getOrchestrationRuntime } from "../../orchestration/runtime.js"

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

  async execute({ shell_id }, ctx: ToolContext) {
    const job = backgroundBashJobs.get(shell_id)
    if (!job) {
      return {
        success: false,
        output: `No background bash job found for shell_id: ${shell_id}. It may have already exited.`,
      }
    }
    try {
      kill(job.pid, "SIGTERM")
      const runtime = await getOrchestrationRuntime(ctx.cwd)
      const task = await runtime.setBackgroundTaskStatus(shell_id, "killed", { processId: job.pid })
      if (task) ctx.host.emit({ type: "background_task_updated", task })
      return { success: true, output: `Killed process ${job.pid} (shell_id: ${shell_id}).` }
    } catch (err) {
      return {
        success: false,
        output: `Failed to kill process ${job.pid}: ${(err as Error).message}`,
      }
    }
  },
}
