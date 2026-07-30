import { describe, expect, it } from "vitest"

import {
  closeSessionTab,
  openSessionTab,
  persistedSessionTabsState,
  readPersistedSessionTabs,
  reconcileSessionTabs,
  visibleSessionTabs,
} from "./session-tab-policy.js"

describe("visibleSessionTabs", () => {
  it("renders only persisted open tabs and preserves their order", () => {
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      id: `session-${index}`,
      ts: index,
      title: `Session ${index}`,
      messageCount: index,
    }))

    expect(
      visibleSessionTabs(
        sessions,
        ["session-3", "session-17", "session-9"],
        "session-17",
      ),
    ).toEqual([
      sessions[3],
      sessions[17],
      sessions[9],
    ])
  })

  it("uses a synthetic current tab before a new session enters history", () => {
    expect(visibleSessionTabs([], [], "new-session")).toEqual([
      {
        id: "new-session",
        ts: 0,
        title: "New chat",
        messageCount: 0,
      },
    ])
  })

  it("opens a history item once without discarding existing tabs", () => {
    expect(openSessionTab(["session-a", "session-b"], "session-c")).toEqual([
      "session-a",
      "session-b",
      "session-c",
    ])
    expect(openSessionTab(["session-a", "session-b"], "session-a")).toEqual([
      "session-a",
      "session-b",
    ])
  })

  it("closes an active tab without deleting history and focuses its left neighbour", () => {
    expect(
      closeSessionTab(
        ["session-a", "session-b", "session-c"],
        "session-b",
        "session-b",
      ),
    ).toEqual({
      openIds: ["session-a", "session-c"],
      nextActiveId: "session-a",
    })
  })

  it("closes a background tab without changing the active chat", () => {
    expect(
      closeSessionTab(
        ["session-a", "session-b", "session-c"],
        "session-a",
        "session-c",
      ),
    ).toEqual({
      openIds: ["session-b", "session-c"],
      nextActiveId: "session-c",
    })
  })

  it("reconciles restored tabs with durable history while keeping a new active chat", () => {
    const sessions = [
      { id: "session-a", ts: 3, messageCount: 1 },
      { id: "session-c", ts: 1, messageCount: 2 },
    ]

    expect(
      reconcileSessionTabs(
        ["session-a", "missing", "session-c"],
        sessions,
        "new-session",
      ),
    ).toEqual(["session-a", "session-c", "new-session"])
  })

  it("round-trips open tabs through VS Code webview state without overwriting other state", () => {
    const persisted = persistedSessionTabsState(
      { unrelated: { keep: true } },
      ["session-a", "session-b", "session-a", ""],
      "session-b",
    )

    expect(persisted).toEqual({
      unrelated: { keep: true },
      nexusSessionTabs: {
        openIds: ["session-a", "session-b"],
        activeId: "session-b",
      },
    })
    expect(readPersistedSessionTabs(persisted)).toEqual({
      openIds: ["session-a", "session-b"],
      activeId: "session-b",
    })
  })

  it("fails closed on malformed restored webview state", () => {
    expect(
      readPersistedSessionTabs({
        nexusSessionTabs: { openIds: ["valid", 7, null], activeId: 9 },
      }),
    ).toEqual({
      openIds: ["valid"],
      activeId: "",
    })
  })
})
