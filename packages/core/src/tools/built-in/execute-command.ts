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

function isProcessRunning(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Compact background job summary for prompt context so the agent can keep tracking long-running commands. */
export function getBackgroundBashJobsForPrompt(cwd: string): string {
  if (backgroundBashJobs.size === 0) return ""
  const rows = Array.from(backgroundBashJobs.entries())
    .map(([bashId, job]) => {
      const running = isProcessRunning(job.pid)
      const relLog = path.isAbsolute(job.logPath) ? path.relative(cwd, job.logPath) : job.logPath
      return `- ${bashId} | pid=${job.pid} | status=${running ? "running" : "exited"} | log=${relLog}`
    })
    .sort((a, b) => a.localeCompare(b))
  return rows.join("\n")
}

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

IMPORTANT: This tool is for terminal operations like git, npm, docker, builds, tests, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) — use the dedicated tools instead.

Before executing the command, follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use List or Glob to verify the parent directory exists and is the correct location.
   - For example, before running "mkdir foo/bar", first use List to check that "foo" exists and is the intended parent directory.

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt").
   - After ensuring proper quoting, execute the command. Capture the output.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). Default timeout is 120000ms (2 minutes).
  - Write a clear, concise description of what this command does. For simple commands keep it brief (5-10 words). For complex piped commands or obscure flags, add enough context to clarify what it does. Never use words like "complex" or "risk" in the description.
    - ls → "List files in current directory"
    - git status → "Show working tree status"
    - npm install → "Install package dependencies"
    - find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
  - If output exceeds 50KB, it will be truncated (head+tail shown); full output is saved to .nexus/tool-output/ for further inspection.
  - **Blocking vs background:** Use blocking (default) for short commands where you need the result immediately (e.g. git status, npm run lint, short scripts). Use run_in_background: true for long-running commands (builds, servers, tests, migrations). With background: Bash returns immediately with bash_id; output is written to .nexus/<bash_id>.log in real time. Use BashOutput(bash_id) to read progress — the response includes [Process status: running | exited]. Poll until exited or use KillBash(shell_id) to stop. Do NOT use '&' in the command itself.
  - Avoid using Bash with find, grep, cat, head, tail, sed, awk, or echo unless explicitly instructed. Instead use dedicated tools:
    - File search: Glob (NOT find or ls)
    - Content search: Grep (NOT grep or rg)
    - Read files: Read (NOT cat/head/tail)
    - Edit files: Edit (NOT sed/awk)
    - Write files: Write (NOT echo >/cat <<EOF)
    - Communication: output text directly (NOT echo/printf)
  - **Non-interactive commands** — For any command that would prompt for user input (confirmations, passwords, selections), assume the user is NOT available. Pass non-interactive flags: \`--yes\` / \`-y\` for package managers, \`--force\` / \`-f\` when appropriate, \`--non-interactive\` for CLIs that support it. Never run a command that will block waiting for input.
  - When issuing multiple commands: if they are independent, make multiple Bash calls in a single response (parallel). If they depend on each other, use '&&' to chain them. Use ';' only when you don't care if earlier commands fail. DO NOT use newlines to separate commands (newlines are ok in quoted strings).
  - Use absolute paths and avoid cd. If you must run in a subdirectory, prefix with the absolute path:
    <good-example>
    pytest /foo/bar/tests
    </good-example>
    <bad-example>
    cd /foo/bar && pytest tests
    </bad-example>

### Committing changes with git

Only create commits when the user explicitly requests it. If unclear, ask first.

Git Safety Protocol:
- NEVER update the git config.
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests them.
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc.) unless the user explicitly asks.
- NEVER force-push to main/master; warn the user if they request it.
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would corrupt the previous commit. Fix the issue, re-stage, and create a NEW commit instead.
- When staging files, prefer adding specific files by name rather than "git add -A" or "git add ." to avoid accidentally including secrets (.env, credentials) or large binaries.
- NEVER commit unless the user explicitly asks. It is VERY IMPORTANT to only commit when asked.

When the user asks for a git commit:
1. Run in parallel: git status (to see untracked files — NEVER use -uall flag, it can OOM on large repos), git diff (to see staged and unstaged changes), git log --oneline -10 (to understand commit message style).
2. Draft a commit message: summarize the nature of changes (feat/fix/refactor/docs/test); focus on "why" not "what"; 1-2 sentences; do not commit files that may contain secrets (.env, credentials.json).
3. Run in parallel: git add <specific-files>, then create the commit; run git status after to verify.
4. If the commit fails due to a pre-commit hook: fix the issue and create a NEW commit (do not amend).

Always pass the commit message via a HEREDOC:
<example>
git commit -m "$(cat <<'EOF'
feat: add user authentication flow

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
</example>

Important: NEVER push to remote unless the user explicitly asks. NEVER use git commands with -i flag (rebase -i, add -i) as they require interactive input.

### Creating pull requests

Use the gh command for ALL GitHub-related tasks (issues, PRs, checks, releases). If given a GitHub URL, use gh to fetch the information.

When the user asks to create a pull request:
1. Run in parallel: git status (no -uall), git diff, git log + git diff [base-branch]...HEAD (full history since diverging from base).
2. Analyze ALL commits that will be included (not just the latest). Draft a PR title (under 70 characters) and body.
3. Run in parallel: create branch if needed, push with -u flag if needed, create PR with gh pr create using a HEREDOC for the body:
<example>
gh pr create --title "feat: add user authentication" --body "$(cat <<'EOF'
## Summary
- Add JWT-based authentication middleware
- Implement login/logout endpoints
- Add token refresh logic

## Test plan
- [ ] Run auth unit tests: npm test src/auth
- [ ] Test login flow manually in staging
- [ ] Verify token expiry behavior

🤖 Generated with NexusCode
EOF
)"
</example>

Return the PR URL when done. Do NOT push unless explicitly asked.`,
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
        output: `[background] bash_id: ${bashId}\nPID: ${pid}\nLog: ${relLog}\n\nOutput is written to the log file in real time. Use BashOutput(bash_id: "${bashId}") to read progress; the response includes [Process status: running | exited]. Use KillBash(shell_id: "${bashId}") to stop the process.`,
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
