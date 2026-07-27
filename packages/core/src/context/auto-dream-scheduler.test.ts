import { describe, expect, it, vi } from "vitest"

import { createNexusRunServices } from "../agent/run-services.js"
import { createTestConfig } from "../test/fakes.js"
import { scheduleAutoMemoryDream } from "./auto-dream-scheduler.js"

describe("auto-memory dream scheduling", () => {
  it("is workspace-owned instead of inheriting the completed turn signal", async () => {
    const services = createNexusRunServices()
    const turn = new AbortController()
    const run = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal).not.toBe(turn.signal)
      expect(signal.aborted).toBe(false)
    })
    const config = createTestConfig()
    config.memory = {
      ...config.memory,
      autoDreamEnabled: true,
    }

    const handle = scheduleAutoMemoryDream({
      cwd: process.cwd(),
      config,
      client: {} as never,
      services,
      run: run as never,
    })
    turn.abort()

    expect(handle?.started).toBe(true)
    await handle?.promise
    expect(run).toHaveBeenCalledOnce()
    await services.workspaceTasks.close()
    await services.parallelAgentManager.shutdown()
  })

  it("deduplicates root runs and skips delegated agents", async () => {
    const services = createNexusRunServices()
    let finish!: () => void
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const config = createTestConfig()
    config.memory = {
      ...config.memory,
      autoDreamEnabled: true,
    }

    const first = scheduleAutoMemoryDream({
      cwd: process.cwd(),
      config,
      client: {} as never,
      services,
      run: run as never,
    })
    const duplicate = scheduleAutoMemoryDream({
      cwd: process.cwd(),
      config,
      client: {} as never,
      services,
      run: run as never,
    })
    const delegated = scheduleAutoMemoryDream({
      cwd: process.cwd(),
      config,
      client: {} as never,
      services: { ...services, subagentDepth: 1, subagentId: "child" },
      run: run as never,
    })

    expect(first?.started).toBe(true)
    expect(duplicate?.started).toBe(false)
    expect(delegated).toBeUndefined()
    expect(run).toHaveBeenCalledOnce()
    finish()
    await first?.promise
    await services.workspaceTasks.close()
    await services.parallelAgentManager.shutdown()
  })
})
