/**
 * Remote skill registries.
 *
 * A registry is treated as untrusted content even after its base URL has been
 * approved by configuration authority. Downloads are bounded, same-origin,
 * staged, and atomically swapped into a registry-specific cache namespace.
 */
import { createHash, randomBytes } from "node:crypto"
import type { Dirent } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { atomicWriteFile, withFileLock } from "../storage/durable-fs.js"

type SkillIndex = {
  skills: Array<{ name?: unknown; files?: unknown }>
}

export interface SkillUrlRegistryOptions {
  cacheDirectory?: string
  fetcher?: typeof fetch
  maxIndexBytes?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxSkills?: number
  maxFilesPerSkill?: number
  timeoutMs?: number
}

const DEFAULT_MAX_INDEX_BYTES = 512 * 1024
const DEFAULT_MAX_FILE_BYTES = 512 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_SKILLS = 128
const DEFAULT_MAX_FILES_PER_SKILL = 128
const DEFAULT_TIMEOUT_MS = 20_000

function defaultCacheDirectory(): string {
  return path.join(os.homedir(), ".nexus", "cache", "skills")
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return fallback
  return Math.min(value!, maximum)
}

function parseRegistryBaseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Skill registry URL must be a valid http(s) URL: ${raw}`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Skill registry URL must use http(s), received ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new Error("Skill registry URLs must not contain embedded credentials")
  }
  if (url.search || url.hash) {
    throw new Error("Skill registry URLs must not contain a query string or fragment")
  }
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`
  return url
}

function registryNamespace(base: URL): string {
  return createHash("sha256").update(base.href).digest("hex").slice(0, 24)
}

function isSafeSkillName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    value !== "." &&
    value !== ".."
  )
}

function normalizeRegistryFile(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value)
  ) {
    return undefined
  }
  const normalized = path.posix.normalize(value)
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      /[\u0000-\u001f\u007f]/u.test(segment))
  ) {
    return undefined
  }
  return normalized
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

async function fetchBounded(
  fetcher: typeof fetch,
  url: URL,
  maxBytes: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Skill registry request timed out: ${url.href}`))
  }, timeoutMs)
  try {
    const response = await fetcher(url.href, {
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Skill registry request failed (${response.status}): ${url.href}`)
    }
    const contentLength = response.headers.get("content-length")
    const declaredLength =
      contentLength === null ? undefined : Number(contentLength)
    if (
      declaredLength !== undefined &&
      Number.isFinite(declaredLength) &&
      declaredLength >= 0 &&
      declaredLength > maxBytes
    ) {
      throw new Error(`Skill registry response exceeds ${maxBytes} bytes: ${url.href}`)
    }

    const reader = response.body?.getReader()
    if (!reader) return new Uint8Array()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          const error = new Error(
            `Skill registry response exceeds ${maxBytes} bytes: ${url.href}`,
          )
          await reader.cancel(error).catch(() => undefined)
          controller.abort(error)
          throw error
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }

    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    clearTimeout(timeout)
  }
}

function parseIndex(
  bytes: Uint8Array,
  maxSkills: number,
  maxFilesPerSkill: number,
): Array<{ name: string; files: string[] }> {
  let parsed: SkillIndex
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as SkillIndex
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.skills)) {
    return []
  }

  const result: Array<{ name: string; files: string[] }> = []
  const seenNames = new Set<string>()
  for (const candidate of parsed.skills.slice(0, maxSkills)) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !isSafeSkillName(candidate.name) ||
      !Array.isArray(candidate.files) ||
      candidate.files.length === 0 ||
      candidate.files.length > maxFilesPerSkill ||
      seenNames.has(candidate.name)
    ) {
      continue
    }
    const files = candidate.files.map(normalizeRegistryFile)
    if (
      files.some((file) => file === undefined) ||
      !files.includes("SKILL.md") ||
      new Set(files).size !== files.length
    ) {
      continue
    }
    seenNames.add(candidate.name)
    result.push({
      name: candidate.name,
      files: files as string[],
    })
  }
  return result
}

async function hasRegularSkillFile(root: string): Promise<boolean> {
  try {
    const rootStat = await fs.lstat(root)
    const skillStat = await fs.lstat(path.join(root, "SKILL.md"))
    return rootStat.isDirectory() && !rootStat.isSymbolicLink() &&
      skillStat.isFile() && !skillStat.isSymbolicLink()
  } catch {
    return false
  }
}

async function listCachedRoots(namespaceRoot: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(namespaceRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const roots: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeSkillName(entry.name)) continue
    const root = path.join(namespaceRoot, entry.name)
    if (await hasRegularSkillFile(root)) roots.push(root)
  }
  return roots.sort()
}

async function replaceSkillDirectory(
  namespaceRoot: string,
  skillName: string,
  stagedRoot: string,
): Promise<string> {
  const target = path.join(namespaceRoot, skillName)
  if (!isPathInside(namespaceRoot, target)) {
    throw new Error(`Unsafe skill cache destination: ${skillName}`)
  }
  const backup = path.join(
    namespaceRoot,
    `.backup-${skillName}-${randomBytes(8).toString("hex")}`,
  )
  const targetExists = await fs.lstat(target).then(() => true).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  })
  if (targetExists) await fs.rename(target, backup)
  try {
    await fs.rename(stagedRoot, target)
  } catch (error) {
    if (targetExists) {
      await fs.rename(backup, target).catch(() => undefined)
    }
    throw error
  }
  if (targetExists) {
    await fs.rm(backup, { recursive: true, force: true })
  }
  return target
}

/**
 * Download a registry's index and return cached directories containing a
 * regular `SKILL.md`. A broken refresh preserves the last complete pack.
 */
export async function fetchSkillUrlRegistryRoots(
  baseUrl: string,
  options: SkillUrlRegistryOptions = {},
): Promise<string[]> {
  const base = parseRegistryBaseUrl(baseUrl)
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== "function") {
    throw new Error("Skill registry downloads require a fetch implementation")
  }

  const maxIndexBytes = boundedOption(
    options.maxIndexBytes,
    DEFAULT_MAX_INDEX_BYTES,
    4 * 1024 * 1024,
  )
  const maxFileBytes = boundedOption(
    options.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    16 * 1024 * 1024,
  )
  const maxTotalBytes = boundedOption(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    64 * 1024 * 1024,
  )
  const maxSkills = boundedOption(options.maxSkills, DEFAULT_MAX_SKILLS, 1_024)
  const maxFilesPerSkill = boundedOption(
    options.maxFilesPerSkill,
    DEFAULT_MAX_FILES_PER_SKILL,
    1_024,
  )
  const timeoutMs = boundedOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, 120_000)

  const cacheDirectory = path.resolve(
    options.cacheDirectory ?? defaultCacheDirectory(),
  )
  const namespaceRoot = path.join(cacheDirectory, registryNamespace(base))
  await fs.mkdir(namespaceRoot, { recursive: true, mode: 0o700 })
  await fs.chmod(namespaceRoot, 0o700).catch(() => undefined)

  return withFileLock(path.join(namespaceRoot, ".registry"), async () => {
    let indexBytes: Uint8Array
    try {
      indexBytes = await fetchBounded(
        fetcher,
        new URL("index.json", base),
        maxIndexBytes,
        timeoutMs,
      )
    } catch {
      return listCachedRoots(namespaceRoot)
    }

    const packs = parseIndex(indexBytes, maxSkills, maxFilesPerSkill)
    if (packs.length === 0) return listCachedRoots(namespaceRoot)

    const result: string[] = []
    let totalDownloadedBytes = 0
    for (const pack of packs) {
      const existingRoot = path.join(namespaceRoot, pack.name)
      const stageDirectory = await fs.mkdtemp(
        path.join(namespaceRoot, `.stage-${pack.name}-`),
      )
      const stagedRoot = path.join(stageDirectory, pack.name)
      let complete = false
      try {
        await fs.mkdir(stagedRoot, { recursive: true, mode: 0o700 })
        const packBase = new URL(`${encodeURIComponent(pack.name)}/`, base)
        for (const file of pack.files) {
          const fileUrl = new URL(
            file.split("/").map(encodeURIComponent).join("/"),
            packBase,
          )
          if (fileUrl.origin !== base.origin || !fileUrl.pathname.startsWith(packBase.pathname)) {
            throw new Error(`Skill file escaped its approved registry origin: ${file}`)
          }
          const bytes = await fetchBounded(
            fetcher,
            fileUrl,
            maxFileBytes,
            timeoutMs,
          )
          totalDownloadedBytes += bytes.byteLength
          if (totalDownloadedBytes > maxTotalBytes) {
            throw new Error(`Skill registry exceeds ${maxTotalBytes} downloaded bytes`)
          }
          const destination = path.join(stagedRoot, ...file.split("/"))
          if (!isPathInside(stagedRoot, destination)) {
            throw new Error(`Skill file escaped its staging directory: ${file}`)
          }
          await atomicWriteFile(destination, bytes, { mode: 0o600 })
        }
        if (!(await hasRegularSkillFile(stagedRoot))) {
          throw new Error(`Skill pack ${pack.name} has no regular SKILL.md`)
        }
        result.push(await replaceSkillDirectory(
          namespaceRoot,
          pack.name,
          stagedRoot,
        ))
        complete = true
      } catch {
        if (await hasRegularSkillFile(existingRoot)) result.push(existingRoot)
      } finally {
        await fs.rm(stageDirectory, { recursive: true, force: true })
      }
      if (!complete && totalDownloadedBytes > maxTotalBytes) break
    }
    return result
  })
}
