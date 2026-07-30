import { spawn } from "node:child_process"
import { isLikelySandboxDenied } from "./denial.js"
import { sanitizeSandboxEnvironment } from "./environment.js"
import type {
  NativeSandboxRequest,
  SandboxExecutionResult,
  SandboxKind,
} from "./types.js"

const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000

type NativeControlMessage = {
  version: number
  type: "started" | "exited" | "error"
  executionId: string
  sandbox?: SandboxKind
  exitCode?: number
  errorCode?: string
  message?: string
  timedOut?: boolean
}

export interface RunSandboxedOptions {
  binaryPath: string
  signal?: AbortSignal
  maxOutputBytes?: number
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  detached?: boolean
}

export interface SandboxExecutionHandle {
  /** PID of the trusted Nexus sandbox helper, not the untrusted command. */
  pid: number
  /** Resolves only after the helper confirms that the OS policy is active. */
  ready: Promise<SandboxKind | null>
  result: Promise<SandboxExecutionResult>
  stop(): boolean
}

export function startSandboxed(
  request: NativeSandboxRequest,
  options: RunSandboxedOptions,
): SandboxExecutionHandle {
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const child = spawn(options.binaryPath, [], {
    cwd: request.cwd,
    shell: false,
    windowsHide: true,
    detached: options.detached ?? false,
    env: sanitizeSandboxEnvironment(process.env),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  let controlBuffer = ""
  let sandbox: SandboxKind = "none"
  let started = false
  let timedOut = false
  let setupError: SandboxExecutionResult["setupError"]
  let invalidControl = false
  let readySettled = false
  let resolveReady!: (sandbox: SandboxKind | null) => void
  const ready = new Promise<SandboxKind | null>((resolve) => {
    resolveReady = resolve
  })
  const settleReady = (value: SandboxKind | null) => {
    if (readySettled) return
    readySettled = true
    resolveReady(value)
  }

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8")
    stdout = appendBounded(stdout, text, maxBytes)
    options.onStdout?.(text)
  })
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8")
    stderr = appendBounded(stderr, text, maxBytes)
    options.onStderr?.(text)
  })
  const control = child.stdio[3]
  let earlyFailure: SandboxExecutionResult | undefined
  if (!control || typeof control === "number" || !("on" in control)) {
    child.kill("SIGKILL")
    earlyFailure = setupFailure(
      "control_channel_unavailable",
      "Sandbox control channel is unavailable",
    )
  }
  if (control && typeof control !== "number" && "on" in control) {
    control.on("data", (chunk: Buffer) => {
    controlBuffer += chunk.toString("utf8")
    let newline = controlBuffer.indexOf("\n")
    while (newline >= 0) {
      const line = controlBuffer.slice(0, newline).trim()
      controlBuffer = controlBuffer.slice(newline + 1)
      if (line) {
        const result = consumeControlMessage(line, request.executionId)
        if (!result.valid) {
          invalidControl = true
          setupError = {
            code: "invalid_control_message",
            message: result.error,
          }
          child.kill("SIGKILL")
          break
        }
        const message = result.message
        if (message.type === "started") {
          started = true
          sandbox = message.sandbox ?? "none"
          settleReady(sandbox)
        } else if (message.type === "exited") {
          timedOut = message.timedOut === true
        } else {
          setupError = {
            code: message.errorCode ?? "sandbox_setup_failed",
            message: message.message ?? "Sandbox setup failed",
          }
          settleReady(null)
        }
      }
      newline = controlBuffer.indexOf("\n")
    }
    })
  }

  const abort = () => {
    child.kill("SIGTERM")
    setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL")
    }, 500).unref()
  }
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener("abort", abort, { once: true })

  child.stdin.end(JSON.stringify(request))
  const result = (async (): Promise<SandboxExecutionResult> => {
    if (earlyFailure) {
      settleReady(null)
      return earlyFailure
    }
    const outcome = await new Promise<{ code: number; error?: Error }>((resolve) => {
      child.once("error", (error) => resolve({ code: 125, error }))
      child.once("close", (code, signal) => {
        resolve({
          code:
            typeof code === "number"
              ? code
              : signal === "SIGTERM" || signal === "SIGINT"
                ? 130
                : 125,
        })
      })
    })
    options.signal?.removeEventListener("abort", abort)

    if (outcome.error) {
      settleReady(null)
      return setupFailure("sandbox_spawn_failed", outcome.error.message, stdout, stderr)
    }
    if (!setupError && !started) {
      setupError = {
        code: "sandbox_start_unconfirmed",
        message: "Sandbox helper exited without confirming OS sandbox activation",
      }
    }
    if (!started) settleReady(null)
    const exitCode = invalidControl && outcome.code === 0 ? 125 : outcome.code
    return {
      stdout,
      stderr,
      exitCode,
      sandbox,
      timedOut,
      denied:
        !setupError &&
        isLikelySandboxDenied({
          sandbox,
          exitCode,
          stdout,
          stderr,
        }),
      ...(setupError ? { setupError } : {}),
    }
  })()

  return {
    pid: child.pid ?? 0,
    ready,
    result,
    stop() {
      if (child.exitCode != null || child.signalCode != null) return false
      abort()
      return true
    },
  }
}

export async function runSandboxed(
  request: NativeSandboxRequest,
  options: RunSandboxedOptions,
): Promise<SandboxExecutionResult> {
  return startSandboxed(request, options).result
}

function consumeControlMessage(
  line: string,
  executionId: string,
):
  | { valid: true; message: NativeControlMessage }
  | { valid: false; error: string } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { valid: false, error: "Sandbox control channel emitted invalid JSON" }
  }
  if (!value || typeof value !== "object") {
    return { valid: false, error: "Sandbox control message is not an object" }
  }
  const message = value as Partial<NativeControlMessage>
  if (
    message.version !== 1 ||
    message.executionId !== executionId ||
    !["started", "exited", "error"].includes(message.type ?? "")
  ) {
    return {
      valid: false,
      error: "Sandbox control message has an invalid version, type, or execution identity",
    }
  }
  return { valid: true, message: message as NativeControlMessage }
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const combined = current + chunk
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined
  const bytes = Buffer.from(combined, "utf8")
  return `[output truncated]\n${bytes.subarray(bytes.length - maxBytes).toString("utf8")}`
}

function setupFailure(
  code: string,
  message: string,
  stdout = "",
  stderr = "",
): SandboxExecutionResult {
  return {
    stdout,
    stderr,
    exitCode: 125,
    sandbox: "none",
    timedOut: false,
    denied: false,
    setupError: { code, message },
  }
}
