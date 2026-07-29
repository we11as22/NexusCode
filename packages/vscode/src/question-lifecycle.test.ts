import { describe, expect, it } from "vitest"
import type {
  UserQuestionAnswer,
  UserQuestionRequest,
} from "@nexuscode/core"
import { PendingQuestionCoordinator } from "./question-lifecycle.js"

const request: UserQuestionRequest = {
  requestId: "request-1",
  questions: [
    {
      id: "q1",
      question: "Choose",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  ],
}
const answers: UserQuestionAnswer[] = [
  { questionId: "q1", optionId: "a" },
]

describe("PendingQuestionCoordinator", () => {
  it("accepts one response and rejects duplicates and stale responses", () => {
    const coordinator = new PendingQuestionCoordinator()
    coordinator.publish(request)
    expect(coordinator.resolve(request.requestId, answers).accepted).toBe(true)
    expect(coordinator.resolve(request.requestId, answers).accepted).toBe(false)

    coordinator.publish({ ...request, requestId: "request-2" })
    expect(coordinator.resolve(request.requestId, answers).accepted).toBe(false)
    expect(coordinator.snapshot()?.requestId).toBe("request-2")
  })

  it("clears state on dismiss and lifecycle boundaries", () => {
    const coordinator = new PendingQuestionCoordinator()
    coordinator.publish(request)
    expect(coordinator.dismiss(request.requestId)).toBe(true)
    expect(coordinator.dismiss(request.requestId)).toBe(false)
    coordinator.publish(request)
    coordinator.clear("session-switch")
    expect(coordinator.snapshot()).toBeNull()
  })

  it("rejects forged answers without consuming the pending request", () => {
    const coordinator = new PendingQuestionCoordinator()
    coordinator.publish(request)
    expect(() =>
      coordinator.resolve(request.requestId, [
        { questionId: "q1", optionId: "forged" },
      ]),
    ).toThrow(/unknown option/i)
    expect(coordinator.snapshot()?.requestId).toBe(request.requestId)
  })
})
