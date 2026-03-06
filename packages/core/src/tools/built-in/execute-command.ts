import { z } from "zod"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import stripAnsi from "strip-ansi"
import type { ToolDef, ToolContext } from "../../types.js"

const MAX_OUTPUT_BYTES = 50 * 1024 // 50 KB
/** Max size of saved full output file (OpenCode-style disk protection). */
const MAX_TOOL_OUTPUT_FILE_BYTES = 50 * 1024 * 1024 // 50 MB
const DEFAULT_TIMEOUT = 120_000 // 2 minutes
const PROGRESS_LINE_PATTERN = /[\r\x1b\[2K]/ // CR or ANSI clear line
/** Matches lines that look like progress bar updates (one per line). */
const PROGRESS_LIKE_LINE = /%\s*$|progress|downloading|building|extracting|\[\s*[\d.]*%?\s*\]|\d+\.?\d*\s*%/i

/** Delete .nexus/run_*.log files older than this (same idea as OpenCode Truncate cleanup). */
const RUN_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const TOOL_OUTPUT_DIR = "tool-output"

async function cleanupOldRunLogs(nexusDir: string): Promise<void> {
  const cutoff = Date.now() - RUN_LOG_RETENTION_MS
  try {
    const entries = await fs.promises.readdir(nexusDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith("run_") || !e.name.endsWith(".log")) continue
      const m = e.name.match(/^run_(\d+)\.log$/)
      const ts = m ? parseInt(m[1]!, 10) : NaN
      if (!Number.isFinite(ts) || ts < cutoff) {
        await fs.promises.unlink(path.join(nexusDir, e.name)).catch(() => {})
      }
    }
  } catch {
    // Dir missing or not readable — ignore
  }
}

/** Delete .nexus/tool-output/tool_*.out files older than retention (OpenCode-style). */
async function cleanupOldToolOutputs(toolOutputDir: string): Promise<void> {
  const cutoff = Date.now() - RUN_LOG_RETENTION_MS
  try {
    const entries = await fs.promises.readdir(toolOutputDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith("tool_") || !e.name.endsWith(".out")) continue
      const m = e.name.match(/^tool_(\d+)\.out$/)
      const ts = m ? parseInt(m[1]!, 10) : NaN
      if (!Number.isFinite(ts) || ts < cutoff) {
        await fs.promises.unlink(path.join(toolOutputDir, e.name)).catch(() => {})
      }
    }
  } catch {
    // Dir missing or not readable — ignore
  }
}

/** Registry of background bash jobs: bash_id -> { pid, logPath } for BashOutput and KillBash. */
export const backgroundBashJobs = new Map<string, { pid: number; logPath: string }>()

const schema = z.object({
  command: z.string().describe("The command to execute"),
  timeout: z.number().int().positive().max(600000).optional().describe("Optional timeout in milliseconds (max 600000). If not specified, commands will timeout after 120000ms (2 minutes)."),
  description: z.string().optional().describe("Clear, concise description of what this command does in active voice. For simple commands keep it brief (5-10 words). For complex commands add enough context to clarify what it does."),
  run_in_background: z.boolean().optional().describe("Set to true to run this command in the background. Use BashOutput to read the output later."),
  dangerouslyDisableSandbox: z.boolean().optional().describe("Set this to true to dangerously override sandbox mode and run commands without sandboxing."),
})

export const bashTool: ToolDef<z.infer<typeof schema>> = {
  name: "Bash",
  description: `Executes a given bash command with optional timeout. Working directory persists between commands; shell state (everything else) does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use ListFiles or Glob to verify the parent directory exists and is the correct location

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")
   - After ensuring proper quoting, execute the command. Capture the output of the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).
  - It is very helpful if you write a clear, concise description of what this command does. For simple commands, keep it brief (5-10 words).
  - If the output exceeds 30000 characters, output will be truncated before being returned to you.
  - You can use the run_in_background parameter to run the command in the background. Use BashOutput to read the output later. You do not need to use '&' at the end of the command when using this parameter.
  - Avoid using Bash with find, grep, cat, head, tail, sed, awk, or echo commands, unless explicitly instructed. Instead, prefer: Glob (not find/ls), Grep (not grep/rg), Read (not cat/head/tail), Edit (not sed/awk), Write (not echo/cat).
  - When issuing multiple commands, use ';' or '&&' to separate them. DO NOT use newlines to separate commands (newlines are ok in quoted strings).
  - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of cd. You may use cd if the User explicitly requests it.`,
  parameters: schema,
  requiresApproval: true,

  async execute({ command, timeout: timeoutMs, run_in_background: background }, ctx: ToolContext) {
    const workingDir = ctx.cwd

    if (background) {
      const nexusDir = path.join(ctx.cwd, ".nexus")
      try { fs.mkdirSync(nexusDir, { recursive: true }) } catch { /* ignore */ }
      await cleanupOldRunLogs(nexusDir)
      const bashId = `run_${Date.now()}`
      const logPath = path.join(nexusDir, `${bashId}.log`)
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
      backgroundBashJobs.set(bashId, { pid, logPath })

      const relLog = path.relative(ctx.cwd, logPath) || logPath
      return {
        success: true,
        output: `[background] bash_id: ${bashId}\nPID: ${pid}\nLog: ${relLog}\n\nUse BashOutput with bash_id "${bashId}" to read output. Use KillBash with shell_id "${bashId}" to stop.`,
        metadata: { bash_id: bashId, pid, logPath: relLog },
      }
    }

    const timeout = timeoutMs ?? DEFAULT_TIMEOUT

    let result: { stdout: string; stderr: string; exitCode: number }
    try {
      const ac = new AbortController()
      const timeoutId = setTimeout(() => ac.abort(), timeout)
      try {
        result = await ctx.host.runCommand(command, workingDir, ac.signal)
      } finally {
        clearTimeout(timeoutId)
      }
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; exitCode?: number }
      if (e.code === "ABORT_ERR" || (err as Error).message?.includes("abort") || (err as Error).message?.includes("timed out")) {
        return {
          success: false,
          output: `Command timed out after ${(timeoutMs ?? 120000) / 1000}s: ${command}`,
        }
      }
      result = {
        stdout: (e as { stdout?: string }).stdout ?? "",
        stderr: (e as { stderr?: string }).stderr ?? (err as Error).message,
        exitCode: (e as { exitCode?: number }).exitCode ?? 1,
      }
    }

    const fullOutput = sanitizeOutput(result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ""))
    const bytes = Buffer.byteLength(fullOutput, "utf8")
    let outputMessage: string
    if (bytes <= MAX_OUTPUT_BYTES) {
      outputMessage = fullOutput
    } else {
      const lines = fullOutput.split("\n")
      const total = lines.length
      const headLines = lines.slice(0, 100)
      const tailLines = lines.slice(-100)
      const truncatedCount = total - 200
      const truncated = [
        ...headLines,
        `[... ${truncatedCount} lines truncated ...]`,
        ...tailLines,
      ].join("\n")
      const nexusDir = path.join(ctx.cwd, ".nexus")
      const toolOutputDir = path.join(nexusDir, TOOL_OUTPUT_DIR)
      try { fs.mkdirSync(toolOutputDir, { recursive: true }) } catch { /* ignore */ }
      await cleanupOldToolOutputs(toolOutputDir)
      const ts = Date.now()
      const outPath = path.join(toolOutputDir, `tool_${ts}.out`)
      // Cap file size by bytes to protect disk (OpenCode-style)
      const buf = Buffer.from(fullOutput, "utf8")
      const capped =
        buf.length <= MAX_TOOL_OUTPUT_FILE_BYTES
          ? fullOutput
          : buf.subarray(0, MAX_TOOL_OUTPUT_FILE_BYTES).toString("utf8") +
            "\n\n[output truncated at 50 MB in file; use grep or read_file with start_line/end_line]\n"
      await fs.promises.writeFile(outPath, capped, "utf8").catch(() => {})
      const relPath = path.relative(ctx.cwd, outPath).replace(/\\/g, "/") || `.nexus/${TOOL_OUTPUT_DIR}/tool_${ts}.out`
      const hint = `\n\nFull output saved to: ${relPath}\nUse grep to search the full content or read_file with start_line/end_line to view specific sections.`
      outputMessage = truncated + hint
    }

    const success = result.exitCode === 0
    const header = `$ ${command}\n[exit: ${result.exitCode}]\n`

    return {
      success,
      output: header + outputMessage,
    }
  },
}

function sanitizeOutput(raw: string): string {
  // Strip ANSI escape codes
  let cleaned = stripAnsi(raw)
  // Deduplicate progress bar lines (lines with CR/ANSI clear that overwrite each other)
  let lines = cleaned
    .split("\n")
    .map(line => {
      if (PROGRESS_LINE_PATTERN.test(line)) {
        // Take only the last "frame" of a progress line
        const frames = line.split("\r")
        return frames[frames.length - 1]?.trim() ?? ""
      }
      return line
    })
  // Collapse consecutive progress-like lines (when each update was emitted with \n, like in Cline)
  lines = collapseProgressLines(lines)
  return lines.join("\n")
}

/** Merge consecutive progress-bar lines into one (keep last), so they don't inflate line count. */
function collapseProgressLines(lines: string[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const runStart = i
    while (i < lines.length && isProgressLikeLine(lines[i]!)) {
      i++
    }
    if (i > runStart) {
      // Keep only the last line of the run (final progress state)
      out.push(lines[i - 1]!)
    } else {
      out.push(lines[i]!)
      i++
    }
  }
  return out
}

function isProgressLikeLine(line: string): boolean {
  const t = line.trim()
  if (t.length > 100) return false
  return PROGRESS_LIKE_LINE.test(t)
}
