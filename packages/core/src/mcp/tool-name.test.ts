import { describe, expect, it } from "vitest"

import {
  callableMcpToolName,
  MAX_MODEL_TOOL_NAME_CHARS,
} from "./tool-name.js"

describe("MCP model-visible tool names", () => {
  it("preserves existing short safe names", () => {
    expect(callableMcpToolName("calendar", "create_event")).toBe(
      "calendar__create_event",
    )
  })

  it("sanitizes and deterministically disambiguates raw collisions", () => {
    const dashed = callableMcpToolName("team-calendar", "review/pr")
    const underscored = callableMcpToolName("team_calendar", "review_pr")

    expect(dashed).toMatch(/^[A-Za-z0-9_]+$/u)
    expect(underscored).toMatch(/^[A-Za-z0-9_]+$/u)
    expect(dashed).not.toBe(underscored)
    expect(callableMcpToolName("team-calendar", "review/pr")).toBe(dashed)
  })

  it("keeps long names within the strictest provider limit", () => {
    const name = callableMcpToolName(
      "server".repeat(30),
      "tool".repeat(40),
    )
    expect(name).toHaveLength(MAX_MODEL_TOOL_NAME_CHARS)
    expect(name).toMatch(/^[A-Za-z0-9_]+$/u)
  })
})
