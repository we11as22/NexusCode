import { describe, expect, it } from "vitest"
import {
  planFollowupAction,
  PLAN_FOLLOWUP_OPTIONS,
} from "./plan-followup-policy.js"

describe("plan follow-up policy", () => {
  it("matches the approve-or-revise workflow and keeps dismissal separate", () => {
    expect(PLAN_FOLLOWUP_OPTIONS.map((option) => option.id)).toEqual([
      "implement",
      "revise",
    ])
    expect(planFollowupAction("implement", "")).toEqual({
      choice: "implement",
    })
    expect(planFollowupAction("revise", "  cover rollback  ")).toEqual({
      choice: "revise",
      instruction: "cover rollback",
    })
    expect(planFollowupAction("dismiss", "")).toEqual({
      choice: "abandon",
    })
  })

  it("does not submit a revision without feedback", () => {
    expect(planFollowupAction("revise", "   ")).toBeNull()
  })
})
