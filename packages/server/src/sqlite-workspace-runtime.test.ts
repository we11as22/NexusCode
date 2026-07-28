import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  McpClient,
  PROTOCOL_VERSION,
  type NexusRunServices,
  type TurnRunner,
} from "@nexuscode/core"
import { NexusStateDatabase } from "@nexuscode/state"

import {
  createSqliteWorkspaceRuntimeFactory,
  resolveWorkspaceStatePath,
} from "./sqlite-workspace-runtime.js"
import { ServerHost } from "./host.js"

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("SQLite workspace runtime factory", () => {
  it("owns one database/protocol lifecycle and leaves a reopenable state file", async () => {
    const workspace = temporaryDirectory("nexus-runtime-workspace-")
    const stateRoot = temporaryDirectory("nexus-runtime-state-")
    const run = vi.fn(async () => ({ status: "completed" as const }))
    const runner: TurnRunner = { run }
    const factory = createSqliteWorkspaceRuntimeFactory({
      stateRoot,
      ownerId: "server-factory",
      runnerFactory: () => runner,
      epochs: {
        capture: () => ({ configEpoch: 1, contextEpoch: 1 }),
      },
    })

    const runtime = await factory.create(workspace)
    const protocol = runtime.services.protocol
    expect(protocol).toBeDefined()
    const receipt = await protocol!.dispatch({
      version: PROTOCOL_VERSION,
      type: "start_turn",
      commandId: "factory-command",
      sessionId: "factory-session",
      inputId: "factory-input",
      input: [{ type: "text", text: "safe fake run" }],
      mode: "agent",
    })
    expect(receipt).toMatchObject({
      type: "start_turn",
      inputId: "factory-input",
      started: true,
    })
    expect(run).toHaveBeenCalledOnce()

    await runtime.close()
    expect(runtime.closed).toBe(true)
    const reopened = NexusStateDatabase.open({
      path: resolveWorkspaceStatePath(workspace, stateRoot),
    })
    try {
      expect(reopened.integrityCheck()).toEqual({ ok: true })
    } finally {
      reopened.close()
    }
  })

  it("creates one workspace-owned agent service set and shuts it down with the runtime", async () => {
    const workspace = temporaryDirectory("nexus-runtime-services-workspace-")
    const stateRoot = temporaryDirectory("nexus-runtime-services-state-")
    let servicesFromFactory: NexusRunServices | undefined
    const factory = createSqliteWorkspaceRuntimeFactory({
      stateRoot,
      runnerFactory: (context) => {
        servicesFromFactory = context.services
        return {
          run: async () => ({ status: "completed" }),
        }
      },
    })

    const runtime = await factory.create(workspace)
    expect(servicesFromFactory).toBeDefined()
    expect(runtime.services.parallelAgents).toBe(
      servicesFromFactory?.parallelAgentManager,
    )
    expect(runtime.services.backgroundProcesses).toBe(
      servicesFromFactory?.backgroundProcesses,
    )
    expect(runtime.services.workspaceTasks).toBe(
      servicesFromFactory?.workspaceTasks,
    )
    expect(servicesFromFactory?.mcpClient).toBeDefined()
    expect(runtime.services.mcp).toBe(servicesFromFactory?.mcpClient)
    expect(runtime.services.agentRuns).toBe(servicesFromFactory)
    expect(servicesFromFactory?.changeSets?.workspaceId).toMatch(
      /^[a-f0-9]{64}$/u,
    )
    expect(servicesFromFactory?.changeSets?.store).toBeDefined()
    expect(servicesFromFactory?.git).toBeDefined()

    await runtime.close()
    expect(runtime.closed).toBe(true)
    await expect(
      servicesFromFactory?.parallelAgentManager.spawnInBackground(
        "must not start",
        "agent",
        {} as never,
        workspace,
        new AbortController().signal,
        1,
      ),
    ).rejects.toThrow(/shutting down/i)
  })

  it("binds its workspace-owned remote MCP client to the server host network policy", async () => {
    const workspace = temporaryDirectory("nexus-runtime-mcp-workspace-")
    const stateRoot = temporaryDirectory("nexus-runtime-mcp-state-")
    const authorize = vi.spyOn(
      ServerHost.prototype,
      "authorizeNetworkRequest",
    ).mockRejectedValue(new Error("blocked by the fake host policy"))
    const factory = createSqliteWorkspaceRuntimeFactory({
      stateRoot,
      ownerId: "server-mcp-policy",
    })
    const runtime = await factory.create(workspace)
    try {
      const mcp = runtime.services.mcp as McpClient
      const statuses = await mcp.ensureConnected([{
        name: "remote-test",
        url: "https://mcp.invalid/rpc",
        startupTimeoutMs: 100,
      }])

      expect(statuses["remote-test"]).toMatchObject({
        state: "failed",
        error: expect.stringContaining("blocked by the fake host policy"),
      })
      expect(authorize).toHaveBeenCalledWith({
        url: "https://mcp.invalid/rpc",
        purpose: "mcp",
      })
    } finally {
      await runtime.close()
    }
  })

  it("derives distinct bounded state paths from canonical workspace identity", () => {
    const stateRoot = temporaryDirectory("nexus-runtime-paths-")
    const first = temporaryDirectory("nexus-runtime-first-")
    const second = temporaryDirectory("nexus-runtime-second-")

    expect(resolveWorkspaceStatePath(first, stateRoot)).not.toBe(
      resolveWorkspaceStatePath(second, stateRoot),
    )
    expect(resolveWorkspaceStatePath(first, stateRoot)).toMatch(
      /state\.sqlite$/,
    )
  })
})
