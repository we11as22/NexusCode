import { describe, expect, it } from "vitest"

import { checkpointDisplayLabel } from "./CheckpointStrip.js"

describe("checkpoint display labels", () => {
  it("never exposes the internal checkpoint hash as a fallback label", () => {
    expect(
      checkpointDisplayLabel(
        {
          hash: "0123456789abcdef",
          ts: 1,
        },
        2,
      ),
    ).toBe("Checkpoint 3")
  })

  it("uses a bounded human description when one is available", () => {
    expect(
      checkpointDisplayLabel(
        {
          hash: "0123456789abcdef",
          ts: 1,
          description: "  Implement the approved plan and verify the result  ",
        },
        0,
      ),
    ).toBe("Implement the approved plan …")
  })
})
