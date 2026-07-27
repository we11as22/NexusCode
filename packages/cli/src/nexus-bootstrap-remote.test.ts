import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  McpClient,
  NexusConfigSchema,
  type NexusConfig,
} from "@nexuscode/core"
import {
  applyCliModelSelection,
  bootstrapNexus,
} from "./nexus-bootstrap.js"

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
      serverUrl: "https://nexus.test",
    })

    expect(nexus.session.id).toBe("remote-latest")
    expect(nexus.session.messages).toEqual([message])
    expect(nexus.serverUrl).toBe("https://nexus.test")
    expect(fetchMock).toHaveBeenCalled()
    await nexus.close()
  })

  it("selects the remote dependency graph before local MCP initialization", async () => {
    cwd = await mkdtemp(join(tmpdir(), "nexus-cli-remote-no-local-"))
    vi.stubEnv("NEXUS_SERVER_TOKEN", "test-token")
    await mkdir(join(cwd, ".nexus"), { recursive: true })
    await writeFile(join(cwd, ".nexus", "nexus.yaml"), [
      "mcp:",
      "  servers:",
      "    - name: must-not-start",
      "      command: node",
      "      args: ['never-run.js']",
    ].join("\n"))
    const connectAll = vi
      .spyOn(McpClient.prototype, "connectAll")
      .mockResolvedValue({})
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input))
      if (url.pathname === "/session") {
        return url.searchParams.has("directory")
          ? Response.json([])
          : Response.json({
              id: "remote-created",
              ts: Date.now(),
              messageCount: 0,
              revision: 0,
            })
      }
      return new Response("not found", { status: 404 })
    }))

    const nexus = await bootstrapNexus({
      cwd,
      indexEnabled: true,
      serverUrl: "https://nexus.test",
    })

    expect(connectAll).not.toHaveBeenCalled()
    expect(nexus.indexer).toBeUndefined()
    await nexus.close()
  })

  it("closes workspace-owned live services exactly once", async () => {
    cwd = await mkdtemp(join(tmpdir(), "nexus-cli-remote-close-"))
    vi.stubEnv("NEXUS_SERVER_TOKEN", "test-token")
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input))
      if (url.pathname === "/session") {
        return url.searchParams.has("directory")
          ? Response.json([])
          : Response.json({
              id: "remote-close",
              ts: Date.now(),
              messageCount: 0,
              revision: 0,
            })
      }
      return new Response("not found", { status: 404 })
    }))

    const nexus = await bootstrapNexus({
      cwd,
      indexEnabled: false,
      serverUrl: "https://nexus.test",
    })
    const shutdown = vi.spyOn(
      nexus.services.parallelAgentManager,
      "shutdown",
    )
    const disconnect = vi.spyOn(nexus.mcpClient, "disconnectAll")
    const closeBackground = vi.spyOn(
      nexus.services.backgroundProcesses,
      "close",
    )
    const closeWorkspaceTasks = vi.spyOn(
      nexus.services.workspaceTasks,
      "close",
    )

    await Promise.all([nexus.close(), nexus.close()])

    expect(shutdown).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(closeBackground).toHaveBeenCalledOnce()
    expect(closeWorkspaceTasks).toHaveBeenCalledOnce()
  })

  it.each([
    { modelOverride: "openai/gpt-4.1" },
    { profileOverride: "work" },
    { temperatureOverride: 0.2 },
    { reasoningEffortOverride: "high" },
  ])("fails closed when protocol v1 cannot carry a local selection override: %o", async (override) => {
    cwd = await mkdtemp(join(tmpdir(), "nexus-cli-remote-overrides-"))

    await expect(bootstrapNexus({
      cwd,
      indexEnabled: false,
      serverUrl: "https://nexus.test",
      ...override,
    })).rejects.toThrow(/Remote protocol v2/)
  })
})

describe("CLI effective model selection", () => {
  it("applies provider, model, temperature and reasoning as one safe selection", () => {
    const config = NexusConfigSchema.parse({
      model: {
        provider: "openai-compatible",
        id: "old",
        baseUrl: "https://api.kilo.ai/api/openrouter",
        apiKey: "kilo-secret",
      },
    }) as NexusConfig

    applyCliModelSelection(config, {
      modelOverride: "groq/llama",
      temperatureOverride: 0.25,
      reasoningEffortOverride: "high",
    })

    expect(config.model).toEqual({
      provider: "groq",
      id: "llama",
      temperature: 0.25,
      reasoningEffort: "high",
      reasoningHistoryMode: "auto",
    })
  })

  it("keeps the current credential scope for a model-id-only override", () => {
    const config = NexusConfigSchema.parse({
      model: {
        provider: "openai",
        id: "old",
        apiKey: "same-scope",
      },
    }) as NexusConfig

    applyCliModelSelection(config, { modelOverride: "new-model" })

    expect(config.model.apiKey).toBe("same-scope")
  })
})
