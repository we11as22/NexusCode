import { describe, expect, it, vi } from "vitest"

import { createNexusRunServices } from "../agent/run-services.js"
import { createFakeSession, createTestConfig } from "../test/fakes.js"
import { scheduleSessionMemoryRefresh } from "./session-memory-scheduler.js"

describe("session-memory refresh scheduling", () => {
  it("is workspace-owned and deduplicated per root session", async () => {
    const services = createNexusRunServices()
    const session = createFakeSession()
    let finish!: () => void
    const run = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          finish = resolve
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          )
        }),
    )
    const options = {
      session,
      client: {} as never,
      cwd: process.cwd(),
      config: createTestConfig(),
      services,
      run: run as never,
    }

    const first = scheduleSessionMemoryRefresh(options)
    const duplicate = scheduleSessionMemoryRefresh(options)

    expect(first?.started).toBe(true)
    expect(duplicate?.started).toBe(false)
    expect(run).toHaveBeenCalledOnce()
    finish()
    await first?.promise
    await services.workspaceTasks.close()
    await services.parallelAgentManager.shutdown()
  })

  it("skips ephemeral delegated sessions", async () => {
    const services = createNexusRunServices()
    const run = vi.fn(async () => undefined)

    const handle = scheduleSessionMemoryRefresh({
      session: createFakeSession(),
      client: {} as never,
      cwd: process.cwd(),
      config: createTestConfig(),
      services: {
        ...services,
        subagentDepth: 1,
        subagentId: "subagent-1",
      },
      run: run as never,
    })

    expect(handle).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    await services.workspaceTasks.close()
    await services.parallelAgentManager.shutdown()
  })

  it("aborts an in-flight refresh when the workspace closes", async () => {
    const services = createNexusRunServices()
    let observedSignal!: AbortSignal
    const run = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<void>((resolve) => {
          observedSignal = signal
          signal.addEventListener("abort", () => resolve(), { once: true })
        }),
    )

    const handle = scheduleSessionMemoryRefresh({
      session: createFakeSession(),
      client: {} as never,
      cwd: process.cwd(),
      config: createTestConfig(),
      services,
      run: run as never,
    })
    await services.workspaceTasks.close()

    expect(handle?.started).toBe(true)
    expect(observedSignal.aborted).toBe(true)
    await handle?.promise
    await services.parallelAgentManager.shutdown()
  })
})
