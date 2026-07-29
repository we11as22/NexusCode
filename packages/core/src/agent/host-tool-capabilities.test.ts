import { describe, expect, it } from "vitest"
import { z } from "zod"

import type { ToolDef } from "../types.js"
import { filterToolsForHostCapabilities } from "./host-tool-capabilities.js"

function fakeTool(name: string): ToolDef {
  return {
    name,
    description: `${name} fixture`,
    parameters: z.object({}),
    async execute() {
      return { success: true, output: name }
    },
  }
}

describe("host tool capability projection", () => {
  it("removes AskFollowupQuestion when interactive input is unavailable", () => {
    const projected = filterToolsForHostCapabilities(
      [fakeTool("Read"), fakeTool("AskFollowupQuestion")],
      { interactiveQuestions: false },
    )

    expect(projected.map((tool) => tool.name)).toEqual(["Read"])
  })

  it("fails closed when host capabilities are absent", () => {
    const projected = filterToolsForHostCapabilities(
      [fakeTool("AskFollowupQuestion")],
      undefined,
    )

    expect(projected).toEqual([])
  })

  it("keeps the question tool for an interactive host", () => {
    const ask = fakeTool("AskFollowupQuestion")

    expect(
      filterToolsForHostCapabilities(
        [ask],
        { interactiveQuestions: true },
      ),
    ).toEqual([ask])
  })
})
