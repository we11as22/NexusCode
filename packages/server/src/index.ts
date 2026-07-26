import { createApp } from "./app.js"
import { serve } from "@hono/node-server"
import {
  isLoopbackHost,
  readServerSecurityOptions,
  type ServerSecurityOptions,
} from "./security.js"

const port = Number(process.env.NEXUS_SERVER_PORT || process.env.PORT || "4097")
const hostname = process.env.NEXUS_SERVER_HOST || "127.0.0.1"

export async function listen(opts?: {
  port?: number
  hostname?: string
  security?: ServerSecurityOptions
}) {
  const p = opts?.port ?? port
  const h = opts?.hostname ?? hostname
  const security = opts?.security ?? readServerSecurityOptions()
  if (!isLoopbackHost(h) && security.allowedOrigins.length === 0) {
    throw new Error(
      "Binding NexusCode server to a non-loopback host requires NEXUS_SERVER_ORIGINS",
    )
  }
  const app = createApp(security)
  return new Promise<{ stop: () => void }>((resolve, reject) => {
    const server = serve(
      {
        port: p,
        hostname: h,
        fetch: app.fetch,
      },
      (info) => {
        console.error(`NexusCode server listening on http://${info.address}:${info.port}`)
        resolve({
          stop: () => server.close(),
        })
      }
    )
    server.on("error", reject)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  listen().catch((err: NodeJS.ErrnoException) => {
    if (err?.code === "EADDRINUSE") {
      const p = process.env.NEXUS_SERVER_PORT || process.env.PORT || "4097"
      console.error(
        `Port ${p} is already in use. Stop the other process (e.g. \`lsof -i :${p}\` then \`kill <pid>\`) or use another port: NEXUS_SERVER_PORT=4098 pnpm run serve`
      )
    } else {
      console.error(err)
    }
    process.exit(1)
  })
}
