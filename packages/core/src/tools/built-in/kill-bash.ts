import { z } from "zod"
import { kill } from "node:process"
import type { ToolDef, ToolContext } from "../../types.js"
import { backgroundBashJobs } from "./execute-command.js"

const schema = z.object({
  shell_id: z.string().describe("The ID of the background shell to kill"),
})

export const killBashTool: ToolDef<z.infer<typeof schema>> = {
  name: "KillBash",
  description: `Kills a running background bash shell by its ID.

- Takes a shell_id parameter (same as bash_id returned by Bash when run_in_background is true).
- Returns success or failure status.
- Use this tool when you need to terminate a long-running shell.`,
  parameters: schema,

  async execute({ shell_id }, _ctx: ToolContext) {
    const job = backgroundBashJobs.get(shell_id)
    if (!job) {
      return {
        success: false,
        output: `No background bash job found for shell_id: ${shell_id}. It may have already exited.`,
      }
    }
    try {
      kill(job.pid, "SIGTERM")
      backgroundBashJobs.delete(shell_id)
      return { success: true, output: `Killed process ${job.pid} (shell_id: ${shell_id}).` }
    } catch (err) {
      return {
        success: false,
        output: `Failed to kill process ${job.pid}: ${(err as Error).message}`,
      }
    }
  },
}
