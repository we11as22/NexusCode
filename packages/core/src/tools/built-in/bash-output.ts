import { z } from "zod"
import * as fs from "node:fs"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"
import { backgroundBashJobs } from "./execute-command.js"

const schema = z.object({
  bash_id: z.string().describe("The ID of the background shell to retrieve output from"),
  filter: z.string().optional().describe("Optional regular expression to filter the output lines. Only lines matching this regex will be included in the result."),
})

/** Check if a process is still running (Unix: signal 0; Windows: may be unreliable). */
function isProcessRunning(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const bashOutputTool: ToolDef<z.infer<typeof schema>> = {
  name: "BashOutput",
  description: `Read output from a background bash shell started with run_in_background: true.

The response includes a status line: [Process status: running | exited]. Use it to decide whether to poll again or proceed (exited = command finished; log contains full output).

Usage:
- Call with the bash_id returned by Bash when run_in_background is true.
- Returns a status line (running/exited), then all stdout/stderr logged so far (from .nexus/<bash_id>.log).
- Use the optional filter parameter (regex) to show only matching lines — e.g. errors or progress.
- Poll periodically: call BashOutput again to see new output; when status is "exited", the log is final.
- To stop a running process, use KillBash(shell_id) with the same id.

Example flow:
1. Bash({ command: "npm run build", run_in_background: true }) → returns bash_id "run_1234567890"
2. BashOutput({ bash_id: "run_1234567890" }) → [Process status: running] + output so far
3. BashOutput({ bash_id: "run_1234567890" }) → [Process status: exited] + full log (or use filter: "error|Error|ERROR" to find errors)`,
  parameters: schema,
  readOnly: true,

  async execute({ bash_id, filter }, ctx: ToolContext) {
    const job = backgroundBashJobs.get(bash_id)
    if (!job) {
      return {
        success: false,
        output: `No background bash job found for bash_id: ${bash_id}. It may have finished or never been started in this process.`,
      }
    }
    const logPath = path.isAbsolute(job.logPath) ? job.logPath : path.join(ctx.cwd, job.logPath)
    let content: string
    try {
      content = await fs.promises.readFile(logPath, "utf8")
    } catch (err) {
      return {
        success: false,
        output: `Could not read log for bash_id ${bash_id}: ${(err as Error).message}`,
      }
    }
    const running = isProcessRunning(job.pid)
    const statusLine = `[Process status: ${running ? "running" : "exited"} | PID: ${job.pid}]\n`
    let lines = content.split(/\r?\n/)
    if (filter) {
      try {
        const re = new RegExp(filter)
        lines = lines.filter(line => re.test(line))
      } catch {
        return { success: false, output: `Invalid filter regex: ${filter}` }
      }
    }
    const output = lines.join("\n")
    return {
      success: true,
      output: statusLine + (output || "(no output yet)"),
      metadata: { pid: job.pid, lineCount: lines.length, status: running ? "running" : "exited" },
    }
  },
}
