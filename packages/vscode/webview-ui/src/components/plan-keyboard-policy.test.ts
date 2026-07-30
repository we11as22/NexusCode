import { describe, expect, it } from "vitest"
import { planKeyboardAction } from "./plan-keyboard-policy"

describe("Plan decision keyboard policy", () => {
  it("selects the two visible decisions with number keys", () => {
    expect(planKeyboardAction({ key: "1", canSubmit: true })).toEqual({ select: 0 })
    expect(planKeyboardAction({ key: "2", canSubmit: true })).toEqual({ select: 1 })
    expect(planKeyboardAction({ key: "3", canSubmit: true })).toBe("none")
  })

  it("maps Escape to the separate dismiss action", () => {
    expect(planKeyboardAction({ key: "Escape", canSubmit: true })).toBe("dismiss")
  })

  it("keeps plain Enter in feedback multiline and submits with Cmd/Ctrl+Enter", () => {
    expect(planKeyboardAction({
      key: "Enter",
      targetTag: "textarea",
      canSubmit: true,
    })).toBe("none")
    expect(planKeyboardAction({
      key: "Enter",
      targetTag: "textarea",
      canSubmit: true,
      metaKey: true,
    })).toBe("submit")
  })

  it("submits with Enter outside editors only when the choice is valid", () => {
    expect(planKeyboardAction({ key: "Enter", canSubmit: true })).toBe("submit")
    expect(planKeyboardAction({ key: "Enter", canSubmit: false })).toBe("none")
  })

  it("does not hijack native button activation or text entry", () => {
    expect(planKeyboardAction({
      key: "Enter",
      targetTag: "button",
      canSubmit: true,
    })).toBe("none")
    expect(planKeyboardAction({
      key: "2",
      targetTag: "textarea",
      canSubmit: true,
    })).toBe("none")
  })
})
