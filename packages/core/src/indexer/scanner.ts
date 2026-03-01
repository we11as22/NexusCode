import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as crypto from "node:crypto"
import * as fsSync from "node:fs"
import { glob } from "glob"
import ignore from "ignore"

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".scala",
  ".md", ".mdx",
])

const DEFAULT_EXCLUDE = [
  "node_modules/**", ".git/**", "dist/**", "build/**",
  ".next/**", ".nuxt/**", "coverage/**", "*.lock",
  ".nexus/index/**", ".nexus/checkpoints/**",
  "**/*.min.js", "**/*.bundle.js", "**/*.map",
]

export interface FileInfo {
  path: string
  absPath: string
  ext: string
  mtime: number
  hash: string
  size: number
}

export async function* walkDir(
  root: string,
  excludePatterns: string[] = []
): AsyncIterable<FileInfo> {
  const ig = ignore()
  ig.add(DEFAULT_EXCLUDE)
  ig.add(excludePatterns)

  // Load .gitignore
  try {
    const gitignoreContent = await fs.readFile(path.join(root, ".gitignore"), "utf8")
    ig.add(gitignoreContent)
  } catch {}

  // Load .nexusignore if exists
  try {
    const nexusignoreContent = await fs.readFile(path.join(root, ".nexusignore"), "utf8")
    ig.add(nexusignoreContent)
  } catch {}

  async function* walkInternal(dir: string): AsyncIterable<FileInfo> {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }

    for (const entry of entries.sort()) {
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
        const ext = path.extname(entry).toLowerCase()
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue
        if (stat.size > 1024 * 1024) continue // Skip files >1MB

        const hash = await hashFile(absPath, stat.size)
        yield {
          path: relPath,
          absPath,
          ext,
          mtime: stat.mtimeMs,
          hash,
          size: stat.size,
        }
      }
    }
  }

  yield* walkInternal(root)
}

async function hashFile(filePath: string, size: number): Promise<string> {
  if (size < 8192) {
    // Small files: hash the full content
    try {
      const content = await fs.readFile(filePath)
      return crypto.createHash("md5").update(content).digest("hex")
    } catch {
      return `${size}_0`
    }
  }
  // Large files: hash first 4KB + mtime
  try {
    const fd = await fs.open(filePath, "r")
    const buf = Buffer.alloc(4096)
    const { bytesRead } = await fd.read(buf, 0, 4096, 0)
    await fd.close()
    return crypto.createHash("md5").update(buf.subarray(0, bytesRead)).digest("hex")
  } catch {
    return `${size}_error`
  }
}
