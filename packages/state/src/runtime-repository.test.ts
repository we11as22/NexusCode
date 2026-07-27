import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  NexusStateDatabase,
  RuntimeConflictError,
  RuntimeRepository,
} from "./index.js"

const temporaryDirectories: string[] = []

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nexus-runtime-state-test-"))
  temporaryDirectories.push(directory)
  return join(directory, "state.sqlite")
}

function seedSession(database: NexusStateDatabase): void {
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
      ["session-1", "workspace-1", 1, 1],
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

  it("keeps unresolved redacted approvals across reopen", () => {
    const path = temporaryDatabasePath()
    const database = NexusStateDatabase.open({ path })
    seedSession(database)
    const repository = new RuntimeRepository(database, { now: () => 700 })
    repository.createApproval({
      id: "approval-1",
      sessionId: "session-1",
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
      repository.createApproval({
        id: "approval-1",
        sessionId: "session-1",
        toolName: "shell",
        redactedSummary: "Run tests",
        dedupeKey: "shell-action",
      })
      expect(() =>
        repository.createApproval({
          id: "approval-2",
          sessionId: "session-1",
          toolName: "shell",
          redactedSummary: "Delete workspace",
          dedupeKey: "shell-action",
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
})
