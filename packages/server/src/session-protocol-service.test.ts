import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  PROTOCOL_VERSION,
  SessionProtocolError,
  type TurnRunnerContext,
  type TurnRunnerResult,
} from "@nexuscode/core"
import {
  NexusStateDatabase,
  RuntimeConflictError,
  RuntimeRepository,
  SessionRuntimeRepository,
} from "@nexuscode/state"

import { SqliteSessionProtocolService } from "./session-protocol-service.js"

const temporaryDirectories: string[] = []

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function setup(options: {
  now?: () => number
  run?: (context: TurnRunnerContext) => Promise<TurnRunnerResult>
  leaseTtlMs?: number
  onDiagnostic?: (error: unknown) => void
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "nexus-protocol-service-"))
  temporaryDirectories.push(directory)
  const database = NexusStateDatabase.open({
    path: join(directory, "state.sqlite"),
    now: options.now,
  })
  let id = 0
  const state = new SessionRuntimeRepository(database, {
    now: options.now,
    createId: (kind) => `${kind}-${++id}`,
  })
  const runtime = new RuntimeRepository(database, { now: options.now })
  const contexts: TurnRunnerContext[] = []
  const run = vi.fn(async (context: TurnRunnerContext) => {
    contexts.push(context)
    return options.run?.(context) ?? { status: "completed" as const }
  })
  const service = new SqliteSessionProtocolService({
    canonicalDirectory: directory,
    workspaceId: "workspace-1",
    ownerId: "server-1",
    state,
    runtime,
    runner: { run },
    epochs: {
      capture: () => ({ configEpoch: 4, contextEpoch: 6 }),
    },
    leaseTtlMs: options.leaseTtlMs ?? 60_000,
    onDiagnostic: options.onDiagnostic,
  })
  return { database, state, runtime, service, run, contexts, directory }
}

afterEach(() => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("SqliteSessionProtocolService", () => {
  it("tombstones only idle sessions and makes deletion idempotent", async () => {
    const { database, service } = setup()
    try {
      await service.snapshot("session-delete")
      await expect(service.deleteSession!("session-delete")).resolves.toEqual({
        deleted: true,
      })
      await expect(service.deleteSession!("session-delete")).resolves.toEqual({
        deleted: false,
      })
      await expect(service.snapshot("session-delete")).rejects.toMatchObject({
        protocolError: {
          code: "not_found",
          retryable: false,
        },
      })
    } finally {
      await service.close()
      database.close()
    }
  })

  it("does not delete a session with accepted work", async () => {
    const blocker = deferred<TurnRunnerResult>()
    const { database, service } = setup({
      run: async () => blocker.promise,
    })
    try {
      await service.dispatch({
        version: PROTOCOL_VERSION,
        type: "start_turn",
        commandId: "command-delete-active",
        sessionId: "session-delete-active",
        inputId: "input-delete-active",
        input: [{ type: "text", text: "keep running" }],
        mode: "agent",
      })
      await expect(
        service.deleteSession!("session-delete-active"),
      ).rejects.toMatchObject({
        protocolError: {
          code: "turn_conflict",
          retryable: false,
        },
      })
    } finally {
      blocker.resolve({ status: "completed" })
      await service.close()
      database.close()
    }
  })

  it("reconciles a crashed active turn after lease takeover without replaying the runner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-protocol-recovery-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "state.sqlite")
    let now = 100
    const crashedDatabase = NexusStateDatabase.open({
      path,
      now: () => now,
    })
    const crashedState = new SessionRuntimeRepository(crashedDatabase, {
      now: () => now,
      createId: (() => {
        let id = 0
        return (kind) => `${kind}-${++id}`
      })(),
    })
    const crashedRuntime = new RuntimeRepository(crashedDatabase, {
      now: () => now,
    })
    crashedState.ensureWorkspaceSession({
      workspaceId: "workspace-recovery",
      canonicalPath: directory,
      sessionId: "session-recovery",
    })
    const oldLease = crashedRuntime.claimSession({
      sessionId: "session-recovery",
      ownerId: "crashed-owner",
      ttlMs: 10,
    })
    const oldFence = {
      ownerId: oldLease.ownerId,
      leaseEpoch: oldLease.epoch,
    }
    crashedState.prepareCommand({
      command: {
        version: 2,
        type: "start_turn",
        commandId: "command-recovery",
        sessionId: "session-recovery",
        inputId: "input-recovery",
        input: [{ type: "text", text: "do not replay me" }],
        mode: "agent",
      },
      fence: oldFence,
    })
    crashedState.claimNextTurn({
      sessionId: "session-recovery",
      epochs: { configEpoch: 1, contextEpoch: 1 },
      fence: oldFence,
    })
    crashedState.createApproval({
      approvalId: "approval-recovery",
      sessionId: "session-recovery",
      expectedTurnId: "turn-1",
      toolName: "Bash",
      redactedSummary: "Do not resume this ambiguous tool execution",
      dedupeKey: "turn-1:approval-recovery",
      fence: oldFence,
    })
    crashedDatabase.close()

    now = oldLease.expiresAt + 1
    const recoveredDatabase = NexusStateDatabase.open({
      path,
      now: () => now,
    })
    const recoveredState = new SessionRuntimeRepository(recoveredDatabase, {
      now: () => now,
    })
    const recoveredRuntime = new RuntimeRepository(recoveredDatabase, {
      now: () => now,
    })
    const run = vi.fn(async () => ({ status: "completed" as const }))
    const service = new SqliteSessionProtocolService({
      canonicalDirectory: directory,
      workspaceId: "workspace-recovery",
      ownerId: "replacement-owner",
      state: recoveredState,
      runtime: recoveredRuntime,
      runner: { run },
      epochs: {
        capture: () => ({ configEpoch: 2, contextEpoch: 2 }),
      },
      leaseTtlMs: 60_000,
    })
    try {
      const recoveredSnapshot = await service.snapshot("session-recovery")
      expect(recoveredSnapshot).toMatchObject({
        phase: "interrupted",
        pendingQueueCount: 0,
        pendingApprovals: [],
      })
      expect(recoveredSnapshot).not.toHaveProperty("activeTurnId")
      expect(recoveredSnapshot).not.toHaveProperty("activeRunId")
      expect(run).not.toHaveBeenCalled()
      expect(
        recoveredState
          .events("session-recovery", 0)
          .filter((event) =>
            event.payload.type === "approval_resolved" ||
            event.payload.type === "turn_finished"
          )
          .map((event) => event.payload),
      ).toEqual([
        {
          type: "approval_resolved",
          approvalId: "approval-recovery",
          status: "cancelled",
        },
        expect.objectContaining({
          type: "turn_finished",
          status: "interrupted",
        }),
      ])
      expect(
        recoveredDatabase.read((connection) =>
          connection.get<{ status: string }>(
            "SELECT status FROM approval WHERE id = ?",
            ["approval-recovery"],
          ),
        ),
      ).toEqual({ status: "cancelled" })
    } finally {
      await service.close()
      recoveredDatabase.close()
    }
  })

  it("dispatches through one durable coordinator and returns the original receipt on retry", async () => {
    const gate = deferred<TurnRunnerResult>()
    const { database, service, run, contexts } = setup({
      run: async () => gate.promise,
    })
    const command = {
      version: PROTOCOL_VERSION,
      type: "start_turn" as const,
      commandId: "command-1",
      sessionId: "session-1",
      inputId: "input-1",
      input: [{ type: "text" as const, text: "hello" }],
      mode: "debug" as const,
      selection: {
        profileId: "primary",
        selectionEpoch: 8,
      },
    }
    try {
      const first = await service.dispatch(command)
      const retry = await service.dispatch(command)

      expect(retry).toEqual(first)
      expect(first).toMatchObject({
        type: "start_turn",
        inputId: "input-1",
        turnId: "turn-1",
        runId: "run-2",
        started: true,
      })
      expect(run).toHaveBeenCalledOnce()
      expect(contexts[0]).toMatchObject({
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-2",
        epochs: { configEpoch: 4, contextEpoch: 6 },
        execution: {
          mode: "debug",
          selection: {
            profileId: "primary",
            selectionEpoch: 8,
          },
        },
      })
      expect(await service.snapshot("session-1")).toMatchObject({
        version: PROTOCOL_VERSION,
        sessionId: "session-1",
        phase: "preparing",
        activeTurnId: "turn-1",
        activeRunId: "run-2",
        activeTurnFirstSequence: 1,
        activeExecution: {
          mode: "debug",
          selection: {
            profileId: "primary",
            selectionEpoch: 8,
          },
        },
        pendingQueueCount: 0,
        pendingSteerCount: 0,
        earliestAvailableSequence: 1,
      })

      await expect(
        service.dispatch({
          ...command,
          input: [{ type: "text", text: "changed" }],
        }),
      ).rejects.toMatchObject({
        name: "SessionProtocolError",
        protocolError: {
          code: "idempotency_conflict",
          retryable: false,
        },
      })
    } finally {
      gate.resolve({ status: "interrupted" })
      await service.close()
      database.close()
    }
  })

  it("replays committed envelopes contiguously and observes later state", async () => {
    const gate = deferred<TurnRunnerResult>()
    const { database, service } = setup({
      run: async () => gate.promise,
    })
    const abort = new AbortController()
    try {
      await service.dispatch({
        version: PROTOCOL_VERSION,
        type: "start_turn",
        commandId: "command-events",
        sessionId: "session-events",
        inputId: "input-events",
        input: [{ type: "text", text: "stream" }],
        mode: "agent",
      })
      const iterator = service.events({
        sessionId: "session-events",
        afterSequence: 0,
        signal: abort.signal,
      })[Symbol.asyncIterator]()
      const first = await iterator.next()
      const second = await iterator.next()

      expect(first.value?.sequence).toBe(1)
      expect(first.value?.payload.type).toBe("input_admitted")
      expect(second.value?.sequence).toBe(2)
      expect(second.value?.payload.type).toBe("turn_started")

      gate.resolve({ status: "completed" })
      let terminal
      for (let attempts = 0; attempts < 8; attempts += 1) {
        const next = await iterator.next()
        if (next.value?.payload.type === "turn_finished") {
          terminal = next.value
          break
        }
      }
      expect(terminal).toMatchObject({
        sessionId: "session-events",
        turnId: "turn-1",
        runId: "run-2",
        payload: { type: "turn_finished", status: "completed" },
      })
      abort.abort()
      await iterator.return?.()
    } finally {
      abort.abort()
      await service.close()
      database.close()
    }
  })

  it("projects exact redacted pending approval identities in reattach snapshots", async () => {
    const gate = deferred<TurnRunnerResult>()
    const { database, state, service, contexts } = setup({
      run: async () => gate.promise,
    })
    try {
      await service.dispatch({
        version: PROTOCOL_VERSION,
        type: "start_turn",
        commandId: "command-approval-snapshot",
        sessionId: "session-approval-snapshot",
        inputId: "input-approval-snapshot",
        input: [{ type: "text", text: "wait for approval" }],
        mode: "agent",
      })
      const active = contexts[0]!
      state.createApproval({
        approvalId: "approval-snapshot",
        sessionId: active.sessionId,
        expectedTurnId: active.turnId,
        toolName: "Bash",
        redactedSummary: "Run the focused test suite",
        dedupeKey: `${active.turnId}:approval-snapshot`,
        fence: active.fence,
      })

      await expect(
        service.snapshot("session-approval-snapshot"),
      ).resolves.toMatchObject({
        activeTurnId: active.turnId,
        activeRunId: active.runId,
        pendingApprovals: [
          {
            approvalId: "approval-snapshot",
            turnId: active.turnId,
            toolName: "Bash",
            redactedSummary: "Run the focused test suite",
          },
        ],
      })
    } finally {
      gate.resolve({ status: "interrupted" })
      await service.close()
      database.close()
    }
  })

  it("maps expected coordinator/storage conflicts without exposing internals", async () => {
    const { database, service } = setup()
    try {
      await expect(
        service.dispatch({
          version: PROTOCOL_VERSION,
          type: "steer_turn",
          commandId: "command-steer",
          sessionId: "session-empty",
          inputId: "input-steer",
          expectedTurnId: "turn-missing",
          input: [{ type: "text", text: "late" }],
        }),
      ).rejects.toSatisfy((error: unknown) => {
        return (
          error instanceof SessionProtocolError &&
          error.protocolError.code === "no_active_turn" &&
          error.protocolError.retryable === false &&
          !error.protocolError.message.includes("SELECT")
        )
      })
    } finally {
      await service.close()
      database.close()
    }
  })

  it("retries a transient lease renewal failure without abandoning the runner", async () => {
    vi.useFakeTimers()
    const gate = deferred<TurnRunnerResult>()
    const diagnostics: unknown[] = []
    const { database, runtime, service, contexts } = setup({
      leaseTtlMs: 3_000,
      run: async () => gate.promise,
      onDiagnostic: (error) => diagnostics.push(error),
    })
    const renewal = vi.spyOn(runtime, "renewSessionLease")
    renewal.mockImplementationOnce(() => {
      throw new Error("temporary SQLite busy")
    })
    try {
      await service.dispatch({
        version: PROTOCOL_VERSION,
        type: "start_turn",
        commandId: "command-transient-renewal",
        sessionId: "session-transient-renewal",
        inputId: "input-transient-renewal",
        input: [{ type: "text", text: "keep running" }],
        mode: "agent",
      })

      await vi.advanceTimersByTimeAsync(1_000)
      expect(contexts[0]?.signal.aborted).toBe(false)
      await expect(
        service.snapshot("session-transient-renewal"),
      ).resolves.toMatchObject({
        activeTurnId: contexts[0]?.turnId,
      })
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ message: "temporary SQLite busy" }),
      )

      await vi.advanceTimersByTimeAsync(1_000)
      expect(renewal).toHaveBeenCalledTimes(2)
      expect(contexts[0]?.signal.aborted).toBe(false)
    } finally {
      gate.resolve({ status: "interrupted" })
      await service.close()
      database.close()
    }
  })

  it("aborts the in-memory runner immediately when its fenced lease is lost", async () => {
    vi.useFakeTimers()
    const diagnostics: unknown[] = []
    const { database, runtime, service, contexts } = setup({
      leaseTtlMs: 3_000,
      run: async (context) =>
        new Promise<TurnRunnerResult>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => resolve({ status: "interrupted" }),
            { once: true },
          )
        }),
      onDiagnostic: (error) => diagnostics.push(error),
    })
    vi.spyOn(runtime, "renewSessionLease").mockImplementation(() => {
      throw new RuntimeConflictError(
        "lease_lost",
        "lease was taken by another runtime",
      )
    })
    try {
      await service.dispatch({
        version: PROTOCOL_VERSION,
        type: "start_turn",
        commandId: "command-lost-renewal",
        sessionId: "session-lost-renewal",
        inputId: "input-lost-renewal",
        input: [{ type: "text", text: "must stop" }],
        mode: "agent",
      })

      await vi.advanceTimersByTimeAsync(1_000)
      expect(contexts[0]?.signal.aborted).toBe(true)
      await expect(
        service.snapshot("session-lost-renewal"),
      ).rejects.toMatchObject({
        protocolError: {
          code: "runtime_unavailable",
          retryable: true,
        },
      })
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ code: "lease_lost" }),
      )
    } finally {
      await service.close()
      database.close()
    }
  })

  it("retries a transient lease release failure during runtime shutdown", async () => {
    const { database, runtime, service } = setup()
    await service.dispatch({
      version: PROTOCOL_VERSION,
      type: "start_turn",
      commandId: "command-release-retry",
      sessionId: "session-release-retry",
      inputId: "input-release-retry",
      input: [{ type: "text", text: "complete before shutdown" }],
      mode: "agent",
    })
    const release = vi.spyOn(runtime, "releaseSessionLease")
    release.mockImplementationOnce(() => {
      throw new Error("temporary release failure")
    })
    try {
      await expect(service.close()).rejects.toThrow(
        "temporary release failure",
      )
      await expect(service.close()).resolves.toBeUndefined()
      expect(release).toHaveBeenCalledTimes(2)
    } finally {
      await service.close().catch(() => undefined)
      database.close()
    }
  })
})
