import { describe, expect, it } from "vitest"
import { createFakeHost } from "../../test/fakes.js"
import type { PermissionResult } from "../../types.js"
import { requestHostApproval } from "../approval-coordinator.js"
import { createDelegatedHost } from "../parallel.js"

describe("approval coordination", () => {
  it("serializes approval events across delegated hosts", async () => {
    const resolvers: Array<(result: PermissionResult) => void> = []
    const host = createFakeHost({
      async showApprovalDialog() {
        return new Promise<PermissionResult>((resolve) => resolvers.push(resolve))
      },
    })
    const firstHost = createDelegatedHost(host, host.cwd, host.emit.bind(host))
    const secondHost = createDelegatedHost(host, host.cwd, host.emit.bind(host))
    const action = (tool: string) => ({
      type: "plugin" as const,
      tool,
      description: tool,
    })

    const first = requestHostApproval(firstHost, action("first"), "part-first")
    const second = requestHostApproval(secondHost, action("second"), "part-second")
    await Promise.resolve()
    await Promise.resolve()

    expect(host.events.filter((event) => event.type === "tool_approval_needed"))
      .toMatchObject([{ partId: "part-first" }])
    resolvers.shift()!({ approved: true })
    await first
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(host.events.filter((event) => event.type === "tool_approval_needed"))
      .toMatchObject([{ partId: "part-first" }, { partId: "part-second" }])
    resolvers.shift()!({ approved: false })
    await expect(second).resolves.toEqual({ approved: false })
  })

  it("cancels a queued approval without emitting it or replacing the active resolver", async () => {
    let resolveFirst!: (result: PermissionResult) => void
    const host = createFakeHost({
      async showApprovalDialog() {
        return new Promise<PermissionResult>((resolve) => {
          resolveFirst = resolve
        })
      },
    })
    const action = (tool: string) => ({
      type: "plugin" as const,
      tool,
      description: tool,
    })
    const first = requestHostApproval(host, action("first"), "part-first")
    const abort = new AbortController()
    const second = requestHostApproval(
      host,
      action("second"),
      "part-second",
      { signal: abort.signal },
    )
    abort.abort()

    const secondResult = await Promise.race([
      second,
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 50)
      }),
    ])
    expect(secondResult).toEqual({ approved: false })
    expect(host.events.filter((event) => event.type === "tool_approval_needed"))
      .toMatchObject([{ partId: "part-first" }])

    resolveFirst({ approved: false })
    await first
  })

  it("passes cancellation to the active host dialog", async () => {
    const abort = new AbortController()
    const host = createFakeHost({
      async showApprovalDialog(_action, signal) {
        return new Promise<PermissionResult>((resolve) => {
          if (signal?.aborted) resolve({ approved: false })
          else signal?.addEventListener(
            "abort",
            () => resolve({ approved: false }),
            { once: true },
          )
        })
      },
    })
    const pending = requestHostApproval(
      host,
      {
        type: "plugin",
        tool: "active",
        description: "active",
      },
      "part-active",
      { signal: abort.signal },
    )
    abort.abort()

    await expect(Promise.race([
      pending,
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 50)
      }),
    ])).resolves.toEqual({ approved: false })
  })
})
