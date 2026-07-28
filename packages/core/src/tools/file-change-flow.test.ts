import { describe, expect, it } from "vitest"

import {
  buildDurableChangeHunks,
  exactChangeHunkDiffStats,
  exactLineDiffStats,
  workspaceRelativeChangePath,
} from "./file-change-flow.js"

describe("exactLineDiffStats", () => {
  it("does not count the empty segment after a trailing newline", () => {
    expect(exactLineDiffStats("before\n", "after\n")).toEqual({
      added: 1,
      removed: 1,
    })
    expect(exactLineDiffStats("", "created\n")).toEqual({
      added: 1,
      removed: 0,
    })
  })

  it("retains duplicate-line multiplicity", () => {
    expect(exactLineDiffStats("same\nsame\n", "same\n")).toEqual({
      added: 0,
      removed: 1,
    })
  })

  it("reports no changes for identical empty or populated text", () => {
    expect(exactLineDiffStats("", "")).toEqual({ added: 0, removed: 0 })
    expect(exactLineDiffStats("same", "same")).toEqual({
      added: 0,
      removed: 0,
    })
  })

  it("derives review counts from canonical hunk additions and removals", () => {
    const hunks = buildDurableChangeHunks(
      "same\nsame\nbefore\n",
      "same\nafter\n",
    )
    expect(exactChangeHunkDiffStats(hunks)).toEqual({
      added: 1,
      removed: 2,
    })
  })
})

describe("workspaceRelativeChangePath", () => {
  it("normalizes an absolute in-workspace tool path for durable storage", () => {
    expect(
      workspaceRelativeChangePath(
        "/workspace/project",
        "/workspace/project/src/index.ts",
      ),
    ).toBe("src/index.ts")
  })

  it("rejects paths outside the execution workspace", () => {
    expect(() =>
      workspaceRelativeChangePath(
        "/workspace/project",
        "/workspace/other.txt",
      ),
    ).toThrow("outside")
  })
})
