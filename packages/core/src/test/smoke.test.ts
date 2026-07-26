import { describe, expect, it } from "vitest"

import { NexusConfigSchema } from "../config/schema.js"
import { ToolRegistry } from "../tools/registry.js"
import { createFakeHost, createFakeSession, createTestConfig } from "./fakes.js"

describe("core test harness", () => {
  it("constructs the default config and registry", () => {
    const config = NexusConfigSchema.parse({})
    const registry = new ToolRegistry()

    expect(config.model.provider).toBeTruthy()
    expect(registry.get("Read")?.name).toBe("Read")
  })

  it("uses fail-closed fake host defaults", async () => {
    const host = createFakeHost()

    await expect(
      host.showApprovalDialog({
        type: "execute",
        tool: "Bash",
        description: "run",
      }),
    ).resolves.toEqual({ approved: false })
    await expect(host.runCommand("echo unsafe", host.cwd)).rejects.toThrow(
      /command stub/i,
    )
  })

  it("creates isolated test sessions and deeply merged config", () => {
    const session = createFakeSession()
    const config = createTestConfig({
      permissions: { autoApproveRead: false },
    })

    expect(session.messages).toEqual([])
    expect(config.permissions.autoApproveRead).toBe(false)
    expect(config.permissions.denyPatterns.length).toBeGreaterThan(0)
  })
})
