import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  InputConflictError,
  NexusStateDatabase,
  SessionInputRepository,
  type UserInputPartRecord,
} from "./index.js"

const temporaryDirectories: string[] = []

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nexus-input-test-"))
  temporaryDirectories.push(directory)
  return join(directory, "state.sqlite")
}

function seedSession(database: NexusStateDatabase, sessionId = "session-1"): void {
  database.transaction((connection) => {
    connection.run(
      `INSERT OR IGNORE INTO workspace
        (id, canonical_path, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      ["workspace-1", "/tmp/nexus-input-workspace", 1, 1],
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

describe("SessionInputRepository", () => {
  it("makes admission idempotent while rejecting a changed payload", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    const repository = new SessionInputRepository(database, { now: () => 100 })

    try {
      const input = {
        id: "input-1",
        sessionId: "session-1",
        delivery: "queue" as const,
        parts: [{ type: "text" as const, text: "fix the tests" }],
      }
      const admitted = repository.admit(input)

      expect(repository.admit(input)).toEqual(admitted)
      expect(repository.pending("session-1")).toEqual([admitted])
      expect(() =>
        repository.admit({
          ...input,
          parts: [{ type: "text", text: "different request" }],
        }),
      ).toThrow(InputConflictError)
      expect(
        database.read((connection) =>
          connection.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM durable_event",
          ),
        ),
      ).toEqual({ count: 1 })
    } finally {
      database.close()
    }
  })

  it("canonicalizes part keys before checking idempotency", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    const repository = new SessionInputRepository(database)

    try {
      const admitted = repository.admit({
        id: "image-key-order",
        sessionId: "session-1",
        delivery: "queue",
        parts: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      })
      const retried = repository.admit({
        id: "image-key-order",
        sessionId: "session-1",
        delivery: "queue",
        parts: [
          {
            mimeType: "image/png",
            data: "aGVsbG8=",
            type: "image",
          },
        ],
      })

      expect(retried).toEqual(admitted)
    } finally {
      database.close()
    }
  })

  it("promotes steering input through a cutoff in FIFO order", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 0
    const repository = new SessionInputRepository(database, { now: () => ++now })

    try {
      const first = repository.admit({
        id: "steer-1",
        sessionId: "session-1",
        delivery: "steer",
        parts: [{ type: "text", text: "first" }],
      })
      const second = repository.admit({
        id: "steer-2",
        sessionId: "session-1",
        delivery: "steer",
        parts: [{ type: "text", text: "second" }],
      })
      repository.admit({
        id: "steer-3",
        sessionId: "session-1",
        delivery: "steer",
        parts: [{ type: "text", text: "third" }],
      })

      const promoted = repository.promoteSteers(
        "session-1",
        second.admittedSequence,
      )

      expect(promoted.map((input) => input.id)).toEqual(["steer-1", "steer-2"])
      expect(promoted[0]?.promotedSequence).toBeGreaterThan(
        first.admittedSequence,
      )
      expect(promoted[1]?.promotedSequence).toBeGreaterThan(
        promoted[0]?.promotedSequence ?? 0,
      )
      expect(repository.pending("session-1", "steer").map((input) => input.id)).toEqual(
        ["steer-3"],
      )
    } finally {
      database.close()
    }
  })

  it("promotes exactly one queued input in FIFO order", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    const repository = new SessionInputRepository(database)

    try {
      repository.admit({
        id: "queue-1",
        sessionId: "session-1",
        delivery: "queue",
        parts: [{ type: "text", text: "first" }],
      })
      repository.admit({
        id: "queue-2",
        sessionId: "session-1",
        delivery: "queue",
        parts: [{ type: "text", text: "second" }],
      })

      expect(repository.promoteNextQueued("session-1")?.id).toBe("queue-1")
      expect(repository.pending("session-1", "queue").map((input) => input.id)).toEqual(
        ["queue-2"],
      )
      expect(repository.promoteNextQueued("session-1")?.id).toBe("queue-2")
      expect(repository.promoteNextQueued("session-1")).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it("allocates unique sequences across independent database handles", () => {
    const path = temporaryDatabasePath()
    const firstDatabase = NexusStateDatabase.open({ path })
    seedSession(firstDatabase)
    const secondDatabase = NexusStateDatabase.open({ path })
    const firstRepository = new SessionInputRepository(firstDatabase)
    const secondRepository = new SessionInputRepository(secondDatabase)

    try {
      const first = firstRepository.admit({
        id: "handle-1",
        sessionId: "session-1",
        delivery: "queue",
        parts: [{ type: "text", text: "one" }],
      })
      const second = secondRepository.admit({
        id: "handle-2",
        sessionId: "session-1",
        delivery: "queue",
        parts: [{ type: "text", text: "two" }],
      })

      expect(second.admittedSequence).toBe(first.admittedSequence + 1)
    } finally {
      secondDatabase.close()
      firstDatabase.close()
    }
  })

  it("round-trips text and image parts through close and reopen", () => {
    const path = temporaryDatabasePath()
    const parts: readonly UserInputPartRecord[] = [
      { type: "text", text: "inspect this image" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]
    const database = NexusStateDatabase.open({ path })
    seedSession(database)
    new SessionInputRepository(database).admit({
      id: "multimodal-1",
      sessionId: "session-1",
      delivery: "queue",
      parts,
    })
    database.close()

    const reopened = NexusStateDatabase.open({ path })
    try {
      expect(
        new SessionInputRepository(reopened).pending("session-1")[0]?.parts,
      ).toEqual(parts)
    } finally {
      reopened.close()
    }
  })
})
