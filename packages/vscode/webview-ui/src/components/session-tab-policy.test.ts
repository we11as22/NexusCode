import { describe, expect, it } from "vitest"

import { visibleSessionTabs } from "./session-tab-policy.js"

describe("visibleSessionTabs", () => {
  it("keeps only the active session in the compact tab strip", () => {
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      id: `session-${index}`,
      ts: index,
      title: `Session ${index}`,
      messageCount: index,
    }))

    expect(visibleSessionTabs(sessions, "session-17")).toEqual([
      sessions[17],
    ])
  })

  it("uses a synthetic current tab before a new session enters history", () => {
    expect(visibleSessionTabs([], "new-session")).toEqual([
      {
        id: "new-session",
        ts: 0,
        title: "New chat",
        messageCount: 0,
      },
    ])
  })
})
