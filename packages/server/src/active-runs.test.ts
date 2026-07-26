import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  appendRunEvent,
  createActiveRun,
  evictFinishedRun,
  finishRun,
  getBufferedRunEvents,
  getOrRestoreRun,
  replayAndSubscribeToRun,
} from "./active-runs.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable active runs", () => {
  it("coalesces concurrent creation attempts for the same client run id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-active-run-"))
    roots.push(root)
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    await mkdir(cwd)

    const [first, second] = await Promise.all([
      createActiveRun("session-0", cwd, "agent", { homeDir, runId: "run_client_retry" }),
      createActiveRun("session-0", cwd, "agent", { homeDir, runId: "run_client_retry" }),
    ])

    expect(second.id).toBe(first.id)
    expect(second.abortController).toBe(first.abortController)
    await finishRun(first.id)
  })

  it("replays persisted events after the in-memory registry is lost", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-active-run-"))
    roots.push(root)
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    await mkdir(cwd)
    const created = await createActiveRun("session-1", cwd, "agent", { homeDir })
    appendRunEvent(created.id, {
      type: "text_delta",
      delta: "persisted",
      messageId: "message-1",
    })
    await finishRun(created.id)
    expect(evictFinishedRun(created.id)).toBe(true)

    const restored = await getOrRestoreRun(created.id, cwd, { homeDir })
    expect(restored).toMatchObject({ id: created.id, done: true })
    expect(await getBufferedRunEvents(created.id)).toMatchObject([
      { seq: 1, event: { type: "text_delta", delta: "persisted" } },
    ])
  })

  it("replays events older than the bounded in-memory stream buffer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-active-run-"))
    roots.push(root)
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    await mkdir(cwd)
    const created = await createActiveRun("session-2", cwd, "agent", { homeDir })
    for (let index = 0; index < 1_510; index += 1) {
      appendRunEvent(created.id, {
        type: "text_delta",
        delta: String(index),
        messageId: "message-1",
      })
    }
    await finishRun(created.id)

    const replay = await getBufferedRunEvents(created.id, 0)
    expect(replay).toHaveLength(1_510)
    expect(replay[0]?.seq).toBe(1)
    expect(replay.at(-1)?.seq).toBe(1_510)
  })

  it("bridges replay and live delivery in sequence without duplicates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-active-run-"))
    roots.push(root)
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    await mkdir(cwd)
    const created = await createActiveRun("session-3", cwd, "agent", { homeDir })
    appendRunEvent(created.id, {
      type: "text_delta",
      delta: "before",
      messageId: "message-1",
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const delivered: Array<{ seq: number; delta?: string }> = []
    const subscriptionPromise = replayAndSubscribeToRun(created.id, 0, (envelope) => {
      delivered.push({
        seq: envelope.seq,
        ...(envelope.event.type === "text_delta" ? { delta: envelope.event.delta } : {}),
      })
    })
    appendRunEvent(created.id, {
      type: "text_delta",
      delta: "during",
      messageId: "message-1",
    })
    const subscription = await subscriptionPromise
    await finishRun(created.id)
    await subscription.completion
    subscription.unsubscribe()

    expect(delivered).toEqual([
      { seq: 1, delta: "before" },
      { seq: 2, delta: "during" },
    ])
  })
})
