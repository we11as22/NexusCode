import { describe, expect, it } from "vitest"
import { NexusConfigSchema } from "../../../config/schema.js"
import type { NexusConfig } from "../../../types.js"
import { buildRoleBlock, buildSystemPrompt } from "./index.js"

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

  it("does not advertise arbitrary shell access in review mode", () => {
    const prompt = buildRoleBlock({
      mode: "review",
      config: NexusConfigSchema.parse({}) as NexusConfig,
      cwd: "/workspace",
      modelId: "test-model",
      providerName: "test-provider",
      skills: [],
      rulesContent: "",
    })

    expect(prompt).not.toContain(
      "You MAY run read/search tools and Bash/PowerShell for git inspection",
    )
    expect(prompt).toContain("GitInspect")
    expect(prompt).not.toContain("`Bash` only for actual shell operations")
    expect(prompt).not.toContain("`MemoryCreate` / `MemoryList`")
  })

  it("describes the exact constrained tool surface in plan mode", () => {
    const prompt = buildRoleBlock({
      mode: "plan",
      config: NexusConfigSchema.parse({}) as NexusConfig,
      cwd: "/workspace",
      modelId: "test-model",
      providerName: "test-provider",
      skills: [],
      rulesContent: "",
      enabledToolNames: [
        "Read",
        "Grep",
        "Write",
        "Edit",
        "MemoryList",
        "MemoryGet",
        "PlanExit",
      ],
    })

    expect(prompt).toContain(
      "Enabled tools for this turn: `Edit`, `Grep`, `MemoryGet`, `MemoryList`, `PlanExit`, `Read`, `Write`.",
    )
    expect(prompt).not.toContain("`McpAuthenticate`")
    expect(prompt).not.toContain("`MemoryCreate`")
    expect(prompt).not.toContain("`Bash` only for actual shell operations")
  })

  it("projects configured mode prompts and instructions into the system prompt", () => {
    const config = NexusConfigSchema.parse({
      modes: {
        debug: {
          systemPrompt: "Treat reproducibility as the primary objective.",
          customInstructions: "Capture the smallest failing input before editing.",
        },
      },
    }) as NexusConfig

    const prompt = buildSystemPrompt({
      mode: "debug",
      config,
      cwd: "/workspace",
      modelId: "test-model",
      providerName: "test-provider",
      skills: [],
      rulesContent: "",
    }).blocks.join("\n")

    expect(prompt).toContain("Treat reproducibility as the primary objective.")
    expect(prompt).toContain("Capture the smallest failing input before editing.")
  })
})
