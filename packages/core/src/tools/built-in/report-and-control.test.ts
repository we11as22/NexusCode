import { describe, expect, it, vi } from "vitest"

import type { AgentEvent, ToolContext } from "../../types.js"
import { askFollowupTool } from "./report-and-control.js"

describe("AskFollowupQuestion contract", () => {
  it("rejects a question with fewer than two real choices", () => {
    const parsed = askFollowupTool.parameters.safeParse({
      question: "Choose the target",
      options: ["Only one"],
    })

    expect(parsed.success).toBe(false)
  })

  it("rejects a legacy question that omits concrete choices", () => {
    const parsed = askFollowupTool.parameters.safeParse({
      question: "Choose the target",
    })

    expect(parsed.success).toBe(false)
  })

  it("rejects an agent-supplied custom row as a real choice", () => {
    const parsed = askFollowupTool.parameters.safeParse({
      question: "Choose the target",
      options: ["Workspace", "Other"],
    })

    expect(parsed.success).toBe(false)
  })

  it("accepts two unique concrete choices", () => {
    const parsed = askFollowupTool.parameters.safeParse({
      question: "Choose the target",
      options: [
        {
          label: "Workspace (Recommended)",
          description: "Use the currently open workspace.",
        },
        {
          label: "New worktree",
          description: "Create an isolated worktree.",
        },
      ],
    })

    expect(parsed.success).toBe(true)
  })

  it("rejects more than four questions in one interruption", () => {
    const parsed = askFollowupTool.parameters.safeParse({
      questions: Array.from({ length: 5 }, (_, index) => ({
        id: `q${index + 1}`,
        question: `Question ${index + 1}?`,
        options: ["Yes", "No"],
      })),
    })

    expect(parsed.success).toBe(false)
  })

  it("assigns collision-safe request ids to consecutive questions", async () => {
    const emitted: AgentEvent[] = []
    const context = {
      host: {
        emit(event: AgentEvent) {
          emitted.push(event)
        },
      },
      partId: "part-1",
    } as ToolContext
    const input = askFollowupTool.parameters.parse({
      question: "Choose the target",
      options: ["Workspace", "Worktree"],
    })
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000)

    try {
      await askFollowupTool.execute(input, context)
      await askFollowupTool.execute(input, context)
    } finally {
      now.mockRestore()
    }

    const requestIds = emitted.flatMap((event) =>
      event.type === "question_request" ? [event.request.requestId] : [],
    )
    expect(requestIds).toHaveLength(2)
    expect(new Set(requestIds).size).toBe(2)
  })

  it("lets the agent explicitly suppress the custom answer row", async () => {
    const emitted: AgentEvent[] = []
    const input = askFollowupTool.parameters.parse({
      question: "Choose the target",
      options: ["Workspace", "Worktree"],
      allow_custom: false,
    })
    await askFollowupTool.execute(input, {
      host: {
        emit(event: AgentEvent) {
          emitted.push(event)
        },
      },
      partId: "part-no-custom",
    } as ToolContext)

    const request = emitted.find(
      (event) => event.type === "question_request",
    )
    expect(request?.type).toBe("question_request")
    if (request?.type !== "question_request") return
    expect(request.request.questions[0]?.allowCustom).toBe(false)
  })

  it("returns an actionable model-facing validation error", () => {
    const parsed = askFollowupTool.parameters.safeParse({
      question: "Choose the target",
      options: ["Only one"],
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return

    const message = askFollowupTool.formatValidationError?.(parsed.error)
    expect(message).toMatch(/2.?4 real options/i)
    expect(message).toContain('"options"')
  })
})
