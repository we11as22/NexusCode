import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { glob } from "glob"
import { canonicalProjectRoot } from "../session/storage.js"
import type { NexusConfig } from "../types.js"
import { expandInstructionIncludes } from "./instruction-include.js"

function expandHome(p: string): string {
  const t = p.trim()
  if (t.startsWith("~/")) return path.join(os.homedir(), t.slice(2))
  return path.resolve(t)
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
  if (custom) return expandHome(custom)
  return getDefaultAutoMemoryDir(cwd)
}

/**
 * Load all `*.md` under the auto-memory directory (project-scoped notes, agent-written memory).
 */
export async function loadAutoMemoryMarkdown(cwd: string, config: NexusConfig): Promise<string> {
  const base = resolveAutoMemoryDirectory(cwd, config)
  if (!base) return ""

  const files = await glob(path.join(base, "**/*.md")).catch(() => [] as string[])
  if (files.length === 0) return ""

  const chunks: string[] = []
  for (const f of files.sort()) {
    const raw = await fs.readFile(f, "utf8").catch(() => "")
    if (!raw.trim()) continue
    const expanded = await expandInstructionIncludes(raw, path.dirname(f), new Set())
    const rel = path.relative(base, f)
    chunks.push(`<!-- auto-memory: ${rel.replace(/\\/g, "/")} -->\n${expanded}`)
  }
  return chunks.join("\n\n")
}
