import { z } from "zod"
import * as fs from "node:fs"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"
import { backgroundBashJobs } from "./execute-command.js"

const schema = z.object({
  bash_id: z.string().describe("The ID of the background shell to retrieve output from"),
  filter: z.string().optional().describe("Optional regular expression to filter the output lines. Only lines matching this regex will be included in the result."),
})

export const bashOutputTool: ToolDef<z.infer<typeof schema>> = {
  name: "BashOutput",
  description: `Read output from a background bash shell started with run_in_background: true.

Usage:
- Call with the bash_id returned by Bash when run_in_background is true.
- Returns all stdout and stderr output logged so far (from .nexus/<bash_id>.log).
- Use the optional filter parameter (regex) to show only matching lines — useful for finding errors or specific progress messages without reading all output.
- Call periodically to poll progress on long-running commands (builds, tests, servers).
- When the command is done, BashOutput returns the complete log. Use KillBash to stop a still-running process.

Example flow:
1. Bash({ command: "npm run build", run_in_background: true }) → returns bash_id "run_1234567890"
2. BashOutput({ bash_id: "run_1234567890" }) → reads build output so far
3. BashOutput({ bash_id: "run_1234567890", filter: "error|Error|ERROR" }) → find any errors`,
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
      output: output || "(no output yet)",
      metadata: { pid: job.pid, lineCount: lines.length },
    }
  },
}
