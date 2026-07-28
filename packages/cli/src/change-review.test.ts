import { describe, expect, it } from "vitest"

import {
  formatChangeReview,
  resolveChangeReviewSelection,
  type CliChangeReviewItem,
} from "./change-review.js"

const items: CliChangeReviewItem[] = [
  {
    changeSetId: "aaaaaaaa-1111",
    proposalHash: "1".repeat(64),
    paths: ["src/a.ts"],
    added: 3,
    removed: 1,
  },
  {
    changeSetId: "bbbbbbbb-2222",
    proposalHash: "2".repeat(64),
    paths: ["src/b.ts", "src/c.ts"],
    added: 4,
    removed: 0,
  },
]

describe("CLI durable change review", () => {
  it("selects an exact pending change by one-based number or unique prefix", () => {
    expect(resolveChangeReviewSelection(items, "2")).toBe(items[1])
    expect(resolveChangeReviewSelection(items, "aaaaaaaa")).toBe(items[0])
  })

  it("fails closed for missing, unknown, or ambiguous selectors", () => {
    expect(() => resolveChangeReviewSelection(items, "")).toThrow(/specify/i)
    expect(() => resolveChangeReviewSelection(items, "9")).toThrow(/no pending/i)
    expect(() =>
      resolveChangeReviewSelection(
        [
          items[0]!,
          { ...items[1]!, changeSetId: "aaaa2222" },
        ],
        "aaaa",
      ),
    ).toThrow(/ambiguous/i)
  })

  it("renders bounded actionable review instructions", () => {
    expect(formatChangeReview(items)).toContain(
      "/accept <number|id>",
    )
    expect(formatChangeReview(items)).toContain("src/b.ts, src/c.ts")
    expect(formatChangeReview([], true)).toMatch(/no applied/i)
  })
})
