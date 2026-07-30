import { describe, expect, it } from "vitest"

import {
  SESSION_DROPDOWN_LIMIT,
  visibleSessionDropdown,
  visibleSessionTabs,
} from "./session-tab-policy.js"

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

  it("bounds the quick dropdown while keeping an older active session reachable", () => {
    const sessions = Array.from({ length: 54 }, (_, index) => ({
      id: `session-${index}`,
      ts: 54 - index,
      title: `Session ${index}`,
      messageCount: index,
    }))

    const visible = visibleSessionDropdown(sessions, "session-40")

    expect(visible).toHaveLength(SESSION_DROPDOWN_LIMIT)
    expect(visible[0]).toBe(sessions[40])
    expect(visible.slice(1)).toEqual(
      sessions.slice(0, SESSION_DROPDOWN_LIMIT - 1),
    )
  })
})
