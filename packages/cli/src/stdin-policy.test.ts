import { describe, expect, it } from "vitest"
import { shouldReadPromptFromStdin } from "./stdin-policy.js"

describe("CLI stdin policy", () => {
  it.each([
    ["config", "get", "theme"],
    ["--cwd", "/tmp/project", "config", "list"],
    ["mcp", "list"],
    ["task", "checkpoints"],
    ["approved-tools", "list"],
    ["doctor"],
  ])("does not wait for prompt stdin for command argv %j", (...argv) => {
    expect(shouldReadPromptFromStdin(argv)).toBe(false)
  })

  it.each([
    [],
    ["Fix", "the", "tests"],
    ["--mode", "plan", "Design", "the", "feature"],
    ["--print"],
  ])("allows prompt stdin for agent argv %j", (...argv) => {
    expect(shouldReadPromptFromStdin(argv)).toBe(true)
  })
})
