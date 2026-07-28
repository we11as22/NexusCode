import { describe, expect, it } from "vitest"

import { Session } from "./index.js"

describe("Session message identity", () => {
  it("preserves a caller-owned id for optimistic-to-durable reconciliation", () => {
    const session = new Session("session-1", process.cwd(), [], undefined, true)

    const message = session.addMessage(
      { role: "user", content: "hello" },
      { id: "local_user_123", ts: 123 },
    )

    expect(message).toMatchObject({
      id: "local_user_123",
      ts: 123,
      role: "user",
      content: "hello",
    })
  })

  it("rejects duplicate caller-owned ids", () => {
    const session = new Session("session-1", process.cwd(), [], undefined, true)
    session.addMessage(
      { role: "user", content: "hello" },
      { id: "local_user_123" },
    )

    expect(() =>
      session.addMessage(
        { role: "user", content: "again" },
        { id: "local_user_123" },
      ),
    ).toThrow("already exists")
  })
})
