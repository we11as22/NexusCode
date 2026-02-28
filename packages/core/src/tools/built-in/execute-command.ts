import { z } from "zod"
import { execa } from "execa"
import stripAnsi from "strip-ansi"
import type { ToolDef, ToolContext } from "../../types.js"

const MAX_OUTPUT_BYTES = 50 * 1024 // 50 KB
const DEFAULT_TIMEOUT = 120_000 // 2 minutes
const PROGRESS_LINE_PATTERN = /[\r\x1b\[2K]/ // CR or ANSI clear line

const schema = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory (defaults to project root)"),
  timeout_seconds: z.number().int().positive().max(600).optional().describe("Timeout in seconds (default: 120)"),
  task_progress: z.string().optional().describe("Updated todo list in markdown checklist format"),
})

export const executeCommandTool: ToolDef<z.infer<typeof schema>> = {
  name: "execute_command",
  description: `Execute a shell command in the project directory.
Returns stdout, stderr, and exit code.
Output is capped at 50KB (head + tail shown if larger).
Progress bars and ANSI escape sequences are stripped.
Timeout default: 120 seconds (max: 600).

Best practices:
- Use for: running tests, build tools, installing packages, git operations
- Prefer other tools when available (read_file, write_to_file, search_files)
- For long-running servers, check if they start successfully then stop monitoring
- Chain commands with && for sequential execution`,
  parameters: schema,
  requiresApproval: true,

  async execute({ command, cwd: cmdCwd, timeout_seconds }, ctx: ToolContext) {
    const workingDir = cmdCwd ? (cmdCwd.startsWith("/") ? cmdCwd : `${ctx.cwd}/${cmdCwd}`) : ctx.cwd
    const timeout = (timeout_seconds ?? 120) * 1000

    let result: { stdout: string; stderr: string; exitCode: number }
    try {
      const proc = await execa(command, {
        cwd: workingDir,
        shell: true,
        timeout,
        all: true,
        reject: false,
      })

      result = {
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? "",
        exitCode: proc.exitCode ?? 0,
      }
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; exitCode?: number }
      if (e.code === "ETIMEDOUT" || (err as Error).message?.includes("timed out")) {
        return {
          success: false,
          output: `Command timed out after ${timeout_seconds ?? 120}s: ${command}`,
        }
      }
      result = {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? (err as Error).message,
        exitCode: e.exitCode ?? 1,
      }
    }

    const fullOutput = sanitizeOutput(result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ""))
    const truncated = truncateOutput(fullOutput)

    const success = result.exitCode === 0
    const header = `$ ${command}\n[exit: ${result.exitCode}]\n`

    return {
      success,
      output: header + truncated,
    }
  },
}

function sanitizeOutput(raw: string): string {
  // Strip ANSI escape codes
  let cleaned = stripAnsi(raw)
  // Deduplicate progress bar lines (lines ending with CR that overwrite each other)
  cleaned = cleaned
    .split("\n")
    .map(line => {
      if (PROGRESS_LINE_PATTERN.test(line)) {
        // Take only the last "frame" of a progress line
        const frames = line.split("\r")
        return frames[frames.length - 1]?.trim() ?? ""
      }
      return line
    })
    .join("\n")
  return cleaned
}

function truncateOutput(output: string): string {
  const bytes = Buffer.byteLength(output, "utf8")
  if (bytes <= MAX_OUTPUT_BYTES) return output

  const lines = output.split("\n")
  const total = lines.length
  const headLines = lines.slice(0, 100)
  const tailLines = lines.slice(-100)
  const truncatedCount = total - 200

  return [
    ...headLines,
    `[... ${truncatedCount} lines truncated ...]`,
    ...tailLines,
  ].join("\n")
}
