import { constants as fsConstants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"

export interface BoundedMemoryMarkdownFile {
  path: string
  relativePath: string
  content: string
  truncated: boolean
}

export interface BoundedMemoryMarkdownCollection {
  files: BoundedMemoryMarkdownFile[]
  omitted: boolean
}

export interface CollectMemoryMarkdownOptions {
  maxDepth: number
  maxFiles: number
  maxEntries: number
  maxFileBytes: number
  maxTotalChars: number
  excludeBasenames?: readonly string[]
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

async function readBoundedFile(
  filePath: string,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean } | undefined> {
  const before = await fs.lstat(filePath)
  if (!before.isFile() || before.isSymbolicLink()) return undefined
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  )
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) return undefined
    const readableBytes = Math.min(opened.size, maxBytes)
    const buffer = Buffer.alloc(readableBytes)
    let offset = 0
    while (offset < readableBytes) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        readableBytes - offset,
        offset,
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return {
      content: buffer.subarray(0, offset).toString("utf8"),
      truncated: opened.size > maxBytes,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Enumerate memory markdown without following links or allowing directory/file
 * counts to turn prompt construction into an unbounded filesystem scan.
 */
export async function collectMemoryMarkdownFiles(
  base: string,
  options: CollectMemoryMarkdownOptions,
): Promise<BoundedMemoryMarkdownCollection> {
  assertPositiveSafeInteger(options.maxDepth, "maxDepth")
  assertPositiveSafeInteger(options.maxFiles, "maxFiles")
  assertPositiveSafeInteger(options.maxEntries, "maxEntries")
  assertPositiveSafeInteger(options.maxFileBytes, "maxFileBytes")
  assertPositiveSafeInteger(options.maxTotalChars, "maxTotalChars")

  let baseStats
  try {
    baseStats = await fs.lstat(base)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { files: [], omitted: false }
    }
    throw error
  }
  if (!baseStats.isDirectory() || baseStats.isSymbolicLink()) {
    throw new Error(`Memory path is not a real directory: ${base}`)
  }

  const excluded = new Set(options.excludeBasenames ?? [])
  const candidates: string[] = []
  const directories: Array<{ path: string; depth: number }> = [
    { path: base, depth: 0 },
  ]
  let visitedEntries = 0
  let omitted = false

  while (directories.length > 0 && candidates.length < options.maxFiles) {
    const current = directories.pop()
    if (!current) break
    const currentStats = await fs.lstat(current.path).catch(() => undefined)
    if (
      !currentStats ||
      !currentStats.isDirectory() ||
      currentStats.isSymbolicLink()
    ) {
      omitted = true
      continue
    }
    const entries: import("node:fs").Dirent[] = []
    const directory = await fs.opendir(current.path)
    try {
      for await (const entry of directory) {
        visitedEntries += 1
        if (visitedEntries > options.maxEntries) {
          omitted = true
          break
        }
        entries.push(entry)
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
    if (visitedEntries > options.maxEntries) break

    const childDirectories: Array<{ path: string; depth: number }> = []
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const full = path.join(current.path, entry.name)
      if (entry.isSymbolicLink()) {
        omitted = true
        continue
      }
      if (entry.isDirectory()) {
        if (current.depth < options.maxDepth) {
          childDirectories.push({ path: full, depth: current.depth + 1 })
        } else {
          omitted = true
        }
        continue
      }
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".md") ||
        excluded.has(entry.name)
      ) {
        continue
      }
      if (candidates.length >= options.maxFiles) {
        omitted = true
        break
      }
      candidates.push(full)
    }
    // LIFO stack: push reverse lexical order so the next pop is deterministic.
    directories.push(...childDirectories.reverse())
  }
  if (directories.length > 0) omitted = true

  const files: BoundedMemoryMarkdownFile[] = []
  let totalChars = 0
  for (const filePath of candidates.sort()) {
    const loaded = await readBoundedFile(
      filePath,
      options.maxFileBytes,
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (!loaded) {
      omitted = true
      continue
    }
    const remaining = options.maxTotalChars - totalChars
    if (remaining <= 0) {
      omitted = true
      break
    }
    const content = loaded.content.slice(0, remaining)
    const truncated =
      loaded.truncated || content.length < loaded.content.length
    if (truncated) omitted = true
    if (!content.trim()) continue
    files.push({
      path: filePath,
      relativePath: path.relative(base, filePath).replaceAll("\\", "/"),
      content,
      truncated,
    })
    totalChars += content.length
    if (totalChars >= options.maxTotalChars) break
  }
  if (files.length < candidates.length) omitted = true
  return { files, omitted }
}
