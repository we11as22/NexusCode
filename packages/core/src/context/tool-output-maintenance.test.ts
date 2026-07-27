import { describe, expect, it, vi } from "vitest"

import { createNexusRunServices } from "../agent/run-services.js"
import { scheduleToolOutputMaintenance } from "./tool-output-maintenance.js"

describe("scheduleToolOutputMaintenance", () => {
  it("runs at most once per workspace services lifetime", async () => {
    const services = createNexusRunServices()
    let finish!: () => void
    const run = vi.fn(
      () =>
        new Promise<{
          scannedSessionDirectories: number
          scannedArtifacts: number
          removedArtifacts: number
          truncated: boolean
          errors: string[]
        }>((resolve) => {
          finish = () =>
            resolve({
              scannedSessionDirectories: 0,
              scannedArtifacts: 0,
              removedArtifacts: 0,
              truncated: false,
              errors: [],
            })
        }),
    )

    const first = scheduleToolOutputMaintenance({
      cwd: "/workspace",
      services,
      run,
    })
    const duplicate = scheduleToolOutputMaintenance({
      cwd: "/workspace",
      services,
      run,
    })

    expect(first?.started).toBe(true)
    expect(duplicate?.started).toBe(false)
    expect(run).toHaveBeenCalledOnce()
    finish()
    await first?.promise
    await services.workspaceTasks.close()
  })

  it("does not schedule maintenance from delegated agents", async () => {
    const services = createNexusRunServices({ subagentDepth: 1 })
    const run = vi.fn()

    expect(
      scheduleToolOutputMaintenance({
        cwd: "/workspace",
        services,
        run,
      }),
    ).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    await services.workspaceTasks.close()
  })
})
