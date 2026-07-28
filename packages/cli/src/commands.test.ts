import { describe, expect, it } from "vitest"
import { getCommands, hasCommand } from "./commands.js"

describe("Nexus CLI command catalog", () => {
  it("does not expose the retired Anthropic feedback endpoint", async () => {
    const commands = await getCommands(false)
    expect(commands.map((command: { name: string }) => command.name)).not.toContain("bug")
  })

  it("always routes /help through the local command catalog", async () => {
    const commands = await getCommands(false)

    expect(hasCommand("help", commands)).toBe(true)
    expect(
      commands.find(
        (command: { name: string; type: string }) => command.name === "help",
      )?.type,
    ).toBe("local-jsx")
  })
})
