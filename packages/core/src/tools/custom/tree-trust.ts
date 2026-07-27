import { constants as fsConstants, type Stats } from "node:fs"
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

import { getNexusDataDir } from "../../data-dir.js"
import { atomicWriteJson, withFileLock } from "../../storage/durable-fs.js"

const STORE_VERSION = 1
const MAX_STORE_BYTES = 2 * 1024 * 1024
const CUSTOM_TREE_FINGERPRINT_VERSION = "nexus-custom-tool-tree-v1"

const trustGrantSchema = z.object({
  id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  declaredPath: z.string().min(1),
  canonicalPath: z.string().min(1),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
  kind: z.enum(["directory", "file"]),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  grantedAt: z.number().int().nonnegative(),
}).strict()

const trustStoreSchema = z.object({
  version: z.literal(STORE_VERSION),
  grants: z.array(trustGrantSchema).max(512),
}).strict()

export interface ExecutableTreeLimits {
  maxEntries: number
  maxFileBytes: number
  maxTotalBytes: number
  maxDepth: number
  maxRelativePathBytes: number
}

export const DEFAULT_EXECUTABLE_TREE_LIMITS: Readonly<ExecutableTreeLimits> = {
  maxEntries: 4_096,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxDepth: 32,
  maxRelativePathBytes: 4_096,
}

export interface ExecutableTreeSnapshot {
  declaredPath: string
  canonicalPath: string
  device: string
  inode: string
  kind: "directory" | "file"
  fingerprint: string
  entries: number
  totalBytes: number
}

export interface StagedExecutableTree extends ExecutableTreeSnapshot {
  /** Exact copied bytes that may be passed to a compiler or isolated runtime. */
  stagedPath: string
  stagingRoot: string
}

export type CustomToolTrustGrant = z.infer<typeof trustGrantSchema>

export type CustomToolTrustReason =
  | "trusted"
  | "not-granted"
  | "content-changed"
  | "identity-changed"
  | "unsafe-source"
  | "store-unavailable"

export interface CustomToolTrustEvaluation {
  trusted: boolean
  reason: CustomToolTrustReason
  fingerprint?: string
  grantId?: string
  message?: string
  snapshot?: ExecutableTreeSnapshot
}

export interface CustomToolTrustStoreOptions {
  storePath?: string
  limits?: Partial<ExecutableTreeLimits>
  now?: () => number
}

interface SnapshotOptions {
  limits?: Partial<ExecutableTreeLimits>
  /**
   * Kept internal to the executable-content boundary. Plugin tools use the
   * plugin tree version so their staged bytes can be compared to PluginTrust.
   */
  fingerprintVersion?: string
  stagingRoot?: string
}

export class UnsafeCustomToolSourceError extends Error {
  constructor(
    readonly sourcePath: string,
    message: string,
  ) {
    super(`Unsafe custom tool source at ${sourcePath}: ${message}`)
    this.name = "UnsafeCustomToolSourceError"
  }
}

export class CustomToolTrustStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CustomToolTrustStoreError"
  }
}

function resolvedLimits(
  partial: Partial<ExecutableTreeLimits> = {},
): ExecutableTreeLimits {
  const limits = { ...DEFAULT_EXECUTABLE_TREE_LIMITS, ...partial }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(
        `Executable tree limit ${name} must be a positive safe integer`,
      )
    }
  }
  return limits
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
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

async function writeStagedFile(
  destination: string,
  content: Buffer,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const handle = await open(
    destination,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL,
    0o600,
  )
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function snapshotExecutableTree(
  sourcePath: string,
  options: SnapshotOptions = {},
): Promise<ExecutableTreeSnapshot | StagedExecutableTree> {
  const limits = resolvedLimits(options.limits)
  const declaredPath = path.resolve(sourcePath)
  const declaredStats = await lstat(declaredPath).catch((error) => {
    throw new UnsafeCustomToolSourceError(
      declaredPath,
      error instanceof Error ? error.message : String(error),
    )
  })
  if (
    declaredStats.isSymbolicLink() ||
    (!declaredStats.isDirectory() && !declaredStats.isFile())
  ) {
    throw new UnsafeCustomToolSourceError(
      declaredPath,
      "source must be a regular non-symlink file or directory",
    )
  }

  const canonicalPath = await realpath(declaredPath)
  const rootStats = await lstat(canonicalPath, { bigint: true })
  const kind = rootStats.isDirectory()
    ? "directory"
    : rootStats.isFile()
      ? "file"
      : undefined
  if (!kind) {
    throw new UnsafeCustomToolSourceError(
      declaredPath,
      "source identity changed during validation",
    )
  }

  const stagingRoot = options.stagingRoot
    ? path.resolve(options.stagingRoot)
    : undefined
  if (
    stagingRoot &&
    (isPathInside(canonicalPath, stagingRoot) ||
      isPathInside(stagingRoot, canonicalPath))
  ) {
    throw new UnsafeCustomToolSourceError(
      declaredPath,
      "staging directory must not overlap the executable source",
    )
  }
  if (stagingRoot) await mkdir(stagingRoot, { recursive: true, mode: 0o700 })

  const hash = createHash("sha256")
  hash.update(
    options.fingerprintVersion ?? CUSTOM_TREE_FINGERPRINT_VERSION,
  )
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0
  let entries = 0
  let totalBytes = 0

  const readFile = async (
    absolute: string,
    relative: string,
    before: Stats,
  ): Promise<void> => {
    if (before.size > limits.maxFileBytes) {
      throw new UnsafeCustomToolSourceError(
        absolute,
        `file exceeds ${limits.maxFileBytes} bytes`,
      )
    }
    totalBytes += before.size
    if (totalBytes > limits.maxTotalBytes) {
      throw new UnsafeCustomToolSourceError(
        absolute,
        `source tree exceeds ${limits.maxTotalBytes} bytes`,
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
        throw new UnsafeCustomToolSourceError(
          absolute,
          "file identity changed while it was being opened",
        )
      }
      const content = await handle.readFile()
      updateTreeHash(hash, "file", relative, opened.mode, content.byteLength)
      hash.update(content)
      if (stagingRoot) {
        const destination = path.join(stagingRoot, relative)
        if (!isPathInside(stagingRoot, destination)) {
          throw new UnsafeCustomToolSourceError(
            absolute,
            "relative path escaped the staging directory",
          )
        }
        await writeStagedFile(destination, content)
      }
      const after = await handle.stat()
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      ) {
        throw new UnsafeCustomToolSourceError(
          absolute,
          "file changed while its fingerprint was being computed",
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new UnsafeCustomToolSourceError(
          absolute,
          "file became a symbolic link while it was being opened",
        )
      }
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  const walk = async (
    directory: string,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> => {
    if (depth > limits.maxDepth) {
      throw new UnsafeCustomToolSourceError(
        directory,
        `source tree exceeds maximum depth ${limits.maxDepth}`,
      )
    }
    const directoryBefore = await lstat(directory)
    if (
      directoryBefore.isSymbolicLink() ||
      !directoryBefore.isDirectory()
    ) {
      throw new UnsafeCustomToolSourceError(
        directory,
        "directory changed into an unsafe filesystem entry",
      )
    }
    const canonicalDirectory = await realpath(directory)
    if (!isPathInside(canonicalPath, canonicalDirectory)) {
      throw new UnsafeCustomToolSourceError(
        directory,
        "directory escapes the canonical source root",
      )
    }
    const children = await readdir(directory)
    children.sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right))
    )
    for (const name of children) {
      entries += 1
      if (entries > limits.maxEntries) {
        throw new UnsafeCustomToolSourceError(
          directory,
          `source tree exceeds ${limits.maxEntries} entries`,
        )
      }
      const absolute = path.join(directory, name)
      const relative = relativeDirectory
        ? path.posix.join(relativeDirectory, name)
        : name
      if (Buffer.byteLength(relative, "utf8") > limits.maxRelativePathBytes) {
        throw new UnsafeCustomToolSourceError(
          absolute,
          `relative path exceeds ${limits.maxRelativePathBytes} bytes`,
        )
      }
      const before = await lstat(absolute)
      if (before.isSymbolicLink()) {
        throw new UnsafeCustomToolSourceError(
          absolute,
          "symbolic links are not executable source content",
        )
      }
      if (before.isDirectory()) {
        updateTreeHash(hash, "directory", relative, before.mode)
        if (stagingRoot) {
          await mkdir(path.join(stagingRoot, relative), {
            recursive: false,
            mode: 0o700,
          })
        }
        await walk(absolute, relative, depth + 1)
        continue
      }
      if (!before.isFile()) {
        throw new UnsafeCustomToolSourceError(
          absolute,
          "special filesystem entries are not executable source content",
        )
      }
      await readFile(absolute, relative, before)
    }
    const directoryAfter = await lstat(directory)
    if (
      !directoryAfter.isDirectory() ||
      directoryAfter.dev !== directoryBefore.dev ||
      directoryAfter.ino !== directoryBefore.ino ||
      directoryAfter.mtimeMs !== directoryBefore.mtimeMs ||
      directoryAfter.ctimeMs !== directoryBefore.ctimeMs
    ) {
      throw new UnsafeCustomToolSourceError(
        directory,
        "directory changed while its fingerprint was being computed",
      )
    }
  }

  let stagedPath: string | undefined
  if (kind === "directory") {
    await walk(canonicalPath, "", 0)
    stagedPath = stagingRoot
  } else {
    entries = 1
    const relative = path.basename(canonicalPath)
    const before = await lstat(canonicalPath)
    await readFile(canonicalPath, relative, before)
    stagedPath = stagingRoot ? path.join(stagingRoot, relative) : undefined
  }

  const snapshot: ExecutableTreeSnapshot = {
    declaredPath,
    canonicalPath,
    device: rootStats.dev.toString(),
    inode: rootStats.ino.toString(),
    kind,
    fingerprint: `sha256:${hash.digest("hex")}`,
    entries,
    totalBytes,
  }
  return stagingRoot && stagedPath
    ? { ...snapshot, stagedPath, stagingRoot }
    : snapshot
}

export async function fingerprintExecutableTree(
  sourcePath: string,
  options: Omit<SnapshotOptions, "stagingRoot"> = {},
): Promise<ExecutableTreeSnapshot> {
  return snapshotExecutableTree(sourcePath, options) as Promise<ExecutableTreeSnapshot>
}

export async function stageExecutableTree(
  sourcePath: string,
  stagingRoot: string,
  options: Omit<SnapshotOptions, "stagingRoot"> = {},
): Promise<StagedExecutableTree> {
  return snapshotExecutableTree(sourcePath, {
    ...options,
    stagingRoot,
  }) as Promise<StagedExecutableTree>
}

function emptyStore(): z.infer<typeof trustStoreSchema> {
  return { version: STORE_VERSION, grants: [] }
}

async function prepareStoreDirectory(storePath: string): Promise<void> {
  const directory = path.dirname(storePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stats = await lstat(directory)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new CustomToolTrustStoreError(
      "Custom tool authority-store parent must be a real directory",
    )
  }
  await chmod(directory, 0o700)
}

async function readStore(
  storePath: string,
): Promise<z.infer<typeof trustStoreSchema>> {
  await prepareStoreDirectory(storePath)
  const before = await lstat(storePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
  if (!before) return emptyStore()
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new CustomToolTrustStoreError(
      "Custom tool authority-store must be a regular non-symlink file",
    )
  }
  if (before.size > MAX_STORE_BYTES) {
    throw new CustomToolTrustStoreError(
      `Custom tool authority-store exceeds ${MAX_STORE_BYTES} bytes`,
    )
  }
  const getuid = process.getuid
  if (typeof getuid === "function" && before.uid !== getuid()) {
    throw new CustomToolTrustStoreError(
      `Custom tool authority-store is owned by uid ${before.uid}, expected ${getuid()}`,
    )
  }
  await chmod(storePath, 0o600)
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0
  const handle = await open(storePath, fsConstants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new CustomToolTrustStoreError(
        "Custom tool authority-store identity changed while opening",
      )
    }
    const raw = await handle.readFile("utf8")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new CustomToolTrustStoreError(
        "Custom tool authority-store contains invalid JSON",
        { cause: error },
      )
    }
    const result = trustStoreSchema.safeParse(parsed)
    if (!result.success) {
      throw new CustomToolTrustStoreError(
        `Custom tool authority-store is invalid: ${result.error.message}`,
      )
    }
    const identities = new Set<string>()
    for (const grant of result.data.grants) {
      if (identities.has(grant.declaredPath)) {
        throw new CustomToolTrustStoreError(
          `Custom tool authority-store contains a duplicate grant for ${grant.declaredPath}`,
        )
      }
      identities.add(grant.declaredPath)
    }
    return result.data
  } finally {
    await handle.close()
  }
}

async function writeStore(
  storePath: string,
  store: z.infer<typeof trustStoreSchema>,
): Promise<void> {
  const validated = trustStoreSchema.parse(store)
  await prepareStoreDirectory(storePath)
  await atomicWriteJson(storePath, validated, { mode: 0o600 })
  await chmod(storePath, 0o600)
}

function grantId(snapshot: ExecutableTreeSnapshot): string {
  return `sha256:${createHash("sha256")
    .update("nexus-custom-tool-grant-v1\0")
    .update(snapshot.declaredPath)
    .update("\0")
    .update(snapshot.canonicalPath)
    .digest("hex")}`
}

function sameIdentity(
  grant: CustomToolTrustGrant,
  snapshot: ExecutableTreeSnapshot,
): boolean {
  return (
    grant.canonicalPath === snapshot.canonicalPath &&
    grant.device === snapshot.device &&
    grant.inode === snapshot.inode &&
    grant.kind === snapshot.kind
  )
}

export class CustomToolTrustStore {
  readonly storePath: string
  private readonly options: CustomToolTrustStoreOptions

  constructor(options: CustomToolTrustStoreOptions = {}) {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options)
    ) {
      throw new TypeError(
        "CustomToolTrustStore options must be an object; use { storePath }",
      )
    }
    this.storePath = path.resolve(
      options.storePath ??
        path.join(
          getNexusDataDir(),
          "authority",
          "custom-tool-trust-v1.json",
        ),
    )
    this.options = options
    resolvedLimits(options.limits)
  }

  async grant(sourcePath: string): Promise<CustomToolTrustGrant> {
    const snapshot = await fingerprintExecutableTree(sourcePath, {
      limits: this.options.limits,
    })
    return withFileLock(this.storePath, async () => {
      const store = await readStore(this.storePath)
      const grant: CustomToolTrustGrant = {
        id: grantId(snapshot),
        declaredPath: snapshot.declaredPath,
        canonicalPath: snapshot.canonicalPath,
        device: snapshot.device,
        inode: snapshot.inode,
        kind: snapshot.kind,
        fingerprint: snapshot.fingerprint,
        grantedAt: (this.options.now ?? Date.now)(),
      }
      store.grants = store.grants.filter(
        (candidate) => candidate.declaredPath !== snapshot.declaredPath,
      )
      store.grants.push(grant)
      store.grants.sort((left, right) =>
        left.declaredPath.localeCompare(right.declaredPath)
      )
      await writeStore(this.storePath, store)
      return grant
    })
  }

  async evaluate(sourcePath: string): Promise<CustomToolTrustEvaluation> {
    let snapshot: ExecutableTreeSnapshot
    try {
      snapshot = await fingerprintExecutableTree(sourcePath, {
        limits: this.options.limits,
      })
    } catch (error) {
      return {
        trusted: false,
        reason: "unsafe-source",
        message: error instanceof Error ? error.message : String(error),
      }
    }
    return this.evaluateSnapshot(snapshot)
  }

  async evaluateSnapshot(
    snapshot: ExecutableTreeSnapshot,
  ): Promise<CustomToolTrustEvaluation> {
    try {
      const store = await readStore(this.storePath)
      const grant = store.grants.find(
        (candidate) => candidate.declaredPath === snapshot.declaredPath,
      )
      if (!grant) {
        return {
          trusted: false,
          reason: "not-granted",
          fingerprint: snapshot.fingerprint,
          snapshot,
        }
      }
      if (!sameIdentity(grant, snapshot)) {
        return {
          trusted: false,
          reason: "identity-changed",
          fingerprint: snapshot.fingerprint,
          grantId: grant.id,
          snapshot,
        }
      }
      if (grant.fingerprint !== snapshot.fingerprint) {
        return {
          trusted: false,
          reason: "content-changed",
          fingerprint: snapshot.fingerprint,
          grantId: grant.id,
          snapshot,
        }
      }
      return {
        trusted: true,
        reason: "trusted",
        fingerprint: snapshot.fingerprint,
        grantId: grant.id,
        snapshot,
      }
    } catch (error) {
      return {
        trusted: false,
        reason: "store-unavailable",
        fingerprint: snapshot.fingerprint,
        message: error instanceof Error ? error.message : String(error),
        snapshot,
      }
    }
  }

  async list(): Promise<CustomToolTrustGrant[]> {
    return (await readStore(this.storePath)).grants
  }

  async revoke(sourcePath: string): Promise<boolean> {
    const declaredPath = path.resolve(sourcePath)
    return withFileLock(this.storePath, async () => {
      const store = await readStore(this.storePath)
      const next = store.grants.filter(
        (candidate) => candidate.declaredPath !== declaredPath,
      )
      if (next.length === store.grants.length) return false
      store.grants = next
      await writeStore(this.storePath, store)
      return true
    })
  }
}
