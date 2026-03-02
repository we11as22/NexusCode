import { Hono } from "hono"
import { cors } from "hono/cors"
import { sessionRoutes } from "./routes/session.js"

const app = new Hono()

app.use("*", cors({
  origin: (origin) => origin || "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "x-nexus-directory"],
}))

app.get("/", (c) => c.json({ name: "NexusCode Server", version: "0.1.0" }))
app.route("/session", sessionRoutes)

export function createApp() {
  return app
}

export type App = ReturnType<typeof createApp>
