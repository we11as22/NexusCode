import { describe, expect, it, vi } from "vitest"

import type { AgentEvent, ToolContext } from "../../types.js"
import {
  askFollowupTool,
  todoWriteTool,
} from "./report-and-control.js"

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

describe("TodoWrite lifecycle", () => {
  function todoContext(initial = "") {
    let todo = initial
    return {
      context: {
        session: {
          getTodo: () => todo,
          updateTodo: (next: string) => {
            todo = next
          },
        },
      } as ToolContext,
      getTodo: () => todo,
    }
  }

  it("clears the active list after every item completes", async () => {
    const state = todoContext(
      JSON.stringify([
        { id: "one", content: "First milestone", status: "in_progress" },
        { id: "two", content: "Second milestone", status: "pending" },
      ]),
    )
    const input = todoWriteTool.parameters.parse({
      merge: true,
      todos: [
        { id: "one", content: "First milestone", status: "completed" },
        { id: "two", content: "Second milestone", status: "completed" },
      ],
    })

    await expect(
      todoWriteTool.execute(input, state.context),
    ).resolves.toMatchObject({
      success: true,
      output: "Todo list completed and cleared.",
    })
    expect(state.getTodo()).toBe("")
  })

  it("reconciles plan-seeded todos by content when the model chooses new ids", async () => {
    const state = todoContext(
      JSON.stringify([
        {
          id: "plan-1",
          content: "Создать nexus-plan-ui-check.txt со строкой UI_OK.",
          status: "in_progress",
        },
        {
          id: "plan-2",
          content: "Проверить, что в файле ровно одна строка UI_OK.",
          status: "pending",
        },
      ]),
    )
    const input = todoWriteTool.parameters.parse({
      merge: true,
      todos: [
        {
          id: "1",
          content: "  создать   nexus-plan-ui-check.txt со строкой UI_OK. ",
          status: "completed",
        },
        {
          id: "2",
          content: "Проверить, что в файле ровно одна строка UI_OK.",
          status: "completed",
        },
      ],
    })

    await expect(
      todoWriteTool.execute(input, state.context),
    ).resolves.toMatchObject({
      success: true,
      output: "Todo list completed and cleared.",
    })
    expect(state.getTodo()).toBe("")
  })

  it("keeps at most one active item after merging into prior state", async () => {
    const state = todoContext(
      JSON.stringify([
        { id: "old", content: "Old milestone", status: "in_progress" },
        { id: "later", content: "Later milestone", status: "pending" },
      ]),
    )
    const input = todoWriteTool.parameters.parse({
      merge: true,
      todos: [
        { id: "new", content: "New milestone", status: "in_progress" },
      ],
    })

    await todoWriteTool.execute(input, state.context)

    expect(JSON.parse(state.getTodo())).toEqual([
      { id: "old", content: "Old milestone", status: "pending" },
      { id: "later", content: "Later milestone", status: "pending" },
      { id: "new", content: "New milestone", status: "in_progress" },
    ])
  })

  it("rejects a merged list above the bounded todo limit without mutating state", async () => {
    const initial = JSON.stringify(
      Array.from({ length: 100 }, (_, index) => ({
        id: `existing-${index}`,
        content: `Existing milestone ${index}`,
        status: "pending",
      })),
    )
    const state = todoContext(initial)
    const input = todoWriteTool.parameters.parse({
      merge: true,
      todos: [
        { id: "overflow", content: "Overflow milestone", status: "pending" },
      ],
    })

    await expect(
      todoWriteTool.execute(input, state.context),
    ).resolves.toMatchObject({
      success: false,
      output: expect.stringMatching(/100/),
    })
    expect(state.getTodo()).toBe(initial)
  })

  it("retains unfinished and cancelled work for recovery", async () => {
    const state = todoContext()
    const input = todoWriteTool.parameters.parse({
      merge: false,
      todos: [
        { id: "done", content: "Finished milestone", status: "completed" },
        { id: "blocked", content: "Blocked milestone", status: "cancelled" },
      ],
    })

    await todoWriteTool.execute(input, state.context)

    expect(JSON.parse(state.getTodo())).toEqual(input.todos)
  })

  it("rejects duplicate ids and multiple active items", () => {
    const parsed = todoWriteTool.parameters.safeParse({
      merge: false,
      todos: [
        { id: "same", content: "First", status: "in_progress" },
        { id: "same", content: "Second", status: "in_progress" },
      ],
    })

    expect(parsed.success).toBe(false)
  })
})
