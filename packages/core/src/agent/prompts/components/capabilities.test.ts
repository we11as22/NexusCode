import { describe, expect, it } from "vitest"
import { NexusConfigSchema } from "../../../config/schema.js"
import type { NexusConfig } from "../../../types.js"
import { buildRoleBlock } from "./index.js"

describe("agent capability prompt", () => {
  it("describes built-in web access without claiming an absent browser tool", () => {
    const prompt = buildRoleBlock({
      mode: "agent",
      config: NexusConfigSchema.parse({}) as NexusConfig,
      cwd: "/workspace",
      modelId: "test-model",
      providerName: "test-provider",
      skills: [],
      rulesContent: "",
    })

    expect(prompt).toContain("web search/fetch")
    expect(prompt).toContain("browser plugin or MCP tool")
    expect(prompt).not.toContain(
      "search the codebase, browser automation, and MCP tool servers",
    )
  })
})
