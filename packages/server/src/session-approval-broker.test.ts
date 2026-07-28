import { describe, expect, it } from "vitest"

import { SessionApprovalBroker } from "./session-approval-broker.js"

const action = {
  type: "write" as const,
  tool: "Write",
  description: "Write a source file",
  content: "first",
}

describe("SessionApprovalBroker", () => {
  it("isolates reused provider approval ids by durable turn identity", async () => {
    const broker = new SessionApprovalBroker()
    broker.register({
      approvalId: "provider-call-1",
      turnId: "turn-1",
      action,
    })
    broker.register({
      approvalId: "provider-call-1",
      turnId: "turn-2",
      action,
    })

    const first = broker.wait("turn-1", action)
    const second = broker.wait("turn-2", action)
    broker.deliver({
      expectedTurnId: "turn-2",
      approvalId: "provider-call-1",
      status: "denied",
    })
    broker.deliver({
      expectedTurnId: "turn-1",
      approvalId: "provider-call-1",
      status: "approved",
    })

    await expect(first).resolves.toEqual({ approved: true })
    await expect(second).resolves.toEqual({ approved: false })
    broker.close()
  })

  it("rejects approval identity reuse when security-relevant action content differs", () => {
    const broker = new SessionApprovalBroker()
    broker.register({
      approvalId: "approval-1",
      turnId: "turn-1",
      action,
    })

    expect(() =>
      broker.register({
        approvalId: "approval-1",
        turnId: "turn-1",
        action: { ...action, content: "different" },
      }),
    ).toThrow(/different content/i)
    broker.close()
  })

  it("treats the structured write path as approval identity", () => {
    const broker = new SessionApprovalBroker()
    broker.register({
      approvalId: "approval-path",
      turnId: "turn-1",
      action: { ...action, path: "src/first.ts" },
    })

    expect(() =>
      broker.register({
        approvalId: "approval-path",
        turnId: "turn-1",
        action: { ...action, path: "src/second.ts" },
      }),
    ).toThrow(/different content/i)
    broker.close()
  })
})
