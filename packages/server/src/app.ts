import { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { createSessionRoutes } from "./routes/session.js"
import {
  authorizeBearer,
  isOriginAllowed,
  resolveWorkspaceRoot,
  type ServerEnv,
  type ServerSecurityOptions,
} from "./security.js"

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

export function createApp(options: ServerSecurityOptions) {
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

  app.get("/", (c) => c.json({ name: "NexusCode Server" }))
  app.get("/health", (c) => c.json({ ok: true }))
  app.route("/session", createSessionRoutes())

  return app
}

export type App = ReturnType<typeof createApp>
