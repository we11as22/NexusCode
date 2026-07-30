import { describe, expect, it } from "vitest"

import type { Message } from "./query.js"
import type { ContentBlock } from "./provider/message-schema.js"
import {
  reorderMessages,
  timelineSourceMessages,
} from "./utils/messages.js"
import {
  buildChatTimeline,
  exploreSegmentShouldBeTransient,
} from "./utils/exploreTimeline.js"

function progress(id: string, name: string, path: string): Message {
  return {
    type: "progress",
    uuid: `progress-${id}`,
    toolUseID: id,
    siblingToolUseIDs: new Set(),
    normalizedMessages: [],
    tools: [],
    content: {
      type: "assistant",
      uuid: `inner-${id}`,
      costUSD: 0,
      durationMs: 0,
      message: {
        id: `inner-${id}`,
        model: "",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: "",
        type: "message",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [
          { type: "tool_use", id, name, input: { file_path: path } },
        ],
      },
    },
  } as Message
}

function assistant(
  uuid: string,
  content: ContentBlock[],
): Message {
  return {
    type: "assistant",
    uuid,
    costUSD: 0,
    durationMs: 0,
    message: {
      id: uuid,
      model: "",
      role: "assistant",
      stop_reason: "tool_use",
      stop_sequence: "",
      type: "message",
      usage: { input_tokens: 0, output_tokens: 0 },
      content,
    },
  } as Message
}

function result(id: string): Message {
  return {
    type: "user",
    uuid: `result-${id}`,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
    },
  } as Message
}

describe("CLI explore timeline projection", () => {
  it("renders mixed assistant text plus progress tools as one explore wave", () => {
    const messages: Message[] = [
      progress("read-alpha", "Read", "alpha.txt"),
      progress("read-beta", "Read", "beta.txt"),
      assistant("mixed", [
        { type: "text", text: "Читаю файлы параллельно." },
        {
          type: "tool_use",
          id: "read-alpha",
          name: "Read",
          input: { file_path: "alpha.txt" },
        },
        {
          type: "tool_use",
          id: "read-beta",
          name: "Read",
          input: { file_path: "beta.txt" },
        },
      ]),
      result("read-alpha"),
      result("read-beta"),
      assistant("final", [{ type: "text", text: "Готово." }]),
    ]

    const projected = reorderMessages(timelineSourceMessages(messages))
    const timeline = buildChatTimeline(projected)

    expect(timeline.map((piece) => piece.kind)).toEqual([
      "message",
      "explore",
      "message",
    ])
    const explore = timeline[1]
    expect(explore?.kind).toBe("explore")
    if (explore?.kind === "explore") {
      expect([...explore.toolUseIds]).toEqual(["read-alpha", "read-beta"])
      expect(
        exploreSegmentShouldBeTransient(explore, new Set(), new Set()),
      ).toBe(false)
    }

    const renderedToolIds = projected.flatMap((message) => {
      if (message.type === "progress") return [message.toolUseID]
      if (message.type !== "assistant") return []
      return message.message.content.flatMap((block) =>
        block.type === "tool_use" ? [block.id] : [],
      )
    })
    expect(renderedToolIds).toEqual(["read-alpha", "read-beta"])
  })

  it("keeps an unfinished explore wave live", () => {
    const projected = reorderMessages(
      timelineSourceMessages([
        progress("read-alpha", "Read", "alpha.txt"),
        assistant("tool", [
          {
            type: "tool_use",
            id: "read-alpha",
            name: "Read",
            input: { file_path: "alpha.txt" },
          },
        ]),
      ]),
    )
    const explore = buildChatTimeline(projected).find(
      (piece) => piece.kind === "explore",
    )

    expect(explore?.kind).toBe("explore")
    if (explore?.kind === "explore") {
      expect(
        exploreSegmentShouldBeTransient(
          explore,
          new Set(["read-alpha"]),
          new Set(["read-alpha"]),
        ),
      ).toBe(true)
    }
  })
})
