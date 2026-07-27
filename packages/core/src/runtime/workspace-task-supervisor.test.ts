import { describe, expect, it, vi } from "vitest"

import { WorkspaceTaskSupervisor } from "./workspace-task-supervisor.js"

describe("WorkspaceTaskSupervisor", () => {
  it("deduplicates a named task while it is running", async () => {
    const supervisor = new WorkspaceTaskSupervisor()
    let finish!: () => void
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )

    const first = supervisor.start("memory-dream", task)
    const second = supervisor.start("memory-dream", task)

    expect(first.started).toBe(true)
    expect(second.started).toBe(false)
    expect(second.promise).toBe(first.promise)
    expect(task).toHaveBeenCalledOnce()
    finish()
    await first.promise
    await supervisor.close()
  })

  it("aborts and drains every task exactly once during close", async () => {
    const supervisor = new WorkspaceTaskSupervisor()
    const aborted: string[] = []
    const start = (name: string) =>
      supervisor.start(name, (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted.push(name)
              resolve()
            },
            { once: true },
          )
        }),
      )

    start("one")
    start("two")
    await Promise.all([supervisor.close(), supervisor.close()])

    expect(aborted.sort()).toEqual(["one", "two"])
    expect(() =>
      supervisor.start("late", async () => undefined),
    ).toThrow(/closed/i)
  })

  it("waits for failure cleanup without hiding the task result", async () => {
    const supervisor = new WorkspaceTaskSupervisor()
    const failure = new Error("background failure")
    const running = supervisor.start("failing", async () => {
      throw failure
    })

    await expect(running.promise).rejects.toBe(failure)
    await expect(supervisor.close()).resolves.toBeUndefined()
  })
})
