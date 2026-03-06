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
  description: `Retrieves output from a running or completed background bash shell.

- Takes a bash_id parameter identifying the shell (returned by Bash when run_in_background is true).
- Returns stdout and stderr output from the log file.
- Supports optional regex filtering to show only lines matching a pattern.
- Use this tool when you need to monitor or check the output of a long-running shell.`,
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
