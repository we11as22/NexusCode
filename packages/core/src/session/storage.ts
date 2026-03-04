import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import type { SessionMessage, ToolPart, MessagePart } from "../types.js"

/**
 * Session storage using JSONL format (like Pi).
 * Each line is a JSON entry with { id, parentId, role, content, ts, metadata }.
 * Sessions are stored per project in ~/.nexus/sessions/{project-hash}/
 */

export function getSessionsDir(cwd: string): string {
  const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12)
  return path.join(os.homedir(), ".nexus", "sessions", hash)
}

export interface StoredSession {
  id: string
  cwd: string
  ts: number
  title?: string
  /** Global todo list for the chat (persisted with session) */
  todo?: string
  messages: SessionMessage[]
}

export async function saveSession(session: StoredSession): Promise<void> {
  const dir = getSessionsDir(session.cwd)
  await fsp.mkdir(dir, { recursive: true })

  const filePath = path.join(dir, `${session.id}.jsonl`)
  const lines = session.messages.map(m => JSON.stringify(m)).join("\n")
  const meta = JSON.stringify({
    id: session.id,
    cwd: session.cwd,
    ts: session.ts,
    title: session.title,
    todo: session.todo ?? "",
  })

  await fsp.writeFile(filePath, `${meta}\n${lines}\n`, "utf8")
}

export async function loadSession(sessionId: string, cwd: string): Promise<StoredSession | null> {
  const dir = getSessionsDir(cwd)
  const filePath = path.join(dir, `${sessionId}.jsonl`)

  if (!fs.existsSync(filePath)) return null

  const content = await fsp.readFile(filePath, "utf8")
  const lines = content.split("\n").filter(Boolean)

  if (lines.length === 0) return null

  const meta = JSON.parse(lines[0]!) as { id: string; cwd: string; ts: number; title?: string; todo?: string }
  const messages = lines.slice(1).map(l => JSON.parse(l) as SessionMessage)

  return {
    id: meta.id,
    cwd,
    ts: meta.ts,
    title: meta.title,
    todo: typeof meta.todo === "string" ? meta.todo : "",
    messages,
  }
}

export async function listSessions(cwd: string): Promise<Array<{ id: string; ts: number; title?: string; messageCount: number }>> {
  const dir = getSessionsDir(cwd)
  if (!fs.existsSync(dir)) return []

  const files = await fsp.readdir(dir).catch(() => [] as string[])
  const sessions: Array<{ id: string; ts: number; title?: string; messageCount: number }> = []

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue
    try {
      const content = await fsp.readFile(path.join(dir, file), "utf8")
      const lines = content.split("\n").filter(Boolean)
      if (lines.length === 0) continue
      const meta = JSON.parse(lines[0]!) as { id: string; ts: number; title?: string }
      sessions.push({ id: meta.id, ts: meta.ts, title: meta.title, messageCount: lines.length - 1 })
    } catch {}
  }

  return sessions.sort((a, b) => b.ts - a.ts)
}

export async function deleteSession(sessionId: string, cwd: string): Promise<boolean> {
  const dir = getSessionsDir(cwd)
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  try {
    await fsp.unlink(filePath)
    return true
  } catch {
    return false
  }
}

export function generateSessionId(): string {
  return `session_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
}
