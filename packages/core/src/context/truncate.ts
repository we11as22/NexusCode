/**
 * Bounded tool-result projection with an owner-scoped durable artifact.
 *
 * Kilo/OpenCode supplies the line/byte preview policy. OpenClaude supplies the
 * more important storage invariants: session ownership, exclusive creation,
 * private permissions, and an honest distinction between full and capped
 * artifacts.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import {
  getToolOutputDir,
  getToolOutputSessionDir,
  getToolOutputWorkspaceDir,
} from "../data-dir.js"
import { listToolSpillsForWorkspace } from "./tool-output-registry.js"
import {
  collectPersistedToolOutputProtection,
} from "../session/storage.js"
import {
  TOOL_OUTPUT_ARTIFACT_FILE_PATTERN,
  TOOL_OUTPUT_SESSION_DIRECTORY_PATTERN,
} from "./tool-output-format.js"

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024 // 50 KB
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
/** Cap size of saved file to protect disk (OpenCode-style). */
const MAX_FILE_BYTES = 50 * 1024 * 1024 // 50 MB
const MAX_MAINTENANCE_SESSION_DIRECTORIES = 512
const MAX_MAINTENANCE_ARTIFACTS_PER_SESSION = 2_048

export interface TruncateOptions {
  /** Kept for call-site compatibility and diagnostics. */
  cwd: string
  /** Exact owner of the artifact. Never used as a literal path segment. */
  sessionId: string
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
  /** Internal/testing override; production remains capped at 50 MiB. */
  maxFileBytes?: number
  /**
   * When true, hint mentions KiloCode's Task tool (explore agent). Nexus has no Task tool by default.
   */
  suggestTaskTool?: boolean
}

export interface TruncateResult {
  content: string
  truncated: false
}

export interface TruncateResultTruncated {
  content: string
  truncated: true
  /** Whether the artifact contains all source bytes, a capped prefix, or could not be written. */
  persisted: "full" | "partial" | "none"
  /** Absolute filesystem path to the spilled `.out` file. */
  absolutePath?: string
  /** Opaque capability passed to ToolOutputRead; never interpreted as a path. */
  artifactId?: string
}

export type TruncateOutputResult = TruncateResult | TruncateResultTruncated

export interface ToolOutputMaintenanceResult {
  scannedSessionDirectories: number
  scannedArtifacts: number
  removedArtifacts: number
  truncated: boolean
  errors: string[]
}

export interface ToolOutputMaintenanceOptions {
  signal?: AbortSignal
  now?: number
  retentionMs?: number
  maxSessionDirectories?: number
  maxArtifactsPerSession?: number
  /** Session home override for isolated hosts/tests. */
  sessionHomeDir?: string
}

/**
 * Same decision tree as KiloCode `Truncate.output` (tool/truncation.ts).
 */
function buildTruncatedMessage(
  lines: string[],
  maxLines: number,
  maxBytes: number,
  direction: "head" | "tail",
  artifact: {
    absoluteFilePath?: string
    artifactId?: string
    persisted: "full" | "partial" | "none"
  },
  suggestTaskTool: boolean,
): string {
  const text = lines.join("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")

  const out: string[] = []
  let hitBytes = false
  let bytes = 0

  if (direction === "head") {
    for (let i = 0; i < lines.length && i < maxLines; i++) {
      const size = Buffer.byteLength(lines[i]!, "utf-8") + (i > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.push(lines[i]!)
      bytes += size
    }
  } else {
    for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      const size = Buffer.byteLength(lines[i]!, "utf-8") + (out.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      out.unshift(lines[i]!)
      bytes += size
    }
  }

  const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
  const unit = hitBytes ? "bytes" : "lines"
  const preview = out.join("\n")

  let hint: string
  if (artifact.persisted === "none" || !artifact.absoluteFilePath) {
    hint =
      "The tool output was truncated, and Nexus could not save the omitted content to disk."
  } else if (artifact.artifactId) {
    const saved =
      artifact.persisted === "full"
        ? `Full output saved as Nexus artifact: ${artifact.artifactId}`
        : `Partial output saved as Nexus artifact: ${artifact.artifactId} (artifact capped; the tail is not available)`
    hint = suggestTaskTool
      ? `The tool output was truncated. ${saved}\nUse ToolOutputRead with this artifact_id (and search or offset/limit), or delegate that bounded read to an explore agent.`
      : `The tool output was truncated. ${saved}\nUse ToolOutputRead with this artifact_id and a bounded search or offset/limit.`
  } else {
    hint =
      "The tool output was truncated, and Nexus could not create an artifact capability for the omitted content."
  }

  return direction === "head"
    ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
    : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`
}

export async function truncateOutput(
  text: string,
  options: TruncateOptions,
): Promise<TruncateOutputResult> {
  const maxLines = normalizePositiveLimit(options.maxLines, MAX_LINES)
  const maxBytes = normalizePositiveLimit(options.maxBytes, MAX_BYTES)
  const maxFileBytes = Math.min(
    MAX_FILE_BYTES,
    normalizePositiveLimit(options.maxFileBytes, MAX_FILE_BYTES),
  )
  const direction = options.direction ?? "head"
  const suggestTaskTool = options.suggestTaskTool ?? false

  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")

  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false }
  }

  const outDir = getToolOutputSessionDir(options.cwd, options.sessionId)
  try {
    await ensurePrivateOutputDirectory(outDir)
  } catch {
    const fallback = buildTruncatedMessage(
      lines,
      maxLines,
      maxBytes,
      direction,
      { persisted: "none" },
      suggestTaskTool,
    )
    return {
      content: fallback,
      truncated: true,
      persisted: "none",
    }
  }

  const artifactId = `artifact_${randomUUID()}`
  const filePath = path.join(outDir, `${artifactId}.out`)
  const source = Buffer.from(text, "utf8")
  const persisted = source.byteLength <= maxFileBytes ? "full" : "partial"
  try {
    const handle = await fs.promises.open(filePath, "wx", 0o600)
    try {
      if (persisted === "full") {
        await handle.writeFile(source)
      } else {
        await handle.writeFile(utf8SafeBufferPrefix(source, maxFileBytes))
        await handle.writeFile(
          Buffer.from(
            `\n\n[artifact capped at ${maxFileBytes} bytes; original output was ${source.byteLength} bytes]\n`,
            "utf8",
          ),
        )
      }
    } finally {
      await handle.close()
    }
    await fs.promises.chmod(filePath, 0o600)
  } catch {
    await fs.promises.unlink(filePath).catch(() => undefined)
    return {
      content: buildTruncatedMessage(
        lines,
        maxLines,
        maxBytes,
        direction,
        { persisted: "none" },
        suggestTaskTool,
      ),
      truncated: true,
      persisted: "none",
    }
  }

  const content = buildTruncatedMessage(
    lines,
    maxLines,
    maxBytes,
    direction,
    { absoluteFilePath: filePath, artifactId, persisted },
    suggestTaskTool,
  )

  return {
    content,
    truncated: true,
    persisted,
    absolutePath: filePath,
    artifactId,
  }
}

function utf8SafeBufferPrefix(
  source: Buffer,
  maxBytes: number,
): Buffer {
  if (source.byteLength <= maxBytes) return source
  let end = Math.max(0, Math.min(maxBytes, source.byteLength))
  while (
    end > 0 &&
    end < source.byteLength &&
    (source[end]! & 0xc0) === 0x80
  ) {
    end -= 1
  }
  return source.subarray(0, end)
}

function normalizePositiveLimit(
  value: number | undefined,
  fallback: number,
): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return fallback
  }
  return value
}

async function ensurePrivateOutputDirectory(dir: string): Promise<void> {
  const root = getToolOutputDir()
  const workspaceRoot = path.dirname(dir)
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
  await fs.promises.mkdir(workspaceRoot, { recursive: true, mode: 0o700 })
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })

  const [
    rootInfo,
    workspaceInfo,
    dirInfo,
    rootReal,
    workspaceReal,
    dirReal,
  ] = await Promise.all([
    fs.promises.lstat(root),
    fs.promises.lstat(workspaceRoot),
    fs.promises.lstat(dir),
    fs.promises.realpath(root),
    fs.promises.realpath(workspaceRoot),
    fs.promises.realpath(dir),
  ])
  if (
    rootInfo.isSymbolicLink() ||
    workspaceInfo.isSymbolicLink() ||
    dirInfo.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    !workspaceInfo.isDirectory() ||
    !dirInfo.isDirectory()
  ) {
    throw new Error("Tool output storage must use real directories")
  }
  const relativeWorkspace = path.relative(rootReal, workspaceReal)
  if (
    !relativeWorkspace ||
    relativeWorkspace === ".." ||
    relativeWorkspace.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeWorkspace)
  ) {
    throw new Error("Tool output workspace directory escaped its storage root")
  }
  const relativeDir = path.relative(rootReal, dirReal)
  if (
    !relativeDir ||
    relativeDir === ".." ||
    relativeDir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDir)
  ) {
    throw new Error("Tool output session directory escaped its storage root")
  }
  await Promise.all([
    fs.promises.chmod(root, 0o700),
    fs.promises.chmod(workspaceRoot, 0o700),
    fs.promises.chmod(dir, 0o700),
  ])
}

/**
 * Bounded workspace maintenance for artifacts whose sessions are no longer
 * active. It never recurses, never follows symlinks, and only removes Nexus'
 * exact opaque artifact filename shape.
 */
export async function cleanupExpiredToolOutputArtifacts(
  cwd: string,
  options: ToolOutputMaintenanceOptions = {},
): Promise<ToolOutputMaintenanceResult> {
  const result: ToolOutputMaintenanceResult = {
    scannedSessionDirectories: 0,
    scannedArtifacts: 0,
    removedArtifacts: 0,
    truncated: false,
    errors: [],
  }
  const workspaceDir = getToolOutputWorkspaceDir(cwd)
  const maxSessionDirectories = normalizePositiveLimit(
    options.maxSessionDirectories,
    MAX_MAINTENANCE_SESSION_DIRECTORIES,
  )
  const maxArtifactsPerSession = normalizePositiveLimit(
    options.maxArtifactsPerSession,
    MAX_MAINTENANCE_ARTIFACTS_PER_SESSION,
  )
  const retentionMs = normalizePositiveLimit(
    options.retentionMs,
    RETENTION_MS,
  )
  const cutoff = (options.now ?? Date.now()) - retentionMs
  const persistedProtection =
    await collectPersistedToolOutputProtection(
      cwd,
      options.sessionHomeDir,
    )
  if (persistedProtection.protectAll) {
    result.truncated = true
    result.errors.push(
      "Tool-output retention skipped deletion because persisted session references could not be scanned completely.",
    )
  }
  const protectedArtifacts = new Set(
    listToolSpillsForWorkspace(cwd).map((entry) =>
      path.resolve(entry.absolutePath),
    ),
  )
  for (const candidate of persistedProtection.artifactPaths) {
    protectedArtifacts.add(path.resolve(candidate))
  }

  const workspaceInfo = await fs.promises.lstat(workspaceDir).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        result.errors.push(formatMaintenanceError(workspaceDir, error))
      }
      return undefined
    },
  )
  if (!workspaceInfo) return result
  if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) {
    result.errors.push(
      `Skipped unsafe tool-output workspace directory: ${workspaceDir}`,
    )
    return result
  }

  let workspaceHandle: fs.Dir
  try {
    workspaceHandle = await fs.promises.opendir(workspaceDir)
  } catch (error) {
    result.errors.push(formatMaintenanceError(workspaceDir, error))
    return result
  }

  try {
    for await (const entry of workspaceHandle) {
      throwIfMaintenanceAborted(options.signal)
      if (
        !entry.isDirectory() ||
        !TOOL_OUTPUT_SESSION_DIRECTORY_PATTERN.test(entry.name)
      ) {
        continue
      }
      if (result.scannedSessionDirectories >= maxSessionDirectories) {
        result.truncated = true
        break
      }
      result.scannedSessionDirectories += 1
      await cleanupExpiredArtifactsInSessionDirectory({
        workspaceDir,
        sessionDirectoryName: entry.name,
        cutoff,
        maxArtifacts: maxArtifactsPerSession,
        protectedArtifacts,
        protectedSessionDirectories:
          persistedProtection.sessionDirectories,
        protectAll: persistedProtection.protectAll,
        signal: options.signal,
        result,
      })
    }
  } catch (error) {
    if (options.signal?.aborted) throw error
    result.errors.push(formatMaintenanceError(workspaceDir, error))
  } finally {
    await workspaceHandle.close().catch(() => undefined)
  }

  return result
}

async function cleanupExpiredArtifactsInSessionDirectory(input: {
  workspaceDir: string
  sessionDirectoryName: string
  cutoff: number
  maxArtifacts: number
  protectedArtifacts: ReadonlySet<string>
  protectedSessionDirectories: ReadonlySet<string>
  protectAll: boolean
  signal?: AbortSignal
  result: ToolOutputMaintenanceResult
}): Promise<void> {
  const sessionDir = path.join(
    input.workspaceDir,
    input.sessionDirectoryName,
  )
  if (
    input.protectAll ||
    input.protectedSessionDirectories.has(path.resolve(sessionDir))
  ) {
    return
  }
  const info = await fs.promises.lstat(sessionDir).catch((error) => {
    input.result.errors.push(formatMaintenanceError(sessionDir, error))
    return undefined
  })
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return

  let handle: fs.Dir
  try {
    handle = await fs.promises.opendir(sessionDir)
  } catch (error) {
    input.result.errors.push(formatMaintenanceError(sessionDir, error))
    return
  }

  let scannedInSession = 0
  try {
    for await (const entry of handle) {
      throwIfMaintenanceAborted(input.signal)
      if (
        !entry.isFile() ||
        !TOOL_OUTPUT_ARTIFACT_FILE_PATTERN.test(entry.name)
      ) {
        continue
      }
      if (scannedInSession >= input.maxArtifacts) {
        input.result.truncated = true
        break
      }
      scannedInSession += 1
      input.result.scannedArtifacts += 1

      const candidate = path.join(sessionDir, entry.name)
      if (input.protectedArtifacts.has(path.resolve(candidate))) continue
      const candidateInfo = await fs.promises.lstat(candidate).catch((error) => {
        input.result.errors.push(formatMaintenanceError(candidate, error))
        return undefined
      })
      if (
        !candidateInfo ||
        candidateInfo.isSymbolicLink() ||
        !candidateInfo.isFile() ||
        candidateInfo.mtimeMs >= input.cutoff
      ) {
        continue
      }
      try {
        await fs.promises.unlink(candidate)
        input.result.removedArtifacts += 1
      } catch (error) {
        input.result.errors.push(formatMaintenanceError(candidate, error))
      }
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function throwIfMaintenanceAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Tool-output maintenance was aborted.")
}

function formatMaintenanceError(target: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${target}: ${message}`
}
