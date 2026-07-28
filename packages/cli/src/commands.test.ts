import { describe, expect, it } from "vitest"
import { getCommands } from "./commands.js"

describe("Nexus CLI command catalog", () => {
  it("does not expose the retired Anthropic feedback endpoint", async () => {
    const commands = await getCommands(false)
    expect(commands.map((command: { name: string }) => command.name)).not.toContain("bug")
  })
})
