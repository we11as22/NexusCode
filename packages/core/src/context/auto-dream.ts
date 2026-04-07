import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { LLMClient } from "../provider/types.js"
import type { NexusConfig } from "../types.js"
import { resolveAutoMemoryDirectory } from "./auto-memory.js"

const LAST_RUN_BASENAME = ".nexus_last_auto_dream"
const CONSOLIDATED_BASENAME = "_nexus_consolidated_memory.md"

/**
 * Periodically merge project auto-memory markdown into one durable file (OpenClaude auto-dream parity).
 */
export async function runAutoMemoryDreamIfDue(opts: {
  cwd: string
  config: NexusConfig
  client: LLMClient
  signal: AbortSignal
}): Promise<void> {
  const { cwd, config, client, signal } = opts
  if (config.memory?.autoDreamEnabled !== true) return

  const base = resolveAutoMemoryDirectory(cwd, config)
  if (!base) return

  const minMs = config.memory?.autoDreamMinIntervalMs ?? 3600000
  const stampPath = path.join(base, LAST_RUN_BASENAME)
  try {
    const prev = await fs.readFile(stampPath, "utf8").catch(() => "")
    const last = parseInt(prev.trim(), 10)
    if (Number.isFinite(last) && Date.now() - last < minMs) return
  } catch {
    // first run
  }

  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[])
  const mdFiles: string[] = []
  async function walk(dir: string): Promise<void> {
    const list = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[])
    for (const e of list) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && e.name.endsWith(".md") && !e.name.startsWith(".nexus_")) {
        mdFiles.push(full)
      }
    }
  }
  await walk(base)
  if (mdFiles.length < 2) return

  let combined = ""
  for (const f of mdFiles.sort()) {
    if (path.basename(f) === CONSOLIDATED_BASENAME) continue
    const t = await fs.readFile(f, "utf8").catch(() => "")
    if (t.trim()) combined += `\n\n## Source: ${path.relative(base, f)}\n\n${t.slice(0, 12_000)}`
  }
  if (combined.length < 800) return

  const systemPrompt =
    "You consolidate project memory notes into a single markdown file. Remove duplicates, merge facts, keep durable preferences and technical discoveries. Output ONLY markdown, no fences."

  let out = ""
  try {
    for await (const event of client.stream({
      messages: [
        {
          role: "user",
          content: `Merge these memory fragments into one file:\n${combined.slice(0, 45_000)}`,
        },
      ],
      systemPrompt,
      signal,
      maxTokens: 4096,
      temperature: 0.15,
    })) {
      if (event.type === "text_delta" && event.delta) out += event.delta
      if (event.type === "finish") break
      if (event.type === "error") return
    }
  } catch {
    return
  }

  const trimmed = out.trim()
  if (!trimmed) return

  await fs.mkdir(base, { recursive: true })
  await fs.writeFile(path.join(base, CONSOLIDATED_BASENAME), `${trimmed}\n`, "utf8")
  await fs.writeFile(stampPath, String(Date.now()), "utf8")
}
