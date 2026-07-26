import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { bootstrapNexus } from "./nexus-bootstrap.js"

describe("remote CLI bootstrap", () => {
  let cwd: string | undefined

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    if (cwd) await rm(cwd, { recursive: true, force: true })
  })

  it("continues the newest server session instead of a local session", async () => {
    cwd = await mkdtemp(join(tmpdir(), "nexus-cli-remote-"))
    vi.stubEnv("NEXUS_SERVER_TOKEN", "test-token")
    const message = {
      id: "message-1",
      role: "user",
      content: "remote history",
      ts: Date.now(),
    }
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input))
      if (url.pathname === "/session" && url.searchParams.has("directory")) {
        return Response.json([{
          id: "remote-latest",
          ts: Date.now(),
          messageCount: 1,
          revision: 1,
        }])
      }
      if (url.pathname === "/session/remote-latest") {
        return Response.json({
          id: "remote-latest",
          cwd,
          ts: Date.now(),
          messageCount: 1,
          revision: 1,
        })
      }
      if (url.pathname === "/session/remote-latest/message") {
        return Response.json([message])
      }
      return new Response("not found", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const nexus = await bootstrapNexus({
      cwd,
      continue: true,
      indexEnabled: false,
      serverUrl: "http://nexus.test",
    })

    expect(nexus.session.id).toBe("remote-latest")
    expect(nexus.session.messages).toEqual([message])
    expect(nexus.serverUrl).toBe("http://nexus.test")
    expect(fetchMock).toHaveBeenCalled()
    await nexus.mcpClient.disconnectAll()
  })
})
