import { describe, expect, it } from "vitest"

import {
  distanceFromBottom,
  shouldFollowNewContent,
} from "./native-scroll-policy.js"

describe("native chat scroll policy", () => {
  it("treats the Cursor-like bottom tolerance as pinned", () => {
    expect(distanceFromBottom({
      scrollHeight: 1_000,
      clientHeight: 400,
      scrollTop: 590,
    })).toBe(10)
    expect(shouldFollowNewContent({
      scrollHeight: 1_000,
      clientHeight: 400,
      scrollTop: 590,
    })).toBe(true)
  })

  it("preserves deliberate history browsing", () => {
    expect(shouldFollowNewContent({
      scrollHeight: 1_000,
      clientHeight: 400,
      scrollTop: 300,
    })).toBe(false)
  })
})
