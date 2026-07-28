import * as path from "node:path"

import { execa } from "execa"

import type {
  GitCommandFailureKind,
  GitCommandLimits,
  GitCommandResult,
  GitCommandRunnerPort,
} from "./types.js"

const DEFAULT_LIMITS: GitCommandLimits = Object.freeze({
  timeoutMs: 30_000,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 256 * 1024,
})

const REMOVED_GIT_ENVIRONMENT = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_ASKPASS",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_PROXY_COMMAND",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_TEMPLATE_DIR",
  "GIT_WORK_TREE",
  "SSH_ASKPASS",
])

const DISABLED_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null"

export function createSanitizedGitEnvironment(
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined || REMOVED_GIT_ENVIRONMENT.has(key)) continue
    environment[key] = value
  }
  environment.GIT_TERMINAL_PROMPT = "0"
  environment.GIT_PAGER = "cat"
  environment.PAGER = "cat"
  environment.GIT_OPTIONAL_LOCKS = "0"
  return environment
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return resolved
}

function resolveLimits(
  defaults: GitCommandLimits,
  overrides: Partial<GitCommandLimits> = {},
): GitCommandLimits {
  return {
    timeoutMs: positiveLimit(
      overrides.timeoutMs,
      defaults.timeoutMs,
      "Git command timeout",
    ),
    maxStdoutBytes: positiveLimit(
      overrides.maxStdoutBytes,
      defaults.maxStdoutBytes,
      "Git stdout limit",
    ),
    maxStderrBytes: positiveLimit(
      overrides.maxStderrBytes,
      defaults.maxStderrBytes,
      "Git stderr limit",
    ),
  }
}

function outputBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === "string") return Buffer.from(value)
  return Buffer.alloc(0)
}

export class GitCommandExecutionError extends Error {
  readonly kind: GitCommandFailureKind
  readonly result: GitCommandResult

  constructor(
    kind: GitCommandFailureKind,
    message: string,
    result: GitCommandResult,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "GitCommandExecutionError"
    this.kind = kind
    this.result = result
  }
}

export interface GitCommandRunnerOptions {
  executable?: string
  environment?: NodeJS.ProcessEnv
  defaultLimits?: Partial<GitCommandLimits>
}

/**
 * Workspace-bound, argv-only Git process boundary.
 *
 * Operation-specific callers still select read-only subcommands and pass
 * helper-disabling flags such as --no-ext-diff and --no-textconv.
 */
export class GitCommandRunner implements GitCommandRunnerPort {
  readonly #cwd: string
  readonly #executable: string
  readonly #environment: NodeJS.ProcessEnv
  readonly #defaultLimits: GitCommandLimits

  constructor(cwd: string, options: GitCommandRunnerOptions = {}) {
    if (!cwd.trim()) throw new Error("Git command cwd cannot be empty")
    this.#cwd = path.resolve(cwd)
    this.#executable = options.executable ?? "git"
    this.#environment = createSanitizedGitEnvironment(
      options.environment ?? process.env,
    )
    this.#defaultLimits = resolveLimits(
      DEFAULT_LIMITS,
      options.defaultLimits,
    )
  }

  async run(
    args: readonly string[],
    limitOverrides: Partial<GitCommandLimits> = {},
  ): Promise<GitCommandResult> {
    const argv = [...args]
    if (
      argv.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.includes("\0"),
      )
    ) {
      throw new TypeError("Git arguments must be NUL-free strings")
    }
    const limits = resolveLimits(this.#defaultLimits, limitOverrides)
    const invocation = [
      "-c",
      `core.hooksPath=${DISABLED_HOOKS_PATH}`,
      "-c",
      "core.pager=cat",
      ...argv,
    ]

    let rawResult
    try {
      rawResult = await execa(this.#executable, invocation, {
        cwd: this.#cwd,
        env: this.#environment,
        extendEnv: false,
        shell: false,
        reject: false,
        encoding: "buffer",
        stripFinalNewline: false,
        timeout: limits.timeoutMs,
        forceKillAfterDelay: 250,
        maxBuffer: {
          stdout: limits.maxStdoutBytes,
          stderr: limits.maxStderrBytes,
        },
      })
    } catch (error) {
      const result: GitCommandResult = {
        argv,
        exitCode: -1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false,
        truncated: false,
      }
      throw new GitCommandExecutionError(
        "spawn",
        "Git process could not be started",
        result,
        { cause: error },
      )
    }

    const timedOut = rawResult.timedOut === true
    const truncated = rawResult.isMaxBuffer === true
    const result: GitCommandResult = {
      argv,
      exitCode:
        typeof rawResult.exitCode === "number"
          ? rawResult.exitCode
          : -1,
      stdout: outputBuffer(rawResult.stdout),
      stderr: outputBuffer(rawResult.stderr),
      timedOut,
      truncated,
    }
    if (timedOut) {
      throw new GitCommandExecutionError(
        "timeout",
        `Git command exceeded its ${limits.timeoutMs} ms deadline`,
        result,
      )
    }
    if (truncated) {
      throw new GitCommandExecutionError(
        "output_limit",
        "Git command exceeded its bounded output allowance",
        result,
      )
    }
    if (rawResult.failed && rawResult.exitCode === undefined) {
      throw new GitCommandExecutionError(
        "spawn",
        "Git process failed before returning an exit code",
        result,
        { cause: rawResult.cause },
      )
    }
    return result
  }
}
