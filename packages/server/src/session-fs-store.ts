/**
 * Session persistence for the HTTP server: same JSONL layout as CLI / extension
 * (~/.nexus/sessions/{hash}/*.jsonl via @nexuscode/core).
 *
 * Replaces the legacy SQLite session store so server, CLI, and VS Code share one source of truth.
 */

import type { SessionMessage } from "@nexuscode/core"
import {
  canonicalProjectRoot,
  listSessions as coreListSessions,
  loadSession,
  saveSession,
  loadSessionMessages,
  deleteSession as coreDeleteSession,
  getSessionMeta,
  generateSessionId,
  type StoredSession,
} from "@nexuscode/core"

export interface SessionMeta {
  id: string
  cwd: string
  ts: number
  title?: string
  messageCount: number
}

export async function createSession(cwd: string): Promise<SessionMeta> {
  const root = canonicalProjectRoot(cwd)
  const id = generateSessionId()
  const ts = Date.now()
  const stored: StoredSession = {
    id,
    cwd: root,
    ts,
    title: undefined,
    todo: "",
    messages: [],
  }
  await saveSession(stored)
  return { id, cwd: root, ts, messageCount: 0 }
}

/** Create an on-disk session with a client-chosen id (CLI / extension Session id). */
export async function ensureSessionOnDisk(sessionId: string, cwd: string): Promise<SessionMeta> {
  const root = canonicalProjectRoot(cwd)
  const existing = await getSessionMeta(sessionId, root)
  if (existing) {
    return {
      id: existing.id,
      cwd: existing.cwd,
      ts: existing.ts,
      title: existing.title,
      messageCount: existing.messageCount,
    }
  }
  const ts = Date.now()
  await saveSession({
    id: sessionId,
    cwd: root,
    ts,
    title: undefined,
    todo: "",
    messages: [],
  })
  return { id: sessionId, cwd: root, ts, messageCount: 0 }
}

export async function listSessions(
  cwd: string
): Promise<Array<{ id: string; ts: number; title?: string; messageCount: number }>> {
  return coreListSessions(cwd)
}

export async function getSession(sessionId: string, cwd: string): Promise<SessionMeta | null> {
  const meta = await getSessionMeta(sessionId, cwd)
  if (!meta) return null
  return {
    id: meta.id,
    cwd: meta.cwd,
    ts: meta.ts,
    title: meta.title,
    messageCount: meta.messageCount,
  }
}

export async function deleteSession(sessionId: string, cwd: string): Promise<boolean> {
  return coreDeleteSession(sessionId, cwd)
}

export async function updateSessionTitle(sessionId: string, cwd: string, title: string): Promise<void> {
  const root = canonicalProjectRoot(cwd)
  const stored = await loadSession(sessionId, root)
  if (!stored) return
  stored.title = title
  stored.ts = Date.now()
  await saveSession(stored)
}

export async function getMessages(
  sessionId: string,
  cwd: string,
  limit: number = 50,
  offset: number = 0
): Promise<SessionMessage[]> {
  const loaded = await loadSessionMessages(sessionId, cwd, limit, offset)
  return loaded?.messages ?? []
}

export async function getRecentMessages(
  sessionId: string,
  cwd: string,
  limit: number = 200
): Promise<SessionMessage[]> {
  const meta = await getSessionMeta(sessionId, cwd)
  if (!meta) return []
  const total = meta.messageCount
  const offset = Math.max(0, total - limit)
  return getMessages(sessionId, cwd, limit, offset)
}

export async function appendMessages(
  sessionId: string,
  cwd: string,
  messages: SessionMessage[]
): Promise<void> {
  if (messages.length === 0) return
  const root = canonicalProjectRoot(cwd)
  const stored = await loadSession(sessionId, root)
  if (!stored) throw new Error(`Session not found: ${sessionId}`)
  stored.messages = [...stored.messages, ...messages]
  stored.ts = Date.now()
  await saveSession(stored)
}
