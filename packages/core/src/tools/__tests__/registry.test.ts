import { describe, expect, it } from "vitest"
import { z } from "zod"

import { MODES, type ToolDef } from "../../types.js"
import { getBuiltinToolsForMode } from "../../agent/modes.js"
import { ToolRegistry } from "../registry.js"

function fakeTool(name: string): ToolDef {
  return {
    name,
    description: `${name} test tool`,
    parameters: z.object({}),
    async execute() {
      return { success: true, output: name }
    },
  }
}

describe("ToolRegistry registration contracts", () => {
  it("registers manager-bound built-ins declared by modes", () => {
    const registry = new ToolRegistry()
    const tool = fakeTool("TaskCreateBatch")

    expect(registry.registerBoundBuiltin(tool)).toEqual({
      ok: true,
      replaced: false,
    })
    expect(registry.get("TaskCreateBatch")).toBe(tool)
  })

  it("rejects a dynamic tool that collides with a reserved built-in", () => {
    const registry = new ToolRegistry()

    expect(registry.registerDynamic(fakeTool("Read"))).toEqual({
      ok: false,
      reason: "reserved-name",
    })
  })

  it("reports duplicate dynamic registration instead of replacing it", () => {
    const registry = new ToolRegistry()
    const first = fakeTool("example__tool")

    expect(registry.registerDynamic(first)).toEqual({
      ok: true,
      replaced: false,
    })
    expect(registry.registerDynamic(fakeTool("example__tool"))).toEqual({
      ok: false,
      reason: "duplicate",
    })
    expect(registry.get("example__tool")).toBe(first)
  })

  it("resolves every mode-declared built-in after bound tools attach", () => {
    const registry = new ToolRegistry()
    for (const name of ["TaskCreateBatch", "TaskSnapshot", "TaskResume"]) {
      expect(registry.registerBoundBuiltin(fakeTool(name))).toEqual({
        ok: true,
        replaced: false,
      })
    }

    const unresolved = MODES.flatMap((mode) =>
      getBuiltinToolsForMode(mode)
        .filter((name) => !registry.get(name))
        .map((name) => `${mode}:${name}`),
    )

    expect(registry.get("TaskCreateBatch")).toBeDefined()
    expect(registry.get("TaskSnapshot")).toBeDefined()
    expect(registry.get("TaskResume")).toBeDefined()
    expect(unresolved).toEqual([])
  })
})

