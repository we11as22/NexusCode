import { describe, expect, it } from "vitest"

import {
  shouldAnimateNexusActivity,
  shouldCancelActiveNexusRun,
  shouldEnableGlobalCancelInput,
} from "./cancel-policy.js"

describe("CLI cancel routing", () => {
  it("leaves Escape to the approval panel instead of aborting the whole turn", () => {
    expect(
      shouldCancelActiveNexusRun({
        isLoading: true,
        hasRunningSubagent: false,
        hasApprovalPanel: true,
      }),
    ).toBe(false)
  })

  it("still aborts a running turn when no modal owns Escape", () => {
    expect(
      shouldCancelActiveNexusRun({
        isLoading: true,
        hasRunningSubagent: false,
        hasApprovalPanel: false,
      }),
    ).toBe(true)
  })

  it("unsubscribes the global Escape handler while an approval owns input", () => {
    expect(shouldEnableGlobalCancelInput({ hasApprovalPanel: true })).toBe(false)
    expect(shouldEnableGlobalCancelInput({ hasApprovalPanel: false })).toBe(true)
  })

  it("freezes background activity animations while an approval is visible", () => {
    expect(
      shouldAnimateNexusActivity({
        hasApprovalPanel: true,
        hasLegacyPermissionPanel: false,
        hasToolShell: false,
        messageSelectorVisible: false,
        primarySpinnerVisible: true,
      }),
    ).toBe(false)
    expect(
      shouldAnimateNexusActivity({
        hasApprovalPanel: false,
        hasLegacyPermissionPanel: false,
        hasToolShell: false,
        messageSelectorVisible: false,
        primarySpinnerVisible: false,
      }),
    ).toBe(true)
  })
})
