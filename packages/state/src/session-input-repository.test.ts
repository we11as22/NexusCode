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
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid admission clock value %s without consuming a sequence",
    (now) => {
      const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
      seedSession(database)
      const repository = new SessionInputRepository(database, { now: () => now })

      try {
        expect(() =>
          repository.admit({
            id: "invalid-clock-input",
            sessionId: "session-1",
            delivery: "queue",
            parts: [{ type: "text", text: "safe payload" }],
          }),
        ).toThrow(/clock.*non-negative safe integer/i)
        expect(
          database.read((connection) =>
            connection.get<{ inputs: number; events: number; sequences: number }>(
              `SELECT
                 (SELECT COUNT(*) FROM session_input) AS inputs,
                 (SELECT COUNT(*) FROM durable_event) AS events,
                 (SELECT COUNT(*) FROM aggregate_sequence) AS sequences`,
            ),
          ),
        ).toEqual({ inputs: 0, events: 0, sequences: 0 })
      } finally {
        database.close()
      }
    },
  )

  it("rejects an invalid promotion clock without promoting the input", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 1
    const repository = new SessionInputRepository(database, { now: () => now })

    try {
      repository.admit({
        id: "promotion-clock-input",
        sessionId: "session-1",
        delivery: "queue",
        parts: [{ type: "text", text: "safe payload" }],
      })
      now = -1
      expect(() => repository.promoteNextQueued("session-1")).toThrow(
        /clock.*non-negative safe integer/i,
      )
      expect(repository.pending("session-1", "queue")).toHaveLength(1)
      expect(
        database.read((connection) =>
          connection.get<{ events: number; sequence: number }>(
            `SELECT
               (SELECT COUNT(*) FROM durable_event) AS events,
               (SELECT last_sequence FROM aggregate_sequence
                WHERE aggregate_id = 'session:session-1') AS sequence`,
          ),
        ),
      ).toEqual({ events: 1, sequence: 1 })
    } finally {
      database.close()
    }
  })

  it("keeps durable event timestamps monotonic when the clock moves backwards", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    let now = 100
    const repository = new SessionInputRepository(database, { now: () => now })

    try {
      repository.admit({
        id: "clock-monotonic-input",
        sessionId: "session-1",
        delivery: "queue",
        parts: [{ type: "text", text: "safe payload" }],
      })
      now = 50
      repository.promoteNextQueued("session-1")

      expect(
        database.read((connection) =>
          connection.all<{ created_at: number }>(
            `SELECT created_at
             FROM durable_event
             WHERE aggregate_id = ?
             ORDER BY sequence`,
            ["session:session-1"],
          ),
        ),
      ).toEqual([{ created_at: 100 }, { created_at: 100 }])
    } finally {
      database.close()
    }
  })

  it.each([
    [
      "empty text",
      [{ type: "text", text: "" }],
      /text.*at least one|text.*empty/i,
    ],
    [
      "unsupported image MIME",
      [{ type: "image", data: "aGVsbG8=", mimeType: "image/svg+xml" }],
      /image.*mime/i,
    ],
    [
      "non-base64 image",
      [{ type: "image", data: "not-base64", mimeType: "image/png" }],
      /base64/i,
    ],
    [
      "too many parts",
      Array.from({ length: 65 }, () => ({ type: "text", text: "x" })),
      /at most 64/i,
    ],
    [
      "too many images",
      Array.from({ length: 9 }, () => ({
        type: "image",
        data: "aA==",
        mimeType: "image/png",
      })),
      /at most 8.*image/i,
    ],
    [
      "oversized aggregate text",
      [{ type: "text", text: "x".repeat((1 << 20) + 1) }],
      /text.*1048576|text.*limit/i,
    ],
  ] as const)(
    "rejects %s before persisting an input",
    (_description, parts, expectedError) => {
      const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
      seedSession(database)
      const repository = new SessionInputRepository(database)

      try {
        expect(() =>
          repository.admit({
            id: "invalid-parts-input",
            sessionId: "session-1",
            delivery: "queue",
            parts: parts as readonly UserInputPartRecord[],
          }),
        ).toThrow(expectedError)
        expect(repository.pending("session-1")).toEqual([])
      } finally {
        database.close()
      }
    },
  )

  it("rejects identifiers outside the protocol-safe form", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedSession(database)
    const repository = new SessionInputRepository(database)

    try {
      expect(() =>
        repository.admit({
          id: "contains whitespace",
          sessionId: "session-1",
          delivery: "queue",
          parts: [{ type: "text", text: "payload" }],
        }),
      ).toThrow(/identifier/i)
    } finally {
      database.close()
    }
  })

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

  it("round-trips mention and skill parts used by protocol v2", () => {
    const path = temporaryDatabasePath()
    const parts = [
      { type: "mention", name: "database.ts", path: "packages/state/src/database.ts" },
      { type: "skill", name: "systematic-debugging" },
    ] as const
    const database = NexusStateDatabase.open({ path })
    seedSession(database)

    try {
      const admitted = new SessionInputRepository(database).admit({
        id: "context-parts",
        sessionId: "session-1",
        delivery: "queue",
        parts,
      })
      expect(admitted.parts).toEqual(parts)
    } finally {
      database.close()
    }

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
