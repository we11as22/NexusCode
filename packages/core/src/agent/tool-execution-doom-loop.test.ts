import { describe, expect, it } from "vitest"

import { createFakeSession } from "../test/fakes.js"
import {
  detectDoomLoop,
  getDoomLoopSignature,
} from "./tool-execution.js"

function addToolAttempt(
  session: ReturnType<typeof createFakeSession>,
  tool: string,
  input: Record<string, unknown>,
  status: "completed" | "error" = "completed",
): void {
  const message = session.addMessage({ role: "assistant", content: "" })
  session.addToolPart(message.id, {
    type: "tool",
    id: `part-${session.messages.length}-${tool}`,
    tool,
    status,
    input,
    output: status === "completed" ? "ok" : "failed",
    timeStart: session.messages.length,
    timeEnd: session.messages.length,
  })
}

describe("detectDoomLoop", () => {
  it("detects identical successful calls that make no observable progress", async () => {
    const session = createFakeSession(process.cwd())
    session.addMessage({ role: "user", content: "update the list once" })
    for (let index = 0; index < 3; index += 1) {
      addToolAttempt(session, "TodoWrite", {
        merge: false,
        todos: [{ id: "one", content: "One", status: "pending" }],
      })
    }

    await expect(
      detectDoomLoop(session, "TodoWrite", {
        merge: false,
        todos: [{ id: "one", content: "One", status: "pending" }],
      }),
    ).resolves.toBe(true)
  })

  it("still detects identical failed calls", async () => {
    const session = createFakeSession(process.cwd())
    session.addMessage({ role: "user", content: "retry" })
    for (let index = 0; index < 3; index += 1) {
      addToolAttempt(session, "RetryTool", { value: "same" }, "error")
    }

    await expect(
      detectDoomLoop(session, "RetryTool", { value: "same" }),
    ).resolves.toBe(true)
  })

  it("does not treat repeated calls separated by other progress as consecutive", async () => {
    const session = createFakeSession(process.cwd())
    session.addMessage({ role: "user", content: "inspect several files" })
    addToolAttempt(session, "Read", { file_path: "a.ts" })
    addToolAttempt(session, "Grep", { pattern: "first" })
    addToolAttempt(session, "Read", { file_path: "a.ts" })
    addToolAttempt(session, "Grep", { pattern: "second" })
    addToolAttempt(session, "Read", { file_path: "a.ts" })

    await expect(
      detectDoomLoop(session, "Read", { file_path: "a.ts" }),
    ).resolves.toBe(false)
  })

  it("does not combine calls across the active compaction boundary", async () => {
    const session = createFakeSession(process.cwd())
    session.addMessage({ role: "user", content: "old task" })
    for (let index = 0; index < 3; index += 1) {
      addToolAttempt(session, "Read", { file_path: "a.ts" })
    }
    session.addMessage({
      role: "assistant",
      content: "Compacted state",
      summary: true,
    })
    session.addMessage({ role: "user", content: "new task" })

    await expect(
      detectDoomLoop(session, "Read", { file_path: "a.ts" }),
    ).resolves.toBe(false)
  })
})

describe("getDoomLoopSignature", () => {
  it("canonicalizes nested key order without erasing nested values", () => {
    const first = getDoomLoopSignature("TodoWrite", {
      merge: false,
      todos: [{ id: "one", content: "One", status: "pending" }],
    })
    const reordered = getDoomLoopSignature("TodoWrite", {
      todos: [{ status: "pending", content: "One", id: "one" }],
      merge: false,
    })
    const different = getDoomLoopSignature("TodoWrite", {
      merge: false,
      todos: [{ id: "two", content: "Two", status: "pending" }],
    })

    expect(first).toBe(reordered)
    expect(first).not.toBe(different)
    expect(first).toContain('"content":"One"')
  })
})
