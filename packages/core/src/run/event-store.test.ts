import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DurableRunEventSink, RunEventStore } from "./event-store.js"

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-run-events-"))
  roots.push(root)
  const cwd = path.join(root, "workspace")
  const homeDir = path.join(root, ".nexus")
  await mkdir(cwd)
  return { cwd, homeDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("RunEventStore", () => {
  it("serializes concurrent writers with monotonic replayable sequence numbers", async () => {
    const { cwd, homeDir } = await fixture()
    const first = new RunEventStore(cwd, { homeDir })
    const second = new RunEventStore(cwd, { homeDir })
    await first.createRun({ id: "run_concurrent", sessionId: "session-1", mode: "agent" })

    await Promise.all([
      first.appendEvent("run_concurrent", { type: "text_delta", delta: "one", messageId: "m1" }),
      second.appendEvent("run_concurrent", { type: "text_delta", delta: "two", messageId: "m1" }),
    ])

    const replay = await first.readEvents("run_concurrent")
    expect(replay.map((item) => item.seq)).toEqual([1, 2])
    expect(replay.map((item) => item.event.type)).toEqual(["text_delta", "text_delta"])
  })

  it("deduplicates explicit idempotency keys without consuming a sequence", async () => {
    const { cwd, homeDir } = await fixture()
    const store = new RunEventStore(cwd, { homeDir })
    await store.createRun({ id: "run_retry", sessionId: "session-1", mode: "debug" })
    const first = await store.appendEvent(
      "run_retry",
      { type: "compaction_start" },
      "compaction-1",
    )
    const retry = await store.appendEvent(
      "run_retry",
      { type: "compaction_start" },
      "compaction-1",
    )

    expect(retry.seq).toBe(first.seq)
    expect(retry.deduplicated).toBe(true)
    expect(await store.readEvents("run_retry")).toHaveLength(1)
  })

  it("replays the verified prefix after a torn tail and preserves pending approvals", async () => {
    const { cwd, homeDir } = await fixture()
    const store = new RunEventStore(cwd, { homeDir })
    await store.createRun({ id: "run_recovery", sessionId: "session-1", mode: "plan" })
    await store.appendEvent("run_recovery", {
      type: "tool_approval_needed",
      partId: "part-1",
      action: { type: "write", tool: "Write", description: "write a file" },
    })
    await appendFile(store.getJournalPath("run_recovery"), '{"type":"run_event"', "utf8")

    const replay = await store.readEvents("run_recovery")
    const state = await store.getRun("run_recovery")
    expect(replay).toHaveLength(1)
    expect(state?.pendingApprovals).toMatchObject([{ partId: "part-1" }])
    expect(store.getDiagnostics().map((item) => item.code)).toContain("corrupt-event-tail")

    await store.appendEvent("run_recovery", { type: "compaction_end" })
    expect((await store.readEvents("run_recovery")).map((item) => item.seq)).toEqual([1, 2])
    const files = await import("node:fs/promises").then((fs) =>
      fs.readdir(path.dirname(store.getJournalPath("run_recovery"))),
    )
    expect(files.some((file) => file.includes(".events.jsonl.corrupt-"))).toBe(true)
    await store.appendEvent("run_recovery", {
      type: "tool_end",
      tool: "Write",
      partId: "part-1",
      messageId: "message-1",
      success: false,
      error: "User denied Write",
    })
    expect((await store.getRun("run_recovery"))?.pendingApprovals).toEqual([])
  })

  it("does not concatenate a new record onto an unterminated event tail", async () => {
    const { cwd, homeDir } = await fixture()
    const store = new RunEventStore(cwd, { homeDir })
    await store.createRun({ id: "run_unterminated", sessionId: "session-1", mode: "agent" })
    await store.appendEvent("run_unterminated", { type: "compaction_start" })
    const journalPath = store.getJournalPath("run_unterminated")
    const journal = await readFile(journalPath, "utf8")
    await writeFile(journalPath, journal.replace(/\n$/, ""), "utf8")

    expect(await store.readEvents("run_unterminated")).toEqual([])
    await store.appendEvent("run_unterminated", { type: "compaction_end" })
    expect((await store.readEvents("run_unterminated")).map((item) => ({
      seq: item.seq,
      type: item.event.type,
    }))).toEqual([{ seq: 1, type: "compaction_end" }])
  })

  it("restores mode, tool artifacts, and terminal status after reopening", async () => {
    const { cwd, homeDir } = await fixture()
    const store = new RunEventStore(cwd, { homeDir })
    await store.createRun({ id: "run_done", sessionId: "session-1", mode: "review" })
    await store.appendEvent("run_done", {
      type: "tool_end",
      tool: "Read",
      partId: "part-1",
      messageId: "message-1",
      success: true,
      path: "/workspace/file.ts",
      metadata: { outputSpillPath: "/tmp/output.txt" },
    })
    await store.appendEvent("run_done", {
      type: "run_context",
      mode: "review",
      memoryCitations: ["memory:architecture"],
      taskIds: ["task-review"],
    })
    await store.finishRun("run_done", "completed")

    const reopened = new RunEventStore(cwd, { homeDir })
    expect(await reopened.getRun("run_done")).toMatchObject({
      mode: "review",
      status: "completed",
      lastSeq: 2,
      memoryCitations: ["memory:architecture"],
      taskIds: ["task-review"],
      toolArtifacts: [{
        partId: "part-1",
        tool: "Read",
        path: "/workspace/file.ts",
        outputSpillPath: "/tmp/output.txt",
      }],
    })
  })

  it("rejects a semantically tampered snapshot and recovers its verified backup", async () => {
    const { cwd, homeDir } = await fixture()
    const store = new RunEventStore(cwd, { homeDir })
    await store.createRun({ id: "run_snapshot", sessionId: "session-1", mode: "agent" })
    await store.appendEvent("run_snapshot", { type: "done", messageId: "message-1" })
    await store.finishRun("run_snapshot", "completed")

    const snapshotPath = store.getSnapshotPath("run_snapshot")
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      state: { status: string }
    }
    snapshot.state.status = "failed"
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8")

    const reopened = new RunEventStore(cwd, { homeDir })
    expect(await reopened.getRun("run_snapshot")).toMatchObject({
      status: "completed",
      lastSeq: 1,
    })
    expect(reopened.getDiagnostics().map((item) => item.code)).toContain("snapshot-recovered")
  })

  it("delivers local host events only through the durable ordered sink", async () => {
    const { cwd, homeDir } = await fixture()
    const delivered: string[] = []
    const sink = await DurableRunEventSink.create({
      cwd,
      sessionId: "session-1",
      mode: "agent",
      deliver: (event) => delivered.push(event.type),
      options: { homeDir, runId: "run_local" },
    })
    sink.emit({ type: "assistant_message_started", messageId: "message-1" })
    sink.emit({ type: "done", messageId: "message-1" })
    await sink.finish("completed")

    expect(delivered).toEqual(["assistant_message_started", "done"])
    const reopened = new RunEventStore(cwd, { homeDir })
    expect((await reopened.readEvents("run_local")).map((item) => item.event.type))
      .toEqual(delivered)
    expect(await reopened.listRuns({ sessionId: "session-1" })).toMatchObject([
      { id: "run_local", status: "completed" },
    ])
  })
})
