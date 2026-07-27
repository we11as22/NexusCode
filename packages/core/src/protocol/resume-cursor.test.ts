import { describe, expect, it } from "vitest"

import { PROTOCOL_VERSION, type SessionProtocolSnapshot } from "./v2.js"
import { selectActiveTurnResumeCursor } from "./resume-cursor.js"

function snapshot(): SessionProtocolSnapshot {
  return {
    version: PROTOCOL_VERSION,
    sessionId: "session",
    phase: "streaming",
    activeTurnId: "turn-current",
    activeRunId: "run-current",
    activeTurnFirstSequence: 3,
    activeExecution: { mode: "agent" },
    pendingApprovals: [],
    pendingQueueCount: 0,
    pendingSteerCount: 0,
    earliestAvailableSequence: 1,
    throughSequence: 11,
  }
}

describe("active turn resume cursor", () => {
  it.each([
    ["missing", undefined],
    [
      "another turn",
      { turnId: "turn-old", runId: "run-old", afterSequence: 9 },
    ],
    [
      "before the active turn",
      { turnId: "turn-current", runId: "run-current", afterSequence: 1 },
    ],
    [
      "past the snapshot high-water mark",
      { turnId: "turn-current", runId: "run-current", afterSequence: 12 },
    ],
  ])("replays from the active turn start when the cursor is %s", (_name, stored) => {
    expect(selectActiveTurnResumeCursor(snapshot(), stored)).toBe(2)
  })

  it("continues from an exact in-range cursor for the active turn", () => {
    expect(
      selectActiveTurnResumeCursor(snapshot(), {
        turnId: "turn-current",
        runId: "run-current",
        afterSequence: 7,
      }),
    ).toBe(7)
  })
})
