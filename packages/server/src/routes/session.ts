import { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { stream } from "hono/streaming"
import { Session, deriveSessionTitle, getOrchestrationRuntime } from "@nexuscode/core"
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
  claimRunExecution,
  createActiveRun,
  finishRun,
  getActiveRun,
  getOrRestoreRun,
  getLatestRunForSession,
  replayAndSubscribeToRun,
  resolveRunApproval,
  waitForRunApproval,
} from "../active-runs.js"
import type { ServerEnv } from "../security.js"

const DEFAULT_MESSAGE_PAGE_SIZE = 50
const MAX_MESSAGE_PAGE_SIZE = 200
const RECENT_MESSAGES_FOR_RUN = 200
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function getCwd(c: { get: (key: "workspaceRoot") => string }): string {
  return c.get("workspaceRoot")
}

const sessionRoutes = new Hono<ServerEnv>()

const validateSessionId: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (!SESSION_ID_PATTERN.test(c.req.param("id") ?? "")) {
    return c.json({ error: "Invalid session id" }, 400)
  }
  await next()
}
sessionRoutes.use("/:id", validateSessionId)
sessionRoutes.use("/:id/*", validateSessionId)

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
    revision: meta.revision,
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
    revision: session.revision,
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
  return c.json({ ok: abortRunBySession(id) })
})

sessionRoutes.post("/:id/run/:runId/approval", async (c) => {
  const sessionId = c.req.param("id")
  const runId = c.req.param("runId")
  if (!SESSION_ID_PATTERN.test(runId)) {
    return c.json({ error: "Invalid run id" }, 400)
  }
  const run = getActiveRun(runId)
  if (!run || run.sessionId !== sessionId || run.done) {
    return c.json({ error: "Active run not found" }, 404)
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const partId = typeof body.partId === "string" ? body.partId.trim() : ""
  if (!SESSION_ID_PATTERN.test(partId) || typeof body.approved !== "boolean") {
    return c.json({ error: "partId and approved are required" }, 400)
  }
  const optionalBoolean = (key: string) =>
    typeof body[key] === "boolean" ? body[key] as boolean : undefined
  const optionalText = (key: string) => {
    const value = typeof body[key] === "string" ? body[key].trim() : ""
    return value ? value.slice(0, 20_000) : undefined
  }
  const resolved = resolveRunApproval(runId, partId, {
    approved: body.approved,
    alwaysApprove: optionalBoolean("alwaysApprove"),
    skipAll: optionalBoolean("skipAll"),
    whatToDoInstead: optionalText("whatToDoInstead"),
    addToAllowedCommand: optionalText("addToAllowedCommand"),
    addToAllowedPattern: optionalText("addToAllowedPattern"),
    addToAllowedMcpTool: optionalText("addToAllowedMcpTool"),
  })
  if (!resolved) return c.json({ error: "Pending approval not found" }, 404)
  return c.json({ ok: true })
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
  const body = (await c.req.json().catch(() => ({}))) as {
    content?: string
    mode?: Mode
    presetName?: string
    runId?: string
    clientRunId?: string
    afterSeq?: number
  }
  const content = typeof body.content === "string" ? body.content : ""
  const presetName = typeof body.presetName === "string" ? body.presetName.trim() : ""
  const requestedRunId = typeof body.runId === "string" ? body.runId.trim() : ""
  const clientRunId = typeof body.clientRunId === "string" ? body.clientRunId.trim() : ""
  if (
    (requestedRunId && !SESSION_ID_PATTERN.test(requestedRunId)) ||
    (clientRunId && !SESSION_ID_PATTERN.test(clientRunId))
  ) {
    return c.json({ error: "Invalid run id" }, 400)
  }
  const afterSeq = typeof body.afterSeq === "number" && Number.isSafeInteger(body.afterSeq)
    ? Math.max(0, body.afterSeq)
    : 0
  const mode: Mode =
    body.mode === "plan" ||
    body.mode === "ask" ||
    body.mode === "debug" ||
    body.mode === "review"
      ? body.mode
      : "agent"
  let sessionMeta = await fsGetSession(id, cwd)
  if (!sessionMeta) {
    await ensureSessionOnDisk(id, cwd)
    sessionMeta = await fsGetSession(id, cwd)
  }
  if (!sessionMeta) return c.json({ error: "Session not found" }, 404)

  const runtime = await getOrchestrationRuntime(cwd)
  let activeRun = requestedRunId
    ? await getOrRestoreRun(requestedRunId, cwd)
    : clientRunId
      ? getActiveRun(clientRunId) ?? await getOrRestoreRun(clientRunId, cwd)
      : getLatestRunForSession(id)
  const isResume = Boolean(requestedRunId || (clientRunId && activeRun))
  if (isResume && !activeRun) {
    return c.json({ error: "run not found" }, 404)
  }
  if (isResume && activeRun?.sessionId !== id) {
    return c.json({ error: "runId does not belong to this session" }, 400)
  }
  if (!isResume) {
    if (!content.trim()) return c.json({ error: "content required" }, 400)
    if (activeRun && !activeRun.done) {
      return c.json({
        error: "session already has an active run; reconnect with its runId",
        runId: activeRun.id,
      }, 409)
    }
    // A completed run remains replayable for its TTL but must never swallow a
    // new user turn. Every new message gets a fresh durable run.
    activeRun = null
  }
  if (!activeRun) {
    const created = await createActiveRun(id, cwd, mode, {
      ...(clientRunId ? { runId: clientRunId } : {}),
    })
    activeRun = {
      id: created.id,
      sessionId: id,
      cwd,
      done: false,
    }
    if (claimRunExecution(created.id)) {
      let session: Session
      let messageCountBeforeRun: number
      try {
        const recentMessages = await fsGetRecentMessages(id, cwd, RECENT_MESSAGES_FOR_RUN)
        // This is a bounded working copy, not the authoritative full transcript.
        // Keep it ephemeral so loop-level saves cannot truncate messages outside
        // the window. Admit the user turn durably before any provider/tool side
        // effect; only the assistant delta is committed at run completion.
        session = new Session(id, cwd, recentMessages, undefined, true)
        const admitted = session.addMessage({
          role: "user",
          content,
          presetName: presetName || "Default",
        })
        await fsAppendMessages(id, cwd, [admitted])
        messageCountBeforeRun = session.messages.length
        if (sessionMeta.messageCount === 0) {
          const title = deriveSessionTitle(session.messages)
          if (title) await fsUpdateSessionTitle(id, cwd, title)
        }
      } catch (error) {
        appendRunEvent(created.id, {
          type: "error",
          error: `Failed to admit user message: ${
            error instanceof Error ? error.message : String(error)
          }`,
        })
        await finishRun(created.id, "failed")
        throw error
      }
      void (async () => {
        let terminalStatus: "completed" | "failed" | "aborted" = "completed"
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
            requestApproval: (action) =>
              waitForRunApproval(created.id, action, created.abortController.signal),
            userMessageAdmitted: true,
          })
          const newMessages = session.messages.slice(messageCountBeforeRun)
          if (newMessages.length > 0) {
            await fsAppendMessages(id, cwd, newMessages)
          }
        } catch (err) {
          terminalStatus = created.abortController.signal.aborted ? "aborted" : "failed"
          const msg = err instanceof Error ? err.message : String(err)
          if (!msg.includes("abort")) appendRunEvent(created.id, { type: "error", error: msg })
        } finally {
          await finishRun(
            created.id,
            created.abortController.signal.aborted ? "aborted" : terminalStatus,
          ).catch((error) => {
            console.error(`[nexus] Failed to finalize run ${created.id}:`, error)
          })
        }
      })()
    }
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
      const subscription = await replayAndSubscribeToRun(activeRun.id, afterSeq, (envelope) => {
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

export function createSessionRoutes() {
  return sessionRoutes
}
