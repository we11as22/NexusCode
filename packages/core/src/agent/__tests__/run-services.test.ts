import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { McpClient } from "../../mcp/client.js"
import { taskCreateTool } from "../../tools/built-in/orchestration-tools.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type { ToolContext } from "../../types.js"
import { z } from "zod"
import {
  createNexusRunServices,
  type NexusRunServices,
} from "../run-services.js"
import type { ParallelAgentManager } from "../parallel.js"
import type { ToolContributionSnapshot } from "../../tools/custom/manager.js"

const orchestrationRuntime = vi.hoisted(() => ({
  updateTask: vi.fn(async () => null),
  getTask: vi.fn(async () => null),
}))

vi.mock("../../orchestration/runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../orchestration/runtime.js")>()
  return {
    ...actual,
    getOrchestrationRuntime: async () => orchestrationRuntime,
  }
})

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

function fakeManager(id: string) {
  return {
    spawnInBackground: vi.fn(async () => ({ subagentId: id })),
  } as unknown as ParallelAgentManager
}

async function createContext(
  services: NexusRunServices,
): Promise<ToolContext> {
  const cwd = await mkdtemp(join(tmpdir(), "nexus-run-services-"))
  temporaryDirectories.push(cwd)
  return {
    cwd,
    host: createFakeHost({ cwd }),
    session: createFakeSession(cwd),
    config: createTestConfig(),
    mode: "agent",
    signal: new AbortController().signal,
    services,
  }
}

function seedMcpClient(client: McpClient, label: string): void {
  const internals = client as unknown as {
    clients: Map<string, { callTool(input: unknown): Promise<unknown> }>
    tools: Map<
      string,
      {
        name: string
        description: string
        inputSchema: Record<string, unknown>
        serverName: string
      }
    >
  }
  internals.clients.set("shared", {
    async callTool() {
      return { content: [{ type: "text", text: label }], isError: false }
    },
  })
  internals.tools.set("shared__ping", {
    name: "shared__ping",
    description: "ping",
    inputSchema: { type: "object", properties: {} },
    serverName: "shared",
  })
}

describe("Nexus run service isolation", () => {
  it("preserves one immutable tool contribution generation for delegated agents", () => {
    const snapshot = Object.freeze({
      generation: "sha256:generation",
      fingerprint: "sha256:content",
      tools: Object.freeze([]),
      diagnostics: Object.freeze([]),
    }) satisfies ToolContributionSnapshot

    const services = createNexusRunServices({
      toolContributionSnapshot: snapshot,
    })

    expect(services.toolContributionSnapshot).toBe(snapshot)
  })

  it("preserves an explicit immutable MCP tool snapshot for delegated agents", () => {
    const mcpToolSnapshot = Object.freeze([Object.freeze({
      name: "docs__lookup",
      description: "Look up documentation",
      parameters: z.object({}),
      integration: {
        kind: "mcp" as const,
        serverName: "docs",
        originalName: "lookup",
      },
      async execute() {
        return { success: true, output: "ok" }
      },
    })])

    const services = createNexusRunServices({ mcpToolSnapshot })

    expect(services.mcpToolSnapshot).toBe(mcpToolSnapshot)
  })

  it("routes agent task creation only to the context manager", async () => {
    const managerA = fakeManager("agent-a")
    const managerB = fakeManager("agent-b")
    const contextA = await createContext(
      createNexusRunServices({
        parallelAgentManager: managerA,
        orchestrationRuntime: orchestrationRuntime as never,
      }),
    )
    const contextB = await createContext(
      createNexusRunServices({
        parallelAgentManager: managerB,
        orchestrationRuntime: orchestrationRuntime as never,
      }),
    )

    await taskCreateTool.execute(
      {
        subject: "A",
        description: "run A",
        kind: "agent",
        block: false,
      },
      contextA,
    )
    await taskCreateTool.execute(
      {
        subject: "B",
        description: "run B",
        kind: "agent",
        block: false,
      },
      contextB,
    )

    expect(managerA.spawnInBackground).toHaveBeenCalledTimes(1)
    expect(managerB.spawnInBackground).toHaveBeenCalledTimes(1)
  })

  it("binds generated MCP tools to the owning client", async () => {
    const clientA = new McpClient()
    const clientB = new McpClient()
    seedMcpClient(clientA, "from-a")
    seedMcpClient(clientB, "from-b")
    const contextA = await createContext(
      createNexusRunServices({ mcpClient: clientA }),
    )
    const contextB = await createContext(
      createNexusRunServices({ mcpClient: clientB }),
    )

    const resultA = await clientA.getTools()[0]!.execute({}, contextA)
    const resultB = await clientB.getTools()[0]!.execute({}, contextB)

    expect(resultA.output).toBe("from-a")
    expect(resultB.output).toBe("from-b")
  })
})
