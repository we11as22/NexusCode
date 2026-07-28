import { describe, expect, it } from "vitest"
import { bashTool } from "./execute-command.js"

describe("Bash tool execution contract", () => {
  it("does not advertise a sandbox override when the host has no sandbox port", () => {
    const parsed = bashTool.parameters.safeParse({
      command: "printf safe",
      dangerouslyDisableSandbox: true,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("dangerouslyDisableSandbox")
    }
    expect(bashTool.description.toLowerCase()).not.toContain(
      "override sandbox",
    )
  })
})
