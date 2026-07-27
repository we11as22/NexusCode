import { describe, expect, it } from "vitest"
import type { MemoryRecord } from "../types.js"
import {
  MAX_MEMORY_CONTENT_CHARS,
  MemoryValueLimitError,
  assertMemoryWriteInput,
  normalizeMemoryRecord,
  redactMemorySecrets,
  retrieveMemories,
} from "./index.js"

function memory(
  id: string,
  title: string,
  content: string,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  const now = Date.now()
  return normalizeMemoryRecord({
    id,
    scope: "project",
    title,
    content,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })
}

describe("memory model and retrieval", () => {
  it("migrates legacy records to the versioned model without losing metadata", () => {
    const migrated = normalizeMemoryRecord({
      id: "legacy",
      scope: "session",
      title: "Pending work",
      content: "Finish the provider adapter",
      createdAt: 10,
      updatedAt: 20,
      metadata: { sessionId: "session-1", kind: "compaction.pending" },
    })

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      kind: "summary",
      trust: "agent",
      confidence: 0.7,
      sensitivity: "normal",
      source: { type: "compaction", sessionId: "session-1" },
      author: { type: "agent" },
      metadata: { sessionId: "session-1", kind: "compaction.pending" },
    })
  })

  it("retrieves Russian morphological variants instead of dropping Cyrillic", () => {
    const result = retrieveMemories({
      memories: [
        memory("index", "Индексирование кодовой базы", "Qdrant обновляется инкрементально."),
        memory("other", "Команды сборки", "Запускать pnpm build."),
      ],
      query: "почему сломалась индексация кода",
      limit: 4,
      maxChars: 4_000,
      now: Date.now(),
    })

    expect(result.items.map((item) => item.memory.id)).toEqual(["index"])
    expect(result.items[0]?.reasons).toContain("query-match")
  })

  it("enforces expiry, supersession, contradiction resolution, and prompt budget", () => {
    const now = 10_000
    const old = memory("old", "Package manager", "Use npm for every command.", {
      updatedAt: 100,
      trust: "agent",
    })
    const correction = memory("new", "Package manager", "Use pnpm through Corepack.", {
      updatedAt: 9_000,
      trust: "user",
      kind: "preference",
      supersedes: ["old"],
      contradicts: ["old"],
    })
    const expired = memory("expired", "Package manager cache", "Use an obsolete cache.", {
      expiresAt: 9_999,
    })
    const huge = memory("huge", "Package manager internals", "x".repeat(10_000))

    const result = retrieveMemories({
      memories: [old, correction, expired, huge],
      query: "package manager pnpm",
      limit: 10,
      maxChars: 900,
      now,
    })

    expect(result.items.map((item) => item.memory.id)).toEqual(["new"])
    expect(result.totalChars).toBeLessThanOrEqual(900)
    expect(result.excluded).toMatchObject({
      expired: 1,
      superseded: 1,
      budget: 1,
    })
  })

  it("does not let a lower-trust record suppress a stronger user memory", () => {
    const user = memory(
      "user-memory",
      "Package manager",
      "Use pnpm for workspace commands.",
      {
        trust: "user",
        author: { type: "user" },
        updatedAt: 100,
      },
    )
    const agent = memory(
      "agent-memory",
      "Package manager override",
      "Use npm for workspace commands.",
      {
        trust: "agent",
        author: { type: "agent" },
        updatedAt: 200,
        supersedes: ["user-memory"],
      },
    )

    const result = retrieveMemories({
      memories: [user, agent],
      query: "package manager workspace commands",
      limit: 10,
      maxChars: 4_000,
      now: 300,
    })

    expect(result.items.map((item) => item.memory.id)).toContain("user-memory")
    expect(result.excluded.superseded).toBe(0)
  })

  it("redacts common credentials before durable storage", () => {
    const raw = [
      "api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "postgres://user:password@example.test/db",
      "-----BEGIN PRIVATE KEY-----",
      "abc",
      "-----END PRIVATE KEY-----",
    ].join("\n")

    const redacted = redactMemorySecrets(raw)
    expect(redacted.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456")
    expect(redacted.text).not.toContain("user:password@")
    expect(redacted.text).not.toContain("BEGIN PRIVATE KEY")
    expect(redacted.redacted).toBe(true)
  })

  it("redacts nested metadata and provenance instead of leaking side-channel secrets", () => {
    const normalized = normalizeMemoryRecord({
      id: "sensitive",
      scope: "project",
      title: "Deployment",
      content: "Use the configured endpoint.",
      source: {
        type: "external",
        uri: "https://user:password@example.test/source",
      },
      author: {
        type: "external",
        id: "token=abcdefghijklmnopqrstuvwxyz123456",
      },
      metadata: {
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        nested: {
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456",
          safe: "kept",
        },
      },
      createdAt: 1,
      updatedAt: 2,
    })

    expect(normalized.source.uri).toBe("https://[redacted]@example.test/source")
    expect(normalized.author.id).toBe("[redacted]")
    expect(normalized.metadata).toEqual({
      authorization: "[redacted]",
      nested: {
        apiKey: "[redacted]",
        safe: "kept",
      },
    })
    expect(normalized.sensitivity).toBe("sensitive")
  })

  it("rejects oversized or non-JSON memory writes before persistence", () => {
    expect(() =>
      assertMemoryWriteInput({
        content: "x".repeat(MAX_MEMORY_CONTENT_CHARS + 1),
      })
    ).toThrow(MemoryValueLimitError)
    expect(() =>
      assertMemoryWriteInput({
        metadata: { invalid: 1n },
      })
    ).toThrow(MemoryValueLimitError)
  })

  it("merges optional healthy vector scores but ignores invalid projection data", () => {
    const semantic = memory("semantic", "Архитектура", "Хранилище проектных знаний")
    const invalid = memory("invalid", "Unrelated", "Nothing relevant")
    const result = retrieveMemories({
      memories: [semantic, invalid],
      query: "completely different words",
      vectorScores: { semantic: 0.92, invalid: Number.NaN },
      limit: 5,
      maxChars: 4_000,
    })

    expect(result.items.map((item) => item.memory.id)).toEqual(["semantic"])
    expect(result.items[0]?.reasons).toContain("vector-match")
  })
})
