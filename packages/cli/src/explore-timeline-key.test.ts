import { describe, expect, it } from "vitest"

import { getExploreTimelineKey } from "./utils/exploreTimeline.js"

describe("CLI explore timeline identity", () => {
  it("keeps one React identity while results and later searches join the wave", () => {
    const initial = getExploreTimelineKey(
      new Set(["tool-list"]),
      "progress-list",
    )
    const withResult = getExploreTimelineKey(
      new Set(["tool-list"]),
      "progress-list|result-list",
    )
    const withLaterSearch = getExploreTimelineKey(
      new Set(["tool-list", "tool-glob"]),
      "progress-list|result-list|progress-glob",
    )

    expect(initial).toBe("explore-tool-list")
    expect(withResult).toBe(initial)
    expect(withLaterSearch).toBe(initial)
  })
})
