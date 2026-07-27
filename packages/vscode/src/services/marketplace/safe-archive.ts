import { constants as fsConstants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { gunzip } from "node:zlib"

export interface SafeArchiveEntry {
  path: string
  kind: "file" | "directory"
  data?: Buffer
  mode: number
}

export interface SafeArchivePlan {
  entries: SafeArchiveEntry[]
}

export interface ArchiveExtractionOptions {
  containmentRoot?: string
}

export interface SafeArchiveLimits {
  maxDownloadBytes: number
  maxExpandedArchiveBytes: number
  maxEntries: number
  maxTotalFileBytes: number
  maxFileBytes: number
  maxPathBytes: number
}

export const DEFAULT_SAFE_ARCHIVE_LIMITS: Readonly<SafeArchiveLimits> = Object.freeze({
  maxDownloadBytes: 25 * 1024 * 1024,
  maxExpandedArchiveBytes: 128 * 1024 * 1024,
  maxEntries: 10_000,
  maxTotalFileBytes: 100 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxPathBytes: 512,
})

const MAX_ARCHIVE_METADATA_BYTES = 64 * 1024
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

export async function readResponseBodyWithLimit(
  response: Response,
  maxBytes = DEFAULT_SAFE_ARCHIVE_LIMITS.maxDownloadBytes,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Invalid archive download limit")
  }
  const contentLength = response.headers.get("content-length")
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength)
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      throw new Error(`Archive download exceeds maximum of ${maxBytes} bytes`)
    }
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
        await reader.cancel()
        throw new Error(`Archive download exceeds maximum of ${maxBytes} bytes`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, totalBytes)
}

function resolveLimits(overrides: Partial<SafeArchiveLimits>): SafeArchiveLimits {
  const limits = { ...DEFAULT_SAFE_ARCHIVE_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid archive limit ${name}`)
    }
  }
  return limits
}

function gunzipArchive(archive: Uint8Array, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(archive, { maxOutputLength }, (error, result) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|larger than/i.test(error.message)) {
          reject(new Error(`Expanded archive exceeds ${maxOutputLength} bytes`))
          return
        }
        reject(new Error(`Invalid gzip archive: ${error.message}`))
      }
      else resolve(result)
    })
  })
}

function readTarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length)
  const nul = field.indexOf(0)
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8")
}

function readTarOctal(header: Buffer, offset: number, length: number): number {
  const value = readTarString(header, offset, length).trim()
  if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar numeric field")
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid tar numeric field")
  return parsed
}

function assertTarChecksum(header: Buffer): void {
  const expected = readTarOctal(header, 148, 8)
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!
  }
  if (actual !== expected) throw new Error("Tar header checksum mismatch")
}

function decodeArchiveText(bytes: Uint8Array, context: string): string {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new Error(`Archive contains invalid UTF-8 in ${context}`)
  }
}

function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) throw new Error("Archive contains malformed PAX metadata")
    const lengthText = data.subarray(offset, space).toString("ascii")
    if (!/^[1-9]\d*$/.test(lengthText)) {
      throw new Error("Archive contains malformed PAX metadata")
    }
    const length = Number(lengthText)
    const end = offset + length
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      throw new Error("Archive contains malformed PAX metadata")
    }
    const record = decodeArchiveText(
      data.subarray(space + 1, end - 1),
      "PAX metadata",
    )
    const separator = record.indexOf("=")
    if (separator <= 0) throw new Error("Archive contains malformed PAX metadata")
    const key = record.slice(0, separator)
    const value = record.slice(separator + 1)
    if (!/^[A-Za-z0-9_.-]+$/.test(key) || value.includes("\0") || records.has(key)) {
      throw new Error("Archive contains malformed PAX metadata")
    }
    records.set(key, value)
    offset = end
  }
  return records
}

function parseGnuLongPath(data: Buffer): string {
  const nul = data.indexOf(0)
  const pathBytes = data.subarray(0, nul === -1 ? data.length : nul)
  if (nul !== -1 && !data.subarray(nul).every((byte) => byte === 0)) {
    throw new Error("Archive contains malformed GNU long-path metadata")
  }
  return decodeArchiveText(pathBytes, "GNU long-path metadata").replace(/\n$/, "")
}

function safeRelativeArchivePath(rawPath: string, maxPathBytes: number): string {
  if (Buffer.byteLength(rawPath, "utf8") > maxPathBytes) {
    throw new Error(`Archive path exceeds ${maxPathBytes} bytes`)
  }
  if (
    !rawPath ||
    rawPath.startsWith("/") ||
    rawPath.includes("\\") ||
    /^[a-zA-Z]:/.test(rawPath)
  ) {
    throw new Error(`Archive contains unsafe path: ${rawPath}`)
  }
  const rawSegments = rawPath.replace(/\/$/, "").split("/")
  if (
    rawSegments.length === 0 ||
    rawSegments.some((segment) => !segment || segment === "..")
  ) {
    throw new Error(`Archive contains unsafe traversal path: ${rawPath}`)
  }
  const segments = rawSegments.filter((segment) => segment !== ".")
  if (segments.length === 0) throw new Error(`Archive contains unsafe path: ${rawPath}`)
  for (const segment of segments) {
    if (Buffer.byteLength(segment, "utf8") > 255) {
      throw new Error("Archive path segment exceeds 255 bytes")
    }
    if (
      /[<>:"|?*\u0000-\u001f]/u.test(segment) ||
      /[ .]$/u.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
    ) {
      throw new Error(`Archive contains non-portable path segment: ${segment}`)
    }
  }
  return segments.join("/")
}

export async function preflightTarGzArchive(
  archive: Uint8Array,
  limitOverrides: Partial<SafeArchiveLimits> = {},
): Promise<SafeArchivePlan> {
  const limits = resolveLimits(limitOverrides)
  if (archive.byteLength > limits.maxDownloadBytes) {
    throw new Error(`Compressed archive exceeds ${limits.maxDownloadBytes} bytes`)
  }
  const unpacked = await gunzipArchive(archive, limits.maxExpandedArchiveBytes)
  if (unpacked.length % 512 !== 0) throw new Error("Truncated tar archive")
  const entries: SafeArchiveEntry[] = []
  let offset = 0
  let totalFileBytes = 0
  let sawEndMarker = false
  let processedHeaders = 0
  let pendingPath: string | undefined

  while (offset + 512 <= unpacked.length) {
    const header = unpacked.subarray(offset, offset + 512)
    offset += 512
    if (header.every((byte) => byte === 0)) {
      const secondEndBlock = unpacked.subarray(offset, offset + 512)
      if (
        secondEndBlock.length !== 512 ||
        !secondEndBlock.every((byte) => byte === 0)
      ) {
        throw new Error("Tar archive is missing its complete end marker")
      }
      offset += 512
      if (!unpacked.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("Tar archive contains data after its end marker")
      }
      sawEndMarker = true
      break
    }

    assertTarChecksum(header)
    processedHeaders += 1
    if (processedHeaders > limits.maxEntries) {
      throw new Error(`Archive entry count exceeds ${limits.maxEntries}`)
    }
    const size = readTarOctal(header, 124, 12)
    const paddedSize = Math.ceil(size / 512) * 512
    if (offset + paddedSize > unpacked.length) throw new Error("Truncated tar entry")
    const type = String.fromCharCode(header[156] ?? 0)
    const dataOffset = offset
    offset += paddedSize

    if (type === "g" || type === "x" || type === "L") {
      if (size > MAX_ARCHIVE_METADATA_BYTES) {
        throw new Error(`Archive metadata exceeds ${MAX_ARCHIVE_METADATA_BYTES} bytes`)
      }
      const metadata = Buffer.from(unpacked.subarray(dataOffset, dataOffset + size))
      if (type === "g") {
        const globalRecords = parsePaxRecords(metadata)
        if (
          globalRecords.has("path") ||
          globalRecords.has("linkpath") ||
          globalRecords.has("size")
        ) {
          throw new Error("Archive contains unsafe global PAX metadata")
        }
        continue
      }
      let metadataPath: string | undefined
      if (type === "x") {
        const records = parsePaxRecords(metadata)
        if (records.has("linkpath") || records.has("size")) {
          throw new Error("Archive contains unsupported PAX link or size metadata")
        }
        metadataPath = records.get("path")
      } else {
        metadataPath = parseGnuLongPath(metadata)
      }
      if (metadataPath !== undefined) {
        if (pendingPath !== undefined) {
          throw new Error("Archive contains ambiguous path metadata")
        }
        pendingPath = safeRelativeArchivePath(metadataPath, limits.maxPathBytes)
      }
      continue
    }

    if (type !== "\0" && type !== "0" && type !== "5") {
      throw new Error(`Archive contains unsupported tar entry type ${JSON.stringify(type)}`)
    }
    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const headerPath = prefix ? `${prefix}/${name}` : name
    const rawPath = pendingPath ?? safeRelativeArchivePath(headerPath, limits.maxPathBytes)
    pendingPath = undefined
    const mode = readTarOctal(header, 100, 8)
    if (type !== "5") {
      if (size > limits.maxFileBytes) {
        throw new Error(`Archive file exceeds ${limits.maxFileBytes} bytes`)
      }
      totalFileBytes += size
      if (!Number.isSafeInteger(totalFileBytes) || totalFileBytes > limits.maxTotalFileBytes) {
        throw new Error(`Archive total file size exceeds ${limits.maxTotalFileBytes} bytes`)
      }
    }
    entries.push({
      path: rawPath,
      kind: type === "5" ? "directory" : "file",
      data:
        type === "5"
          ? undefined
          : Buffer.from(unpacked.subarray(dataOffset, dataOffset + size)),
      mode,
    })
  }

  if (!sawEndMarker) throw new Error("Tar archive is missing its end marker")
  if (pendingPath !== undefined) throw new Error("Archive path metadata has no following entry")
  const roots = new Set(entries.map((entry) => entry.path.split("/")[0]))
  if (roots.size !== 1) throw new Error("Archive must contain one top-level directory")
  const [root] = roots
  const strippedEntries = entries
    .filter((entry) => entry.path !== root)
    .map((entry) => ({
      ...entry,
      path: entry.path.slice(root!.length + 1),
    }))
  return { entries: validateExtractionPlan({ entries: strippedEntries }) }
}

function portablePathKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US")
}

function validateExtractionPlan(plan: SafeArchivePlan): SafeArchiveEntry[] {
  if (!Array.isArray(plan.entries) || plan.entries.length === 0) {
    throw new Error("Archive extraction plan is empty")
  }

  const entries: SafeArchiveEntry[] = []
  const exactPaths = new Set<string>()
  const portablePaths = new Map<string, string>()
  const kinds = new Map<string, SafeArchiveEntry["kind"]>()

  for (const entry of plan.entries) {
    const safePath = safeRelativeArchivePath(
      entry.path,
      DEFAULT_SAFE_ARCHIVE_LIMITS.maxPathBytes,
    )
    if (safePath !== entry.path) throw new Error(`Archive contains unsafe path: ${entry.path}`)
    if (entry.kind !== "file" && entry.kind !== "directory") {
      throw new Error(`Archive contains unsupported extraction entry: ${entry.path}`)
    }
    if (entry.kind === "file" && !Buffer.isBuffer(entry.data)) {
      throw new Error(`Archive file is missing data: ${entry.path}`)
    }
    if (exactPaths.has(safePath)) {
      throw new Error(`Archive contains duplicate path: ${safePath}`)
    }
    const portableKey = portablePathKey(safePath)
    const portableCollision = portablePaths.get(portableKey)
    if (portableCollision && portableCollision !== safePath) {
      throw new Error(`Archive contains platform-ambiguous paths: ${portableCollision}, ${safePath}`)
    }
    exactPaths.add(safePath)
    portablePaths.set(portableKey, safePath)
    kinds.set(safePath, entry.kind)
    entries.push({ ...entry, path: safePath })
  }

  for (const entry of entries) {
    const segments = entry.path.split("/")
    for (let length = 1; length < segments.length; length += 1) {
      const parent = segments.slice(0, length).join("/")
      if (kinds.get(parent) === "file") {
        throw new Error(`Archive file cannot contain child path: ${entry.path}`)
      }
    }
  }

  return entries
}

export function selectArchiveSubtree(
  repositoryPlan: SafeArchivePlan,
  requestedPath: string,
): SafeArchivePlan {
  const safeRequestedPath = safeRelativeArchivePath(
    requestedPath,
    DEFAULT_SAFE_ARCHIVE_LIMITS.maxPathBytes,
  )
  const repositoryEntries = validateExtractionPlan(repositoryPlan)
  const exactEntry = repositoryEntries.find((entry) => entry.path === safeRequestedPath)
  const subtreeRoot =
    exactEntry?.kind === "file"
      ? path.posix.dirname(safeRequestedPath)
      : safeRequestedPath
  const prefix = subtreeRoot === "." ? "" : `${subtreeRoot}/`
  const selected = repositoryEntries
    .filter((entry) => prefix === "" || entry.path === subtreeRoot || entry.path.startsWith(prefix))
    .filter((entry) => entry.path !== subtreeRoot)
    .map((entry) => ({
      ...entry,
      path: prefix === "" ? entry.path : entry.path.slice(prefix.length),
    }))
  if (!selected.some((entry) => entry.path === "SKILL.md" && entry.kind === "file")) {
    throw new Error(`Selected skill subtree is missing SKILL.md: ${safeRequestedPath}`)
  }
  return { entries: validateExtractionPlan({ entries: selected }) }
}

function childPath(root: string, relativePath: string): string {
  const fullPath = path.resolve(root, ...relativePath.split("/"))
  if (!fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Archive contains unsafe traversal path: ${relativePath}`)
  }
  return fullPath
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function assertRealDirectory(target: string): Promise<void> {
  const stat = await fs.lstat(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe extraction directory: ${target}`)
  }
}

async function prepareExtractionDestination(
  destination: string,
  containmentRoot?: string,
): Promise<{ destination: string; parent: string }> {
  const lexicalDestination = path.resolve(destination)
  if (!containmentRoot) {
    const parent = path.dirname(lexicalDestination)
    await fs.mkdir(parent, { recursive: true })
    await assertRealDirectory(parent)
    return { destination: lexicalDestination, parent }
  }

  const lexicalRoot = path.resolve(containmentRoot)
  const relativeDestination = path.relative(lexicalRoot, lexicalDestination)
  if (
    !relativeDestination ||
    path.isAbsolute(relativeDestination) ||
    relativeDestination === ".." ||
    relativeDestination.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Archive destination is outside its containment root")
  }

  const canonicalRoot = await fs.realpath(lexicalRoot)
  await assertRealDirectory(canonicalRoot)
  const relativeParent = path.dirname(relativeDestination)
  let parent = canonicalRoot
  if (relativeParent !== ".") {
    for (const segment of relativeParent.split(path.sep)) {
      parent = path.join(parent, segment)
      try {
        await fs.mkdir(parent, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      await assertRealDirectory(parent)
    }
  }
  return {
    destination: path.join(canonicalRoot, relativeDestination),
    parent,
  }
}

/**
 * Writes only an already-preflighted plan to a private sibling directory, then publishes it
 * with one rename. The plan is validated again so callers cannot bypass the archive preflight.
 */
export async function extractArchivePlanAtomically(
  plan: SafeArchivePlan,
  destination: string,
  options: ArchiveExtractionOptions = {},
): Promise<void> {
  if (!path.isAbsolute(destination)) {
    throw new Error("Archive destination must be absolute")
  }
  const entries = validateExtractionPlan(plan)
  const prepared = await prepareExtractionDestination(
    destination,
    options.containmentRoot,
  )
  const resolvedDestination = prepared.destination
  const parent = prepared.parent
  if (await pathExists(resolvedDestination)) {
    throw new Error(`Archive destination already exists: ${resolvedDestination}`)
  }

  const stagingPrefix = path.join(parent, `.${path.basename(resolvedDestination)}.staging-`)
  let staging: string | undefined
  try {
    staging = await fs.mkdtemp(stagingPrefix)
    await fs.chmod(staging, 0o700)
    await assertRealDirectory(staging)

    const directories = new Set<string>()
    for (const entry of entries) {
      const segments = entry.path.split("/")
      const end = entry.kind === "directory" ? segments.length : segments.length - 1
      for (let length = 1; length <= end; length += 1) {
        directories.add(segments.slice(0, length).join("/"))
      }
    }

    for (const directory of [...directories].sort((left, right) => {
      return left.split("/").length - right.split("/").length || left.localeCompare(right)
    })) {
      const target = childPath(staging, directory)
      await fs.mkdir(target, { mode: 0o700 })
      await assertRealDirectory(target)
    }

    for (const entry of entries) {
      if (entry.kind !== "file") continue
      const target = childPath(staging, entry.path)
      await assertRealDirectory(path.dirname(target))
      const noFollow = fsConstants.O_NOFOLLOW ?? 0
      const handle = await fs.open(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
        0o600,
      )
      try {
        await handle.writeFile(entry.data!)
        await handle.chmod((entry.mode & 0o111) !== 0 ? 0o700 : 0o600)
      } finally {
        await handle.close()
      }
    }

    if (await pathExists(resolvedDestination)) {
      throw new Error(`Archive destination already exists: ${resolvedDestination}`)
    }
    await fs.rename(staging, resolvedDestination)
    staging = undefined
  } finally {
    if (staging) {
      await fs.rm(staging, { recursive: true, force: true })
    }
  }
}
