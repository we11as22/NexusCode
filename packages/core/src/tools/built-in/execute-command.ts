import { z } from "zod"
import { execa } from "execa"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import stripAnsi from "strip-ansi"
import type { ToolDef, ToolContext } from "../../types.js"

const MAX_OUTPUT_BYTES = 50 * 1024 // 50 KB
const DEFAULT_TIMEOUT = 120_000 // 2 minutes
const PROGRESS_LINE_PATTERN = /[\r\x1b\[2K]/ // CR or ANSI clear line

const schema = z.object({
  command: z.string().describe("Shell command to execute"),
  description: z.string().optional().describe("Short (5–10 word) description of what this command does, for progress display (e.g. \"List TS files\", \"Run tests\")"),
  cwd: z.string().optional().describe("Working directory (defaults to project root)"),
  timeout_seconds: z.number().int().positive().max(600).optional().describe("Timeout in seconds (default: 120)"),
  task_progress: z.string().optional().describe("Updated todo list in markdown checklist format"),
  background: z.boolean().optional().describe("Run in background (non-blocking). Returns log path and PID; monitor with tail/grep in follow-up execute_command. Use for long-running commands (builds, servers)."),
  log_path: z.string().optional().describe("Output log path when background is true (default: .nexus/run_<timestamp>.log)."),
})

export const executeCommandTool: ToolDef<z.infer<typeof schema>> = {
  name: "execute_command",
  description: `Run a shell command in the project (or specified cwd). Use for real system/terminal operations only.

**Working directory:** Always use a compound command with \`cd\` at the start so the command runs in the intended folder. Example: \`cd packages/core && npm test\`, \`cd src && ls -la\`. Do not rely on "current" directory — start with \`cd <path> &&\` so everything runs in the right place. You may use the optional \`cwd\` parameter as well, but the command itself should include \`cd ... &&\` when running in a subdirectory.

When to use:
- Tests, builds, package installs, git, linters, formatters.
- **Finding files by name (glob/find):** when you need to list files matching a pattern (e.g. all *.test.ts, or paths under a dir), use execute_command with \`find\` or \`ls\` (e.g. \`find . -name "*.test.ts"\`, \`find src -type f -name "*.ts"\`). Prefer this when search_files would require multiple rounds.
- **Ripgrep (rg):** when you need a single quick content search with rich options (e.g. -l, -c, -A/-B, multiple patterns), you may use execute_command with \`rg\` (e.g. \`rg "pattern" --type-add 'ts:*.ts' -t ts -l\`). Prefer the search_files tool for one-off content search; use execute_command with rg when batching or when you need shell-specific flags.
- Commands that cannot be done with read_file, search_files, or write tools.

When NOT to use:
- Reading a single file: use read_file (not cat/head/tail).
- One-off content search: use search_files (not grep/rg) when a single pattern is enough.
- Editing files: use replace_in_file or write_to_file (not sed/awk/echo).

Provide an optional \`description\` (5–10 words) so the UI can show what the command does (e.g. "List TS files", "Run tests").

Output: stdout+stderr, exit code; capped at 50KB (head+tail if larger). ANSI and progress bars stripped. Timeout: default 120s, max 600s. Chain sequential steps with &&.

**Do not block on long-running work:** For builds, tests, servers, or anything that can take more than 1–2 minutes, set \`background: true\` (and optionally \`log_path\`). The tool returns immediately with PID and log path. Then in separate execute_command calls: (1) **Watch output:** \`tail -n 100 <log_path>\` to see recent lines. (2) **Poll with sleep:** \`sleep 10 && tail -n 100 <log_path>\` to wait and check again. (3) **Search for errors:** \`grep -E "error|Error|FAIL|exception" <log_path>\`. If you see failures, stop the process: \`kill <PID>\` (or \`pkill -f "part of command"\`), then notify the user with attempt_completion or a clear message. Do not run long commands in blocking mode — they will time out and the user cannot see progress.`,
  parameters: schema,
  requiresApproval: true,

  async execute({ command, cwd: cmdCwd, timeout_seconds, background, log_path: userLogPath }, ctx: ToolContext) {
    const workingDir = cmdCwd ? (cmdCwd.startsWith("/") ? cmdCwd : `${ctx.cwd}/${cmdCwd}`) : ctx.cwd

    if (background) {
      const nexusDir = path.join(ctx.cwd, ".nexus")
      try { fs.mkdirSync(nexusDir, { recursive: true }) } catch { /* ignore */ }
      const logPath = userLogPath
        ? (path.isAbsolute(userLogPath) ? userLogPath : path.join(ctx.cwd, userLogPath))
        : path.join(nexusDir, `run_${Date.now()}.log`)
      const logStream = fs.createWriteStream(logPath, { flags: "a" })

      const child = spawn(command, [], {
        shell: true,
        cwd: workingDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      child.stdout?.pipe(logStream)
      child.stderr?.pipe(logStream)
      child.unref()
      const pid = child.pid ?? 0

      return {
        success: true,
        output: `[background] PID: ${pid}\nLog: ${path.relative(ctx.cwd, logPath) || logPath}\n\nMonitor: tail -n 100 "${path.relative(ctx.cwd, logPath) || logPath}"\nPoll: sleep 10 && tail -n 100 "${path.relative(ctx.cwd, logPath) || logPath}"\nSearch errors: grep -E "error|Error|FAIL" "${path.relative(ctx.cwd, logPath) || logPath}"\nStop: kill ${pid}`,
        metadata: { pid, logPath: path.relative(ctx.cwd, logPath) || logPath },
      }
    }

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
