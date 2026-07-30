import { describe, expect, it } from "vitest"

import {
  formatChangeReview,
  formatChangeResolution,
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

  it("renders numbered file-oriented review instructions without opaque ids", () => {
    const output = formatChangeReview(items)
    expect(output).toContain("/accept <number>")
    expect(output).toContain("2. (+4 -0) src/b.ts, src/c.ts")
    expect(output).not.toContain(items[0]!.changeSetId)
    expect(output).not.toContain(items[1]!.changeSetId)
    expect(formatChangeReview([], true)).toMatch(/no applied/i)
  })

  it("describes accepted and reverted changes by files, never internal ids", () => {
    const accepted = formatChangeResolution(items[0]!, "accept")
    const reverted = formatChangeResolution(items[1]!, "revert")

    expect(accepted).toBe("Accepted change: src/a.ts.")
    expect(reverted).toBe(
      "Reverted change and restored the exact prior file state: src/b.ts, src/c.ts.",
    )
    expect(`${accepted}\n${reverted}`).not.toMatch(/aaaaaaaa|bbbbbbbb/)
  })
})
