import { describe, expect, it } from "vitest"

import {
  computeCliRenderWindowStart,
  type CliRenderWindowAnchor,
} from "./cli-render-window.js"

function keys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `message-${index}`)
}

describe("CLI transcript render window", () => {
  it("keeps the initial window stable while messages append below the step threshold", () => {
    const anchor = { current: null as CliRenderWindowAnchor }

    expect(computeCliRenderWindowStart(keys(201), anchor, 200, 50)).toBe(0)
    expect(computeCliRenderWindowStart(keys(250), anchor, 200, 50)).toBe(0)
    expect(anchor.current).toEqual({ key: "message-0", index: 0 })
  })

  it("advances by a stable anchor once the live tree exceeds cap plus step", () => {
    const anchor = { current: null as CliRenderWindowAnchor }

    expect(computeCliRenderWindowStart(keys(251), anchor, 200, 50)).toBe(51)
    expect(anchor.current).toEqual({ key: "message-51", index: 51 })
    expect(computeCliRenderWindowStart(keys(260), anchor, 200, 50)).toBe(51)
  })

  it("falls back to the stored index when timeline grouping replaces an anchor key", () => {
    const anchor = {
      current: { key: "removed-group", index: 51 } as CliRenderWindowAnchor,
    }
    const grouped = keys(260)

    expect(computeCliRenderWindowStart(grouped, anchor, 200, 50)).toBe(51)
    expect(anchor.current).toEqual({ key: "message-51", index: 51 })
  })

  it("resets safely when compaction replaces the transcript with a short timeline", () => {
    const anchor = {
      current: { key: "message-51", index: 51 } as CliRenderWindowAnchor,
    }

    expect(
      computeCliRenderWindowStart(["compaction-boundary"], anchor, 200, 50),
    ).toBe(0)
    expect(anchor.current).toEqual({ key: "compaction-boundary", index: 0 })
  })
})
