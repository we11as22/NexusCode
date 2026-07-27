import { z } from "zod"
import { randomUUID } from "node:crypto"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import stripAnsi from "strip-ansi"
import type { ToolDef, ToolContext } from "../../types.js"
import { getRunLogsDir } from "../../data-dir.js"
import { handleCompletedTaskSideEffects } from "../../orchestration/task-lifecycle.js"
import {
  detectBlockedSleepPattern,
  detectDangerousShellPattern,
  detectPreferDedicatedToolMessage,
  isLikelyLongRunningShellCommand,
} from "./shell-safety.js"
import { interpretShellCommandResult } from "./shell-command-semantics.js"

/** Max size of saved full output file (OpenCode-style disk protection). */
const MAX_TOOL_OUTPUT_FILE_BYTES = 50 * 1024 * 1024 // 50 MB
const DEFAULT_TIMEOUT = 120_000 // 2 minutes
const PROGRESS_LINE_PATTERN = /[\r\x1b\[2K]/ // CR or ANSI clear line
/** Matches lines that look like progress bar updates (one per line). */
const PROGRESS_LIKE_LINE = /%\s*$|progress|downloading|building|extracting|\[\s*[\d.]*%?\s*\]|\d+\.?\d*\s*%/i

/** Delete run_*.log files older than this (Kilo-style retention). */
const RUN_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const BACKGROUND_STOP_GRACE_MS = 1_000
const LOG_TRUNCATION_MARKER =
  "\n[Background output truncated at the 50 MiB safety limit]\n"
const BOUNDED_LOG_RUNNER = String.raw`
const fs = require("node:fs")
const { spawn } = require("node:child_process")
const input = JSON.parse(
  Buffer.from(process.argv[1], "base64url").toString("utf8"),
)
const marker = Buffer.from(input.marker, "utf8")
const payloadLimit = input.maxBytes - marker.byteLength
const logFd = fs.openSync(input.logPath, "r+")
fs.ftruncateSync(logFd, 0)
let written = 0
let truncated = false
let finished = false
const append = (chunk) => {
  if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk)
  const remaining = payloadLimit - written
  if (remaining <= 0) {
    truncated = truncated || chunk.byteLength > 0
    return
  }
  const take = Math.min(remaining, chunk.byteLength)
  if (take > 0) {
    fs.writeSync(logFd, chunk, 0, take)
    written += take
  }
  if (take < chunk.byteLength) truncated = true
}
const finish = (code) => {
  if (finished) return
  finished = true
  if (truncated) fs.writeSync(logFd, marker)
  fs.closeSync(logFd)
  process.exitCode = Number.isInteger(code) ? code : 1
}
const child = spawn(input.command, [], {
  shell: true,
  cwd: input.cwd,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
})
child.stdout.on("data", append)
child.stderr.on("data", append)
child.once("error", () => finish(1))
child.once("close", (code) => finish(code))
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    try {
      child.kill(signal)
    } catch {}
  })
}
`

type BackgroundProcessOutcome = {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

/** Short path for display (e.g. ~/.nexus/data/run/run_123.log). */
function shortDataPath(absolutePath: string): string {
  const home = os.homedir()
  if (absolutePath.startsWith(home + path.sep) || absolutePath === home) {
    return path.join("~", ".nexus", path.relative(path.join(home, ".nexus"), absolutePath)).replace(/\\/g, "/")
  }
  return absolutePath.replace(/\\/g, "/")
}

async function cleanupOldRunLogs(
  runDir: string,
  ownsActiveLog: (logPath: string) => boolean,
): Promise<void> {
  const cutoff = Date.now() - RUN_LOG_RETENTION_MS
  try {
    const entries = await fs.promises.readdir(runDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith("run_") || !e.name.endsWith(".log")) continue
      const m = e.name.match(/^run_(\d+)(?:_[a-f0-9]+)?\.log$/i)
      const ts = m ? parseInt(m[1]!, 10) : NaN
      if (!Number.isFinite(ts) || ts < cutoff) {
        const candidate = path.join(runDir, e.name)
        if (ownsActiveLog(candidate)) continue
        await fs.promises.unlink(candidate).catch(() => {})
      }
    }
  } catch {
    // Dir missing or not readable — ignore
  }
}

async function readBackgroundOutput(logPath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(logPath, "utf8")
  } catch {
    return undefined
  }
}

async function compactCompletedLog(logPath: string): Promise<void> {
  const stat = await fs.promises.stat(logPath)
  if (stat.size <= MAX_TOOL_OUTPUT_FILE_BYTES) return
  const marker = Buffer.from(LOG_TRUNCATION_MARKER, "utf8")
  const markerOffset = MAX_TOOL_OUTPUT_FILE_BYTES - marker.byteLength
  const handle = await fs.promises.open(logPath, "r+")
  try {
    await handle.write(marker, 0, marker.byteLength, markerOffset)
    await handle.truncate(MAX_TOOL_OUTPUT_FILE_BYTES)
  } finally {
    await handle.close()
  }
}

function spawnBackgroundProcess(args: {
  command: string
  cwd: string
  logPath: string
  processIdentity: string
}): ChildProcess {
  const logFd = fs.openSync(args.logPath, "wx", 0o600)
  fs.closeSync(logFd)
  const input = Buffer.from(JSON.stringify({
    command: args.command,
    cwd: args.cwd,
    logPath: args.logPath,
    marker: LOG_TRUNCATION_MARKER,
    maxBytes: MAX_TOOL_OUTPUT_FILE_BYTES,
  })).toString("base64url")
  return spawn(
    process.execPath,
    [
      "-e",
      BOUNDED_LOG_RUNNER,
      input,
    ],
    {
      cwd: args.cwd,
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        NEXUS_BACKGROUND_PROCESS_IDENTITY: args.processIdentity,
      },
    },
  )
}

function waitForProcessOutcome(
  completion: Promise<BackgroundProcessOutcome>,
  timeoutMs: number,
): Promise<BackgroundProcessOutcome | null> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, timeoutMs)
    void completion.then((outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    })
  })
}

export async function startBackgroundShellTask(args: {
  command: string
  cwd: string
  shellRunner?: "bash" | "powershell"
  host: ToolContext["host"]
  services: ToolContext["services"]
  sessionId: string
  config?: ToolContext["config"]
  metadata?: Record<string, unknown>
}): Promise<{ taskId: string; pid: number; logPath: string }> {
  const runDir = getRunLogsDir()
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") {
    fs.chmodSync(runDir, 0o700)
  }
  await cleanupOldRunLogs(
    runDir,
    (candidate) =>
      args.services.backgroundProcesses.ownsLogPath(candidate),
  )
  const taskId = `run_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 12)}`
  const logPath = path.join(runDir, `${taskId}.log`)
  const processIdentity = randomUUID()
  const child = spawnBackgroundProcess({
    command: args.command,
    cwd: args.cwd,
    logPath,
    processIdentity,
  })
  child.unref()
  const pid = child.pid ?? 0
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    child.kill("SIGKILL")
    throw new Error("Background process did not receive a valid process id")
  }

  const completion = new Promise<BackgroundProcessOutcome>((resolve) => {
    let settled = false
    const settle = (outcome: BackgroundProcessOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    child.once("error", (error) => {
      settle({ code: null, signal: null, error })
    })
    child.once("close", (code, signal) => {
      settle({ code, signal })
    })
  })

  const terminate = (signal: NodeJS.Signals): boolean => {
    if (child.exitCode !== null || child.signalCode !== null) return false
    if (process.platform === "win32") {
      const result = spawnSync(
        "taskkill",
        ["/pid", String(pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
          timeout: BACKGROUND_STOP_GRACE_MS,
        },
      )
      return result.status === 0
    }
    try {
      process.kill(-pid, signal)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      try {
        return child.kill(signal)
      } catch {
        return false
      }
    }
  }

  let runtimePromise!: Promise<
    ToolContext["services"]["orchestrationRuntime"]
  >
  let requestedStopReason: "requested" | "owner_shutdown" | undefined
  let terminationWasRequested = false
  let finalizationPromise: Promise<void> | undefined
  const finalize = (
    outcome: BackgroundProcessOutcome,
    options: {
      forcedStatus?: "failed" | "killed"
      stopReason?: "requested" | "owner_shutdown"
    } = {},
  ): Promise<void> => {
    if (finalizationPromise) return finalizationPromise
    finalizationPromise = (async () => {
      const runtime = await runtimePromise
      let logError: string | undefined
      try {
        await compactCompletedLog(logPath)
      } catch (error) {
        logError = (error as Error).message
      }
      const output = await readBackgroundOutput(logPath)
      const interpretation =
        typeof outcome.code === "number"
          ? interpretShellCommandResult(
              args.command,
              outcome.code,
              output ?? "",
              "",
            )
          : { isError: true as const }
      const effectiveStopReason =
        options.stopReason ?? requestedStopReason
      const status =
        options.forcedStatus ??
        (terminationWasRequested
          ? "killed"
          : outcome.error
          ? "failed"
          : outcome.signal === "SIGTERM" || outcome.signal === "SIGKILL"
            ? "killed"
            : !interpretation.isError
              ? "completed"
              : "failed")
      const next = await runtime.setBackgroundTaskStatus(taskId, status, {
        output,
        exitCode:
          typeof outcome.code === "number" ? outcome.code : undefined,
        ...(outcome.error ? { error: outcome.error.message } : {}),
        metadata: {
          tool:
            args.shellRunner === "powershell" ? "PowerShell" : "Bash",
          shellRunner: args.shellRunner ?? "bash",
          ...(typeof outcome.code === "number" && interpretation.message
            ? { returnCodeInterpretation: interpretation.message }
            : {}),
          ...(outcome.signal ? { signal: outcome.signal } : {}),
          ...(effectiveStopReason
            ? { stopReason: effectiveStopReason }
            : {}),
          ...(logError ? { logError } : {}),
          ...(args.metadata ?? {}),
          processIdentity,
        },
      })
      if (!next) {
        throw new Error(
          `Background task ${taskId} disappeared before terminal state could be persisted`,
        )
      }
      args.services.backgroundProcesses.remove(taskId, {
        workspace: args.cwd,
        sessionId: args.sessionId,
      })
      args.host.emit({ type: "background_task_updated", task: next })
      const unified = await runtime.getTask(taskId)
      if (!unified) return
      args.host.emit({ type: "task_updated", task: unified })
      args.host.emit({
        type: "task_completed",
        task: unified,
        outputPreview: unified.output?.slice(0, 500),
      })
      if (args.config) {
        await handleCompletedTaskSideEffects({
          cwd: args.cwd,
          host: args.host,
          config: args.config,
          task: unified,
          outputPreview: unified.output?.slice(0, 500),
          runtime,
        }).catch(() => {})
      }
    })()
    return finalizationPromise
  }

  let stopPromise: Promise<void> | undefined
  const stop = (
    reason: "requested" | "owner_shutdown",
  ): Promise<void> => {
    if (stopPromise) return stopPromise
    requestedStopReason = reason
    stopPromise = (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        terminationWasRequested = terminate("SIGTERM")
      }
      let outcome = await waitForProcessOutcome(
        completion,
        BACKGROUND_STOP_GRACE_MS,
      )
      if (!outcome && child.exitCode === null && child.signalCode === null) {
        terminationWasRequested =
          terminate("SIGKILL") || terminationWasRequested
        outcome = await waitForProcessOutcome(
          completion,
          BACKGROUND_STOP_GRACE_MS,
        )
      }
      if (!outcome) {
        const error = new Error(
          `Could not confirm termination of background process ${pid}`,
        )
        await finalize(
          {
            code: child.exitCode,
            signal: child.signalCode,
            error,
          },
          { forcedStatus: "failed", stopReason: reason },
        )
        throw error
      }
      await finalize(outcome, {
        ...(terminationWasRequested
          ? { forcedStatus: "killed" as const }
          : {}),
        stopReason: reason,
      })
    })()
    return stopPromise
  }

  runtimePromise = (async () => {
    try {
      args.services.backgroundProcesses.register({
        taskId,
        pid,
        processIdentity,
        logPath,
        workspace: args.cwd,
        sessionId: args.sessionId,
        terminate,
        stop,
      })
      const ownedRuntime = args.services.orchestrationRuntime
      const task = await ownedRuntime.registerBackgroundTask({
        id: taskId,
        kind: "bash",
        description: args.command,
        status: "running",
        command: args.command,
        cwd: args.cwd,
        processId: pid,
        logPath,
        outputFile: logPath,
        sessionId: args.sessionId,
        metadata: {
          tool: args.shellRunner === "powershell" ? "PowerShell" : "Bash",
          shellRunner: args.shellRunner ?? "bash",
          ...(args.metadata ?? {}),
          processIdentity,
        },
      })
      args.host.emit({ type: "background_task_updated", task })
      const unified = await ownedRuntime.getTask(taskId)
      if (unified) args.host.emit({ type: "task_created", task: unified })
      return ownedRuntime
    } catch (error) {
      terminate("SIGTERM")
      args.services.backgroundProcesses.remove(taskId, {
        workspace: args.cwd,
        sessionId: args.sessionId,
      })
      throw error
    }
  })()

  void completion
    .then((outcome) => finalize(outcome))
    .catch(() => {})

  await runtimePromise
  return { taskId, pid, logPath }
}

const schema = z.object({
  command: z.string().describe("The command to execute"),
  timeout: z.number().int().positive().max(600000).optional().describe("Optional timeout in milliseconds (max 600000). If not specified, commands will timeout after 120000ms (2 minutes)."),
  description: z.string().optional().describe("Clear, concise description of what this command does in active voice. For simple commands keep it brief (5-10 words). For complex commands add enough context to clarify what it does."),
  run_in_background: z.boolean().optional().describe("Set to true to run this command in the background. Use TaskOutput to read the output later."),
  dangerouslyDisableSandbox: z.boolean().optional().describe("Set this to true to dangerously override sandbox mode and run commands without sandboxing."),
})

export const bashTool: ToolDef<z.infer<typeof schema>> = {
  name: "Bash",
  searchHint: "run shell command, execute tests, build project, git command, install dependencies, long-running process",
  description: `Executes a given bash command with optional timeout. Working directory persists between commands; shell state (everything else) does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: This tool is for terminal operations like git, npm, docker, builds, tests, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) — use the dedicated tools instead.

Prefer the lowest-impact shell command that can answer the question. Inspect before mutating, and prefer dry-run or diff-producing variants when available.

Before executing the command, follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use List (or Glob) to verify the parent directory exists and is the correct location.
   - Example: before running "mkdir foo/bar", use List with path "foo" (or "." and check for foo) to confirm "foo" exists and is the intended parent.

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g. cd "path with spaces/file.txt", python "/path/with spaces/script.py").
   - After ensuring proper quoting, execute the command. Capture the output.

Usage notes:
  - The command argument is required.
  - Use foreground execution for short diagnostics and commands whose output you need immediately.
  - Use \`run_in_background: true\` only for commands that are genuinely long-running or when you have real parallel work to do while they run.
  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). Default timeout is 120000ms (2 minutes).
  - Write a clear, concise description of what this command does in active voice. For simple commands keep it brief (5-10 words). For complex piped commands or obscure flags, add enough context so a reader understands at a glance. Never use words like "complex" or "risk" in the description.
    - ls → "List files in current directory"
    - git status → "Show working tree status"
    - npm install → "Install package dependencies"
    - mkdir foo → "Create directory 'foo'"
    - find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
  - If output exceeds 50KB, the response is truncated and provides an opaque artifact id. Inspect it only with ToolOutputRead using a bounded literal search or offset/limit; artifact filesystem paths are intentionally not exposed.
  - **Blocking vs background:** Use blocking (default) for short commands where you need the result immediately (e.g. git status, npm run lint, short scripts). Use run_in_background: true for long-running commands (builds, servers, tests, migrations). With background: Bash returns immediately with a task id; output is written to the global data dir (~/.nexus/data/run/<task_id>.log) in real time. Use TaskOutput(taskId) to read progress — the response includes the current task status — or TaskStop(taskId) to stop. Do NOT use '&' at the end of the command when using run_in_background. Never use run_in_background for 'sleep' — it returns immediately and is useless.
  - **CRITICAL — Use dedicated tools instead of shell commands:** You MUST avoid using Bash for file search, content search, reading, editing, or writing. Use the dedicated tools instead. Do NOT run find, grep, cat, head, tail, sed, awk, or echo in Bash for those purposes. Use:
    - File search: Glob (NOT find or ls)
    - Content search: Grep (NOT grep or rg)
    - Read files: Read (NOT cat/head/tail)
    - Edit files: Edit (NOT sed/awk)
    - Write files: Write (NOT echo >/cat <<EOF)
    - Communication: output text directly (NOT echo/printf)
  - Use Bash when you need a real process execution side effect or runtime observation: test suites, builds, package managers, servers, git, Docker, migrations, code generators, formatters, or project scripts.
  - **Non-interactive commands** — For any command that would prompt for user input (confirmations, passwords, selections), assume the user is NOT available. Pass non-interactive flags: \`--yes\` / \`-y\` for package managers, \`--force\` / \`-f\` when appropriate, \`--non-interactive\` for CLIs that support it. Never run a command that will block waiting for input.
  - When issuing multiple commands: if they are independent, make multiple Bash calls in a single response (parallel). If they depend on each other, use '&&' to chain them (e.g. git add . && git commit -m "..." && git status). Use ';' only when you don't care if earlier commands fail. DO NOT use newlines to separate commands (newlines are ok inside quoted strings).
  - Maintain current working directory: prefer absolute paths and avoid unnecessary \`cd\`. Use \`cd\` only when the command genuinely depends on that working directory. Good: \`pytest /foo/bar/tests\`. Bad: \`cd /foo/bar && pytest tests\`.
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
    const dedicatedToolMessage = detectPreferDedicatedToolMessage(command)
    if (dedicatedToolMessage) {
      return {
        success: false,
        output: dedicatedToolMessage,
      }
    }
    const sleepWarning = detectBlockedSleepPattern(command, "bash")
    if (background && sleepWarning) {
      return {
        success: false,
        output: `${sleepWarning} Run it in the foreground if you really need it, but do not background it.`,
      }
    }
    const dangerousMessage = detectDangerousShellPattern(command)
    const autoBackgrounded = !background && isLikelyLongRunningShellCommand(command)

    if (background || autoBackgrounded) {
      const { taskId: bashId, pid, logPath } = await startBackgroundShellTask({
        command,
        cwd: workingDir,
        shellRunner: "bash",
        host: ctx.host,
        services: ctx.services,
        sessionId: ctx.session.id,
        config: ctx.config,
        metadata: {
          assistantAutoBackgrounded: autoBackgrounded,
          ...(dangerousMessage ? { dangerousWarning: dangerousMessage } : {}),
        },
      })
      const logDisplay = shortDataPath(logPath)
      return {
        success: true,
        output: `${autoBackgrounded ? "[auto-backgrounded]" : "[background]"} bash_id: ${bashId}\nPID: ${pid}\nLog: ${logDisplay}${dangerousMessage ? `\nWarning: ${dangerousMessage}` : ""}\n\nOutput is written to the log file in real time. Use TaskOutput(taskId: "${bashId}") to read progress or wait; use TaskStop(taskId: "${bashId}") to stop the process.`,
        metadata: { bash_id: bashId, pid, logPath, task_id: bashId, assistantAutoBackgrounded: autoBackgrounded },
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
    const interpretation = interpretShellCommandResult(command, result.exitCode, result.stdout, result.stderr)
    const success = !interpretation.isError
    const header = `$ ${command}\n[exit: ${result.exitCode}]\n`

    return {
      success,
      output:
        header +
        (dangerousMessage ? `[warning] ${dangerousMessage}\n` : "") +
        (interpretation.message ? `[status] ${interpretation.message}\n` : "") +
        fullOutput,
      metadata: {
        ...(interpretation.message ? { returnCodeInterpretation: interpretation.message } : {}),
      },
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
  // Collapse consecutive progress-like lines (when each update was emitted with \n)
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
