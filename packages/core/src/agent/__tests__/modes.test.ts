import { describe, expect, it } from "vitest"
import { z } from "zod"

import { getBuiltinToolsForMode } from "../modes.js"
import { ToolRegistry } from "../../tools/registry.js"
import type { Mode, ToolDef } from "../../types.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import { createNexusRunServices } from "../run-services.js"

const modes: Mode[] = ["agent", "plan", "ask", "debug", "review"]

function visibleNames(mode: Mode): string[] {
  const registry = new ToolRegistry()
  const { builtin, dynamic } = registry.getForMode(mode)
  return [...builtin, ...dynamic].map((tool) => tool.name)
}

describe("mode tool reachability", () => {
  it("exposes only the intended execution surface in read-only modes", () => {
    expect(visibleNames("review")).toContain("GitInspect")
    expect(visibleNames("review")).not.toContain("Bash")
    expect(visibleNames("review")).not.toContain("PowerShell")
    expect(visibleNames("review")).not.toContain("Write")
    expect(visibleNames("review")).not.toContain("Edit")
    expect(visibleNames("ask")).not.toContain("Bash")
    expect(visibleNames("plan")).not.toContain("Bash")
    expect(visibleNames("ask")).not.toContain("McpAuthenticate")
    expect(visibleNames("review")).not.toContain("McpAuthenticate")
    expect(visibleNames("plan")).toContain("McpAuthenticate")
  })

  it("uses one canonical plan-completion tool", () => {
    expect(visibleNames("plan")).toContain("PlanExit")
    expect(visibleNames("plan")).not.toContain("ExitPlanMode")
    const registry = new ToolRegistry()
    expect(registry.get("ExitPlanMode")).toBeUndefined()
    expect(registry.registerDynamic({
      name: "ExitPlanMode",
      description: "attempt to replace a retired core capability",
      parameters: z.object({}),
      async execute() {
        return { success: true, output: "unsafe" }
      },
    })).toEqual({ ok: false, reason: "reserved-name" })
  })

  it("does not reclassify out-of-mode built-ins as dynamic tools", () => {
    for (const mode of modes) {
      const expected = new Set(getBuiltinToolsForMode(mode))
      const registry = new ToolRegistry()
      const { builtin, dynamic } = registry.getForMode(mode)

      expect(builtin.every((tool) => expected.has(tool.name))).toBe(true)
      expect(
        dynamic.some((tool) => !expected.has(tool.name)),
        `${mode} unexpectedly exposes a static built-in as dynamic`,
      ).toBe(false)
    }
  })

  it("rejects dynamic aliases that could bypass a built-in mode boundary", () => {
    const registry = new ToolRegistry()
    const fakeExecuteAlias = {
      name: "execute_command",
      description: "unsafe alias",
      parameters: { safeParse: () => ({ success: true, data: {} }) },
      async execute() {
        return { success: true, output: "unsafe" }
      },
    } as unknown as ToolDef

    expect(registry.registerDynamic(fakeExecuteAlias)).toEqual({
      ok: false,
      reason: "reserved-name",
    })
  })

  it("exposes only explicitly read-only dynamic tools in constrained modes", () => {
    const registry = new ToolRegistry()
    const readOnlyTool: ToolDef = {
      name: "external_read",
      description: "safe external read",
      parameters: z.object({}),
      readOnly: true,
      async execute() {
        return { success: true, output: "read" }
      },
    }
    const mutatingTool: ToolDef = {
      name: "external_mutation",
      description: "mutating external tool",
      parameters: z.object({}),
      readOnly: false,
      async execute() {
        return { success: true, output: "mutated" }
      },
    }
    registry.registerDynamicOrThrow(readOnlyTool)
    registry.registerDynamicOrThrow(mutatingTool)

    for (const mode of ["plan", "ask", "review"] as const) {
      const names = registry.getForMode(mode).dynamic.map((tool) => tool.name)
      expect(names).toContain("external_read")
      expect(names).not.toContain("external_mutation")
    }
    for (const mode of ["agent", "debug"] as const) {
      const names = registry.getForMode(mode).dynamic.map((tool) => tool.name)
      expect(names).toContain("external_read")
      expect(names).toContain("external_mutation")
    }
  })

  it("validates GitInspect operations as a closed enum", () => {
    const registry = new ToolRegistry()
    const tool = registry.get("GitInspect")

    expect(tool).toBeDefined()
    expect(
      tool!.parameters.safeParse({ operation: "reset", revision: "HEAD" }).success,
    ).toBe(false)
    expect(
      tool!.parameters.safeParse({
        operation: "show",
        revision: "HEAD;touch-pwned",
      }).success,
    ).toBe(false)
  })

  it("assembles Git inspection from validated, shell-quoted arguments", async () => {
    let command = ""
    const host = createFakeHost({
      async runCommand(value) {
        command = value
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
    })
    const tool = new ToolRegistry().get("GitInspect")!
    const args = tool.parameters.parse({
      operation: "diff",
      revision: "HEAD~1",
      path: "src/it's-safe.ts",
    })

    const result = await tool.execute(args, {
      cwd: host.cwd,
      host,
      session: createFakeSession(host.cwd),
      config: createTestConfig(),
      services: createNexusRunServices(),
      signal: new AbortController().signal,
      mode: "review",
    })

    expect(result.success).toBe(true)
    expect(command).toBe(
      "git diff --no-ext-diff --no-color 'HEAD~1' -- 'src/it'\\''s-safe.ts'",
    )
  })
})
