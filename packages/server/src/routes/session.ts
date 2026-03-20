import { Hono } from "hono"
import { stream } from "hono/streaming"
import { Session, deriveSessionTitle, canonicalProjectRoot } from "@nexuscode/core"
import type { AgentEvent, Mode } from "@nexuscode/core"
import {
  createSession as fsCreateSession,
  ensureSessionOnDisk,
  listSessions as fsListSessions,
  getSession as fsGetSession,
  getMessages as fsGetMessages,
  getRecentMessages as fsGetRecentMessages,
  appendMessages as fsAppendMessages,
  deleteSession as fsDeleteSession,
  updateSessionTitle as fsUpdateSessionTitle,
} from "../session-fs-store.js"
import { runSession } from "../run-session.js"

const DEFAULT_MESSAGE_PAGE_SIZE = 50
const MAX_MESSAGE_PAGE_SIZE = 200
const RECENT_MESSAGES_FOR_RUN = 200

function getCwd(c: { req: { query: (x: string) => string | undefined; header: (x: string) => string | undefined } }): string {
  const raw = c.req.query("directory") || c.req.header("x-nexus-directory") || process.cwd()
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    decoded = raw
  }
  return canonicalProjectRoot(decoded)
}

export const sessionRoutes = new Hono()

// GET /session — list sessions (JSONL, same as CLI)
sessionRoutes.get("/", async (c) => {
  const cwd = getCwd(c)
  const sessions = await fsListSessions(cwd)
  return c.json(sessions)
})

// POST /session — create new session
sessionRoutes.post("/", async (c) => {
  const cwd = getCwd(c)
  const meta = await fsCreateSession(cwd)
  return c.json({
    id: meta.id,
    cwd: meta.cwd,
    ts: meta.ts,
    messageCount: meta.messageCount,
  })
})

// GET /session/:id — session meta
sessionRoutes.get("/:id", async (c) => {
  const cwd = getCwd(c)
  const id = c.req.param("id")
  const session = await fsGetSession(id, cwd)
  if (!session) return c.json({ error: "Session not found" }, 404)
  return c.json({
    id: session.id,
    cwd: session.cwd,
    ts: session.ts,
    messageCount: session.messageCount,
  })
})

// GET /session/:id/message — paginated messages
sessionRoutes.get("/:id/message", async (c) => {
  const cwd = getCwd(c)
  const id = c.req.param("id")
  const session = await fsGetSession(id, cwd)
  if (!session) return c.json({ error: "Session not found" }, 404)
  const limit = Math.min(
    MAX_MESSAGE_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query("limit") ?? String(DEFAULT_MESSAGE_PAGE_SIZE), 10) || DEFAULT_MESSAGE_PAGE_SIZE)
  )
  const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0)
  const messages = await fsGetMessages(id, cwd, limit, offset)
  return c.json(messages)
})

sessionRoutes.post("/:id/abort", async (c) => {
  return c.json(true)
})

sessionRoutes.delete("/:id", async (c) => {
  const cwd = getCwd(c)
  const id = c.req.param("id")
  const deleted = await fsDeleteSession(id, cwd)
  if (!deleted) return c.json({ error: "Session not found" }, 404)
  return c.json({ ok: true })
})

// POST /session/:id/message — stream agent run; persist new messages to JSONL
sessionRoutes.post("/:id/message", async (c) => {
  const cwd = getCwd(c)
  const id = c.req.param("id")
  let sessionMeta = await fsGetSession(id, cwd)
  if (!sessionMeta) {
    await ensureSessionOnDisk(id, cwd)
    sessionMeta = await fsGetSession(id, cwd)
  }
  if (!sessionMeta) return c.json({ error: "Session not found" }, 404)

  const body = (await c.req.json().catch(() => ({}))) as { content?: string; mode?: Mode }
  const content = typeof body.content === "string" ? body.content : ""
  const mode: Mode =
    body.mode === "plan" ||
    body.mode === "ask" ||
    body.mode === "debug" ||
    body.mode === "review"
      ? body.mode
      : "agent"
  if (!content.trim()) return c.json({ error: "content required" }, 400)

  const recentMessages = await fsGetRecentMessages(id, cwd, RECENT_MESSAGES_FOR_RUN)
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
        await fsAppendMessages(id, cwd, newMessages)
        if (messageCountBeforeRun === 0) {
          const title = deriveSessionTitle(session.messages)
          if (title) await fsUpdateSessionTitle(id, cwd, title)
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
