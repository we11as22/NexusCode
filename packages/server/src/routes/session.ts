import { Hono } from "hono"
import { stream } from "hono/streaming"
import { Session, deriveSessionTitle, canonicalProjectRoot, getOrchestrationRuntime } from "@nexuscode/core"
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
import {
  abortRunBySession,
  appendRunEvent,
  createActiveRun,
  finishRun,
  getActiveRun,
  getBufferedRunEvents,
  getLatestRunForSession,
  subscribeToRun,
} from "../active-runs.js"

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
  const id = c.req.param("id")
  return c.json(abortRunBySession(id))
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

  const body = (await c.req.json().catch(() => ({}))) as {
    content?: string
    mode?: Mode
    presetName?: string
    runId?: string
    afterSeq?: number
  }
  const content = typeof body.content === "string" ? body.content : ""
  const presetName = typeof body.presetName === "string" ? body.presetName.trim() : ""
  const requestedRunId = typeof body.runId === "string" ? body.runId.trim() : ""
  const afterSeq = typeof body.afterSeq === "number" && Number.isFinite(body.afterSeq) ? body.afterSeq : 0
  const mode: Mode =
    body.mode === "plan" ||
    body.mode === "ask" ||
    body.mode === "debug" ||
    body.mode === "review"
      ? body.mode
      : "agent"
  const runtime = await getOrchestrationRuntime(cwd)
  let activeRun = requestedRunId ? getActiveRun(requestedRunId) : getLatestRunForSession(id)
  const isResume = Boolean(requestedRunId)
  if (isResume && !activeRun) {
    return c.json({ error: "run not found" }, 404)
  }
  if (!activeRun) {
    if (!content.trim()) return c.json({ error: "content required" }, 400)
    const created = createActiveRun(id, cwd)
    activeRun = {
      id: created.id,
      sessionId: id,
      cwd,
      done: false,
    }
    const recentMessages = await fsGetRecentMessages(id, cwd, RECENT_MESSAGES_FOR_RUN)
    const session = new Session(id, cwd, recentMessages)
    const messageCountBeforeRun = session.messages.length
    void (async () => {
      try {
        await runSession({
          session,
          cwd,
          content,
          mode,
          configOverride: presetName ? { presetName } : undefined,
          onEvent: (event) => {
            appendRunEvent(created.id, event)
          },
          signal: created.abortController.signal,
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
        if (!msg.includes("abort")) appendRunEvent(created.id, { type: "error", error: msg })
      } finally {
        finishRun(created.id)
      }
    })()
  } else if (!isResume && !content.trim()) {
    return c.json({ error: "content required" }, 400)
  } else if (isResume && activeRun.sessionId !== id) {
    return c.json({ error: "runId does not belong to this session" }, 400)
  }

  c.header("Content-Type", "application/x-ndjson")
  c.header("Transfer-Encoding", "chunked")
  c.header("X-Accel-Buffering", "no")
  c.header("Cache-Control", "no-store")
  c.header("X-Nexus-Run-Id", activeRun.id)

  const HEARTBEAT_INTERVAL_MS = 10_000
  const existingRemote = (await runtime.listRemoteSessions({ sessionId: id, runId: activeRun.id })).find(Boolean) ?? null
  const remoteSession = existingRemote
    ? await runtime.updateRemoteSession(existingRemote.id, {
        status: isResume ? "reconnecting" : "connected",
        reconnectable: true,
        reconnectAttempts: isResume ? (existingRemote.reconnectAttempts ?? 0) + 1 : existingRemote.reconnectAttempts,
        metadata: {
          lastAfterSeq: afterSeq,
          transport: "ndjson",
          userAgent: c.req.header("user-agent") ?? null,
        },
      })
    : await runtime.createRemoteSession({
        url: c.req.url,
        sessionId: id,
        runId: activeRun.id,
        status: isResume ? "reconnecting" : "connected",
        reconnectable: true,
        metadata: {
          lastAfterSeq: afterSeq,
          transport: "ndjson",
          userAgent: c.req.header("user-agent") ?? undefined,
        },
      })
  if (remoteSession) appendRunEvent(activeRun.id, { type: "remote_session_updated", remoteSession })

  return stream(c, async (stream) => {
    const writeEnvelope = (payload: unknown) => {
      stream.write(JSON.stringify(payload) + "\n")
    }
    const writeHeartbeat = () => {
      writeEnvelope({ type: "heartbeat", ts: Date.now() })
    }
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let lastDeliveredSeq = afterSeq
    let clientAborted = false
    const clearHeartbeat = () => {
      if (heartbeatTimer != null) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
    }
    const requestAbort = new Promise<void>((resolve) => {
      c.req.raw.signal?.addEventListener?.("abort", () => {
        clientAborted = true
        clearHeartbeat()
        resolve()
      }, { once: true })
    })
    try {
      heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS)
      for (const envelope of getBufferedRunEvents(activeRun.id, afterSeq)) {
        lastDeliveredSeq = envelope.seq
        writeEnvelope(envelope)
      }
      const subscription = subscribeToRun(activeRun.id, (envelope) => {
        lastDeliveredSeq = envelope.seq
        writeEnvelope(envelope)
      })
      try {
        await Promise.race([subscription.completion, requestAbort])
      } finally {
        subscription.unsubscribe()
      }
    } finally {
      clearHeartbeat()
      const latest = getActiveRun(activeRun.id)
      if (remoteSession) {
        const nextRemote = await runtime.updateRemoteSession(remoteSession.id, {
          status: latest?.done ? "completed" : clientAborted ? "disconnected" : "connected",
          ...(lastDeliveredSeq > 0 ? { lastEventSeq: lastDeliveredSeq } : {}),
          metadata: {
            lastDisconnectAt: clientAborted ? Date.now() : null,
          },
        }).catch(() => null)
        if (nextRemote) appendRunEvent(activeRun.id, { type: "remote_session_updated", remoteSession: nextRemote })
      }
      stream.close()
    }
  })
})
