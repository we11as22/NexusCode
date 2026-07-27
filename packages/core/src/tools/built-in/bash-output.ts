import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"
import { readTrustedRuntimeOutput } from "./runtime-output.js"

const schema = z.object({
  bash_id: z.string().describe("The ID of the background shell to retrieve output from"),
  filter: z.string().optional().describe("Optional regular expression to filter the output lines. Only lines matching this regex will be included in the result."),
})

export const bashOutputTool: ToolDef<z.infer<typeof schema>> = {
  name: "BashOutput",
  hiddenFromAgent: true,
  description: `Retrieve output from a running or completed background bash shell started with Bash(..., run_in_background: true).

- Takes bash_id (returned by Bash when run_in_background is true).
- Returns a status line: [Process status: running | exited] and the log content so far (stdout/stderr from the log file in the global data dir, e.g. ~/.nexus/data/run/<bash_id>.log). Each call returns the full log up to that point; when status is "exited", the log is final.
- Use the optional filter parameter (regex) to show only lines matching the pattern (e.g. "error|Error|ERROR" or "progress|%"). Non-matching lines are not included in the result when filter is set.
- Use this tool to monitor long-running commands (builds, tests, servers). Call periodically; when status is "exited", the command has finished.
- To stop a running process, use KillBash(shell_id) with the same id (shell_id and bash_id are the same value).
- Shell IDs for active jobs are listed in the Environment block under "Active Background Bash Jobs" when present.

Example flow:
1. Bash({ command: "npm run build", run_in_background: true }) → returns bash_id "run_1234567890"
2. BashOutput({ bash_id: "run_1234567890" }) → [Process status: running] + output so far
3. BashOutput({ bash_id: "run_1234567890" }) → [Process status: exited] + full log; or use filter: "error|Error|ERROR" to see only error lines`,
  parameters: schema,
  readOnly: true,

  async execute({ bash_id, filter }, ctx: ToolContext) {
    const runtime = ctx.services.orchestrationRuntime
    let backgroundTask = await runtime.getBackgroundTask(bash_id)
    if (
      !backgroundTask ||
      backgroundTask.kind !== "bash" ||
      backgroundTask.sessionId !== ctx.session.id
    ) {
      return {
        success: false,
        output: `No background bash job found for bash_id: ${bash_id}.`,
      }
    }
    const registeredJob = ctx.services.backgroundProcesses.get(bash_id, {
      workspace: ctx.cwd,
      sessionId: ctx.session.id,
    })
    const processIdentity = backgroundTask.metadata?.processIdentity
    const liveJob =
      registeredJob &&
      typeof processIdentity === "string" &&
      registeredJob.processIdentity === processIdentity
        ? registeredJob
        : undefined
    if (
      !liveJob &&
      (backgroundTask.status === "running" ||
        backgroundTask.status === "pending")
    ) {
      backgroundTask =
        await runtime.setBackgroundTaskStatus(bash_id, "failed", {
          error:
            "Background shell task has no matching live runtime-owned process identity; its persisted PID was not trusted.",
          metadata: {
            ...(backgroundTask.metadata ?? {}),
            reconciliation: "missing_live_process_identity",
          },
        }) ?? backgroundTask
    }
    const job = liveJob ?? (
      backgroundTask.logPath
        ? { logPath: backgroundTask.logPath }
        : undefined
    )
    if (!job) {
      return {
        success: false,
        output: `No background bash job found for bash_id: ${bash_id}. It may have finished or never been started in this process.`,
      }
    }
    let content: string
    try {
      content = await readTrustedRuntimeOutput(job.logPath)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e?.code === "ENOENT") {
        // Race: Bash just started background process but log file was not created yet.
        // Treat as a valid "no output yet" state instead of failing the tool call.
        const running =
          Boolean(liveJob) &&
          (backgroundTask.status === "running" ||
            backgroundTask.status === "pending")
        return {
          success: true,
          output: `[Process status: ${running ? "running" : "exited"}${liveJob ? ` | PID: ${liveJob.pid}` : ""}]\n(no output yet)`,
          metadata: {
            ...(liveJob ? { pid: liveJob.pid } : {}),
            lineCount: 0,
            status: running ? "running" : "exited",
          },
        }
      }
      return {
        success: false,
        output: `Could not read log for bash_id ${bash_id}: ${(err as Error).message}`,
      }
    }
    const running =
      Boolean(liveJob) &&
      (backgroundTask.status === "running" ||
        backgroundTask.status === "pending")
    const statusLine = `[Process status: ${running ? "running" : "exited"}${liveJob ? ` | PID: ${liveJob.pid}` : ""}]\n`
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
      metadata: {
        ...(liveJob ? { pid: liveJob.pid } : {}),
        lineCount: lines.length,
        status: running ? "running" : "exited",
        task: backgroundTask ?? null,
      },
    }
  },
}
