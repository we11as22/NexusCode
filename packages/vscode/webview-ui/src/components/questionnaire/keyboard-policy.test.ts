import { describe, expect, it } from "vitest"
import { questionnaireKeyboardAction } from "./keyboard-policy"

describe("questionnaire keyboard policy", () => {
  it("keeps plain Enter inside the custom textarea for multiline answers", () => {
    expect(
      questionnaireKeyboardAction({
        key: "Enter",
        targetTag: "textarea",
        activeAnswered: true,
      }),
    ).toBe("none")
  })

  it("submits a completed answer with Enter outside an editor", () => {
    expect(
      questionnaireKeyboardAction({
        key: "Enter",
        targetTag: "div",
        activeAnswered: true,
      }),
    ).toBe("continue")
  })

  it("supports Ctrl/Cmd+Enter from the custom textarea", () => {
    expect(
      questionnaireKeyboardAction({
        key: "Enter",
        targetTag: "textarea",
        activeAnswered: true,
        ctrlKey: true,
      }),
    ).toBe("continue")
  })

  it("maps numeric shortcuts only to visible choices", () => {
    expect(
      questionnaireKeyboardAction({
        key: "2",
        targetTag: "div",
        activeAnswered: false,
        optionCount: 3,
      }),
    ).toEqual({ selectOption: 1 })
    expect(
      questionnaireKeyboardAction({
        key: "4",
        targetTag: "div",
        activeAnswered: false,
        optionCount: 3,
      }),
    ).toBe("none")
  })

  it("does not hijack text entry or native button activation", () => {
    expect(
      questionnaireKeyboardAction({
        key: "1",
        targetTag: "textarea",
        activeAnswered: false,
        optionCount: 3,
      }),
    ).toBe("none")
    expect(
      questionnaireKeyboardAction({
        key: "Enter",
        targetTag: "button",
        activeAnswered: true,
      }),
    ).toBe("none")
  })
})
