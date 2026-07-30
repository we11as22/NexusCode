import { describe, expect, it } from "vitest"

import {
  computeApprovalDiffLineLimit,
  truncateToDisplayWidth,
} from "./approval-panel-layout.js"

describe("CLI approval panel layout", () => {
  it("keeps a write approval shorter than a 24-row terminal", () => {
    expect(computeApprovalDiffLineLimit(24, 5)).toBe(8)
  })

  it("uses more diff rows on a tall terminal without becoming unbounded", () => {
    expect(computeApprovalDiffLineLimit(60, 5)).toBe(18)
  })

  it("keeps a minimal preview on very short terminals", () => {
    expect(computeApprovalDiffLineLimit(12, 7)).toBe(2)
  })

  it("clips wide Unicode lines by terminal display width", () => {
    const clipped = truncateToDisplayWidth("abc🙂def", 6)
    expect(clipped).toBe("abc🙂…")
  })
})
