import { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { createSessionRoutes } from "./routes/session.js"
import {
  createSessionV2Routes,
  type SessionV2RuntimeProvider,
} from "./routes/session-v2.js"
import {
  authorizeBearer,
  isOriginAllowed,
  resolveWorkspaceRoot,
  type ServerEnv,
  type ServerSecurityOptions,
} from "./security.js"
import { SessionProtocolError } from "@nexuscode/core"
import {
  deleteSession as deleteSessionTranscript,
  getSession as getSessionTranscript,
} from "./session-fs-store.js"

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function requestedWorkspace(c: {
  req: {
    query: (name: string) => string | undefined
    header: (name: string) => string | undefined
  }
}): string {
  const raw = c.req.query("directory") || c.req.header("x-nexus-directory") || ""
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export interface ServerRuntimeOptions {
  readonly runtimes?: SessionV2RuntimeProvider
  /**
   * Compatibility escape hatch for old clients. Production protocol-v2
   * servers leave this disabled so one session can never be mutated by two
   * unrelated run coordinators.
   */
  readonly allowLegacyTurnProtocol?: boolean
  /** Internal storage seam used by isolated server tests. */
  readonly sessionTranscripts?: {
    get(
      sessionId: string,
      directory: string,
    ): ReturnType<typeof getSessionTranscript>
    delete(
      sessionId: string,
      directory: string,
    ): ReturnType<typeof deleteSessionTranscript>
  }
}

export function createApp(
  options: ServerSecurityOptions,
  runtimeOptions: ServerRuntimeOptions = {},
) {
  const token = options.token.trim()
  if (!token) throw new Error("Server security token cannot be empty")
  if (options.workspaceRoots.length === 0) {
    throw new Error("Server workspace root allowlist cannot be empty")
  }
  const security: ServerSecurityOptions = {
    token,
    allowedOrigins: [...new Set(options.allowedOrigins)],
    workspaceRoots: [...new Set(options.workspaceRoots)],
  }
  const app = new Hono<ServerEnv>()

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin")
    if (!isOriginAllowed(origin, security.allowedOrigins)) {
      return c.json({ error: "Origin not allowed" }, 403)
    }

    if (origin) {
      c.header("Access-Control-Allow-Origin", origin)
      c.header("Vary", "Origin")
      c.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      )
      c.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, x-nexus-directory",
      )
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204)

    c.set("security", security)
    await next()
  })

  const protectSession: MiddlewareHandler<ServerEnv> = async (c, next) => {
    if (!authorizeBearer(c.req.header("authorization"), security.token)) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    try {
      c.set(
        "workspaceRoot",
        resolveWorkspaceRoot(
          requestedWorkspace(c),
          security.workspaceRoots,
        ),
      )
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : "Workspace denied",
        },
        403,
      )
    }
    await next()
  }

  app.use("/session", protectSession)
  app.use("/session/*", protectSession)
  app.use("/v2/session", protectSession)
  app.use("/v2/session/*", protectSession)

  const allowLegacyTurnProtocol =
    runtimeOptions.allowLegacyTurnProtocol ??
    runtimeOptions.runtimes === undefined
  if (!allowLegacyTurnProtocol) {
    const rejectLegacyTurnMutation: MiddlewareHandler<ServerEnv> = async (
      c,
    ) =>
      c.json(
        {
          error:
            "Legacy turn mutation is disabled; use the authenticated protocol v2 session command endpoint",
        },
        410,
      )
    app.use("/session/:id/message", rejectLegacyTurnMutation)
    app.use("/session/:id/abort", rejectLegacyTurnMutation)
    app.use(
      "/session/:id/run/:runId/approval",
      rejectLegacyTurnMutation,
    )
  }

  app.get("/", (c) => c.json({ name: "NexusCode Server" }))
  app.get("/health", (c) => c.json({ ok: true }))
  if (runtimeOptions.runtimes) {
    app.delete("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        return c.json({ error: "Invalid session id" }, 400)
      }
      const directory = c.get("workspaceRoot")
      const transcripts = runtimeOptions.sessionTranscripts ?? {
        get: getSessionTranscript,
        delete: deleteSessionTranscript,
      }
      const transcript = await transcripts.get(sessionId, directory)
      if (!transcript) return c.json({ error: "Session not found" }, 404)

      try {
        const runtime = await runtimeOptions.runtimes!.get(directory)
        const deleteCoordinatedSession =
          runtime.services.protocol?.deleteSession
        if (!deleteCoordinatedSession) {
          return c.json(
            {
              error:
                "The workspace runtime does not support coordinated session deletion",
            },
            503,
          )
        }
        await deleteCoordinatedSession.call(
          runtime.services.protocol,
          sessionId,
        )
        // The SQLite tombstone commits first. A failed filesystem deletion is
        // safely retryable and can never race with newly admitted work.
        await transcripts.delete(sessionId, directory)
        return c.json({ ok: true })
      } catch (error) {
        if (error instanceof SessionProtocolError) {
          const code = error.protocolError.code
          if (
            code === "turn_conflict" ||
            code === "approval_conflict" ||
            code === "selection_conflict"
          ) {
            return c.json(
              { error: error.protocolError.message },
              409,
            )
          }
          if (code === "not_found") {
            return c.json({ error: "Session not found" }, 404)
          }
          if (code === "runtime_unavailable") {
            return c.json(
              { error: error.protocolError.message },
              503,
            )
          }
        }
        return c.json(
          { error: "The session could not be deleted safely" },
          500,
        )
      }
    })
  }
  app.route("/session", createSessionRoutes())
  if (runtimeOptions.runtimes) {
    app.route(
      "/v2/session",
      createSessionV2Routes({ runtimes: runtimeOptions.runtimes }),
    )
  }

  return app
}

export type App = ReturnType<typeof createApp>
