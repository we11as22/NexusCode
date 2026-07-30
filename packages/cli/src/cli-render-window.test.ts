import { describe, expect, it } from "vitest"

import {
  computeCliRenderWindowStart,
  partitionCliRenderItems,
  shouldKeepLatestAssistantMessageLive,
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

describe("CLI static transcript prefix", () => {
  it("freezes only the contiguous completed prefix", () => {
    const items = [
      { key: "user", type: "static" as const },
      { key: "thought", type: "static" as const },
      { key: "tool", type: "transient" as const },
      { key: "result", type: "static" as const },
    ]

    expect(partitionCliRenderItems(items)).toEqual({
      staticPrefix: items.slice(0, 2),
      liveSuffix: items.slice(2),
    })
  })

  it("freezes an entirely completed transcript", () => {
    const items = [
      { key: "user", type: "static" as const },
      { key: "answer", type: "static" as const },
    ]

    expect(partitionCliRenderItems(items)).toEqual({
      staticPrefix: items,
      liveSuffix: [],
    })
  })

  it("keeps an entirely live transcript dynamic", () => {
    const items = [{ key: "tool", type: "transient" as const }]

    expect(partitionCliRenderItems(items)).toEqual({
      staticPrefix: [],
      liveSuffix: items,
    })
  })

  it("keeps only the latest assistant draft live while a turn is streaming", () => {
    expect(
      shouldKeepLatestAssistantMessageLive(true, "assistant-new", "assistant-new"),
    ).toBe(true)
    expect(
      shouldKeepLatestAssistantMessageLive(true, "assistant-old", "assistant-new"),
    ).toBe(false)
    expect(
      shouldKeepLatestAssistantMessageLive(false, "assistant-new", "assistant-new"),
    ).toBe(false)
  })
})
