import { constants as fsConstants } from "node:fs"
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import crypto from "node:crypto"

export type StorageDiagnosticCode =
  | "primary-corrupt"
  | "backup-corrupt"
  | "recovered-from-backup"
  | "stale-lock-recovered"

export interface StorageDiagnostic {
  code: StorageDiagnosticCode
  path: string
  message: string
}

export class StorageCorruptionError extends Error {
  readonly diagnostics: readonly StorageDiagnostic[]

  constructor(target: string, diagnostics: readonly StorageDiagnostic[]) {
    super(`Storage is corrupt and no verified copy can be read: ${target}`)
    this.name = "StorageCorruptionError"
    this.diagnostics = diagnostics
  }
}

export class FileLockTimeoutError extends Error {
  constructor(
    readonly target: string,
    readonly timeoutMs: number,
  ) {
    super(`Timed out after ${timeoutMs}ms waiting for storage lock: ${target}`)
    this.name = "FileLockTimeoutError"
  }
}

export interface AtomicWriteOptions {
  backup?: boolean
  mode?: number
}

export interface FileLockOptions {
  timeoutMs?: number
  staleMs?: number
  retryMinMs?: number
  retryMaxMs?: number
  signal?: AbortSignal
  onDiagnostic?: (diagnostic: StorageDiagnostic) => void
}

type LockOwner = {
  version: 1
  pid: number
  hostname: string
  nonce: string
  createdAt: number
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000
const DEFAULT_STALE_MS = 60_000
const DEFAULT_RETRY_MIN_MS = 10
const DEFAULT_RETRY_MAX_MS = 100
const processQueues = new Map<string, Promise<void>>()

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === "string" ? reason : "The storage operation was aborted")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      if (signal) signal.removeEventListener("abort", onAbort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    if (!signal) return
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(directory, fsConstants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Directory fsync is not supported by every Windows/filesystem combination.
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") {
      throw error
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeAndSync(target: string, content: string | Uint8Array, mode: number): Promise<void> {
  const handle = await open(target, "wx", mode)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Replace a file without exposing a partially written target. The temporary
 * file is created in the same directory so rename remains an atomic boundary.
 */
export async function atomicWriteFile(
  target: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const resolved = path.resolve(target)
  const directory = path.dirname(resolved)
  const mode = options.mode ?? 0o600
  await mkdir(directory, { recursive: true, mode: 0o700 })

  const nonce = crypto.randomBytes(8).toString("hex")
  const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${nonce}.tmp`)
  const backupTemporary = `${temporary}.bak`

  try {
    await writeAndSync(temporary, content, mode)

    if (options.backup) {
      try {
        await copyFile(resolved, backupTemporary, fsConstants.COPYFILE_EXCL)
        const backupHandle = await open(backupTemporary, "r")
        try {
          await backupHandle.sync()
        } finally {
          await backupHandle.close()
        }
        await rename(backupTemporary, `${resolved}.bak`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }

    await rename(temporary, resolved)
    await syncDirectory(directory)
  } finally {
    await unlink(temporary).catch(() => undefined)
    await unlink(backupTemporary).catch(() => undefined)
  }
}

export async function atomicWriteJson(
  target: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`, options)
}

export interface JsonRecoveryResult<T> {
  value: T | undefined
  source: "primary" | "backup" | "missing"
  diagnostics: StorageDiagnostic[]
}

async function readJsonCandidate<T>(
  candidate: string,
): Promise<{ kind: "ok"; value: T } | { kind: "missing" } | { kind: "corrupt"; error: unknown }> {
  try {
    return { kind: "ok", value: JSON.parse(await readFile(candidate, "utf8")) as T }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
    return { kind: "corrupt", error }
  }
}

export async function readJsonWithRecovery<T>(target: string): Promise<JsonRecoveryResult<T>> {
  const resolved = path.resolve(target)
  const diagnostics: StorageDiagnostic[] = []
  const primary = await readJsonCandidate<T>(resolved)
  if (primary.kind === "ok") {
    return { value: primary.value, source: "primary", diagnostics }
  }
  if (primary.kind === "corrupt") {
    diagnostics.push({
      code: "primary-corrupt",
      path: resolved,
      message: primary.error instanceof Error ? primary.error.message : String(primary.error),
    })
  }

  const backupPath = `${resolved}.bak`
  const backup = await readJsonCandidate<T>(backupPath)
  if (backup.kind === "ok") {
    diagnostics.push({
      code: "recovered-from-backup",
      path: backupPath,
      message: `Recovered ${resolved} from its last backup`,
    })
    return { value: backup.value, source: "backup", diagnostics }
  }
  if (backup.kind === "corrupt") {
    diagnostics.push({
      code: "backup-corrupt",
      path: backupPath,
      message: backup.error instanceof Error ? backup.error.message : String(backup.error),
    })
  }

  if (primary.kind === "missing" && backup.kind === "missing") {
    return { value: undefined, source: "missing", diagnostics }
  }
  throw new StorageCorruptionError(resolved, diagnostics)
}

export function getFileLockPath(target: string): string {
  return `${path.resolve(target)}.lock`
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.createdAt !== "number"
    ) {
      return null
    }
    return parsed as LockOwner
  } catch {
    return null
  }
}

async function removeLockDirectory(lockPath: string): Promise<void> {
  await unlink(path.join(lockPath, "owner.json")).catch(() => undefined)
  await rmdir(lockPath).catch(() => undefined)
}

async function recoverStaleLock(
  lockPath: string,
  staleMs: number,
  onDiagnostic?: (diagnostic: StorageDiagnostic) => void,
): Promise<boolean> {
  let lockStat: Awaited<ReturnType<typeof stat>>
  try {
    lockStat = await stat(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }

  const owner = await readLockOwner(lockPath)
  const ageFrom = Math.max(lockStat.mtimeMs, owner?.createdAt ?? 0)
  if (Date.now() - ageFrom < staleMs) return false
  if (owner?.hostname === hostname() && isProcessAlive(owner.pid)) return false

  const stalePath = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
  try {
    await rename(lockPath, stalePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    return false
  }

  await removeLockDirectory(stalePath)
  onDiagnostic?.({
    code: "stale-lock-recovered",
    path: lockPath,
    message: owner
      ? `Recovered stale lock owned by pid ${owner.pid} on ${owner.hostname}`
      : "Recovered stale lock with missing or invalid ownership metadata",
  })
  return true
}

async function acquireCrossProcessLock(
  target: string,
  options: FileLockOptions,
): Promise<() => Promise<void>> {
  const lockPath = getFileLockPath(target)
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const retryMinMs = Math.max(1, options.retryMinMs ?? DEFAULT_RETRY_MIN_MS)
  const retryMaxMs = Math.max(retryMinMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS)
  const startedAt = Date.now()
  const owner: LockOwner = {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    nonce: crypto.randomBytes(12).toString("hex"),
    createdAt: Date.now(),
  }

  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  let attempt = 0
  while (true) {
    throwIfAborted(options.signal)
    try {
      await mkdir(lockPath, { mode: 0o700 })
      try {
        await writeAndSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, 0o600)
      } catch (error) {
        await removeLockDirectory(lockPath)
        throw error
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (await recoverStaleLock(lockPath, staleMs, options.onDiagnostic)) continue
      if (Date.now() - startedAt >= timeoutMs) {
        throw new FileLockTimeoutError(target, timeoutMs)
      }
      const exponential = Math.min(retryMaxMs, retryMinMs * 2 ** Math.min(attempt, 8))
      const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 4)))
      await delay(Math.min(retryMaxMs, exponential + jitter), options.signal)
      attempt += 1
    }
  }

  return async () => {
    const currentOwner = await readLockOwner(lockPath)
    if (currentOwner?.nonce !== owner.nonce) return
    await removeLockDirectory(lockPath)
  }
}

async function serializeInProcess<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(target)
  const previous = processQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = previous.catch(() => undefined).then(() => gate)
  processQueues.set(key, current)

  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (processQueues.get(key) === current) {
      processQueues.delete(key)
    }
  }
}

/**
 * Serialize a durable mutation across both async callers in this process and
 * other Nexus processes sharing the same state directory.
 */
export async function withFileLock<T>(
  target: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  return serializeInProcess(target, async () => {
    const release = await acquireCrossProcessLock(target, options)
    try {
      throwIfAborted(options.signal)
      return await operation()
    } finally {
      await release()
    }
  })
}
