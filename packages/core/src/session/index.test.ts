import { describe, expect, it } from "vitest"

import { deriveSessionTitle, Session } from "./index.js"

describe("session titles", () => {
  it("uses the display projection instead of private injected prompt text", () => {
    expect(
      deriveSessionTitle([
        {
          id: "user-1",
          ts: 1,
          role: "user",
          content: [
            {
              type: "text",
              text: "Implement the following plan:\n\n(private plan body)",
              user_message: "Implement this plan in a new session",
            },
          ],
        },
      ]),
    ).toBe("Implement this plan in a new session")
  })
})

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

describe("Session durable metadata", () => {
  it("tracks the acknowledged journal revision monotonically", () => {
    const session = new Session(
      "session-revision",
      process.cwd(),
      [],
      undefined,
      true,
      null,
      4,
    )

    expect(session.getDurableRevision()).toBe(4)
    session.acknowledgeDurableRevision(5)
    expect(session.getDurableRevision()).toBe(5)
    expect(() => session.acknowledgeDurableRevision(4)).toThrow(
      /older durable revision/i,
    )
  })

  it("remembers the mode that Plan should return to", () => {
    const session = new Session("session-mode", process.cwd(), [], undefined, true)
    session.setMode("debug")
    session.setMode("plan")

    expect(session.getPlanReturnMode()).toBe("debug")
    session.setMode("plan")
    expect(session.getPlanReturnMode()).toBe("debug")
    session.setMode("debug")
    expect(session.getPlanReturnMode()).toBeUndefined()
  })
})

describe("Session provider context anchor", () => {
  it("keeps the provider anchor across a pending user message", () => {
    const session = new Session(
      "session-anchor",
      process.cwd(),
      [
        {
          id: "assistant-1",
          ts: 1,
          role: "assistant",
          content: "done",
        },
      ],
      undefined,
      true,
    )
    session.recordProviderContextAnchor({
      messageId: "assistant-1",
      usedTokens: 12_000,
      manifestTokens: 2_000,
      modelId: "kilo-auto/free",
      recordedAt: 2,
    })

    session.addMessage(
      { role: "user", content: "next request" },
      { id: "user-2", ts: 3 },
    )

    expect(session.getProviderContextAnchor()).toEqual({
      messageId: "assistant-1",
      usedTokens: 12_000,
      manifestTokens: 2_000,
      modelId: "kilo-auto/free",
      recordedAt: 2,
    })
  })

  it("clears an anchor when rewind removes its assistant message", () => {
    const session = new Session(
      "session-anchor",
      process.cwd(),
      [
        { id: "user-1", ts: 1, role: "user", content: "hello" },
        {
          id: "assistant-1",
          ts: 2,
          role: "assistant",
          content: "done",
        },
      ],
      undefined,
      true,
    )
    session.recordProviderContextAnchor({
      messageId: "assistant-1",
      usedTokens: 12_000,
      manifestTokens: 2_000,
      recordedAt: 3,
    })

    session.rewindBeforeMessageId("assistant-1")

    expect(session.getProviderContextAnchor()).toBeUndefined()
  })
})
