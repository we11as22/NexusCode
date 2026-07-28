import { describe, expect, it } from "vitest"
import { z } from "zod"

import { getBuiltinToolsForMode } from "../modes.js"
import { GitService } from "../../git/service.js"
import type { GitCommandRunnerPort } from "../../git/types.js"
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
    expect(visibleNames("plan")).not.toContain("McpAuthenticate")
    expect(visibleNames("plan")).toContain("MemoryList")
    expect(visibleNames("plan")).toContain("MemoryGet")
    expect(visibleNames("plan")).not.toContain("MemoryCreate")
    expect(visibleNames("plan")).not.toContain("MemoryUpdate")
    expect(visibleNames("plan")).not.toContain("MemoryDelete")
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

  it("assembles Git inspection as validated argv without a shell", async () => {
    let argv: readonly string[] = []
    const runner: GitCommandRunnerPort = {
      async run(value) {
        argv = value
        return {
          argv: value,
          stdout: Buffer.from("ok"),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          timedOut: false,
          truncated: false,
        }
      },
    }
    const host = createFakeHost({
      async runCommand() {
        throw new Error("GitInspect must not use the host shell")
      },
    })
    const tool = new ToolRegistry().get("GitInspect")!
    const args = tool.parameters.parse({
      operation: "blame",
      revision: "HEAD~1",
      path: "src/it's-safe.ts",
    })

    const result = await tool.execute(args, {
      cwd: host.cwd,
      host,
      session: createFakeSession(host.cwd),
      config: createTestConfig(),
      services: createNexusRunServices({
        git: new GitService(host.cwd, { runner }),
      }),
      signal: new AbortController().signal,
      mode: "review",
    })

    expect(result.success).toBe(true)
    expect(argv).toEqual([
      "--no-optional-locks",
      "blame",
      "--no-color",
      "HEAD~1",
      "--",
      "src/it's-safe.ts",
    ])
  })
})
