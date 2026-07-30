import { describe, expect, it } from "vitest"
import {
  SESSION_HISTORY_PAGE_SIZE,
  visibleSessionHistory,
} from "./session-history-policy.js"

const sessions = Array.from({ length: 75 }, (_, index) => ({
  id: `session-${index}`,
  ts: 75 - index,
  title: index === 63 ? "Needle conversation" : `Conversation ${index}`,
  messageCount: index + 1,
}))

describe("visibleSessionHistory", () => {
  it("bounds the initial DOM while preserving whether more rows exist", () => {
    const result = visibleSessionHistory(sessions, {
      query: "",
      visibleCount: SESSION_HISTORY_PAGE_SIZE,
      activeSessionId: "session-3",
    })

    expect(result.sessions).toHaveLength(SESSION_HISTORY_PAGE_SIZE)
    expect(result.sessions[0]?.id).toBe("session-0")
    expect(result.hasMore).toBe(true)
    expect(result.totalMatches).toBe(75)
  })

  it("keeps an older active session reachable without mounting the whole list", () => {
    const result = visibleSessionHistory(sessions, {
      query: "",
      visibleCount: SESSION_HISTORY_PAGE_SIZE,
      activeSessionId: "session-63",
    })

    expect(result.sessions).toHaveLength(SESSION_HISTORY_PAGE_SIZE + 1)
    expect(result.sessions.at(-1)?.id).toBe("session-63")
    expect(new Set(result.sessions.map((session) => session.id)).size).toBe(
      result.sessions.length,
    )
  })

  it("searches titles and ids case-insensitively before applying the page bound", () => {
    expect(
      visibleSessionHistory(sessions, {
        query: "needle",
        visibleCount: SESSION_HISTORY_PAGE_SIZE,
        activeSessionId: "session-0",
      }),
    ).toMatchObject({
      sessions: [{ id: "session-63" }],
      hasMore: false,
      totalMatches: 1,
    })

    expect(
      visibleSessionHistory(sessions, {
        query: "SESSION-7",
        visibleCount: SESSION_HISTORY_PAGE_SIZE,
        activeSessionId: "session-0",
      }).sessions.map((session) => session.id),
    ).toContain("session-7")
  })

  it("treats whitespace-only search as no filter and clamps invalid bounds", () => {
    const result = visibleSessionHistory(sessions, {
      query: "   ",
      visibleCount: Number.NaN,
      activeSessionId: undefined,
    })

    expect(result.sessions).toHaveLength(SESSION_HISTORY_PAGE_SIZE)
    expect(result.hasMore).toBe(true)
  })
})
