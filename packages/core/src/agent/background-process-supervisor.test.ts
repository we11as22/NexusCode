import { describe, expect, it, vi } from "vitest"

import { BackgroundProcessSupervisor } from "./background-process-supervisor.js"

describe("BackgroundProcessSupervisor", () => {
  it("awaits owner shutdown for every live handle before forgetting it", async () => {
    const supervisor = new BackgroundProcessSupervisor()
    const calls: string[] = []
    let releaseFirst!: () => void
    const firstStopped = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    supervisor.register({
      taskId: "run-one",
      pid: 123,
      processIdentity: "identity-one",
      logPath: "/tmp/run-one.log",
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
      stop: async (reason) => {
        calls.push(`one:${reason}`)
        await firstStopped
      },
    })
    supervisor.register({
      taskId: "run-two",
      pid: 456,
      processIdentity: "identity-two",
      logPath: "/tmp/run-two.log",
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
      stop: async (reason) => {
        calls.push(`two:${reason}`)
      },
    })

    const closing = supervisor.close()
    await Promise.resolve()

    expect(calls.sort()).toEqual([
      "one:owner_shutdown",
      "two:owner_shutdown",
    ])
    expect(supervisor.list({
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
    })).toHaveLength(2)

    releaseFirst()
    await closing

    expect(supervisor.list({
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
    })).toEqual([])
    expect(() => supervisor.register({
      taskId: "run-three",
      pid: 789,
      processIdentity: "identity-three",
      logPath: "/tmp/run-three.log",
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
      stop: async () => undefined,
    })).toThrow(/closed/i)
  })

  it("requires exact workspace and session ownership for every lookup", () => {
    const supervisor = new BackgroundProcessSupervisor()
    supervisor.register({
      taskId: "run-one",
      pid: 123,
      processIdentity: "identity-one",
      logPath: "/tmp/run-one.log",
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
      stop: async () => undefined,
    })

    expect(supervisor.get("run-one", {
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
    })).toMatchObject({ pid: 123 })
    expect(supervisor.get("run-one", {
      workspace: "/tmp/workspace-a",
      sessionId: "session-b",
    })).toBeUndefined()
    expect(supervisor.get("run-one", {
      workspace: "/tmp/workspace-b",
      sessionId: "session-a",
    })).toBeUndefined()
    expect(supervisor.list({
      workspace: "/tmp/workspace-a",
      sessionId: "session-b",
    })).toEqual([])
    expect(supervisor.ownsLogPath("/tmp/../tmp/run-one.log")).toBe(true)
  })

  it("rejects id collisions and ownership-confused removal", () => {
    const supervisor = new BackgroundProcessSupervisor()
    supervisor.register({
      taskId: "run-one",
      pid: 123,
      processIdentity: "identity-one",
      logPath: "/tmp/run-one.log",
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
      stop: async () => undefined,
    })

    expect(() => supervisor.register({
      taskId: "run-one",
      pid: 456,
      processIdentity: "identity-two",
      logPath: "/tmp/run-two.log",
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
      stop: async () => undefined,
    })).toThrow(/already exists/)
    expect(supervisor.remove("run-one", {
      workspace: "/tmp/workspace-a",
      sessionId: "session-b",
    })).toBe(false)
    expect(supervisor.remove("run-one", {
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
    })).toBe(true)
  })

  it("terminates only through the live owner-bound process handle", () => {
    const supervisor = new BackgroundProcessSupervisor()
    const terminate = vi.fn(() => true)
    supervisor.register({
      taskId: "run-one",
      pid: 123,
      processIdentity: "identity-one",
      logPath: "/tmp/run-one.log",
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
      terminate,
      stop: async () => undefined,
    })

    expect(supervisor.terminate("run-one", {
      workspace: "/tmp/workspace-a",
      sessionId: "session-b",
    })).toBe(false)
    expect(terminate).not.toHaveBeenCalled()

    expect(supervisor.terminate("run-one", {
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
    })).toBe(true)
    expect(terminate).toHaveBeenCalledWith("SIGTERM")
  })

  it("stops once through the matching live identity and waits for finalization", async () => {
    const supervisor = new BackgroundProcessSupervisor()
    let release!: () => void
    const stopped = new Promise<void>((resolve) => {
      release = resolve
    })
    const stop = vi.fn(async () => {
      await stopped
    })
    const owner = {
      workspace: "/tmp/workspace-a",
      sessionId: "session-a",
    }
    supervisor.register({
      taskId: "run-one",
      pid: 123,
      processIdentity: "identity-one",
      logPath: "/tmp/run-one.log",
      ...owner,
      stop,
    })

    await expect(supervisor.stop("run-one", owner, {
      processIdentity: "wrong-identity",
      reason: "requested",
    })).resolves.toBe(false)
    expect(stop).not.toHaveBeenCalled()

    const first = supervisor.stop("run-one", owner, {
      processIdentity: "identity-one",
      reason: "requested",
    })
    const second = supervisor.stop("run-one", owner, {
      processIdentity: "identity-one",
      reason: "requested",
    })
    await Promise.resolve()
    expect(stop).toHaveBeenCalledTimes(1)

    release()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(supervisor.get("run-one", owner)).toBeUndefined()
  })
})
