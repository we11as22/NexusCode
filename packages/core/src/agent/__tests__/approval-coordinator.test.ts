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
    expect(host.events.filter((event) => event.type === "tool_approval_needed"))
      .toMatchObject([{ partId: "part-first" }, { partId: "part-second" }])
    resolvers.shift()!({ approved: false })
    await expect(second).resolves.toEqual({ approved: false })
  })
})
