import { describe, expect, it } from "vitest"

import { searchBm25 } from "./bm25.js"

describe("searchBm25", () => {
  it("ranks relevant Unicode catalog entries deterministically", () => {
    const documents = [
      { value: "browser", text: "browser page navigation" },
      { value: "memory", text: "память агента поиск воспоминаний" },
      { value: "other-memory", text: "память" },
    ]

    expect(
      searchBm25(documents, "память поиск агента", 2).map(
        (match) => match.value,
      ),
    ).toEqual(["memory", "other-memory"])
  })

  it("returns no arbitrary fallback for a query with no matching terms", () => {
    expect(
      searchBm25(
        [{ value: "read", text: "read local file" }],
        "calendar",
        8,
      ),
    ).toEqual([])
  })
})
