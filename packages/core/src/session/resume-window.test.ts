import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  loadSessionMessages: vi.fn(),
  saveSession: vi.fn(),
}))

vi.mock("./storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage.js")>()
  return {
    ...actual,
    loadSessionMessages: mocks.loadSessionMessages,
    saveSession: mocks.saveSession,
  }
})

import { Session } from "./index.js"

describe("Session.resumeWindow persistence", () => {
  beforeEach(() => {
    mocks.loadSessionMessages.mockReset()
    mocks.saveSession.mockReset()
    mocks.saveSession.mockResolvedValue(4)
    mocks.loadSessionMessages.mockResolvedValue({
      meta: {
        id: "session-window",
        cwd: process.cwd(),
        ts: 1,
        messageCount: 1,
        revision: 3,
        mode: "agent",
      },
      messages: [
        {
          id: "user-1",
          ts: 1,
          role: "user",
          content: "hello",
          mode: "agent",
        },
      ],
    })
  })

  it("keeps a complete local window persistable", async () => {
    const session = await Session.resumeWindow(
      "session-window",
      process.cwd(),
      50,
      0,
    )
    expect(session).not.toBeNull()

    session!.addMessage({ role: "assistant", content: "continued" })
    await session!.save()

    expect(mocks.saveSession).toHaveBeenCalledOnce()
    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-window",
        mode: "agent",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: "continued",
          }),
        ]),
      }),
      { expectedRevision: 3 },
    )
  })

  it("does not let a partial window overwrite the durable transcript", async () => {
    const session = await Session.resumeWindow(
      "session-window",
      process.cwd(),
      50,
      10,
    )
    expect(session).not.toBeNull()

    session!.addMessage({ role: "assistant", content: "partial" })
    await session!.save()

    expect(mocks.saveSession).not.toHaveBeenCalled()
  })

  it("treats an offset-zero truncated window as read-only", async () => {
    mocks.loadSessionMessages.mockResolvedValue({
      meta: {
        id: "session-window",
        cwd: process.cwd(),
        ts: 1,
        messageCount: 2,
        revision: 3,
        mode: "agent",
      },
      messages: [
        {
          id: "user-1",
          ts: 1,
          role: "user",
          content: "hello",
          mode: "agent",
        },
      ],
    })

    const session = await Session.resumeWindow(
      "session-window",
      process.cwd(),
      1,
      0,
    )
    expect(session).not.toBeNull()

    session!.addMessage({ role: "assistant", content: "truncated" })
    await session!.save()

    expect(mocks.saveSession).not.toHaveBeenCalled()
  })
})
