import { describe, expect, it } from "vitest"
import type { LLMClient } from "../provider/types.js"
import { createFakeSession } from "../test/fakes.js"
import { createCompaction } from "./compaction.js"

describe("session compaction recovery state", () => {
  it("appends exact structured mode, task, memory, and artifact references", async () => {
    const session = createFakeSession()
    session.addMessage({ role: "user", content: "start" })
    const assistant = session.addMessage({ role: "assistant", content: "working" })
    session.addToolPart(assistant.id, {
      type: "tool",
      id: "part-1",
      tool: "Read",
      status: "completed",
      output: "done",
      path: "/workspace/source.ts",
      outputSpillPath: "/tmp/tool-output.txt",
    })
    session.addMessage({ role: "user", content: "continue" })
    session.addMessage({ role: "assistant", content: "still working" })
    const client = {
      providerName: "test",
      modelId: "test",
      async *stream() {
        yield { type: "text_delta" as const, delta: "## Primary Request and Intent\nKeep working." }
        yield { type: "finish" as const }
      },
    } as unknown as LLMClient

    await createCompaction().compact(session, client, undefined, {
      force: true,
      durableContext: {
        mode: "debug",
        memoryCitations: ["memory:architecture"],
        taskIds: ["task-42"],
      },
    })

    const summary = session.messages.find((message) => message.summary)
    expect(summary?.content).toContain("nexus-recovery-context-v1 context_not_instruction")
    expect(summary?.content).toContain("\"mode\": \"debug\"")
    expect(summary?.content).toContain("\"memory:architecture\"")
    expect(summary?.content).toContain("\"task-42\"")
    expect(summary?.content).toContain("\"/tmp/tool-output.txt\"")
    expect(summary?.content).toContain("\"/workspace/source.ts\"")
  })
})
