import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { SessionMessage } from "../types.js"
import {
  SessionConflictError,
  SessionStore,
  UnsafeSessionIdError,
  type StoredSession,
} from "./storage.js"

const roots: string[] = []

async function fixture(): Promise<{ root: string; cwd: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-session-store-"))
  const cwd = path.join(root, "workspace")
  await mkdir(cwd)
  roots.push(root)
  return { root, cwd }
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function message(id: string, text = id): SessionMessage {
  return { id, ts: Date.now(), role: "user", content: text }
}

function stored(id: string, cwd: string, messages: SessionMessage[] = []): StoredSession {
  return { id, cwd, ts: Date.now(), todo: "", messages, revision: 0 }
}

describe("SessionStore journal v2", () => {
  it("round-trips a checksummed revision and increments monotonically", async () => {
    const { root, cwd } = await fixture()
    const store = new SessionStore({ homeDir: root })

    const firstRevision = await store.saveSession(stored("session_roundtrip", cwd, [message("m1")]), {
      expectedRevision: 0,
    })
    const loaded = await store.loadSession("session_roundtrip", cwd)
    const secondRevision = await store.saveSession(
      { ...loaded!, messages: [...loaded!.messages, message("m2")] },
      { expectedRevision: loaded!.revision },
    )
    const beforeRewind = await store.loadSession("session_roundtrip", cwd)
    const thirdRevision = await store.saveSession(
      { ...beforeRewind!, messages: beforeRewind!.messages.slice(0, 1) },
      { expectedRevision: beforeRewind!.revision },
    )

    expect(firstRevision).toBe(1)
    expect(secondRevision).toBe(2)
    expect(thirdRevision).toBe(3)
    await expect(store.loadSession("session_roundtrip", cwd)).resolves.toMatchObject({
      revision: 3,
      messages: [{ id: "m1" }],
    })
  })

  it.each(["../escape", "..", "a/b", "a\\b", "", ".hidden", "x".repeat(129)])(
    "rejects unsafe session id %j",
    async (sessionId) => {
      const { root, cwd } = await fixture()
      const store = new SessionStore({ homeDir: root })
      await expect(store.loadSession(sessionId, cwd)).rejects.toBeInstanceOf(UnsafeSessionIdError)
    },
  )

  it("detects stale writers instead of silently dropping newer messages", async () => {
    const { root, cwd } = await fixture()
    const store = new SessionStore({ homeDir: root })
    await store.saveSession(stored("session_conflict", cwd, [message("m1")]), { expectedRevision: 0 })
    const writerA = await store.loadSession("session_conflict", cwd)
    const writerB = await store.loadSession("session_conflict", cwd)

    await store.saveSession(
      { ...writerA!, messages: [...writerA!.messages, message("from-a")] },
      { expectedRevision: writerA!.revision },
    )

    await expect(
      store.saveSession(
        { ...writerB!, messages: [...writerB!.messages, message("from-b")] },
        { expectedRevision: writerB!.revision },
      ),
    ).rejects.toBeInstanceOf(SessionConflictError)
  })

  it("serializes concurrent transactional mutations without lost updates", async () => {
    const { root, cwd } = await fixture()
    const store = new SessionStore({ homeDir: root })
    await store.saveSession(stored("session_concurrent", cwd), { expectedRevision: 0 })

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.mutateSession("session_concurrent", cwd, (current) => ({
          ...current,
          messages: [...current.messages, message(`m${index}`)],
        })),
      ),
    )

    const loaded = await store.loadSession("session_concurrent", cwd)
    expect(loaded?.revision).toBe(13)
    expect(new Set(loaded?.messages.map((item) => item.id))).toEqual(
      new Set(Array.from({ length: 12 }, (_, index) => `m${index}`)),
    )
  })

  it("recovers a torn tail, reports it, and quarantines it on the next mutation", async () => {
    const { root, cwd } = await fixture()
    const diagnostics: string[] = []
    const store = new SessionStore({
      homeDir: root,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    })
    await store.saveSession(stored("session_torn", cwd, [message("m1")]), { expectedRevision: 0 })
    const journal = store.getSessionPath("session_torn", cwd)
    await appendFile(journal, '{"type":"session_snapshot","sequence":2', "utf8")

    const recovered = await store.loadSession("session_torn", cwd)
    expect(recovered?.revision).toBe(1)
    expect(recovered?.messages.map((item) => item.id)).toEqual(["m1"])
    expect(diagnostics).toContain("corrupt-journal-tail")
    expect(store.getDiagnostics().map((diagnostic) => diagnostic.code)).toContain(
      "corrupt-journal-tail",
    )

    await store.mutateSession("session_torn", cwd, (current) => ({
      ...current,
      messages: [...current.messages, message("m2")],
    }))

    const files = await readdir(path.dirname(journal))
    expect(files.some((file) => file.startsWith("session_torn.jsonl.corrupt-"))).toBe(true)
    await expect(store.loadSession("session_torn", cwd)).resolves.toMatchObject({
      revision: 2,
      messages: [{ id: "m1" }, { id: "m2" }],
    })
  })

  it("reads legacy JSONL and migrates it idempotently without changing the backup", async () => {
    const { root, cwd } = await fixture()
    const store = new SessionStore({ homeDir: root })
    const journal = store.getSessionPath("session_legacy", cwd)
    await mkdir(path.dirname(journal), { recursive: true })
    const legacy = [
      JSON.stringify({ id: "session_legacy", cwd, ts: 100, title: "Legacy", todo: "old" }),
      JSON.stringify(message("m1")),
      "",
    ].join("\n")
    await writeFile(journal, legacy, "utf8")

    const loaded = await store.loadSession("session_legacy", cwd)
    expect(loaded).toMatchObject({ revision: 0, title: "Legacy", messages: [{ id: "m1" }] })

    await store.saveSession(
      { ...loaded!, messages: [...loaded!.messages, message("m2")] },
      { expectedRevision: 0 },
    )
    const backupPath = `${journal}.legacy-v1.bak`
    expect(await readFile(backupPath, "utf8")).toBe(legacy)

    await store.mutateSession("session_legacy", cwd, (current) => ({
      ...current,
      todo: "migrated",
    }))
    expect(await readFile(backupPath, "utf8")).toBe(legacy)
    expect(JSON.parse((await readFile(journal, "utf8")).split("\n")[0]!)).toMatchObject({
      type: "session_header",
      schemaVersion: 2,
    })
  })

  it("compacts a long snapshot chain without resetting its revision", async () => {
    const { root, cwd } = await fixture()
    const store = new SessionStore({
      homeDir: root,
      compactAfterRecords: 2,
      compactAfterBytes: Number.MAX_SAFE_INTEGER,
    })
    await store.saveSession(stored("session_compact", cwd), { expectedRevision: 0 })
    await store.mutateSession("session_compact", cwd, (current) => ({ ...current, todo: "one" }))
    await store.mutateSession("session_compact", cwd, (current) => ({ ...current, todo: "two" }))

    const journal = await readFile(store.getSessionPath("session_compact", cwd), "utf8")
    expect(journal.trimEnd().split("\n")).toHaveLength(2)
    await expect(store.loadSession("session_compact", cwd)).resolves.toMatchObject({
      revision: 3,
      todo: "two",
    })
  })

  it("keeps metadata, pagination, listing, and deletion consistent", async () => {
    const { root, cwd } = await fixture()
    const store = new SessionStore({ homeDir: root })
    await store.saveSession(
      {
        ...stored("session_crud", cwd, [message("m1"), message("m2"), message("m3")]),
        title: "CRUD",
      },
      { expectedRevision: 0 },
    )

    await expect(store.getSessionMeta("session_crud", cwd)).resolves.toMatchObject({
      id: "session_crud",
      title: "CRUD",
      messageCount: 3,
      revision: 1,
    })
    await expect(store.loadSessionMessages("session_crud", cwd, 1, 1)).resolves.toMatchObject({
      messages: [{ id: "m2" }],
    })
    await expect(store.listSessions(cwd)).resolves.toMatchObject([
      { id: "session_crud", title: "CRUD", messageCount: 3, revision: 1 },
    ])
    await expect(store.deleteSession("session_crud", cwd)).resolves.toBe(true)
    await expect(store.loadSession("session_crud", cwd)).resolves.toBeNull()
  })

  it("does not create a new revision for an idempotent mutation", async () => {
    const { root, cwd } = await fixture()
    const store = new SessionStore({ homeDir: root })
    await store.saveSession(stored("session_idempotent", cwd, [message("m1")]), {
      expectedRevision: 0,
    })

    const unchanged = await store.mutateSession("session_idempotent", cwd, (current) => ({
      ...current,
      messages: [...current.messages],
    }))

    expect(unchanged?.revision).toBe(1)
    expect((await store.loadSession("session_idempotent", cwd))?.revision).toBe(1)
  })
})
