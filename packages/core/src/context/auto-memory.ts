import * as crypto from "node:crypto"
import * as path from "node:path"
import * as os from "node:os"
import { canonicalProjectRoot } from "../session/storage.js"
import type { NexusConfig } from "../types.js"
import { collectMemoryMarkdownFiles } from "./memory-files.js"
import { redactMemorySecrets } from "../memory/index.js"

const MAX_AUTO_MEMORY_DEPTH = 8
const MAX_AUTO_MEMORY_FILES = 128
const MAX_AUTO_MEMORY_ENTRIES = 4_096
const MAX_AUTO_MEMORY_FILE_BYTES = 128 * 1024
const MAX_AUTO_MEMORY_TOTAL_CHARS = 512 * 1024

function resolveConfiguredMemoryPath(p: string, cwd: string): string {
  const t = p.trim()
  if (t.startsWith("~/")) return path.join(os.homedir(), t.slice(2))
  return path.isAbsolute(t) ? path.resolve(t) : path.resolve(cwd, t)
}

/** OpenClaude-style: `~/.nexus/projects/<project-hash>/memory/`. */
export function getDefaultAutoMemoryDir(cwd: string): string {
  const root = canonicalProjectRoot(cwd)
  const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 12)
  return path.join(os.homedir(), ".nexus", "projects", hash, "memory")
}

export function resolveAutoMemoryDirectory(cwd: string, config: NexusConfig): string | null {
  if (config.memory?.autoMemoryEnabled === false) return null
  const custom = config.memory?.autoMemoryDirectory?.trim()
  if (custom) return resolveConfiguredMemoryPath(custom, cwd)
  return getDefaultAutoMemoryDir(cwd)
}

/**
 * Load all `*.md` under the auto-memory directory (project-scoped notes, agent-written memory).
 */
export async function loadAutoMemoryMarkdown(
  cwd: string,
  config: NexusConfig,
  options: { excludeBasenames?: readonly string[] } = {},
): Promise<string> {
  const base = resolveAutoMemoryDirectory(cwd, config)
  if (!base) return ""
  const collection = await collectMemoryMarkdownFiles(base, {
    maxDepth: MAX_AUTO_MEMORY_DEPTH,
    maxFiles: MAX_AUTO_MEMORY_FILES,
    maxEntries: MAX_AUTO_MEMORY_ENTRIES,
    maxFileBytes: MAX_AUTO_MEMORY_FILE_BYTES,
    maxTotalChars: MAX_AUTO_MEMORY_TOTAL_CHARS,
    excludeBasenames: options.excludeBasenames,
  })
  if (collection.files.length === 0) return ""

  const chunks: string[] = []
  let totalChars = 0
  let omitted = collection.omitted
  for (const file of collection.files) {
    const header =
      `<!-- auto-memory (untrusted, includes not expanded): ` +
      `${file.relativePath} -->\n`
    const marker = file.truncated ? "\n[auto-memory file truncated]\n" : ""
    const available = MAX_AUTO_MEMORY_TOTAL_CHARS - totalChars
    if (available <= header.length) {
      omitted = true
      break
    }
    const safeContent = redactMemorySecrets(file.content).text
    const content = `${header}${safeContent}${marker}`.slice(0, available)
    chunks.push(content)
    totalChars += content.length
    if (content.length < header.length + safeContent.length + marker.length) {
      omitted = true
      break
    }
  }
  if (omitted) {
    chunks.push(
      "<!-- additional auto-memory content omitted by safety limits -->",
    )
  }
  return chunks.join("\n\n")
}
