import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  ActiveSessionRunError,
  abortRunBySession,
  appendRunEvent,
  claimRunExecution,
  createActiveRun,
  evictFinishedRun,
  finishRun,
  getBufferedRunEvents,
  getLatestRunForSession,
  getOrRestoreRun,
  replayAndSubscribeToRun,
  resolveRunApproval,
  waitForRunApproval,
} from "./active-runs.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable active runs", () => {
  it("scopes active session ownership to the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-active-run-"))
    roots.push(root)
    const firstCwd = path.join(root, "workspace-a")
    const secondCwd = path.join(root, "workspace-b")
    const homeDir = path.join(root, ".nexus")
    await Promise.all([mkdir(firstCwd), mkdir(secondCwd)])

    const first = await createActiveRun("shared-session", firstCwd, "agent", {
      homeDir,
      runId: "run_workspace_a",
    })
    const second = await createActiveRun("shared-session", secondCwd, "agent", {
      homeDir,
      runId: "run_workspace_b",
    })

    expect(getLatestRunForSession("shared-session", firstCwd)?.id).toBe(first.id)
    expect(getLatestRunForSession("shared-session", secondCwd)?.id).toBe(second.id)
    expect(abortRunBySession("shared-session", firstCwd)).toBe(true)
    expect(first.abortController.signal.aborted).toBe(true)
    expect(second.abortController.signal.aborted).toBe(false)

    await finishRun(first.id, "aborted")
    await finishRun(second.id)
  })

  it("atomically rejects two different active runs for one workspace session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-active-run-"))
    roots.push(root)
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    await mkdir(cwd)

    const firstPromise = createActiveRun("busy-session", cwd, "agent", {
      homeDir,
      runId: "run_first",
    })
    const secondPromise = createActiveRun("busy-session", cwd, "agent", {
      homeDir,
      runId: "run_second",
    })
    const rejected = expect(secondPromise).rejects.toMatchObject({
      name: ActiveSessionRunError.name,
      runId: "run_first",
    })

    const first = await firstPromise
    await rejected
    await finishRun(first.id)
  })

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
    expect(claimRunExecution(first.id)).toBe(true)
    expect(claimRunExecution(second.id)).toBe(false)
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

  it("waits for the matching remote approval and resolves by part id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-active-run-"))
    roots.push(root)
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    await mkdir(cwd)
    const created = await createActiveRun("session-approval", cwd, "agent", { homeDir })
    const action = {
      type: "execute" as const,
      tool: "Bash",
      description: "run tests",
    }
    appendRunEvent(created.id, {
      type: "tool_approval_needed",
      partId: "part_approval",
      action,
    })

    const waiting = waitForRunApproval(created.id, action, created.abortController.signal)
    expect(resolveRunApproval(created.id, "part_approval", { approved: true })).toBe(true)
    await expect(waiting).resolves.toEqual({ approved: true })
    expect(resolveRunApproval(created.id, "part_approval", { approved: true })).toBe(false)
    await finishRun(created.id)
  })

  it("fails pending approvals closed when the run is aborted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-active-run-"))
    roots.push(root)
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    await mkdir(cwd)
    const created = await createActiveRun("session-abort-approval", cwd, "agent", { homeDir })
    const action = {
      type: "write" as const,
      tool: "Write",
      description: "write file",
    }
    appendRunEvent(created.id, {
      type: "tool_approval_needed",
      partId: "part_abort_approval",
      action,
    })

    const waiting = waitForRunApproval(created.id, action, created.abortController.signal)
    created.abortController.abort()

    await expect(waiting).resolves.toEqual({ approved: false })
    await finishRun(created.id, "aborted")
  })
})
