import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createNexusRunServices,
  hashWorkspaceIdentity,
  type SessionMessage,
} from "@nexuscode/core"

import type { RunSessionOptions } from "./run-session.js"
import {
  NexusStateDatabase,
  RuntimeRepository,
  SessionRuntimeRepository,
} from "@nexuscode/state"

import {
  ServerTurnRunner,
  type ServerTurnSessionStore,
} from "./server-turn-runner.js"
import { SessionApprovalBroker } from "./session-approval-broker.js"

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function createMemorySessionStore(
  sessionIds: readonly string[],
): {
  store: ServerTurnSessionStore
  messages(sessionId: string): SessionMessage[]
} {
  const records = new Map(
    sessionIds.map((sessionId) => [
      sessionId,
      {
        messages: [] as SessionMessage[],
        revision: 0,
        title: undefined as string | undefined,
        todo: undefined as string | undefined,
      },
    ]),
  )
  const record = (sessionId: string) => {
    const existing = records.get(sessionId)
    if (existing) return existing
    const created = {
      messages: [] as SessionMessage[],
      revision: 0,
      title: undefined as string | undefined,
      todo: undefined as string | undefined,
    }
    records.set(sessionId, created)
    return created
  }
  return {
    store: {
      ensure: async (sessionId) => {
        const current = record(sessionId)
        return {
          messageCount: current.messages.length,
          revision: current.revision,
        }
      },
      load: async (sessionId) => {
        const current = record(sessionId)
        return {
          messages: structuredClone(current.messages),
          revision: current.revision,
          ...(current.title ? { title: current.title } : {}),
          ...(current.todo ? { todo: current.todo } : {}),
        }
      },
      checkpoint: async (
        sessionId,
        _cwd,
        snapshot,
        expectedRevision,
      ) => {
        const current = record(sessionId)
        if (current.revision !== expectedRevision) {
          throw new Error(
            `revision conflict: expected ${expectedRevision}, actual ${current.revision}`,
          )
        }
        current.messages.splice(
          0,
          current.messages.length,
          ...structuredClone(snapshot.messages),
        )
        current.title = snapshot.title
        current.todo = snapshot.todo
        current.revision += 1
        return current.revision
      },
    },
    messages: (sessionId) => record(sessionId).messages,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("ServerTurnRunner", () => {
  it("passes the workspace-owned run services through every turn", async () => {
    const workspace = temporaryDirectory("nexus-turn-services-workspace-")
    const database = NexusStateDatabase.open({
      path: join(
        temporaryDirectory("nexus-turn-services-state-"),
        "state.sqlite",
      ),
    })
    const state = new SessionRuntimeRepository(database)
    const leases = new RuntimeRepository(database)
    const approvals = new SessionApprovalBroker()
    const services = createNexusRunServices()
    state.ensureWorkspaceSession({
      workspaceId: "workspace-services",
      canonicalPath: workspace,
      sessionId: "session-services",
    })
    const lease = leases.claimSession({
      sessionId: "session-services",
      ownerId: "server-services",
      ttlMs: 60_000,
    })
    const fence = { ownerId: lease.ownerId, leaseEpoch: lease.epoch }
    state.prepareCommand({
      command: {
        version: 2,
        type: "start_turn",
        commandId: "command-services",
        sessionId: "session-services",
        inputId: "input-services",
        input: [{ type: "text", text: "keep services alive" }],
        mode: "agent",
      },
      fence,
    })
    const turn = state.claimNextTurn({
      sessionId: "session-services",
      epochs: { configEpoch: 1, contextEpoch: 1 },
      fence,
    })!
    const execute = vi.fn(async (options: RunSessionOptions) => {
      expect(options.services).toBe(services)
      expect(options.executionIdentity).toEqual({
        workspaceId: hashWorkspaceIdentity(workspace),
        sessionId: "session-services",
        turnId: turn.turnId,
        runId: turn.runId,
      })
    })
    const sessionStore = createMemorySessionStore(["session-services"])
    const runner = new ServerTurnRunner({
      canonicalDirectory: workspace,
      state,
      approvals,
      services,
      execute,
      sessions: sessionStore.store,
    })

    try {
      await expect(
        runner.run({
          sessionId: "session-services",
          turnId: turn.turnId,
          runId: turn.runId,
          input: turn.input,
          epochs: turn.epochs,
          execution: turn.execution,
          fence: turn.fence,
          signal: new AbortController().signal,
          setPhase: async () => undefined,
          safeBoundary: async () => [],
        }),
      ).resolves.toEqual({ status: "completed" })
      expect(execute).toHaveBeenCalledOnce()
    } finally {
      await services.parallelAgentManager.shutdown()
      services.backgroundProcesses.close()
      approvals.close()
      database.close()
    }
  })

  it("gives EnterPlanMode a fenced durable next-turn authority", async () => {
    const workspace = temporaryDirectory("nexus-turn-mode-workspace-")
    const database = NexusStateDatabase.open({
      path: join(
        temporaryDirectory("nexus-turn-mode-state-"),
        "state.sqlite",
      ),
    })
    const state = new SessionRuntimeRepository(database)
    const leases = new RuntimeRepository(database)
    const approvals = new SessionApprovalBroker()
    state.ensureWorkspaceSession({
      workspaceId: "workspace-mode",
      canonicalPath: workspace,
      sessionId: "session-mode",
    })
    const lease = leases.claimSession({
      sessionId: "session-mode",
      ownerId: "server-mode",
      ttlMs: 60_000,
    })
    const fence = { ownerId: lease.ownerId, leaseEpoch: lease.epoch }
    state.prepareCommand({
      command: {
        version: 2,
        type: "start_turn",
        commandId: "command-mode",
        sessionId: "session-mode",
        inputId: "input-mode",
        input: [{ type: "text", text: "decide whether to plan" }],
        mode: "agent",
      },
      fence,
    })
    const turn = state.claimNextTurn({
      sessionId: "session-mode",
      epochs: { configEpoch: 1, contextEpoch: 1 },
      fence,
    })!
    const execute = vi.fn(async (options: RunSessionOptions) => {
      await expect(
        options.requestModeChange?.("plan", "inspect the architecture"),
      ).resolves.toMatchObject({
        success: true,
        mode: "plan",
      })
    })
    const runner = new ServerTurnRunner({
      canonicalDirectory: workspace,
      state,
      approvals,
      execute,
      sessions: createMemorySessionStore(["session-mode"]).store,
    })

    try {
      await expect(
        runner.run({
          sessionId: "session-mode",
          turnId: turn.turnId,
          runId: turn.runId,
          input: turn.input,
          epochs: turn.epochs,
          execution: turn.execution,
          fence: turn.fence,
          signal: new AbortController().signal,
          setPhase: async () => undefined,
          safeBoundary: async () => [],
        }),
      ).resolves.toEqual({ status: "completed" })
      state.prepareCommand({
        command: {
          version: 2,
          type: "queue_turn",
          commandId: "command-mode-followup",
          sessionId: "session-mode",
          inputId: "input-mode-followup",
          input: [{ type: "text", text: "continue after the mode request" }],
          mode: "agent",
        },
        fence,
      })
      state.finishTurn({
        sessionId: "session-mode",
        turnId: turn.turnId,
        result: { status: "completed" },
        fence,
      })
      expect(
        state.claimNextTurn({
          sessionId: "session-mode",
          epochs: { configEpoch: 2, contextEpoch: 2 },
          fence,
        }),
      ).toMatchObject({ execution: { mode: "plan" } })
    } finally {
      approvals.close()
      database.close()
    }
  })

  it("projects admitted input to JSONL before execution and stores bounded agent events", async () => {
    const workspace = temporaryDirectory("nexus-turn-workspace-")
    const database = NexusStateDatabase.open({
      path: join(temporaryDirectory("nexus-turn-state-"), "state.sqlite"),
    })
    let id = 0
    const state = new SessionRuntimeRepository(database, {
      createId: (kind) => `${kind}-${++id}`,
    })
    const leases = new RuntimeRepository(database)
    state.ensureWorkspaceSession({
      workspaceId: "workspace-1",
      canonicalPath: workspace,
      sessionId: "session-1",
    })
    const lease = leases.claimSession({
      sessionId: "session-1",
      ownerId: "server-1",
      ttlMs: 60_000,
    })
    const fence = {
      ownerId: lease.ownerId,
      leaseEpoch: lease.epoch,
    }
    state.prepareCommand({
      command: {
        version: 2,
        type: "start_turn",
        commandId: "command-1",
        sessionId: "session-1",
        inputId: "input-1",
        input: [
          { type: "text", text: "inspect" },
          { type: "image", mimeType: "image/png", data: "aA==" },
        ],
        mode: "agent",
      },
      fence,
    })
    const turn = state.claimNextTurn({
      sessionId: "session-1",
      epochs: { configEpoch: 1, contextEpoch: 1 },
      fence,
    })!
    const sessionStore = createMemorySessionStore(["session-1"])
    const messages = sessionStore.messages("session-1")
    const execute = vi.fn(async (options: RunSessionOptions) => {
      const before = messages
      expect(before).toHaveLength(1)
      expect(before[0]?.role).toBe("user")
      expect(before[0]?.content).toEqual([
        { type: "text", text: "inspect" },
        { type: "image", mimeType: "image/png", data: "aA==" },
      ])
      options.onEvent({
        type: "text_delta",
        delta: "done",
        messageId: "message-1",
      })
      options.onEvent({
        type: "tool_approval_needed",
        partId: "approval-1",
        action: {
          type: "write",
          tool: "write_file",
          description: "Write a source file",
        },
      })
      options.session.addMessage({
        role: "assistant",
        content: "done",
      })
    })
    const approvals = new SessionApprovalBroker()
    const runner = new ServerTurnRunner({
      canonicalDirectory: workspace,
      state,
      approvals,
      execute,
      sessions: sessionStore.store,
    })
    try {
      await expect(
        runner.run({
          sessionId: "session-1",
          turnId: turn.turnId,
          runId: turn.runId,
          input: turn.input,
          epochs: turn.epochs,
          execution: turn.execution,
          fence: turn.fence,
          signal: new AbortController().signal,
          setPhase: async () => undefined,
          safeBoundary: async () => [],
        }),
      ).resolves.toEqual({ status: "completed" })
      expect(messages).toMatchObject([
        { role: "user" },
        { role: "assistant", content: "done" },
      ])
      expect(
        state.events("session-1", 0).map((event) => event.payload.type),
      ).toContain("agent_event")
      const approvalIndex = state
        .events("session-1", 0)
        .findIndex((event) => event.payload.type === "approval_requested")
      const approvalAgentEventIndex = state
        .events("session-1", 0)
        .findIndex(
          (event) =>
            event.payload.type === "agent_event" &&
            typeof event.payload.event === "object" &&
            event.payload.event !== null &&
            "type" in event.payload.event &&
            event.payload.event.type === "tool_approval_needed",
        )
      expect(approvalIndex).toBeGreaterThanOrEqual(0)
      expect(approvalAgentEventIndex).toBeGreaterThan(approvalIndex)
    } finally {
      approvals.close()
      database.close()
    }
  })

  it("checkpoints partial assistant state even when execution fails", async () => {
    const workspace = temporaryDirectory("nexus-turn-failure-workspace-")
    const database = NexusStateDatabase.open({
      path: join(temporaryDirectory("nexus-turn-failure-state-"), "state.sqlite"),
    })
    const state = new SessionRuntimeRepository(database)
    const leases = new RuntimeRepository(database)
    const approvals = new SessionApprovalBroker()
    state.ensureWorkspaceSession({
      workspaceId: "workspace-failure",
      canonicalPath: workspace,
      sessionId: "session-failure",
    })
    const lease = leases.claimSession({
      sessionId: "session-failure",
      ownerId: "server-failure",
      ttlMs: 60_000,
    })
    const fence = { ownerId: lease.ownerId, leaseEpoch: lease.epoch }
    state.prepareCommand({
      command: {
        version: 2,
        type: "start_turn",
        commandId: "command-failure",
        sessionId: "session-failure",
        inputId: "input-failure",
        input: [{ type: "text", text: "persist partial work" }],
        mode: "agent",
      },
      fence,
    })
    const turn = state.claimNextTurn({
      sessionId: "session-failure",
      epochs: { configEpoch: 1, contextEpoch: 1 },
      fence,
    })!
    const sessionStore = createMemorySessionStore(["session-failure"])
    const messages = sessionStore.messages("session-failure")
    const execute = vi.fn(async (options: RunSessionOptions) => {
      options.session.addMessage({
        role: "assistant",
        content: [{
          type: "tool",
          id: "tool-partial",
          tool: "Read",
          status: "running",
        }],
      })
      await options.session.save()
      throw new Error("provider connection failed")
    })
    const runner = new ServerTurnRunner({
      canonicalDirectory: workspace,
      state,
      approvals,
      execute,
      sessions: sessionStore.store,
    })

    try {
      await expect(
        runner.run({
          sessionId: "session-failure",
          turnId: turn.turnId,
          runId: turn.runId,
          input: turn.input,
          epochs: turn.epochs,
          execution: turn.execution,
          fence: turn.fence,
          signal: new AbortController().signal,
          setPhase: async () => undefined,
          safeBoundary: async () => [],
        }),
      ).resolves.toEqual({
        status: "failed",
        error: "provider connection failed",
      })
      expect(messages).toMatchObject([
        { role: "user", content: "persist partial work" },
        {
          role: "assistant",
          content: [{
            type: "tool",
            id: "tool-partial",
            tool: "Read",
            status: "running",
          }],
        },
      ])
    } finally {
      approvals.close()
      database.close()
    }
  })

  it("namespaces reused provider part ids by durable turn across sessions", async () => {
    const workspace = temporaryDirectory("nexus-turn-identity-workspace-")
    const database = NexusStateDatabase.open({
      path: join(
        temporaryDirectory("nexus-turn-identity-state-"),
        "state.sqlite",
      ),
    })
    let id = 0
    const state = new SessionRuntimeRepository(database, {
      createId: (kind) => `${kind}-${++id}`,
    })
    const leases = new RuntimeRepository(database)
    const approvals = new SessionApprovalBroker()
    const turns = ["session-a", "session-b"].map((sessionId, index) => {
      state.ensureWorkspaceSession({
        workspaceId: "workspace-shared",
        canonicalPath: workspace,
        sessionId,
      })
      const lease = leases.claimSession({
        sessionId,
        ownerId: "server-shared",
        ttlMs: 60_000,
      })
      const fence = {
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
      }
      state.prepareCommand({
        command: {
          version: 2,
          type: "start_turn",
          commandId: `command-${index}`,
          sessionId,
          inputId: `input-${index}`,
          input: [{ type: "text", text: "write safely" }],
          mode: "agent",
        },
        fence,
      })
      return state.claimNextTurn({
        sessionId,
        epochs: { configEpoch: 1, contextEpoch: 1 },
        fence,
      })!
    })
    const execute = vi.fn(async (options: RunSessionOptions) => {
      options.onEvent({
        type: "tool_approval_needed",
        partId: "provider-call-1",
        action: {
          type: "write",
          tool: "Write",
          description: "Write a source file",
          content: "safe content",
        },
      })
    })
    const sessionStore = createMemorySessionStore(turns.map((turn) => turn.input.sessionId))
    const runner = new ServerTurnRunner({
      canonicalDirectory: workspace,
      state,
      approvals,
      execute,
      sessions: sessionStore.store,
    })
    try {
      const results = await Promise.all(
        turns.map((turn) =>
          runner.run({
            sessionId: turn.input.sessionId,
            turnId: turn.turnId,
            runId: turn.runId,
            input: turn.input,
            epochs: turn.epochs,
            execution: turn.execution,
            fence: turn.fence,
            signal: new AbortController().signal,
            setPhase: async () => undefined,
            safeBoundary: async () => [],
          }),
        ),
      )
      expect(results).toEqual([
        { status: "completed" },
        { status: "completed" },
      ])
      const approvalIds = turns.map((turn) => {
        const event = state.events(turn.input.sessionId, 0).find(
          (candidate) => candidate.payload.type === "approval_requested",
        )
        return event?.payload.approvalId
      })
      expect(approvalIds[0]).toMatch(/^approval-/)
      expect(approvalIds[1]).toMatch(/^approval-/)
      expect(approvalIds[0]).not.toBe(approvalIds[1])
      expect(approvalIds).not.toContain("provider-call-1")
    } finally {
      approvals.close()
      database.close()
    }
  })
})
