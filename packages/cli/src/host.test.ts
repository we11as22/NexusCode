import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CliHost,
  resolveNonInteractiveApproval,
  shouldAutoApprovePrint,
} from "./host.js"
import type { ApprovalAction } from "@nexuscode/core"

function action(type: ApprovalAction["type"]): ApprovalAction {
  return {
    type,
    tool: type === "execute" ? "Bash" : `Test${type}`,
    description: `test ${type}`,
  }
}

describe("non-interactive approvals", () => {
  it("denies privileged actions regardless of read policy", () => {
    const policy = { read: true }

    expect(resolveNonInteractiveApproval(action("write"), policy)).toEqual({
      approved: false,
    })
    expect(resolveNonInteractiveApproval(action("execute"), policy)).toEqual({
      approved: false,
    })
    expect(resolveNonInteractiveApproval(action("mcp"), policy)).toEqual({
      approved: false,
    })
    expect(resolveNonInteractiveApproval(action("browser"), policy)).toEqual({
      approved: false,
    })
  })

  it("approves reads only when the explicit policy permits them", () => {
    expect(resolveNonInteractiveApproval(action("read"), {})).toEqual({
      approved: false,
    })
    expect(resolveNonInteractiveApproval(action("read"), { read: true })).toEqual({
      approved: true,
    })
  })

  it("uses the dangerous flag as the sole print-mode bypass", () => {
    expect(shouldAutoApprovePrint(undefined)).toBe(false)
    expect(shouldAutoApprovePrint(false)).toBe(false)
    expect(shouldAutoApprovePrint(true)).toBe(true)
  })
})

describe("CliHost in a headless process", () => {
  const originalIsTTY = process.stdin.isTTY

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    })
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    })
    vi.restoreAllMocks()
  })

  it("fails closed without creating readline and emits one diagnostic", async () => {
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const host = new CliHost(process.cwd(), () => {}, false, undefined, {
      read: true,
    })

    await expect(host.showApprovalDialog(action("read"))).resolves.toEqual({
      approved: true,
    })
    await expect(host.showApprovalDialog(action("write"))).resolves.toEqual({
      approved: false,
    })
    await expect(host.showApprovalDialog(action("execute"))).resolves.toEqual({
      approved: false,
    })

    expect(diagnostic).toHaveBeenCalledTimes(1)
    expect(String(diagnostic.mock.calls[0]?.[0])).toContain(
      "Non-interactive mode",
    )
  })

  it("retains the explicit dangerous bypass", async () => {
    const host = new CliHost(process.cwd(), () => {}, true)
    await expect(host.showApprovalDialog(action("execute"))).resolves.toEqual({
      approved: true,
    })
  })
})
