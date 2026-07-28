import { describe, expect, it } from "vitest"

import type { SessionMessage, ToolPart } from "../stores/chat.js"
import { buildChatRenderItems } from "./renderProjection.js"

function assistantWith(tool: ToolPart): SessionMessage {
  return {
    id: "assistant-1",
    ts: 1,
    role: "assistant",
    content: [
      {
        type: "reasoning",
        reasoningId: "reasoning-1",
        text: "Inspecting the code.",
        durationMs: 12,
      },
      tool,
    ],
  }
}

describe("transcript exploration projection", () => {
  it("keeps a stable key and changes Exploring to Explored when its tools finish", () => {
    const running = buildChatRenderItems(
      [
        assistantWith({
          type: "tool",
          id: "read-1",
          tool: "Read",
          status: "running",
          input: { path: "src/index.ts" },
        }),
      ],
      true,
    )
    const completed = buildChatRenderItems(
      [
        assistantWith({
          type: "tool",
          id: "read-1",
          tool: "Read",
          status: "completed",
          input: { path: "src/index.ts" },
          output: "done",
        }),
      ],
      true,
    )

    expect(running[0]).toMatchObject({
      type: "explored",
      isRunning: true,
    })
    expect(completed[0]).toMatchObject({
      type: "explored",
      isRunning: false,
    })
    expect(running[0]!.key).toBe(completed[0]!.key)
  })
})
