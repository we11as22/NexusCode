import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { SessionMessage } from "../types.js"
import { truncateOutput } from "../context/truncate.js"
import { getToolOutputSessionDir } from "../data-dir.js"
import { OrchestrationRuntime } from "../orchestration/runtime.js"
import { getSessionMemoryFilePath } from "./session-memory.js"
import {
  deleteSession as deleteStoredSession,
  getSessionsDir,
  SessionConflictError,
  SessionStore,
  UnsafeSessionIdError,
  type SessionStoreOptions,
  type StoredSession,
} from "./storage.js"

const roots: string[] = []
const previousDataHome = process.env.NEXUS_DATA_HOME

async function fixture(): Promise<{ root: string; cwd: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-session-store-"))
  const cwd = path.join(root, "workspace")
  await mkdir(cwd)
  roots.push(root)
  return { root, cwd }
}

afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.NEXUS_DATA_HOME
  else process.env.NEXUS_DATA_HOME = previousDataHome
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

  it("deletes exact session-owned memory, checkpoints, and artifacts before the transcript", async () => {
    const { root, cwd } = await fixture()
    process.env.NEXUS_DATA_HOME = path.join(root, "data")
    const store = new SessionStore({ homeDir: root })
    await store.saveSession(stored("session_cleanup", cwd), {
      expectedRevision: 0,
    })

    const sessionMemory = getSessionMemoryFilePath(
      "session_cleanup",
      cwd,
      root,
    )
    await writeFile(sessionMemory, "private session memory", "utf8")
    await writeFile(`${sessionMemory}.bak`, "old private memory", "utf8")

    const checkpoints = path.join(
      getSessionsDir(cwd, root),
      "checkpoints.json",
    )
    await writeFile(
      checkpoints,
      JSON.stringify({
        session_cleanup: [{ hash: "owned" }],
        session_other: [{ hash: "preserved" }],
      }),
      "utf8",
    )

    const artifact = await truncateOutput("owned output ".repeat(128), {
      cwd,
      sessionId: "session_cleanup",
      maxBytes: 16,
    })
    if (!artifact.truncated || !artifact.absolutePath) {
      throw new Error("expected a persisted artifact")
    }
    const unrelatedCorruptPrefix = `${store.getSessionPath(
      "session_cleanup",
      cwd,
    )}.corrupt-user-note`
    await writeFile(
      unrelatedCorruptPrefix,
      "not a Nexus quarantine",
      "utf8",
    )

    await expect(store.deleteSession("session_cleanup", cwd)).resolves.toBe(
      true,
    )

    await expect(access(sessionMemory)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(access(`${sessionMemory}.bak`)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(access(artifact.absolutePath)).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(JSON.parse(await readFile(checkpoints, "utf8"))).toEqual({
      session_other: [{ hash: "preserved" }],
    })
    await expect(
      access(store.getSessionPath("session_cleanup", cwd)),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(access(unrelatedCorruptPrefix)).resolves.toBeUndefined()
  })

  it("cleans exact ancillary state even when the authoritative transcript is already missing", async () => {
    const { root, cwd } = await fixture()
    process.env.NEXUS_DATA_HOME = path.join(root, "data")
    const store = new SessionStore({ homeDir: root })
    const artifact = await truncateOutput("orphaned output ".repeat(128), {
      cwd,
      sessionId: "session_missing_journal",
      maxBytes: 16,
    })
    if (!artifact.truncated || !artifact.absolutePath) {
      throw new Error("expected a persisted artifact")
    }
    const memoryPath = getSessionMemoryFilePath(
      "session_missing_journal",
      cwd,
      root,
    )
    await mkdir(path.dirname(memoryPath), { recursive: true })
    await writeFile(memoryPath, "orphaned memory", "utf8")
    const checkpoints = path.join(
      getSessionsDir(cwd, root),
      "checkpoints.json",
    )
    await writeFile(
      checkpoints,
      JSON.stringify({
        session_missing_journal: [{ hash: "remove" }],
        session_other: [{ hash: "preserve" }],
      }),
      "utf8",
    )

    await expect(
      store.deleteSession("session_missing_journal", cwd),
    ).resolves.toBe(false)

    await expect(access(artifact.absolutePath)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(access(memoryPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(JSON.parse(await readFile(checkpoints, "utf8"))).toEqual({
      session_other: [{ hash: "preserve" }],
    })
  })

  it("keeps the transcript as a retry ledger when artifact references cannot be scanned safely", async () => {
    const { root, cwd } = await fixture()
    process.env.NEXUS_DATA_HOME = path.join(root, "data")
    const store = new SessionStore({ homeDir: root })
    await store.saveSession(stored("session_scan_retry", cwd), {
      expectedRevision: 0,
    })
    const artifact = await truncateOutput("retry output ".repeat(128), {
      cwd,
      sessionId: "session_scan_retry",
      maxBytes: 16,
    })
    if (!artifact.truncated || !artifact.absolutePath) {
      throw new Error("expected a persisted artifact")
    }
    const corruptJournal = store.getSessionPath(
      "session_corrupt_peer",
      cwd,
    )
    await writeFile(corruptJournal, "not-json\n", "utf8")

    await expect(
      store.deleteSession("session_scan_retry", cwd),
    ).rejects.toThrow(/references could not be scanned/i)
    await expect(
      store.loadSession("session_scan_retry", cwd),
    ).resolves.not.toBeNull()
    await expect(access(artifact.absolutePath)).resolves.toBeUndefined()

    await writeFile(corruptJournal, "", "utf8")
    await expect(
      store.deleteSession("session_scan_retry", cwd),
    ).resolves.toBe(true)
    await expect(access(artifact.absolutePath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("can delete a corrupt target journal without trusting it as a reference source", async () => {
    const { root, cwd } = await fixture()
    process.env.NEXUS_DATA_HOME = path.join(root, "data")
    const store = new SessionStore({ homeDir: root })
    const targetJournal = store.getSessionPath(
      "session_corrupt_target",
      cwd,
    )
    await mkdir(path.dirname(targetJournal), { recursive: true })
    await writeFile(targetJournal, "not-json\n", "utf8")
    const artifact = await truncateOutput("corrupt owner ".repeat(128), {
      cwd,
      sessionId: "session_corrupt_target",
      maxBytes: 16,
    })
    if (!artifact.truncated || !artifact.absolutePath) {
      throw new Error("expected a persisted artifact")
    }

    await expect(
      store.deleteSession("session_corrupt_target", cwd),
    ).resolves.toBe(true)
    await expect(access(targetJournal)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(access(artifact.absolutePath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("preserves lookalike files that are not exact Nexus artifact UUIDs", async () => {
    const { root, cwd } = await fixture()
    process.env.NEXUS_DATA_HOME = path.join(root, "data")
    const store = new SessionStore({ homeDir: root })
    await store.saveSession(stored("session_exact_artifact", cwd), {
      expectedRevision: 0,
    })
    const sessionDir = getToolOutputSessionDir(
      cwd,
      "session_exact_artifact",
    )
    await mkdir(sessionDir, { recursive: true })
    const lookalike = path.join(
      sessionDir,
      "artifact_------------------------------------.out",
    )
    await writeFile(lookalike, "user-owned lookalike", "utf8")

    await expect(
      store.deleteSession("session_exact_artifact", cwd),
    ).resolves.toBe(true)
    await expect(access(lookalike)).resolves.toBeUndefined()
  })

  it("retains an owned artifact while another durable transcript references it", async () => {
    const { root, cwd } = await fixture()
    process.env.NEXUS_DATA_HOME = path.join(root, "data")
    const store = new SessionStore({ homeDir: root })
    const artifact = await truncateOutput("shared output ".repeat(128), {
      cwd,
      sessionId: "session_source",
      maxBytes: 16,
    })
    if (
      !artifact.truncated ||
      !artifact.absolutePath ||
      !artifact.artifactId
    ) {
      throw new Error("expected a persisted artifact")
    }
    await store.saveSession(stored("session_source", cwd), {
      expectedRevision: 0,
    })
    await store.saveSession(
      stored("session_parent", cwd, [{
        id: "assistant-parent",
        ts: Date.now(),
        role: "assistant",
        content: [{
          type: "tool",
          id: "merged-tool",
          tool: "Read",
          status: "completed",
          output: "Use ToolOutputRead",
          outputArtifactId: artifact.artifactId,
          outputArtifactOwnerSessionId: "session_source",
          mergedFromSubagent: true,
        }],
      }]),
      { expectedRevision: 0 },
    )

    await expect(store.deleteSession("session_source", cwd)).resolves.toBe(
      true,
    )

    await expect(access(artifact.absolutePath)).resolves.toBeUndefined()
    await expect(
      store.loadSession("session_parent", cwd),
    ).resolves.toMatchObject({
      messages: [{
        content: [{
          outputArtifactId: artifact.artifactId,
          outputArtifactOwnerSessionId: "session_source",
        }],
      }],
    })
  })

  it("does not let protected artifacts starve a bounded cleanup batch", async () => {
    const { root, cwd } = await fixture()
    process.env.NEXUS_DATA_HOME = path.join(root, "data")
    const store = new SessionStore({
      homeDir: root,
      toolOutputDeleteBatchSize: 1,
    })
    const protectedArtifact = await truncateOutput(
      "protected output ".repeat(128),
      {
        cwd,
        sessionId: "session_bounded_source",
        maxBytes: 16,
      },
    )
    const abandonedArtifact = await truncateOutput(
      "abandoned output ".repeat(128),
      {
        cwd,
        sessionId: "session_bounded_source",
        maxBytes: 16,
      },
    )
    if (
      !protectedArtifact.truncated ||
      !protectedArtifact.absolutePath ||
      !protectedArtifact.artifactId ||
      !abandonedArtifact.truncated ||
      !abandonedArtifact.absolutePath
    ) {
      throw new Error("expected persisted artifacts")
    }
    await store.saveSession(stored("session_bounded_source", cwd), {
      expectedRevision: 0,
    })
    await store.saveSession(
      stored("session_bounded_parent", cwd, [{
        id: "assistant-bounded-parent",
        ts: Date.now(),
        role: "assistant",
        content: [{
          type: "tool",
          id: "bounded-merged-tool",
          tool: "Read",
          status: "completed",
          output: "protected capability",
          outputArtifactId: protectedArtifact.artifactId,
          outputArtifactOwnerSessionId: "session_bounded_source",
        }],
      }]),
      { expectedRevision: 0 },
    )

    await expect(
      store.deleteSession("session_bounded_source", cwd),
    ).resolves.toBe(true)
    await expect(access(protectedArtifact.absolutePath)).resolves.toBeUndefined()
    await expect(access(abandonedArtifact.absolutePath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("retains a legacy owned spill path referenced by another durable transcript", async () => {
    const { root, cwd } = await fixture()
    process.env.NEXUS_DATA_HOME = path.join(root, "data")
    const store = new SessionStore({ homeDir: root })
    const artifact = await truncateOutput("legacy shared ".repeat(128), {
      cwd,
      sessionId: "session_legacy_source",
      maxBytes: 16,
    })
    if (!artifact.truncated || !artifact.absolutePath) {
      throw new Error("expected a persisted artifact")
    }
    await store.saveSession(stored("session_legacy_source", cwd), {
      expectedRevision: 0,
    })
    await store.saveSession(
      stored("session_legacy_parent", cwd, [{
        id: "assistant-legacy-parent",
        ts: Date.now(),
        role: "assistant",
        content: [{
          type: "tool",
          id: "legacy-merged-tool",
          tool: "Read",
          status: "completed",
          output: "legacy reference",
          outputSpillPath: artifact.absolutePath,
        }],
      }]),
      { expectedRevision: 0 },
    )

    await expect(
      store.deleteSession("session_legacy_source", cwd),
    ).resolves.toBe(true)
    await expect(access(artifact.absolutePath)).resolves.toBeUndefined()
  })

  it("keeps the transcript as a retry ledger when bounded artifact cleanup is incomplete", async () => {
    const { root, cwd } = await fixture()
    process.env.NEXUS_DATA_HOME = path.join(root, "data")
    const store = new SessionStore({
      homeDir: root,
      toolOutputDeleteBatchSize: 1,
    } as SessionStoreOptions)
    await store.saveSession(stored("session_retry_cleanup", cwd), {
      expectedRevision: 0,
    })
    const first = await truncateOutput("first".repeat(128), {
      cwd,
      sessionId: "session_retry_cleanup",
      maxBytes: 16,
    })
    const second = await truncateOutput("second".repeat(128), {
      cwd,
      sessionId: "session_retry_cleanup",
      maxBytes: 16,
    })
    if (
      !first.truncated ||
      !first.absolutePath ||
      !second.truncated ||
      !second.absolutePath
    ) {
      throw new Error("expected persisted artifacts")
    }

    await expect(
      store.deleteSession("session_retry_cleanup", cwd),
    ).rejects.toThrow(/bounded batch limit/i)
    await expect(
      store.loadSession("session_retry_cleanup", cwd),
    ).resolves.not.toBeNull()

    await expect(
      store.deleteSession("session_retry_cleanup", cwd),
    ).resolves.toBe(true)
    await expect(access(first.absolutePath)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(access(second.absolutePath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("coordinates public deletion with orchestration cleanup before removing the transcript", async () => {
    const { root, cwd } = await fixture()
    const store = new SessionStore({ homeDir: root })
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir: root,
      reconcileStaleRuns: false,
    })
    await store.saveSession(stored("session_coordinated", cwd), {
      expectedRevision: 0,
    })
    await runtime.createTask({
      id: "task_coordinated",
      subject: "cleanup",
      description: "terminal projection",
      status: "completed",
      sessionId: "session_coordinated",
    })

    await expect(
      deleteStoredSession(
        "session_coordinated",
        cwd,
        { store, runtime },
      ),
    ).resolves.toBe(true)

    await expect(runtime.getTask("task_coordinated")).resolves.toBeNull()
    await expect(
      store.loadSession("session_coordinated", cwd),
    ).resolves.toBeNull()
  })

  it("retries orchestration cleanup even after the transcript is already missing", async () => {
    const { root, cwd } = await fixture()
    const store = new SessionStore({ homeDir: root })
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir: root,
      reconcileStaleRuns: false,
    })
    await runtime.createTask({
      id: "task_missing_transcript",
      subject: "stale projection",
      description: "must remain retryable without the JSONL",
      status: "completed",
      sessionId: "session_missing_transcript",
    })

    await expect(
      deleteStoredSession(
        "session_missing_transcript",
        cwd,
        { store, runtime },
      ),
    ).resolves.toBe(false)
    await expect(runtime.getTask("task_missing_transcript")).resolves.toBeNull()
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
