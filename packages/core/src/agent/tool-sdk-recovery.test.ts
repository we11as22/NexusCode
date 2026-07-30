import { describe, expect, it } from "vitest"
import {
  createInvalidToolArgumentsDeduper,
  type InvalidToolArgumentsLike,
} from "./tool-sdk-recovery.js"

function invalidWriteCall(args = "{}"): InvalidToolArgumentsLike {
  return Object.assign(
    new Error("Invalid arguments for tool Write: Type validation failed"),
    {
      name: "AI_InvalidToolArgumentsError",
      toolName: "Write",
      toolArgs: args,
    },
  )
}

describe("invalid tool-call recovery", () => {
  it("records one recovery for duplicate SDK errors in the same provider turn", () => {
    const dedupe = createInvalidToolArgumentsDeduper()

    expect(dedupe.shouldRecord(invalidWriteCall())).toBe(true)
    expect(dedupe.shouldRecord(invalidWriteCall())).toBe(false)
  })

  it("keeps distinct malformed calls so the model receives useful corrections", () => {
    const dedupe = createInvalidToolArgumentsDeduper()

    expect(dedupe.shouldRecord(invalidWriteCall("{}"))).toBe(true)
    expect(
      dedupe.shouldRecord(invalidWriteCall('{"file_path":"note.txt"}')),
    ).toBe(true)
  })
})
