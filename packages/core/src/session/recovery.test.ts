import { describe, expect, it } from "vitest"

import type { SessionMessage } from "../types.js"
import { Session } from "./index.js"

describe("session in-memory recovery snapshots", () => {
  it("restores the exact pre-rewind transcript after an ambiguous durable save", () => {
    const messages: SessionMessage[] = [
      {
        id: "message-user",
        role: "user",
        content: "change it",
        ts: 1,
      },
      {
        id: "message-assistant",
        role: "assistant",
        content: "done",
        ts: 2,
      },
    ]
    const session = Session.createEphemeral(process.cwd(), messages)
    const recovery = session.captureRecoverySnapshot()

    session.rewindBeforeTimestamp(1)
    expect(session.messages).toEqual([])

    session.restoreRecoverySnapshot(recovery)
    expect(session.messages).toEqual(messages)
    expect(session.messages).not.toBe(messages)
  })
})
