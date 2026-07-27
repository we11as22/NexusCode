import { constants as fsConstants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"

import { getNexusDataDir } from "../data-dir.js"
import { atomicWriteJson, withFileLock } from "../storage/durable-fs.js"
import type { PluginManifestRecord } from "../types.js"

const STORE_VERSION = 1
const FINGERPRINT_VERSION = "nexus-plugin-tree-v1"
const MAX_TRUST_STORE_BYTES = 4 * 1024 * 1024

const pluginTrustGrantSchema = z.object({
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  pluginName: z.string().min(1),
  declaredRootPath: z.string().min(1),
  declaredSourcePath: z.string().min(1),
  canonicalRootPath: z.string().min(1),
  canonicalSourcePath: z.string().min(1),
  rootDevice: z.string().regex(/^\d+$/),
  rootInode: z.string().regex(/^\d+$/),
  sourceDevice: z.string().regex(/^\d+$/),
  sourceInode: z.string().regex(/^\d+$/),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  grantedAt: z.number().int().nonnegative(),
}).strict()

const pluginTrustStoreSchema = z.object({
  version: z.literal(STORE_VERSION),
  grants: z.array(pluginTrustGrantSchema),
}).strict()

export type PluginTrustGrant = z.infer<typeof pluginTrustGrantSchema>

type PluginTrustStoreData = z.infer<typeof pluginTrustStoreSchema>

export interface PluginFingerprintLimits {
  maxEntries: number
  maxFileBytes: number
  maxTotalBytes: number
  maxDepth: number
  maxRelativePathBytes: number
}

export interface PluginTrustStoreOptions {
  storePath?: string
  limits?: Partial<PluginFingerprintLimits>
  now?: () => number
}

export type PluginTrustReason =
  | "trusted"
  | "not-granted"
  | "content-changed"
  | "identity-changed"
  | "unsafe-plugin"
  | "store-corrupt"
  | "store-unavailable"

export interface PluginTrustEvaluation {
  trusted: boolean
  reason: PluginTrustReason
  fingerprint?: string
  grantId?: string
  revoked?: boolean
  message?: string
}

interface PluginSnapshot {
  declaredRootPath: string
  declaredSourcePath: string
  canonicalRootPath: string
  canonicalSourcePath: string
  rootDevice: string
  rootInode: string
  sourceDevice: string
  sourceInode: string
  fingerprint: string
}

export const DEFAULT_PLUGIN_FINGERPRINT_LIMITS: Readonly<PluginFingerprintLimits> = {
  maxEntries: 10_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  maxRelativePathBytes: 4_096,
}

export class PluginTrustStoreCorruptionError extends Error {
  constructor(
    readonly storePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Plugin trust store is corrupt: ${storePath}: ${message}`, options)
    this.name = "PluginTrustStoreCorruptionError"
  }
}

export class UnsafePluginContentError extends Error {
  constructor(
    readonly pluginPath: string,
    message: string,
  ) {
    super(`Unsafe plugin content at ${pluginPath}: ${message}`)
    this.name = "UnsafePluginContentError"
  }
}

function emptyStore(): PluginTrustStoreData {
  return { version: STORE_VERSION, grants: [] }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function resolvedLimits(
  options: PluginTrustStoreOptions,
): PluginFingerprintLimits {
  const limits = {
    ...DEFAULT_PLUGIN_FINGERPRINT_LIMITS,
    ...options.limits,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Plugin fingerprint limit ${name} must be a positive safe integer`)
    }
  }
  return limits
}

export function getPluginTrustStorePath(
  options: Pick<PluginTrustStoreOptions, "storePath"> = {},
): string {
  return path.resolve(
    options.storePath ??
    path.join(getNexusDataDir(), "authority", "plugin-trust-v1.json"),
  )
}

async function ensurePrivateStoreDirectory(storePath: string): Promise<void> {
  const directory = path.dirname(storePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryStats = await lstat(directory)
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new PluginTrustStoreCorruptionError(
      storePath,
      "authority-store parent must be a real directory",
    )
  }
  await chmod(directory, 0o700)
}

function ensureOwnedByCurrentUser(
  storePath: string,
  stats: Awaited<ReturnType<typeof lstat>>,
): void {
  const getuid = process.getuid
  if (typeof getuid === "function" && stats.uid !== getuid()) {
    throw new PluginTrustStoreCorruptionError(
      storePath,
      `authority-store file is owned by uid ${stats.uid}, expected ${getuid()}`,
    )
  }
}

async function readStoreStrict(storePath: string): Promise<PluginTrustStoreData> {
  await ensurePrivateStoreDirectory(storePath)
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(storePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore()
    throw error
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new PluginTrustStoreCorruptionError(
      storePath,
      "authority-store path must be a regular, non-symlink file",
    )
  }
  ensureOwnedByCurrentUser(storePath, before)
  if (before.size > MAX_TRUST_STORE_BYTES) {
    throw new PluginTrustStoreCorruptionError(
      storePath,
      `authority-store file exceeds ${MAX_TRUST_STORE_BYTES} bytes`,
    )
  }
  await chmod(storePath, 0o600)

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(storePath, fsConstants.O_RDONLY | noFollow)
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new PluginTrustStoreCorruptionError(
        storePath,
        "authority-store identity changed while it was being opened",
      )
    }
    const raw = await handle.readFile("utf8")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new PluginTrustStoreCorruptionError(
        storePath,
        error instanceof Error ? error.message : String(error),
        { cause: error },
      )
    }
    const validated = pluginTrustStoreSchema.safeParse(parsed)
    if (!validated.success) {
      throw new PluginTrustStoreCorruptionError(
        storePath,
        validated.error.issues
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; "),
      )
    }
    const identities = new Set<string>()
    for (const grant of validated.data.grants) {
      const identity = `${grant.declaredRootPath}\0${grant.declaredSourcePath}`
      if (identities.has(identity)) {
        throw new PluginTrustStoreCorruptionError(
          storePath,
          `duplicate authority grant for ${grant.declaredSourcePath}`,
        )
      }
      identities.add(identity)
    }
    return validated.data
  } catch (error) {
    if (
      error instanceof PluginTrustStoreCorruptionError ||
      (error as NodeJS.ErrnoException).code === "ELOOP"
    ) {
      if (error instanceof PluginTrustStoreCorruptionError) throw error
      throw new PluginTrustStoreCorruptionError(
        storePath,
        "authority-store path is a symlink",
        { cause: error },
      )
    }
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeStore(
  storePath: string,
  store: PluginTrustStoreData,
): Promise<void> {
  const validated = pluginTrustStoreSchema.parse(store)
  await ensurePrivateStoreDirectory(storePath)
  await atomicWriteJson(storePath, validated, { mode: 0o600 })
  await chmod(storePath, 0o600)
}

function declaredIdentity(plugin: PluginManifestRecord): {
  declaredRootPath: string
  declaredSourcePath: string
} {
  return {
    declaredRootPath: path.resolve(plugin.rootDir),
    declaredSourcePath: path.resolve(plugin.sourcePath),
  }
}

function matchesDeclaredIdentity(
  grant: PluginTrustGrant,
  plugin: PluginManifestRecord,
): boolean {
  const identity = declaredIdentity(plugin)
  return (
    grant.declaredRootPath === identity.declaredRootPath &&
    grant.declaredSourcePath === identity.declaredSourcePath
  )
}

function grantId(snapshot: PluginSnapshot): string {
  return `sha256:${createHash("sha256")
    .update("nexus-plugin-grant-v1\0")
    .update(snapshot.declaredRootPath)
    .update("\0")
    .update(snapshot.declaredSourcePath)
    .update("\0")
    .update(snapshot.canonicalRootPath)
    .update("\0")
    .update(snapshot.canonicalSourcePath)
    .digest("hex")}`
}

function updateTreeHash(
  hash: ReturnType<typeof createHash>,
  kind: "directory" | "file",
  relativePath: string,
  mode: number,
  size = 0,
): void {
  const encodedPath = Buffer.from(relativePath, "utf8")
  const metadata = Buffer.allocUnsafe(4 + encodedPath.length + 4 + 8)
  metadata.writeUInt32BE(encodedPath.length, 0)
  encodedPath.copy(metadata, 4)
  metadata.writeUInt32BE(mode & 0o777, 4 + encodedPath.length)
  metadata.writeBigUInt64BE(BigInt(size), 8 + encodedPath.length)
  hash.update(kind)
  hash.update(metadata)
}

async function snapshotPlugin(
  plugin: PluginManifestRecord,
  options: PluginTrustStoreOptions,
): Promise<PluginSnapshot> {
  const limits = resolvedLimits(options)
  const declared = declaredIdentity(plugin)
  const declaredRootStats = await lstat(declared.declaredRootPath).catch((error) => {
    throw new UnsafePluginContentError(
      declared.declaredRootPath,
      error instanceof Error ? error.message : String(error),
    )
  })
  if (declaredRootStats.isSymbolicLink() || !declaredRootStats.isDirectory()) {
    throw new UnsafePluginContentError(
      declared.declaredRootPath,
      "plugin root must be a real directory",
    )
  }
  const declaredSourceStats = await lstat(declared.declaredSourcePath).catch((error) => {
    throw new UnsafePluginContentError(
      declared.declaredSourcePath,
      error instanceof Error ? error.message : String(error),
    )
  })
  if (declaredSourceStats.isSymbolicLink() || !declaredSourceStats.isFile()) {
    throw new UnsafePluginContentError(
      declared.declaredSourcePath,
      "plugin manifest must be a regular, non-symlink file",
    )
  }

  const canonicalRootPath = await realpath(declared.declaredRootPath)
  const canonicalSourcePath = await realpath(declared.declaredSourcePath)
  if (!isPathInside(canonicalRootPath, canonicalSourcePath)) {
    throw new UnsafePluginContentError(
      declared.declaredSourcePath,
      "plugin manifest escapes the canonical plugin root",
    )
  }
  const [rootStats, sourceStats] = await Promise.all([
    lstat(canonicalRootPath, { bigint: true }),
    lstat(canonicalSourcePath, { bigint: true }),
  ])
  if (!rootStats.isDirectory() || !sourceStats.isFile()) {
    throw new UnsafePluginContentError(
      declared.declaredRootPath,
      "plugin root or manifest changed identity during validation",
    )
  }

  const hash = createHash("sha256")
  hash.update(FINGERPRINT_VERSION)
  let entries = 0
  let totalBytes = 0
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0

  const walk = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) {
      throw new UnsafePluginContentError(
        directory,
        `plugin tree exceeds maximum depth ${limits.maxDepth}`,
      )
    }
    const directoryBefore = await lstat(directory)
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      throw new UnsafePluginContentError(directory, "directory changed into an unsafe filesystem entry")
    }
    const canonicalDirectory = await realpath(directory)
    if (!isPathInside(canonicalRootPath, canonicalDirectory)) {
      throw new UnsafePluginContentError(directory, "directory escapes the canonical plugin root")
    }
    const children = await readdir(directory)
    children.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    for (const name of children) {
      entries += 1
      if (entries > limits.maxEntries) {
        throw new UnsafePluginContentError(
          directory,
          `plugin tree exceeds ${limits.maxEntries} entries`,
        )
      }
      const absolute = path.join(directory, name)
      const relative = relativeDirectory
        ? path.posix.join(relativeDirectory, name)
        : name
      if (Buffer.byteLength(relative, "utf8") > limits.maxRelativePathBytes) {
        throw new UnsafePluginContentError(
          absolute,
          `relative path exceeds ${limits.maxRelativePathBytes} bytes`,
        )
      }
      const before = await lstat(absolute)
      if (before.isSymbolicLink()) {
        throw new UnsafePluginContentError(absolute, "symbolic links are not trusted plugin content")
      }
      if (before.isDirectory()) {
        updateTreeHash(hash, "directory", relative, before.mode)
        await walk(absolute, relative, depth + 1)
        continue
      }
      if (!before.isFile()) {
        throw new UnsafePluginContentError(
          absolute,
          "special filesystem entries are not trusted plugin content",
        )
      }
      if (before.size > limits.maxFileBytes) {
        throw new UnsafePluginContentError(
          absolute,
          `file exceeds ${limits.maxFileBytes} bytes`,
        )
      }
      totalBytes += before.size
      if (totalBytes > limits.maxTotalBytes) {
        throw new UnsafePluginContentError(
          absolute,
          `plugin tree exceeds ${limits.maxTotalBytes} bytes`,
        )
      }
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(absolute, fsConstants.O_RDONLY | noFollow)
        const opened = await handle.stat()
        if (
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size
        ) {
          throw new UnsafePluginContentError(
            absolute,
            "file identity changed while it was being opened",
          )
        }
        const content = await handle.readFile()
        updateTreeHash(hash, "file", relative, opened.mode, content.byteLength)
        hash.update(content)
        const after = await handle.stat()
        if (
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs
        ) {
          throw new UnsafePluginContentError(
            absolute,
            "file changed while its fingerprint was being computed",
          )
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
          throw new UnsafePluginContentError(
            absolute,
            "file became a symbolic link while it was being opened",
          )
        }
        throw error
      } finally {
        await handle?.close().catch(() => undefined)
      }
    }
    const directoryAfter = await lstat(directory)
    if (
      !directoryAfter.isDirectory() ||
      directoryAfter.dev !== directoryBefore.dev ||
      directoryAfter.ino !== directoryBefore.ino ||
      directoryAfter.mtimeMs !== directoryBefore.mtimeMs ||
      directoryAfter.ctimeMs !== directoryBefore.ctimeMs
    ) {
      throw new UnsafePluginContentError(
        directory,
        "directory changed while its fingerprint was being computed",
      )
    }
  }

  await walk(canonicalRootPath, "", 0)
  return {
    ...declared,
    canonicalRootPath,
    canonicalSourcePath,
    rootDevice: rootStats.dev.toString(),
    rootInode: rootStats.ino.toString(),
    sourceDevice: sourceStats.dev.toString(),
    sourceInode: sourceStats.ino.toString(),
    fingerprint: `sha256:${hash.digest("hex")}`,
  }
}

function sameFilesystemIdentity(
  grant: PluginTrustGrant,
  snapshot: PluginSnapshot,
): boolean {
  return (
    grant.canonicalRootPath === snapshot.canonicalRootPath &&
    grant.canonicalSourcePath === snapshot.canonicalSourcePath &&
    grant.rootDevice === snapshot.rootDevice &&
    grant.rootInode === snapshot.rootInode &&
    grant.sourceDevice === snapshot.sourceDevice &&
    grant.sourceInode === snapshot.sourceInode
  )
}

async function revokeMatchingGrantLocked(
  storePath: string,
  store: PluginTrustStoreData,
  plugin: PluginManifestRecord,
): Promise<boolean> {
  const next = store.grants.filter((grant) => !matchesDeclaredIdentity(grant, plugin))
  if (next.length === store.grants.length) return false
  await writeStore(storePath, { ...store, grants: next })
  return true
}

export async function grantPluginTrust(
  plugin: PluginManifestRecord,
  options: PluginTrustStoreOptions = {},
): Promise<PluginTrustGrant> {
  const storePath = getPluginTrustStorePath(options)
  return withFileLock(storePath, async () => {
    const store = await readStoreStrict(storePath)
    const snapshot = await snapshotPlugin(plugin, options)
    const grant: PluginTrustGrant = {
      id: grantId(snapshot),
      pluginName: plugin.name,
      ...snapshot,
      grantedAt: (options.now ?? Date.now)(),
    }
    const next = store.grants.filter((item) => !matchesDeclaredIdentity(item, plugin))
    next.push(grant)
    next.sort((left, right) => left.id.localeCompare(right.id))
    await writeStore(storePath, { ...store, grants: next })
    return grant
  })
}

export async function revokePluginTrust(
  plugin: PluginManifestRecord,
  options: PluginTrustStoreOptions = {},
): Promise<boolean> {
  const storePath = getPluginTrustStorePath(options)
  return withFileLock(storePath, async () => {
    const store = await readStoreStrict(storePath)
    return revokeMatchingGrantLocked(storePath, store, plugin)
  })
}

export async function listPluginTrustGrants(
  options: PluginTrustStoreOptions = {},
): Promise<PluginTrustGrant[]> {
  const storePath = getPluginTrustStorePath(options)
  return withFileLock(storePath, async () => {
    const store = await readStoreStrict(storePath)
    return store.grants.map((grant) => ({ ...grant }))
  })
}

export async function evaluatePluginTrust(
  plugin: PluginManifestRecord,
  options: PluginTrustStoreOptions = {},
): Promise<PluginTrustEvaluation> {
  const storePath = getPluginTrustStorePath(options)
  try {
    return await withFileLock(storePath, async () => {
      const store = await readStoreStrict(storePath)
      const grant = store.grants.find((item) => matchesDeclaredIdentity(item, plugin))
      if (!grant) return { trusted: false, reason: "not-granted" }
      if (grant.pluginName !== plugin.name) {
        const revoked = await revokeMatchingGrantLocked(storePath, store, plugin)
        return {
          trusted: false,
          reason: "identity-changed",
          grantId: grant.id,
          revoked,
          message:
            `plugin manifest name changed from ${grant.pluginName} to ${plugin.name}`,
        }
      }

      let snapshot: PluginSnapshot
      try {
        snapshot = await snapshotPlugin(plugin, options)
      } catch (error) {
        const revoked = await revokeMatchingGrantLocked(storePath, store, plugin)
        return {
          trusted: false,
          reason: "unsafe-plugin",
          revoked,
          grantId: grant.id,
          message: error instanceof Error ? error.message : String(error),
        }
      }
      if (!sameFilesystemIdentity(grant, snapshot)) {
        const revoked = await revokeMatchingGrantLocked(storePath, store, plugin)
        return {
          trusted: false,
          reason: "identity-changed",
          fingerprint: snapshot.fingerprint,
          grantId: grant.id,
          revoked,
        }
      }
      if (grant.fingerprint !== snapshot.fingerprint) {
        const revoked = await revokeMatchingGrantLocked(storePath, store, plugin)
        return {
          trusted: false,
          reason: "content-changed",
          fingerprint: snapshot.fingerprint,
          grantId: grant.id,
          revoked,
        }
      }
      return {
        trusted: true,
        reason: "trusted",
        fingerprint: snapshot.fingerprint,
        grantId: grant.id,
      }
    })
  } catch (error) {
    if (error instanceof PluginTrustStoreCorruptionError) {
      return {
        trusted: false,
        reason: "store-corrupt",
        message: error.message,
      }
    }
    return {
      trusted: false,
      reason: "store-unavailable",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
