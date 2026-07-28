import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  NexusStateDatabase,
  RuntimeRepository,
  SessionRuntimeConflictError,
  SessionRuntimeRepository,
  type RuntimeSessionCommand,
} from "./index.js"

const temporaryDirectories: string[] = []

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nexus-session-runtime-"))
  temporaryDirectories.push(directory)
  return join(directory, "state.sqlite")
}

function setup(
  nowValue = 100,
  options: { maxPendingInputs?: number } = {},
) {
  const database = NexusStateDatabase.open({
    path: temporaryDatabasePath(),
  })
  database.transaction((connection) => {
    connection.run(
      `INSERT INTO workspace
        (id, canonical_path, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      ["workspace-1", "/tmp/nexus-session-runtime", 1, 1],
    )
    connection.run(
      `INSERT INTO session
        (id, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      ["session-1", "workspace-1", 1, 1],
    )
  })
  const runtime = new RuntimeRepository(database, { now: () => nowValue })
  const lease = runtime.claimSession({
    sessionId: "session-1",
    ownerId: "server-1",
    ttlMs: 10_000,
  })
  let identifier = 0
  const repository = new SessionRuntimeRepository(database, {
    now: () => nowValue,
    createId: (kind) => `${kind}-${++identifier}`,
    ...options,
  })
  const fence = {
    ownerId: lease.ownerId,
    leaseEpoch: lease.epoch,
  }
  return { database, repository, fence }
}

function startCommand(
  overrides: Partial<RuntimeSessionCommand> = {},
): RuntimeSessionCommand {
  return {
    version: 2,
    type: "start_turn",
    commandId: "command-1",
    sessionId: "session-1",
    inputId: "input-1",
    input: [{ type: "text", text: "inspect the repository" }],
    mode: "agent",
    ...overrides,
  } as RuntimeSessionCommand
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("SessionRuntimeRepository command ledger", () => {
  it("bounds all unpromoted queued and steering admissions atomically", () => {
    const { database, repository, fence } = setup(100, {
      maxPendingInputs: 2,
    })
    try {
      const first = startCommand()
      repository.prepareCommand({ command: first, fence })
      repository.prepareCommand({
        command: startCommand({
          type: "queue_turn",
          commandId: "command-2",
          inputId: "input-2",
        }),
        fence,
      })

      expect(() =>
        repository.prepareCommand({
          command: startCommand({
            type: "queue_turn",
            commandId: "command-3",
            inputId: "input-3",
          }),
          fence,
        }),
      ).toThrowError(expect.objectContaining({
        name: "SessionRuntimeConflictError",
        code: "queue_full",
      }))
      expect(repository.snapshot("session-1").pendingQueue).toHaveLength(2)

      // Idempotent retries remain readable when the queue is at capacity.
      expect(repository.prepareCommand({ command: first, fence })).toMatchObject({
        commandId: first.commandId,
        inputId: "input-1",
      })
    } finally {
      database.close()
    }
  })

  it("idempotently creates the workspace/session ownership records", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    const repository = new SessionRuntimeRepository(database)
    try {
      repository.ensureWorkspaceSession({
        workspaceId: "workspace-created",
        canonicalPath: "/tmp/nexus-created",
        sessionId: "session-created",
      })
      repository.ensureWorkspaceSession({
        workspaceId: "workspace-created",
        canonicalPath: "/tmp/nexus-created",
        sessionId: "session-created",
      })

      expect(repository.snapshot("session-created")).toEqual({
        sessionId: "session-created",
        phase: "idle",
        pendingApprovals: [],
        pendingQueue: [],
        pendingSteers: [],
      })
    } finally {
      database.close()
    }
  })

  it("tombstones an idle session and refuses to resurrect it", () => {
    const { database, repository, fence } = setup()
    try {
      expect(repository.tombstoneSession({
        sessionId: "session-1",
        fence,
      })).toEqual({ tombstoned: true })
      expect(repository.isSessionTombstoned("session-1")).toBe(true)
      expect(repository.tombstoneSession({
        sessionId: "session-1",
        fence,
      })).toEqual({ tombstoned: false })
      expect(() =>
        repository.ensureWorkspaceSession({
          workspaceId: "workspace-1",
          canonicalPath: "/tmp/nexus-session-runtime",
          sessionId: "session-1",
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "SessionRuntimeConflictError",
          code: "session_deleted",
        }),
      )
    } finally {
      database.close()
    }
  })

  it("refuses to tombstone accepted or active work", () => {
    const { database, repository, fence } = setup()
    try {
      repository.prepareCommand({
        command: startCommand(),
        fence,
      })
      expect(() =>
        repository.tombstoneSession({
          sessionId: "session-1",
          fence,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "SessionRuntimeConflictError",
          code: "session_not_idle",
        }),
      )

      repository.claimNextTurn({
        sessionId: "session-1",
        epochs: { configEpoch: 0, contextEpoch: 0 },
        fence,
      })
      expect(() =>
        repository.tombstoneSession({
          sessionId: "session-1",
          fence,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "SessionRuntimeConflictError",
          code: "session_not_idle",
        }),
      )
    } finally {
      database.close()
    }
  })

  it("commits an input, immutable execution snapshot, receipt, and envelope atomically", () => {
    const { database, repository, fence } = setup()
    try {
      const command = startCommand({
        selection: { profileId: "primary", selectionEpoch: 7 },
      })
      const first = repository.prepareCommand({ command, fence })
      const retried = repository.prepareCommand({ command, fence })

      expect(retried).toEqual(first)
      expect(first).toMatchObject({
        version: 2,
        type: "start_turn",
        commandId: "command-1",
        sessionId: "session-1",
        inputId: "input-1",
        turnId: "turn-1",
        runId: "run-2",
        started: true,
        accepted: true,
      })
      expect(repository.snapshot("session-1")).toMatchObject({
        phase: "idle",
        pendingQueue: [
          {
            id: "input-1",
            reservedTurnId: "turn-1",
            reservedRunId: "run-2",
            execution: {
              mode: "agent",
              selection: {
                profileId: "primary",
                selectionEpoch: 7,
              },
            },
          },
        ],
      })
      expect(repository.events("session-1", 0)).toEqual([
        expect.objectContaining({
          version: 2,
          sequence: 1,
          sessionId: "session-1",
          turnId: "turn-1",
          runId: "run-2",
          payload: expect.objectContaining({
            type: "input_admitted",
            inputId: "input-1",
            execution: {
              mode: "agent",
              selection: {
                profileId: "primary",
                selectionEpoch: 7,
              },
            },
          }),
        }),
      ])
    } finally {
      database.close()
    }
  })

  it("rejects command-id and input-id content changes without partial mutation", () => {
    const { database, repository, fence } = setup()
    try {
      repository.prepareCommand({
        command: startCommand(),
        fence,
      })

      expect(() =>
        repository.prepareCommand({
          command: startCommand({
            input: [{ type: "text", text: "different request" }],
          }),
          fence,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "SessionRuntimeConflictError",
          code: "idempotency_conflict",
        }),
      )
      expect(() =>
        repository.admitInput({
          inputId: "input-1",
          sessionId: "session-1",
          delivery: "queue",
          parts: [{ type: "text", text: "different request" }],
          execution: { mode: "agent" },
          fence,
        }),
      ).toThrow(SessionRuntimeConflictError)
      expect(repository.events("session-1", 0)).toHaveLength(1)
      expect(repository.snapshot("session-1").pendingQueue).toHaveLength(1)
    } finally {
      database.close()
    }
  })
})

describe("SessionRuntimeRepository coordinator transactions", () => {
  it("durably applies an EnterPlanMode request to exactly the next claimed turn", () => {
    const { database, repository, fence } = setup()
    try {
      repository.prepareCommand({
        command: startCommand({
          selection: { profileId: "current-profile", selectionEpoch: 3 },
        }),
        fence,
      })
      repository.claimNextTurn({
        sessionId: "session-1",
        epochs: { configEpoch: 1, contextEpoch: 1 },
        fence,
      })
      repository.prepareCommand({
        command: startCommand({
          type: "queue_turn",
          commandId: "command-queued-plan",
          inputId: "input-queued-plan",
          input: [{ type: "text", text: "answer the planning questions" }],
          mode: "agent",
          selection: { profileId: "queued-profile", selectionEpoch: 8 },
        }),
        fence,
      })

      repository.requestNextMode({
        sessionId: "session-1",
        expectedTurnId: "turn-1",
        mode: "plan",
        fence,
      })
      repository.requestNextMode({
        sessionId: "session-1",
        expectedTurnId: "turn-1",
        mode: "plan",
        fence,
      })

      // Reconstruct the repository to prove the transition is SQLite-owned,
      // not an in-memory host/UI latch.
      const afterRestart = new SessionRuntimeRepository(database, {
        now: () => 100,
      })
      afterRestart.finishTurn({
        sessionId: "session-1",
        turnId: "turn-1",
        result: { status: "completed" },
        fence,
      })
      const planned = afterRestart.claimNextTurn({
        sessionId: "session-1",
        epochs: { configEpoch: 2, contextEpoch: 2 },
        fence,
      })

      expect(planned).toMatchObject({
        input: {
          id: "input-queued-plan",
          execution: {
            mode: "agent",
            selection: {
              profileId: "queued-profile",
              selectionEpoch: 8,
            },
          },
        },
        execution: {
          mode: "plan",
          selection: {
            profileId: "queued-profile",
            selectionEpoch: 8,
          },
        },
        modeOverride: {
          requestedByTurnId: "turn-1",
        },
      })

      afterRestart.prepareCommand({
        command: startCommand({
          type: "queue_turn",
          commandId: "command-after-plan",
          inputId: "input-after-plan",
          input: [{ type: "text", text: "implement the approved plan" }],
          mode: "agent",
          selection: undefined,
        }),
        fence,
      })
      afterRestart.finishTurn({
        sessionId: "session-1",
        turnId: planned!.turnId,
        result: { status: "completed" },
        fence,
      })
      expect(
        afterRestart.claimNextTurn({
          sessionId: "session-1",
          epochs: { configEpoch: 3, contextEpoch: 3 },
          fence,
        }),
      ).toMatchObject({
        input: { id: "input-after-plan", execution: { mode: "agent" } },
        execution: { mode: "agent" },
      })

    } finally {
      database.close()
    }
  })

  it("rejects next-mode requests without the exact live fenced turn", () => {
    const { database, repository, fence } = setup()
    try {
      expect(() =>
        repository.requestNextMode({
          sessionId: "session-1",
          expectedTurnId: "turn-missing",
          mode: "plan",
          fence,
        }),
      ).toThrowError(expect.objectContaining({ code: "no_active_turn" }))

      repository.prepareCommand({ command: startCommand(), fence })
      repository.claimNextTurn({
        sessionId: "session-1",
        epochs: { configEpoch: 1, contextEpoch: 1 },
        fence,
      })
      expect(() =>
        repository.requestNextMode({
          sessionId: "session-1",
          expectedTurnId: "turn-other",
          mode: "plan",
          fence,
        }),
      ).toThrowError(expect.objectContaining({ code: "turn_conflict" }))
      expect(() =>
        repository.requestNextMode({
          sessionId: "session-1",
          expectedTurnId: "turn-1",
          mode: "plan",
          fence: {
            ownerId: "stale-owner",
            leaseEpoch: fence.leaseEpoch,
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "lease_lost" }))
      expect(repository.events("session-1", 0)).toHaveLength(2)
    } finally {
      database.close()
    }
  })

  it("claims exactly one queued turn and fences every phase mutation", () => {
    const { database, repository, fence } = setup()
    try {
      repository.prepareCommand({ command: startCommand(), fence })
      const claimed = repository.claimNextTurn({
        sessionId: "session-1",
        epochs: { configEpoch: 3, contextEpoch: 5 },
        fence,
      })

      expect(claimed).toMatchObject({
        turnId: "turn-1",
        runId: "run-2",
        phase: "preparing",
        epochs: { configEpoch: 3, contextEpoch: 5 },
        execution: { mode: "agent" },
        fence,
      })
      expect(repository.protocolSnapshot("session-1")).toMatchObject({
        runtime: {
          activeTurn: {
            turnId: "turn-1",
            runId: "run-2",
          },
        },
        activeTurnFirstSequence: 1,
        earliestAvailableSequence: 1,
        throughSequence: 2,
      })
      expect(
        repository.claimNextTurn({
          sessionId: "session-1",
          epochs: { configEpoch: 9, contextEpoch: 9 },
          fence,
        }),
      ).toBeUndefined()
      expect(() =>
        repository.setPhase({
          sessionId: "session-1",
          turnId: "turn-1",
          phase: "streaming",
          fence: { ownerId: "stale-owner", leaseEpoch: fence.leaseEpoch },
        }),
      ).toThrowError(
        expect.objectContaining({ code: "lease_lost" }),
      )
      repository.setPhase({
        sessionId: "session-1",
        turnId: "turn-1",
        phase: "streaming",
        fence,
      })
      expect(repository.snapshot("session-1")).toMatchObject({
        phase: "streaming",
        activeTurn: {
          turnId: "turn-1",
          runId: "run-2",
          phase: "streaming",
        },
        pendingQueue: [],
      })
      expect(repository.events("session-1", 0).map((event) => event.sequence))
        .toEqual([1, 2, 3])
    } finally {
      database.close()
    }
  })

  it("promotes steering at a fixed cutoff and requeues accepted late steering", () => {
    const { database, repository, fence } = setup()
    try {
      repository.prepareCommand({ command: startCommand(), fence })
      repository.claimNextTurn({
        sessionId: "session-1",
        epochs: { configEpoch: 1, contextEpoch: 1 },
        fence,
      })
      const firstSteer = repository.prepareCommand({
        command: {
          version: 2,
          type: "steer_turn",
          commandId: "command-steer-1",
          sessionId: "session-1",
          inputId: "steer-1",
          expectedTurnId: "turn-1",
          input: [{ type: "text", text: "first correction" }],
        },
        fence,
      })
      const pending = repository.pendingSteers("session-1", "turn-1")
      repository.prepareCommand({
        command: {
          version: 2,
          type: "steer_turn",
          commandId: "command-steer-2",
          sessionId: "session-1",
          inputId: "steer-2",
          expectedTurnId: "turn-1",
          input: [{ type: "text", text: "late correction" }],
        },
        fence,
      })

      expect(
        repository.promoteSteers(
          "session-1",
          "turn-1",
          pending[0]!.admittedSequence,
          fence,
        ).map((input) => input.id),
      ).toEqual(["steer-1"])
      const finished = repository.finishTurn({
        sessionId: "session-1",
        turnId: "turn-1",
        result: { status: "completed" },
        fence,
      })
      expect(finished.requeuedInputs).toEqual([
        expect.objectContaining({
          id: "steer-2",
          delivery: "queue",
          execution: { mode: "agent" },
        }),
      ])
      expect(finished.requeuedInputs[0]).not.toHaveProperty("expectedTurnId")
      expect(firstSteer).toMatchObject({
        type: "steer_turn",
        expectedTurnId: "turn-1",
      })
      expect(repository.snapshot("session-1")).toMatchObject({
        phase: "idle",
        pendingQueue: [
          expect.objectContaining({
            id: "steer-2",
            execution: { mode: "agent" },
          }),
        ],
        pendingSteers: [],
      })
      const events = repository.events("session-1", 0)
      expect(events.map((event) => event.sequence)).toEqual(
        events.map((_event, index) => index + 1),
      )
      expect(events.map((event) => event.payload.type)).toContain(
        "steering_requeued",
      )
    } finally {
      database.close()
    }
  })

  it("recovers an ambiguous turn as interrupted without replaying it", () => {
    const { database, repository, fence } = setup()
    try {
      repository.prepareCommand({ command: startCommand(), fence })
      repository.claimNextTurn({
        sessionId: "session-1",
        epochs: { configEpoch: 1, contextEpoch: 1 },
        fence,
      })

      const recovered = repository.recoverSession({
        sessionId: "session-1",
        fence,
      })
      const again = repository.recoverSession({
        sessionId: "session-1",
        fence,
      })

      expect(recovered.interruptedTurn).toMatchObject({
        turnId: "turn-1",
        runId: "run-2",
        result: {
          status: "interrupted",
          error: "Recovered an ambiguous in-progress turn",
        },
      })
      expect(recovered.snapshot.activeTurn).toBeUndefined()
      expect(again.interruptedTurn).toBeUndefined()
      expect(
        repository.events("session-1", 0).filter(
          (event) => event.payload.type === "turn_finished",
        ),
      ).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it("durably cancels pending approvals before publishing the terminal turn", () => {
    const { database, repository, fence } = setup()
    try {
      repository.prepareCommand({ command: startCommand(), fence })
      repository.claimNextTurn({
        sessionId: "session-1",
        epochs: { configEpoch: 1, contextEpoch: 1 },
        fence,
      })
      repository.createApproval({
        approvalId: "approval-cancelled",
        sessionId: "session-1",
        expectedTurnId: "turn-1",
        toolName: "Bash",
        redactedSummary: "Run a command",
        dedupeKey: "turn-1:approval-cancelled",
        fence,
      })

      repository.finishTurn({
        sessionId: "session-1",
        turnId: "turn-1",
        result: { status: "interrupted", error: "client disconnected" },
        fence,
      })

      const terminalEvents = repository
        .events("session-1", 0)
        .slice(2)
        .map((event) => event.payload)
      expect(terminalEvents).toEqual([
        expect.objectContaining({
          type: "approval_requested",
          approvalId: "approval-cancelled",
        }),
        {
          type: "approval_resolved",
          approvalId: "approval-cancelled",
          status: "cancelled",
        },
        {
          type: "turn_finished",
          status: "interrupted",
          error: "client disconnected",
        },
      ])
    } finally {
      database.close()
    }
  })

  it("fences approval creation and atomically receipts its resolution", () => {
    const { database, repository, fence } = setup()
    try {
      repository.prepareCommand({ command: startCommand(), fence })
      repository.claimNextTurn({
        sessionId: "session-1",
        epochs: { configEpoch: 1, contextEpoch: 1 },
        fence,
      })
      repository.createApproval({
        approvalId: "approval-1",
        sessionId: "session-1",
        expectedTurnId: "turn-1",
        toolName: "Bash",
        redactedSummary: "Run the focused tests",
        dedupeKey: "turn-1:approval-1",
        fence,
      })
      expect(repository.snapshot("session-1").pendingApprovals).toEqual([
        {
          approvalId: "approval-1",
          turnId: "turn-1",
          toolName: "Bash",
          redactedSummary: "Run the focused tests",
        },
      ])

      expect(() =>
        repository.createApproval({
          approvalId: "approval-stale",
          sessionId: "session-1",
          expectedTurnId: "turn-1",
          toolName: "Bash",
          redactedSummary: "Stale owner",
          dedupeKey: "turn-1:approval-stale",
          fence: {
            ownerId: "stale-owner",
            leaseEpoch: fence.leaseEpoch,
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "lease_lost" }))

      const command: RuntimeSessionCommand = {
        version: 2,
        type: "resolve_approval",
        commandId: "command-approval",
        sessionId: "session-1",
        approvalId: "approval-1",
        expectedTurnId: "turn-1",
        status: "approved",
      }
      const receipt = repository.prepareCommand({ command, fence })
      expect(repository.prepareCommand({ command, fence })).toEqual(receipt)
      expect(repository.approvalResolution({
        sessionId: "session-1",
        approvalId: "approval-1",
      })).toEqual({
        expectedTurnId: "turn-1",
        status: "approved",
      })
      expect(repository.snapshot("session-1").pendingApprovals).toEqual([])
      expect(
        repository.events("session-1", 0).map((event) => event.payload.type),
      ).toEqual([
        "input_admitted",
        "turn_started",
        "approval_requested",
        "approval_resolved",
      ])
    } finally {
      database.close()
    }
  })
})
