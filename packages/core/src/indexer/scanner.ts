import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as crypto from "node:crypto"
import ignore from "ignore"
import { scannerExtensions as rooScannerExtensions } from "./roo/extensions.js"
import { shouldSkipDirectorySegment } from "./ignore-dirs.js"
import { INDEX_MAX_FILE_SIZE_BYTES } from "./indexing-capacity.js"

const BASE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".scala",
  ".md", ".mdx",
])

/** When `vectorIndexing` is true, include full tree-sitter extension set from `roo/extensions`. */
export function getIndexableExtensions(vectorIndexing: boolean): Set<string> {
  if (!vectorIndexing) return BASE_EXTENSIONS
  const m = new Set(BASE_EXTENSIONS)
  for (const e of rooScannerExtensions) {
    m.add(e.toLowerCase())
  }
  return m
}

const DEFAULT_EXCLUDE = [
  "node_modules/**", ".git/**", "dist/**", "build/**",
  ".next/**", ".nuxt/**", "coverage/**", "*.lock",
  ".nexus/**",
  "**/*.min.js", "**/*.bundle.js", "**/*.map",
]

export interface FileInfo {
  path: string
  absPath: string
  ext: string
  mtime: number
  /** Full-file SHA-256 (hex); used for incremental skip (Roo-style content cache). */
  contentSha256: string
  size: number
}

export interface WalkDirOptions {
  vectorIndexing?: boolean
  /** Stop after this many files (0 = unlimited). */
  maxFiles?: number
}

/**
 * Full-file SHA-256 for files ≤ {@link INDEX_MAX_FILE_SIZE_BYTES} (walk skips larger files; Roo-Code cap).
 */
async function hashFileSha256(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath)
  return crypto.createHash("sha256").update(buf).digest("hex")
}

/** Same rules as the index walk: defaults, YAML excludes, .gitignore, .nexusignore, .cursorignore. */
export async function createIndexerIgnore(root: string, excludePatterns: string[] = []): Promise<ReturnType<typeof ignore>> {
  const ig = ignore()
  ig.add(DEFAULT_EXCLUDE)
  ig.add(excludePatterns)
  try {
    ig.add(await fs.readFile(path.join(root, ".gitignore"), "utf8"))
  } catch {}
  try {
    ig.add(await fs.readFile(path.join(root, ".nexusignore"), "utf8"))
  } catch {}
  try {
    ig.add(await fs.readFile(path.join(root, ".cursorignore"), "utf8"))
  } catch {}
  return ig
}

export async function* walkDir(
  root: string,
  excludePatterns: string[] = [],
  opts?: WalkDirOptions,
): AsyncIterable<FileInfo> {
  const allowed = getIndexableExtensions(opts?.vectorIndexing ?? false)
  const maxFiles = opts?.maxFiles ?? 0
  let yielded = 0

  const ig = await createIndexerIgnore(root, excludePatterns)

  async function* walkInternal(dir: string): AsyncIterable<FileInfo> {
    if (maxFiles > 0 && yielded >= maxFiles) return

    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }

    for (const entry of entries.sort()) {
      if (maxFiles > 0 && yielded >= maxFiles) return

      if (shouldSkipDirectorySegment(entry)) continue

      const absPath = path.join(dir, entry)
      const relPath = path.relative(root, absPath)

      if (ig.ignores(relPath)) continue

      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(absPath)
      } catch {
        continue
      }

      if (stat.isSymbolicLink()) continue

      if (stat.isDirectory()) {
        yield* walkInternal(absPath)
      } else if (stat.isFile()) {
        if (maxFiles > 0 && yielded >= maxFiles) return

        const ext = path.extname(entry).toLowerCase()
        if (!allowed.has(ext)) continue
        if (stat.size > INDEX_MAX_FILE_SIZE_BYTES) continue

        const contentSha256 = await hashFileSha256(absPath)
        yielded++
        yield {
          path: relPath,
          absPath,
          ext,
          mtime: stat.mtimeMs,
          contentSha256,
          size: stat.size,
        }
      }
    }
  }

  yield* walkInternal(root)
}

/**
 * Collect indexable files with optional hard cap (Roo default list limit is 50,000 — same as schema default for `indexing.maxIndexedFiles`).
 */
export async function collectIndexFiles(
  root: string,
  excludePatterns: string[],
  opts?: WalkDirOptions,
): Promise<{ files: FileInfo[]; truncated: boolean }> {
  const maxFiles = opts?.maxFiles ?? 0
  /** Roo: `listFiles(..., 0)` returns no files. */
  if (maxFiles <= 0) {
    return { files: [], truncated: false }
  }
  const files: FileInfo[] = []
  for await (const f of walkDir(root, excludePatterns, { ...opts, maxFiles })) {
    files.push(f)
  }
  const truncated = files.length >= maxFiles
  return { files, truncated }
}

/** Build {@link FileInfo} from an absolute path (stat, size cap, extension, full-file SHA-256). */
export async function buildIndexFileInfo(
  absPath: string,
  root: string,
  vectorIndexing: boolean,
): Promise<FileInfo | null> {
  try {
    const s = await fs.stat(absPath)
    if (!s.isFile()) return null
    if (s.size > INDEX_MAX_FILE_SIZE_BYTES) return null
    const relPath = path.relative(root, absPath).replace(/\\/g, "/")
    if (!relPath || relPath.startsWith("..")) return null
    const ext = path.extname(absPath).toLowerCase()
    if (!getIndexableExtensions(vectorIndexing).has(ext)) return null
    const content = await fs.readFile(absPath)
    const contentSha256 = crypto.createHash("sha256").update(content).digest("hex")
    return {
      path: relPath,
      absPath,
      ext,
      mtime: s.mtimeMs,
      contentSha256,
      size: s.size,
    }
  } catch {
    return null
  }
}

/**
 * Turn ripgrep `--files` output (absolute paths) into indexable {@link FileInfo} list
 * using the same ignore + extension rules as `walkDir`.
 */
export async function materializeIndexFileInfos(
  projectRoot: string,
  absolutePaths: string[],
  excludePatterns: string[],
  vectorIndexing: boolean,
): Promise<FileInfo[]> {
  const ig = await createIndexerIgnore(projectRoot, excludePatterns)
  const out: FileInfo[] = []
  const seen = new Set<string>()
  for (const absRaw of absolutePaths) {
    const absPath = path.resolve(absRaw)
    if (seen.has(absPath)) continue
    seen.add(absPath)
    const relPath = path.relative(projectRoot, absPath).replace(/\\/g, "/")
    if (!relPath || relPath.startsWith("..")) continue
    if (ig.ignores(relPath)) continue
    const fi = await buildIndexFileInfo(absPath, projectRoot, vectorIndexing)
    if (fi) out.push(fi)
  }
  return out
}

/** VS Code `RelativePattern` glob: all indexable extensions (Roo `scannerExtensions`–style coverage when vector on). */
export function buildIndexWatcherGlobPattern(vectorIndexing: boolean): string {
  const exts = [...getIndexableExtensions(vectorIndexing)].map(e => e.replace(/^\./, "")).filter(Boolean).sort()
  if (exts.length === 0) return "**/*"
  return `**/*.{${exts.join(",")}}`
}
