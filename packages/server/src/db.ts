/**
 * SQLite persistence for NexusCode server: sessions and messages.
 * Enables session list/switch and paginated message loading to avoid OOM on long dialogs.
 */

import Database from "better-sqlite3"
import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"
import type { SessionMessage } from "@nexuscode/core"

const DEFAULT_DB_DIR = path.join(os.homedir(), ".nexus")
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "nexus-server.db")

let db: Database.Database | null = null

function getDbPath(): string {
  return process.env.NEXUS_DB_PATH || DEFAULT_DB_PATH
}

export function openDb(): Database.Database {
  if (db) return db
  const dbPath = getDbPath()
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      ts INTEGER NOT NULL,
      title TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ord INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      parent_id TEXT,
      model TEXT,
      tokens TEXT,
      cost REAL,
      summary INTEGER DEFAULT 0,
      todo TEXT,
      PRIMARY KEY (session_id, ord),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_ord ON messages(session_id, ord);
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd_ts ON sessions(cwd, ts DESC);
  `)
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

export interface SessionRow {
  id: string
  cwd: string
  ts: number
  title?: string | null
}

export interface SessionMeta {
  id: string
  cwd: string
  ts: number
  title?: string
  messageCount: number
}

export function createSession(cwd: string): SessionMeta {
  const database = openDb()
  const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  const ts = Date.now()
  database.prepare("INSERT INTO sessions (id, cwd, ts) VALUES (?, ?, ?)").run(id, cwd, ts)
  return { id, cwd, ts, messageCount: 0 }
}

export function listSessions(cwd: string): Array<{ id: string; ts: number; title?: string; messageCount: number }> {
  const database = openDb()
  const rows = database
    .prepare(
      `SELECT s.id, s.ts, s.title,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount
       FROM sessions s WHERE s.cwd = ? ORDER BY s.ts DESC`
    )
    .all(cwd) as Array<{ id: string; ts: number; title?: string | null; messageCount: number }>
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    title: r.title ?? undefined,
    messageCount: r.messageCount,
  }))
}

export function getSession(sessionId: string, cwd: string): SessionMeta | null {
  const database = openDb()
  const row = database
    .prepare("SELECT id, cwd, ts, title FROM sessions WHERE id = ? AND cwd = ?")
    .get(sessionId, cwd) as SessionRow | undefined
  if (!row) return null
  const countRow = database.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(sessionId) as { c: number }
  return {
    id: row.id,
    cwd: row.cwd,
    ts: row.ts,
    title: row.title ?? undefined,
    messageCount: countRow?.c ?? 0,
  }
}

export function deleteSession(sessionId: string, cwd: string): boolean {
  const database = openDb()
  const result = database.prepare("DELETE FROM sessions WHERE id = ? AND cwd = ?").run(sessionId, cwd)
  return result.changes > 0
}

export function updateSessionTitle(sessionId: string, cwd: string, title: string): void {
  const database = openDb()
  database.prepare("UPDATE sessions SET title = ?, ts = ? WHERE id = ? AND cwd = ?").run(title, Date.now(), sessionId, cwd)
}

export function getMessageCount(sessionId: string): number {
  const database = openDb()
  const row = database.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(sessionId) as { c: number }
  return row?.c ?? 0
}

function rowToMessage(row: {
  id: string
  ts: number
  role: string
  content: string
  parent_id?: string | null
  model?: string | null
  tokens?: string | null
  cost?: number | null
  summary?: number | null
  todo?: string | null
}): SessionMessage {
  const content = JSON.parse(row.content) as string | import("@nexuscode/core").MessagePart[]
  const msg: SessionMessage = {
    id: row.id,
    ts: row.ts,
    role: row.role as SessionMessage["role"],
    content,
  }
  if (row.parent_id != null) msg.parentId = row.parent_id
  if (row.model != null) msg.model = row.model
  if (row.tokens != null) {
    try {
      msg.tokens = JSON.parse(row.tokens) as SessionMessage["tokens"]
    } catch {}
  }
  if (row.cost != null) msg.cost = row.cost
  if (row.summary) msg.summary = true
  if (row.todo != null) msg.todo = row.todo
  return msg
}

/**
 * Get messages for a session with limit/offset (chronological order).
 * Use offset = max(0, totalCount - limit) to get the last N messages.
 */
export function getMessages(
  sessionId: string,
  limit: number = 50,
  offset: number = 0
): SessionMessage[] {
  const database = openDb()
  const rows = database
    .prepare(
      "SELECT id, ts, role, content, parent_id, model, tokens, cost, summary, todo FROM messages WHERE session_id = ? ORDER BY ord ASC LIMIT ? OFFSET ?"
    )
    .all(sessionId, limit, offset) as Array<{
      id: string
      ts: number
      role: string
      content: string
      parent_id?: string | null
      model?: string | null
      tokens?: string | null
      cost?: number | null
      summary?: number | null
      todo?: string | null
    }>
  return rows.map(rowToMessage)
}

/**
 * Get the last N messages for agent context (used when running the loop).
 */
export function getRecentMessages(sessionId: string, limit: number = 200): SessionMessage[] {
  const total = getMessageCount(sessionId)
  const offset = Math.max(0, total - limit)
  return getMessages(sessionId, limit, offset)
}

export function appendMessage(sessionId: string, msg: SessionMessage): void {
  const database = openDb()
  const countRow = database.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(sessionId) as { c: number }
  const ord = countRow?.c ?? 0
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
  database
    .prepare(
      `INSERT INTO messages (id, session_id, ord, ts, role, content, parent_id, model, tokens, cost, summary, todo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      msg.id,
      sessionId,
      ord,
      msg.ts,
      msg.role,
      content,
      msg.parentId ?? null,
      msg.model ?? null,
      msg.tokens != null ? JSON.stringify(msg.tokens) : null,
      msg.cost ?? null,
      msg.summary ? 1 : 0,
      msg.todo ?? null
    )
}

export function appendMessages(sessionId: string, messages: SessionMessage[]): void {
  if (messages.length === 0) return
  const database = openDb()
  const countRow = database.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(sessionId) as { c: number }
  let ord = countRow?.c ?? 0
  const stmt = database.prepare(
    `INSERT INTO messages (id, session_id, ord, ts, role, content, parent_id, model, tokens, cost, summary, todo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
    stmt.run(
      msg.id,
      sessionId,
      ord,
      msg.ts,
      msg.role,
      content,
      msg.parentId ?? null,
      msg.model ?? null,
      msg.tokens != null ? JSON.stringify(msg.tokens) : null,
      msg.cost ?? null,
      msg.summary ? 1 : 0,
      msg.todo ?? null
    )
    ord += 1
  }
}
