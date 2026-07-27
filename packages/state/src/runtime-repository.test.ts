import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  NexusStateDatabase,
  RuntimeConflictError,
  RuntimeRepository,
  SessionInputRepository,
} from "./index.js"

const temporaryDirectories: string[] = []

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nexus-runtime-state-test-"))
  temporaryDirectories.push(directory)
  return join(directory, "state.sqlite")
}

function seedSession(
  database: NexusStateDatabase,
  sessionId = "session-1",
): void {
  database.transaction((connection) => {
    connection.run(
      `INSERT OR IGNORE INTO workspace
        (id, canonical_path, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      ["workspace-1", "/tmp/nexus-runtime-workspace", 1, 1],
    )
    connection.run(
      `INSERT OR IGNORE INTO session
        (id, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      [sessionId, "workspace-1", 1, 1],
    )
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("RuntimeRepository leases", () => {
  it("allows only the fenced owner to renew and release a lease", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      const lease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "cli-1",
        ttlMs: 1_000,
      })

      expect(() =>
        repository.renewSessionLease({
          sessionId: "session-1",
          ownerId: "extension-1",
          epoch: lease.epoch,
          ttlMs: 1_000,
        }),
      ).toThrow(RuntimeConflictError)
      expect(() =>
        repository.releaseSessionLease({
          sessionId: "session-1",
          ownerId: "cli-1",
          epoch: lease.epoch + 1,
        }),
      ).toThrow(RuntimeConflictError)

      now = 200
      expect(
        repository.renewSessionLease({
          sessionId: "session-1",
          ownerId: "cli-1",
          epoch: lease.epoch,
          ttlMs: 1_000,
        }).expiresAt,
      ).toBe(1_200)
      repository.releaseSessionLease({
        sessionId: "session-1",
        ownerId: "cli-1",
        epoch: lease.epoch,
      })
    } finally {
      database.close()
    }
  })

  it("blocks a live owner and replaces an expired owner with a new epoch", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 10
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      const first = repository.claimSession({
        sessionId: "session-1",
        ownerId: "cli-1",
        ttlMs: 50,
      })
      expect(() =>
        repository.claimSession({
          sessionId: "session-1",
          ownerId: "extension-1",
          ttlMs: 50,
        }),
      ).toThrow(RuntimeConflictError)

      now = first.expiresAt
      const replacement = repository.claimSession({
        sessionId: "session-1",
        ownerId: "extension-1",
        ttlMs: 50,
      })
      expect(replacement.epoch).toBe(first.epoch + 1)
      expect(replacement.ownerId).toBe("extension-1")
    } finally {
      database.close()
    }
  })

  it("interrupts an orphaned run when an expired lease is taken over", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 10
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      const oldLease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "old-worker",
        ttlMs: 10,
      })
      repository.startRun({
        id: "orphaned-run",
        sessionId: "session-1",
        ownerId: oldLease.ownerId,
        leaseEpoch: oldLease.epoch,
      })
      repository.createApproval({
        id: "orphaned-approval",
        sessionId: "session-1",
        runId: "orphaned-run",
        ownerId: oldLease.ownerId,
        leaseEpoch: oldLease.epoch,
        toolName: "shell",
        redactedSummary: "Run tests",
        dedupeKey: "orphaned-shell",
      })

      now = oldLease.expiresAt
      const newLease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "new-worker",
        ttlMs: 100,
      })
      expect(() =>
        repository.finishRun({
          runId: "orphaned-run",
          ownerId: oldLease.ownerId,
          leaseEpoch: oldLease.epoch,
          status: "completed",
        }),
      ).toThrow(RuntimeConflictError)
      expect(
        repository.startRun({
          id: "replacement-run",
          sessionId: "session-1",
          ownerId: newLease.ownerId,
          leaseEpoch: newLease.epoch,
        }).status,
      ).toBe("running")
      expect(repository.pendingApprovals("session-1")).toEqual([])
    } finally {
      database.close()
    }
  })

  it("preserves the fencing epoch and settles runtime state on release", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new RuntimeRepository(database, { now: () => now })
    const inputRepository = new SessionInputRepository(database, {
      now: () => now,
    })

    try {
      const oldLease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "old-worker",
        ttlMs: 1_000,
      })
      repository.startRun({
        id: "released-run",
        sessionId: "session-1",
        ownerId: oldLease.ownerId,
        leaseEpoch: oldLease.epoch,
      })
      repository.createApproval({
        id: "released-run-approval",
        sessionId: "session-1",
        runId: "released-run",
        ownerId: oldLease.ownerId,
        leaseEpoch: oldLease.epoch,
        toolName: "shell",
        redactedSummary: "Run tests",
        dedupeKey: "released-run-shell",
      })
      repository.createApproval({
        id: "released-session-approval",
        sessionId: "session-1",
        ownerId: oldLease.ownerId,
        leaseEpoch: oldLease.epoch,
        toolName: "network",
        redactedSummary: "Fetch metadata",
        dedupeKey: "released-session-network",
      })
      inputRepository.admit({
        id: "durable-queued-input",
        sessionId: "session-1",
        delivery: "queue",
        parts: [{ type: "text", text: "Keep this follow-up" }],
      })
      inputRepository.admit({
        id: "durable-steering-input",
        sessionId: "session-1",
        delivery: "steer",
        parts: [{ type: "text", text: "Keep this steering input" }],
      })

      now = 150
      repository.releaseSessionLease({
        sessionId: "session-1",
        ownerId: oldLease.ownerId,
        epoch: oldLease.epoch,
      })

      expect(
        database.read((connection) =>
          connection.get<{
            owner_id: string
            epoch: number
            expires_at: number
          }>(
            `SELECT owner_id, epoch, expires_at
             FROM session_lease
             WHERE session_id = ?`,
            ["session-1"],
          ),
        ),
      ).toEqual({
        owner_id: "old-worker",
        epoch: oldLease.epoch,
        expires_at: 0,
      })
      expect(
        database.read((connection) =>
          connection.get<{ status: string; finished_at: number }>(
            `SELECT status, finished_at FROM run WHERE id = ?`,
            ["released-run"],
          ),
        ),
      ).toEqual({ status: "interrupted", finished_at: 150 })
      expect(
        database.read((connection) =>
          connection.all<{
            id: string
            status: string
            resolved_at: number
          }>(
            `SELECT id, status, resolved_at
             FROM approval
             WHERE session_id = ?
             ORDER BY id`,
            ["session-1"],
          ),
        ),
      ).toEqual([
        {
          id: "released-run-approval",
          status: "cancelled",
          resolved_at: 150,
        },
        {
          id: "released-session-approval",
          status: "cancelled",
          resolved_at: 150,
        },
      ])
      expect(inputRepository.pending("session-1", "queue")).toHaveLength(1)
      expect(inputRepository.pending("session-1", "steer")).toHaveLength(1)

      const replacement = repository.claimSession({
        sessionId: "session-1",
        ownerId: "new-worker",
        ttlMs: 1_000,
      })
      expect(replacement.epoch).toBe(oldLease.epoch + 1)
      expect(() =>
        repository.finishRun({
          runId: "released-run",
          ownerId: oldLease.ownerId,
          leaseEpoch: oldLease.epoch,
          status: "completed",
        }),
      ).toThrow(RuntimeConflictError)
      expect(
        repository.startRun({
          id: "post-release-run",
          sessionId: "session-1",
          ownerId: replacement.ownerId,
          leaseEpoch: replacement.epoch,
        }).status,
      ).toBe("running")
    } finally {
      database.close()
    }
  })

  it("keeps a released lease expired when the clock moves backwards", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      const released = repository.claimSession({
        sessionId: "session-1",
        ownerId: "old-worker",
        ttlMs: 1_000,
      })
      now = 150
      repository.releaseSessionLease({
        sessionId: "session-1",
        ownerId: released.ownerId,
        epoch: released.epoch,
      })

      now = 140
      expect(() =>
        repository.renewSessionLease({
          sessionId: "session-1",
          ownerId: released.ownerId,
          epoch: released.epoch,
          ttlMs: 1_000,
        }),
      ).toThrow(RuntimeConflictError)
      const reclaimed = repository.claimSession({
        sessionId: "session-1",
        ownerId: "new-worker",
        ttlMs: 1_000,
      })
      expect(reclaimed.epoch).toBe(released.epoch + 1)
    } finally {
      database.close()
    }
  })

  it("does not let an expired owner release or mutate runtime state", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      const expired = repository.claimSession({
        sessionId: "session-1",
        ownerId: "expired-worker",
        ttlMs: 10,
      })
      repository.startRun({
        id: "still-running",
        sessionId: "session-1",
        ownerId: expired.ownerId,
        leaseEpoch: expired.epoch,
      })
      repository.createApproval({
        id: "still-pending",
        sessionId: "session-1",
        runId: "still-running",
        ownerId: expired.ownerId,
        leaseEpoch: expired.epoch,
        toolName: "shell",
        redactedSummary: "Do not settle from an expired owner",
        dedupeKey: "expired-release",
      })

      now = expired.expiresAt
      expect(() =>
        repository.releaseSessionLease({
          sessionId: expired.sessionId,
          ownerId: expired.ownerId,
          epoch: expired.epoch,
        }),
      ).toThrow(RuntimeConflictError)
      expect(
        database.read((connection) =>
          connection.get<{ expires_at: number }>(
            "SELECT expires_at FROM session_lease WHERE session_id = ?",
            [expired.sessionId],
          ),
        ),
      ).toEqual({ expires_at: expired.expiresAt })
      expect(
        database.read((connection) =>
          connection.get<{ status: string }>(
            "SELECT status FROM run WHERE id = ?",
            ["still-running"],
          ),
        ),
      ).toEqual({ status: "running" })
      expect(repository.pendingApprovals(expired.sessionId)).toHaveLength(1)

      repository.claimSession({
        sessionId: expired.sessionId,
        ownerId: "replacement-worker",
        ttlMs: 100,
      })
      expect(
        database.read((connection) =>
          connection.get<{ status: string }>(
            "SELECT status FROM run WHERE id = ?",
            ["still-running"],
          ),
        ),
      ).toEqual({ status: "interrupted" })
      expect(repository.pendingApprovals(expired.sessionId)).toEqual([])
    } finally {
      database.close()
    }
  })

  it("treats a repeated release of the same tombstone as a true no-op", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      const lease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "worker",
        ttlMs: 1_000,
      })
      now = 150
      repository.releaseSessionLease({
        sessionId: lease.sessionId,
        ownerId: lease.ownerId,
        epoch: lease.epoch,
      })
      now = 999
      repository.releaseSessionLease({
        sessionId: lease.sessionId,
        ownerId: lease.ownerId,
        epoch: lease.epoch,
      })

      expect(
        database.read((connection) =>
          connection.get<{ expires_at: number; updated_at: number }>(
            `SELECT expires_at, updated_at
             FROM session_lease
             WHERE session_id = ?`,
            [lease.sessionId],
          ),
        ),
      ).toEqual({ expires_at: 0, updated_at: 150 })
    } finally {
      database.close()
    }
  })

  it("does not move lease or settlement timestamps backwards with the clock", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      const lease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "worker",
        ttlMs: 1_000,
      })
      repository.startRun({
        id: "rollback-release-run",
        sessionId: "session-1",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
      })
      repository.createApproval({
        id: "rollback-release-approval",
        sessionId: "session-1",
        runId: "rollback-release-run",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
        toolName: "shell",
        redactedSummary: "Clock-safe action",
        dedupeKey: "clock-safe-release",
      })

      now = 50
      repository.releaseSessionLease({
        sessionId: lease.sessionId,
        ownerId: lease.ownerId,
        epoch: lease.epoch,
      })

      expect(
        database.read((connection) =>
          connection.get<{
            lease_updated_at: number
            finished_at: number
            resolved_at: number
          }>(
            `SELECT session_lease.updated_at AS lease_updated_at,
                    run.finished_at AS finished_at,
                    approval.resolved_at AS resolved_at
             FROM session_lease
             JOIN run ON run.session_id = session_lease.session_id
             JOIN approval ON approval.run_id = run.id
             WHERE session_lease.session_id = ?`,
            [lease.sessionId],
          ),
        ),
      ).toEqual({
        lease_updated_at: 100,
        finished_at: 100,
        resolved_at: 100,
      })
    } finally {
      database.close()
    }
  })

  it("fails closed before incrementing the maximum safe fencing epoch", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    const repository = new RuntimeRepository(database, { now: () => 100 })

    try {
      repository.claimSession({
        sessionId: "session-1",
        ownerId: "old-worker",
        ttlMs: 1_000,
      })
      database.transaction((connection) => {
        connection.run(
          `UPDATE session_lease
           SET epoch = ?, expires_at = 0
           WHERE session_id = ?`,
          [Number.MAX_SAFE_INTEGER, "session-1"],
        )
      })

      expect(() =>
        repository.claimSession({
          sessionId: "session-1",
          ownerId: "new-worker",
          ttlMs: 1_000,
        }),
      ).toThrow(/maximum safe.*epoch/i)
      expect(
        database.read((connection) =>
          connection.get<{ epoch: number; owner_id: string }>(
            `SELECT epoch, owner_id
             FROM session_lease
             WHERE session_id = ?`,
            ["session-1"],
          ),
        ),
      ).toEqual({
        epoch: Number.MAX_SAFE_INTEGER,
        owner_id: "old-worker",
      })
    } finally {
      database.close()
    }
  })

  it("rejects a negative runtime clock value", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    const repository = new RuntimeRepository(database, { now: () => -1 })

    try {
      expect(() =>
        repository.claimSession({
          sessionId: "session-1",
          ownerId: "worker",
          ttlMs: 1_000,
        }),
      ).toThrow(/non-negative safe integer/i)
    } finally {
      database.close()
    }
  })
})

describe("RuntimeRepository runs and approvals", () => {
  it("allows only one active run and makes terminal transitions idempotent", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    const repository = new RuntimeRepository(database, { now: () => 500 })

    try {
      const lease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "server-1",
        ttlMs: 1_000,
      })
      repository.startRun({
        id: "run-1",
        sessionId: "session-1",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
      })
      expect(() =>
        repository.startRun({
          id: "run-2",
          sessionId: "session-1",
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch,
        }),
      ).toThrow(RuntimeConflictError)

      const completed = repository.finishRun({
        runId: "run-1",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
        status: "completed",
      })
      expect(
        repository.finishRun({
          runId: "run-1",
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch,
          status: "completed",
        }),
      ).toEqual(completed)
      expect(() =>
        repository.finishRun({
          runId: "run-1",
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch,
          status: "failed",
        }),
      ).toThrow(RuntimeConflictError)
    } finally {
      database.close()
    }
  })

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "atomically cancels run-bound approvals when a run becomes %s",
    (status) => {
      const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
      seedSession(database)
      let now = 500
      const repository = new RuntimeRepository(database, { now: () => now })

      try {
        const lease = repository.claimSession({
          sessionId: "session-1",
          ownerId: "server-1",
          ttlMs: 1_000,
        })
        repository.startRun({
          id: `run-${status}`,
          sessionId: "session-1",
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch,
        })
        repository.createApproval({
          id: `approval-${status}`,
          sessionId: "session-1",
          runId: `run-${status}`,
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch,
          toolName: "shell",
          redactedSummary: "Run-bound action",
          dedupeKey: `action-${status}`,
        })

        now = 550
        const finished = repository.finishRun({
          runId: `run-${status}`,
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch,
          status,
        })

        expect(finished).toMatchObject({ status, finishedAt: 550 })
        expect(repository.pendingApprovals("session-1")).toEqual([])
        expect(
          database.read((connection) =>
            connection.get<{ status: string; resolved_at: number }>(
              "SELECT status, resolved_at FROM approval WHERE id = ?",
              [`approval-${status}`],
            ),
          ),
        ).toEqual({ status: "cancelled", resolved_at: 550 })
      } finally {
        database.close()
      }
    },
  )

  it("does not finish a run or cancel its approval before their creation time", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      const lease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "server-1",
        ttlMs: 1_000,
      })
      repository.startRun({
        id: "clock-safe-run",
        sessionId: "session-1",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
      })
      repository.createApproval({
        id: "clock-safe-approval",
        sessionId: "session-1",
        runId: "clock-safe-run",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
        toolName: "shell",
        redactedSummary: "Clock-safe action",
        dedupeKey: "clock-safe-finish",
      })

      now = 50
      expect(
        repository.finishRun({
          runId: "clock-safe-run",
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch,
          status: "completed",
        }),
      ).toMatchObject({ startedAt: 100, finishedAt: 100 })
      expect(
        database.read((connection) =>
          connection.get<{ created_at: number; resolved_at: number }>(
            "SELECT created_at, resolved_at FROM approval WHERE id = ?",
            ["clock-safe-approval"],
          ),
        ),
      ).toEqual({ created_at: 100, resolved_at: 100 })
    } finally {
      database.close()
    }
  })

  it("revalidates the live lease before returning an idempotent running run", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      const lease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "server-1",
        ttlMs: 10,
      })
      repository.startRun({
        id: "expiring-run",
        sessionId: "session-1",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
      })

      now = lease.expiresAt
      expect(() =>
        repository.startRun({
          id: "expiring-run",
          sessionId: "session-1",
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch,
        }),
      ).toThrow(/live lease/i)
    } finally {
      database.close()
    }
  })

  it("requires the stored fence for idempotent terminal completion", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    const repository = new RuntimeRepository(database, { now: () => 500 })

    try {
      const lease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "server-1",
        ttlMs: 1_000,
      })
      repository.startRun({
        id: "completed-run",
        sessionId: "session-1",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
      })
      const completed = repository.finishRun({
        runId: "completed-run",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
        status: "completed",
      })

      expect(() =>
        repository.finishRun({
          runId: "completed-run",
          ownerId: "stale-worker",
          leaseEpoch: lease.epoch,
          status: "completed",
        }),
      ).toThrow(RuntimeConflictError)
      expect(() =>
        repository.finishRun({
          runId: "completed-run",
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch + 1,
          status: "completed",
        }),
      ).toThrow(RuntimeConflictError)
      expect(
        repository.finishRun({
          runId: "completed-run",
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch,
          status: "completed",
        }),
      ).toEqual(completed)
    } finally {
      database.close()
    }
  })

  it("keeps unresolved redacted approvals across reopen", () => {
    const path = temporaryDatabasePath()
    const database = NexusStateDatabase.open({ path })
    seedSession(database)
    const repository = new RuntimeRepository(database, { now: () => 700 })
    const lease = repository.claimSession({
      sessionId: "session-1",
      ownerId: "approval-worker",
      ttlMs: 1_000,
    })
    repository.createApproval({
      id: "approval-1",
      sessionId: "session-1",
      ownerId: lease.ownerId,
      leaseEpoch: lease.epoch,
      toolName: "shell",
      redactedSummary: "Run package tests",
      dedupeKey: "run-tests",
    })
    database.close()

    const reopened = NexusStateDatabase.open({ path })
    try {
      const pending = new RuntimeRepository(reopened).pendingApprovals("session-1")
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        id: "approval-1",
        status: "pending",
        redactedSummary: "Run package tests",
      })
      expect(JSON.stringify(pending[0])).not.toMatch(
        /api[_-]?key|password|environment/i,
      )
    } finally {
      reopened.close()
    }
  })

  it("rejects a reused approval dedupe key with different content", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    const repository = new RuntimeRepository(database)

    try {
      const lease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "approval-worker",
        ttlMs: 1_000,
      })
      repository.createApproval({
        id: "approval-1",
        sessionId: "session-1",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
        toolName: "shell",
        redactedSummary: "Run tests",
        dedupeKey: "shell-action",
      })
      expect(() =>
        repository.createApproval({
          id: "approval-2",
          sessionId: "session-1",
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch,
          toolName: "shell",
          redactedSummary: "Delete workspace",
          dedupeKey: "shell-action",
        }),
      ).toThrow(RuntimeConflictError)
    } finally {
      database.close()
    }
  })

  it("rejects an approval whose run belongs to another session", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    seedSession(database, "session-2")
    const repository = new RuntimeRepository(database, { now: () => 800 })

    try {
      const approvalLease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "server-1",
        ttlMs: 1_000,
      })
      const lease = repository.claimSession({
        sessionId: "session-2",
        ownerId: "server-2",
        ttlMs: 1_000,
      })
      repository.startRun({
        id: "session-2-run",
        sessionId: "session-2",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
      })

      expect(() =>
        repository.createApproval({
          id: "cross-session-approval",
          sessionId: "session-1",
          runId: "session-2-run",
          ownerId: approvalLease.ownerId,
          leaseEpoch: approvalLease.epoch,
          toolName: "shell",
          redactedSummary: "Run tests",
          dedupeKey: "cross-session-shell",
        }),
      ).toThrow(RuntimeConflictError)
    } finally {
      database.close()
    }
  })

  it("enforces approval and run session consistency in the schema", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    seedSession(database, "session-2")
    const repository = new RuntimeRepository(database, { now: () => 800 })

    try {
      const lease = repository.claimSession({
        sessionId: "session-2",
        ownerId: "server-2",
        ttlMs: 1_000,
      })
      repository.startRun({
        id: "schema-session-2-run",
        sessionId: "session-2",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
      })

      expect(() =>
        database.transaction((connection) => {
          connection.run(
            `INSERT INTO approval
              (id, session_id, run_id, tool_name, redacted_summary, dedupe_key,
               status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
            [
              "schema-cross-session-approval",
              "session-1",
              "schema-session-2-run",
              "shell",
              "Run tests",
              "schema-cross-session-shell",
              800,
            ],
          )
        }),
      ).toThrow(/same session/i)
    } finally {
      database.close()
    }
  })

  it("rejects approval creation for a run fenced off by lease takeover", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      const oldLease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "old-worker",
        ttlMs: 10,
      })
      repository.startRun({
        id: "fenced-run",
        sessionId: "session-1",
        ownerId: oldLease.ownerId,
        leaseEpoch: oldLease.epoch,
      })

      now = oldLease.expiresAt
      repository.claimSession({
        sessionId: "session-1",
        ownerId: "new-worker",
        ttlMs: 1_000,
      })

      expect(() =>
        repository.createApproval({
          id: "late-stale-approval",
          sessionId: "session-1",
          runId: "fenced-run",
          ownerId: oldLease.ownerId,
          leaseEpoch: oldLease.epoch,
          toolName: "shell",
          redactedSummary: "Late stale action",
          dedupeKey: "late-stale-action",
        }),
      ).toThrow(RuntimeConflictError)
      expect(repository.pendingApprovals("session-1")).toEqual([])
    } finally {
      database.close()
    }
  })

  it("rejects approval resolution from a stale lease fence", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      const oldLease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "old-worker",
        ttlMs: 10,
      })
      now = oldLease.expiresAt
      const currentLease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "new-worker",
        ttlMs: 1_000,
      })
      repository.startRun({
        id: "current-run",
        sessionId: "session-1",
        ownerId: currentLease.ownerId,
        leaseEpoch: currentLease.epoch,
      })
      repository.createApproval({
        id: "current-approval",
        sessionId: "session-1",
        runId: "current-run",
        ownerId: currentLease.ownerId,
        leaseEpoch: currentLease.epoch,
        toolName: "shell",
        redactedSummary: "Current action",
        dedupeKey: "current-action",
      })

      expect(() =>
        repository.resolveApproval({
          approvalId: "current-approval",
          sessionId: "session-1",
          ownerId: oldLease.ownerId,
          leaseEpoch: oldLease.epoch,
          status: "approved",
        }),
      ).toThrow(RuntimeConflictError)
      expect(repository.pendingApprovals("session-1")).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it("keeps approval creation and resolution idempotent under one live fence", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    const repository = new RuntimeRepository(database, { now: () => 500 })

    try {
      const lease = repository.claimSession({
        sessionId: "session-1",
        ownerId: "approval-worker",
        ttlMs: 1_000,
      })
      repository.startRun({
        id: "approval-run",
        sessionId: "session-1",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
      })
      const input = {
        id: "idempotent-approval",
        sessionId: "session-1",
        runId: "approval-run",
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
        toolName: "shell",
        redactedSummary: "Run tests",
        dedupeKey: "idempotent-shell",
      }

      const created = repository.createApproval(input)
      expect(repository.createApproval(input)).toEqual(created)

      const resolution = {
        approvalId: created.id,
        sessionId: created.sessionId,
        ownerId: lease.ownerId,
        leaseEpoch: lease.epoch,
        status: "approved" as const,
      }
      const approved = repository.resolveApproval(resolution)
      expect(repository.resolveApproval(resolution)).toEqual(approved)
      expect(() =>
        repository.resolveApproval({
          ...resolution,
          status: "denied",
        }),
      ).toThrow(RuntimeConflictError)
    } finally {
      database.close()
    }
  })
})

describe("RuntimeRepository projection cursors", () => {
  it("never moves backwards or accepts a divergent checksum", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    const repository = new RuntimeRepository(database, { now: () => 900 })

    try {
      expect(
        repository.advanceProjectionCursor({
          sessionId: "session-1",
          sequence: 10,
          checksum: "checksum-10",
        }),
      ).toMatchObject({ sequence: 10, checksum: "checksum-10" })
      expect(() =>
        repository.advanceProjectionCursor({
          sessionId: "session-1",
          sequence: 9,
          checksum: "checksum-9",
          expectedPreviousChecksum: "checksum-10",
        }),
      ).toThrow(RuntimeConflictError)
      expect(() =>
        repository.advanceProjectionCursor({
          sessionId: "session-1",
          sequence: 10,
          checksum: "divergent",
        }),
      ).toThrow(RuntimeConflictError)
      expect(() =>
        repository.advanceProjectionCursor({
          sessionId: "session-1",
          sequence: 11,
          checksum: "checksum-11",
          expectedPreviousChecksum: "wrong-parent",
        }),
      ).toThrow(RuntimeConflictError)

      expect(
        repository.advanceProjectionCursor({
          sessionId: "session-1",
          sequence: 11,
          checksum: "checksum-11",
          expectedPreviousChecksum: "checksum-10",
        }),
      ).toMatchObject({ sequence: 11, checksum: "checksum-11" })
    } finally {
      database.close()
    }
  })

  it("does not move the projection timestamp backwards", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new RuntimeRepository(database, { now: () => now })

    try {
      repository.advanceProjectionCursor({
        sessionId: "session-1",
        sequence: 1,
        checksum: "checksum-1",
      })
      now = 50
      expect(
        repository.advanceProjectionCursor({
          sessionId: "session-1",
          sequence: 2,
          checksum: "checksum-2",
          expectedPreviousChecksum: "checksum-1",
        }),
      ).toMatchObject({ sequence: 2, updatedAt: 100 })
    } finally {
      database.close()
    }
  })
})
