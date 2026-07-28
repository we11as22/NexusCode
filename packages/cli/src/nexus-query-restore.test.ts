import { describe, expect, it } from "vitest"

import type { SessionMessage } from "@nexuscode/core"
import { replMessagesFromSession } from "./nexus-query.js"

describe("replMessagesFromSession", () => {
  it("restores completed file tools with the same exact diff payload used live", () => {
    const messages: SessionMessage[] = [
      {
        id: "assistant-edit",
        ts: 1,
        role: "assistant",
        content: [
          {
            type: "tool",
            id: "tool-edit",
            tool: "Edit",
            status: "completed",
            input: {
              file_path: "/Users/mac/Projects/nexus/test/example.txt",
              old_string: "BETA",
              new_string: "GAMMA",
            },
            output: "Successfully replaced text in example.txt",
            path: "/Users/mac/Projects/nexus/test/example.txt",
            diffStats: { added: 1, removed: 1 },
            diffHunks: [
              { type: "remove", lineNum: 2, line: "BETA" },
              { type: "add", lineNum: 2, line: "GAMMA" },
            ],
            appliedReplacements: [
              { oldSnippet: "BETA", newSnippet: "GAMMA" },
            ],
          },
        ],
      },
    ]

    const restored = replMessagesFromSession(messages)

    expect(restored).toHaveLength(2)
    expect(restored[0]?.type).toBe("assistant")
    expect(restored[1]).toMatchObject({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-edit",
            content: "Successfully replaced text in example.txt",
            is_error: false,
          },
        ],
      },
      toolUseResult: {
        data: {
          tool: "Edit",
          output: "Successfully replaced text in example.txt",
          path: "/Users/mac/Projects/nexus/test/example.txt",
          diffStats: { added: 1, removed: 1 },
          diffHunks: [
            { type: "remove", lineNum: 2, line: "BETA" },
            { type: "add", lineNum: 2, line: "GAMMA" },
          ],
          metadata: {
            appliedReplacements: [
              { oldSnippet: "BETA", newSnippet: "GAMMA" },
            ],
          },
          success: true,
        },
        resultForAssistant: "Successfully replaced text in example.txt",
      },
    })
    expect(JSON.stringify(restored)).not.toContain("writtenContent")
  })

  it("restores failed tools as errors without inventing file changes", () => {
    const messages: SessionMessage[] = [
      {
        id: "assistant-write-error",
        ts: 1,
        role: "assistant",
        content: [
          {
            type: "tool",
            id: "tool-write-error",
            tool: "Write",
            status: "error",
            input: { file_path: "/Users/mac/Projects/nexus/test/example.txt" },
            error: "Permission denied",
          },
        ],
      },
    ]

    const restored = replMessagesFromSession(messages)

    expect(restored).toHaveLength(2)
    expect(restored[1]).toMatchObject({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-write-error",
            content: "Permission denied",
            is_error: true,
          },
        ],
      },
      toolUseResult: {
        data: {
          tool: "Write",
          output: "Permission denied",
          success: false,
        },
      },
    })
  })
})
