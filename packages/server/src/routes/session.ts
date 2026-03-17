import { Hono } from "hono"
import { stream } from "hono/streaming"
import { Session, deriveSessionTitle } from "@nexuscode/core"
import type { AgentEvent, Mode } from "@nexuscode/core"
import {
  createSession as dbCreateSession,
  listSessions as dbListSessions,
  getSession as dbGetSession,
  getMessages as dbGetMessages,
  getRecentMessages,
  appendMessages,
  deleteSession as dbDeleteSession,
  updateSessionTitle as dbUpdateSessionTitle,
} from "../db.js"
import { runSession } from "../run-session.js"

const DEFAULT_MESSAGE_PAGE_SIZE = 50
const MAX_MESSAGE_PAGE_SIZE = 200
const RECENT_MESSAGES_FOR_RUN = 200

function getCwd(c: { req: { query: (x: string) => string | undefined; header: (x: string) => string | undefined } }): string {
  const raw = c.req.query("directory") || c.req.header("x-nexus-directory") || process.cwd()
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export const sessionRoutes = new Hono()

// GET /session — list sessions (from DB)
sessionRoutes.get("/", async (c) => {
  const cwd = getCwd(c)
  const sessions = dbListSessions(cwd)
  return c.json(sessions)
})

// POST /session — create new session (in DB)
sessionRoutes.post("/", async (c) => {
  const cwd = getCwd(c)
  const meta = dbCreateSession(cwd)
  return c.json({
    id: meta.id,
    cwd: meta.cwd,
    ts: meta.ts,
    messageCount: meta.messageCount,
  })
})

// GET /session/:id — get session meta + message count (from DB)
sessionRoutes.get("/:id", async (c) => {
  const cwd = getCwd(c)
  const id = c.req.param("id")
  const session = dbGetSession(id, cwd)
  if (!session) return c.json({ error: "Session not found" }, 404)
  return c.json({
    id: session.id,
    cwd: session.cwd,
    ts: session.ts,
    messageCount: session.messageCount,
  })
})

// GET /session/:id/message — get messages with pagination (from DB)
// Query: limit (default 50, max 200), offset (default 0)
sessionRoutes.get("/:id/message", async (c) => {
  const cwd = getCwd(c)
  const id = c.req.param("id")
  const session = dbGetSession(id, cwd)
  if (!session) return c.json({ error: "Session not found" }, 404)
  const limit = Math.min(
    MAX_MESSAGE_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query("limit") ?? String(DEFAULT_MESSAGE_PAGE_SIZE), 10) || DEFAULT_MESSAGE_PAGE_SIZE)
  )
  const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0)
  const messages = dbGetMessages(id, limit, offset)
  return c.json(messages)
})

// POST /session/:id/abort — abort current run (no-op; abort via stream close)
sessionRoutes.post("/:id/abort", async (c) => {
  return c.json(true)
})

// DELETE /session/:id — delete session and its messages
sessionRoutes.delete("/:id", async (c) => {
  const cwd = getCwd(c)
  const id = c.req.param("id")
  const deleted = dbDeleteSession(id, cwd)
  if (!deleted) return c.json({ error: "Session not found" }, 404)
  return c.json({ ok: true })
})

// POST /session/:id/message — send message, stream AgentEvents as NDJSON
// Loads last RECENT_MESSAGES_FOR_RUN messages from DB into memory, runs agent, persists only new messages to DB.
sessionRoutes.post("/:id/message", async (c) => {
  const cwd = getCwd(c)
  const id = c.req.param("id")
  const sessionMeta = dbGetSession(id, cwd)
  if (!sessionMeta) return c.json({ error: "Session not found" }, 404)
  const body = await c.req.json().catch(() => ({})) as { content?: string; mode?: Mode }
  const content = typeof body.content === "string" ? body.content : ""
  const mode: Mode =
    body.mode === "plan" ||
    body.mode === "ask" ||
    body.mode === "debug" ||
    body.mode === "review"
      ? body.mode
      : "agent"
  if (!content.trim()) return c.json({ error: "content required" }, 400)

  const recentMessages = getRecentMessages(id, RECENT_MESSAGES_FOR_RUN)
  const session = new Session(id, cwd, recentMessages)
  const messageCountBeforeRun = session.messages.length

  const abortController = new AbortController()
  c.req.raw.signal?.addEventListener?.("abort", () => abortController.abort())

  c.header("Content-Type", "application/x-ndjson")
  c.header("Transfer-Encoding", "chunked")
  c.header("X-Accel-Buffering", "no")
  c.header("Cache-Control", "no-store")

  const HEARTBEAT_INTERVAL_MS = 10_000

  return stream(c, async (stream) => {
    const write = (event: AgentEvent) => {
      stream.write(JSON.stringify(event) + "\n")
    }
    const writeHeartbeat = () => {
      stream.write(JSON.stringify({ type: "heartbeat", ts: Date.now() }) + "\n")
    }
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    const clearHeartbeat = () => {
      if (heartbeatTimer != null) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
    }
    abortController.signal.addEventListener(
      "abort",
      () => clearHeartbeat(),
      { once: true }
    )
    try {
      heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS)
      await runSession({
        session,
        cwd,
        content,
        mode,
        onEvent: write,
        signal: abortController.signal,
      })
      const newMessages = session.messages.slice(messageCountBeforeRun)
      if (newMessages.length > 0) {
        appendMessages(id, newMessages)
        if (messageCountBeforeRun === 0) {
          const title = deriveSessionTitle(session.messages)
          if (title) dbUpdateSessionTitle(id, cwd, title)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("abort")) write({ type: "error", error: msg })
    } finally {
      clearHeartbeat()
      stream.close()
    }
  })
})
