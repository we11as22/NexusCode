import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { LLMClient } from "../provider/types.js"
import type { ISession, MessagePart, NexusConfig, SessionMessage, TextPart, ToolPart } from "../types.js"
import { getSessionsDir, canonicalProjectRoot } from "./storage.js"

export function getSessionMemoryFilePath(sessionId: string, cwd: string): string {
  const dir = getSessionsDir(canonicalProjectRoot(cwd))
  return path.join(dir, `${sessionId}.session-memory.md`)
}

export async function readSessionMemoryFile(sessionId: string, cwd: string): Promise<string> {
  try {
    const text = await fs.readFile(getSessionMemoryFilePath(sessionId, cwd), "utf8")
    return text.trim()
  } catch {
    return ""
  }
}

function messageSnippet(m: SessionMessage): string {
  if (typeof m.content === "string") return `${m.role}: ${m.content.slice(0, 4000)}`
  const parts = m.content as MessagePart[]
  const lines: string[] = []
  for (const p of parts) {
    if (p.type === "text") lines.push((p as TextPart).text ?? "")
    if (p.type === "tool") {
      const t = p as ToolPart
      lines.push(`[tool ${t.tool} ${t.status}] ${(t.output ?? "").slice(0, 2000)}`)
    }
  }
  return `${m.role}: ${lines.join("\n").slice(0, 6000)}`
}

function buildTailForMemory(messages: SessionMessage[], maxMessages: number): string {
  const relevant = messages.filter((m) => !m.summary && (m.role === "user" || m.role === "assistant"))
  const slice = relevant.slice(-maxMessages)
  return slice.map(messageSnippet).join("\n\n---\n\n")
}

/**
 * Background refresh: merge conversation tail into the session memory file (OpenClaude Session Memory parity).
 */
export async function refreshSessionMemoryFile(opts: {
  session: ISession
  client: LLMClient
  cwd: string
  config: NexusConfig
  signal: AbortSignal
}): Promise<void> {
  const { session, client, cwd, config, signal } = opts
  if (config.memory?.sessionMemoryEnabled === false) return

  const maxChars = config.memory?.sessionMemoryMaxChars ?? 48_000
  const filePath = getSessionMemoryFilePath(session.id, cwd)
  await fs.mkdir(path.dirname(filePath), { recursive: true })

  let previous = ""
  try {
    previous = await fs.readFile(filePath, "utf8")
  } catch {
    previous = ""
  }

  const tail = buildTailForMemory(session.messages, 14)
  if (!tail.trim()) return

  const systemPrompt =
    "You maintain SESSION_MEMORY.md for a coding agent. Merge durable notes: goals, decisions, file paths, errors, preferences. " +
    "Update the previous file with new facts from the tail; drop stale items. Output ONLY valid markdown (no code fences). " +
    "Use concise bullets and ## sections."

  const userContent =
    `PREVIOUS_FILE:\n${previous.slice(0, maxChars)}\n\n---\n\nNEW_CONVERSATION_TAIL:\n${tail.slice(0, 24_000)}`

  let out = ""
  try {
    for await (const event of client.stream({
      messages: [{ role: "user", content: userContent }],
      systemPrompt,
      signal,
      maxTokens: 4096,
      temperature: 0.2,
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
  const capped = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n\n[truncated]\n` : trimmed
  await fs.writeFile(filePath, capped, "utf8").catch(() => {})
}

export async function appendCompactionSnippetToSessionMemory(
  sessionId: string,
  cwd: string,
  summaryText: string,
  maxChars: number,
): Promise<void> {
  const filePath = getSessionMemoryFilePath(sessionId, cwd)
  let prev = ""
  try {
    prev = await fs.readFile(filePath, "utf8")
  } catch {
    prev = ""
  }
  const stamp = new Date().toISOString()
  const block = `\n\n## Compaction snapshot (${stamp})\n\n${summaryText.trim().slice(0, 12_000)}\n`
  const next = (prev + block).slice(-maxChars)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, next, "utf8").catch(() => {})
}
