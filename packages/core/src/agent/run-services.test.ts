import { describe, expect, it, vi } from "vitest"

import {
  closeNexusRunServices,
  type NexusRunServices,
} from "./run-services.js"

function fakeServices(input: {
  shutdown?: () => Promise<void>
  closeTasks?: () => Promise<void>
  closeBackground?: () => void | Promise<void>
  closeToolContributions?: () => Promise<void>
}): NexusRunServices {
  return {
    parallelAgentManager: {
      shutdown: input.shutdown ?? (async () => undefined),
    },
    workspaceTasks: {
      close: input.closeTasks ?? (async () => undefined),
    },
    backgroundProcesses: {
      close: input.closeBackground ?? (() => undefined),
    },
    toolContributionManager: {
      close: input.closeToolContributions ?? (async () => undefined),
    },
    subagentDepth: 0,
  } as unknown as NexusRunServices
}

describe("closeNexusRunServices", () => {
  it("awaits background terminal-state publication before closing later owners", async () => {
    const calls: string[] = []
    let releaseBackground!: () => void
    const backgroundClosed = new Promise<void>((resolve) => {
      releaseBackground = resolve
    })
    const closing = closeNexusRunServices(
      fakeServices({
        shutdown: async () => {
          calls.push("parallel")
        },
        closeTasks: async () => {
          calls.push("workspace-tasks")
        },
        closeBackground: async () => {
          calls.push("background-processes:start")
          await backgroundClosed
          calls.push("background-processes:end")
        },
        closeToolContributions: async () => {
          calls.push("tool-contributions")
        },
      }),
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([
      "parallel",
      "workspace-tasks",
      "background-processes:start",
    ])

    releaseBackground()
    await closing
    expect(calls).toEqual([
      "parallel",
      "workspace-tasks",
      "background-processes:start",
      "background-processes:end",
      "tool-contributions",
    ])
  })

  it("uses one dependency order across every host", async () => {
    const calls: string[] = []
    await closeNexusRunServices(
      fakeServices({
        shutdown: vi.fn(async () => {
          calls.push("parallel")
        }),
        closeTasks: vi.fn(async () => {
          calls.push("workspace-tasks")
        }),
        closeBackground: vi.fn(() => {
          calls.push("background-processes")
        }),
        closeToolContributions: vi.fn(async () => {
          calls.push("tool-contributions")
        }),
      }),
    )

    expect(calls).toEqual([
      "parallel",
      "workspace-tasks",
      "background-processes",
      "tool-contributions",
    ])
  })

  it("attempts every close and preserves all failures", async () => {
    const errors = [
      new Error("parallel"),
      new Error("tasks"),
      new Error("background"),
      new Error("tool-contributions"),
    ]
    const services = fakeServices({
      shutdown: async () => {
        throw errors[0]
      },
      closeTasks: async () => {
        throw errors[1]
      },
      closeBackground: () => {
        throw errors[2]
      },
      closeToolContributions: async () => {
        throw errors[3]
      },
    })

    await expect(closeNexusRunServices(services)).rejects.toMatchObject({
      errors,
    })
  })
})
