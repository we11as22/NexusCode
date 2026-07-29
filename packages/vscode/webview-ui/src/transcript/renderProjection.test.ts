import { describe, expect, it } from "vitest"

import type { SessionMessage, ToolPart } from "../stores/chat.js"
import { countExplorationMetricsFromItems } from "../components/ExploredProgressBlock.js"
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

  it("counts files, listings, and searches independently", () => {
    const assistant: SessionMessage = {
      id: "assistant-mixed-explore",
      ts: 1,
      role: "assistant",
      content: [
        {
          type: "tool",
          id: "read-1",
          tool: "Read",
          status: "completed",
          input: { path: "src/index.ts" },
        },
        {
          type: "tool",
          id: "list-1",
          tool: "List",
          status: "completed",
          input: { path: "src" },
        },
        {
          type: "tool",
          id: "search-1",
          tool: "Grep",
          status: "completed",
          input: { pattern: "context_usage", path: "src" },
        },
        {
          type: "tool",
          id: "glob-1",
          tool: "Glob",
          status: "completed",
          input: { pattern: "**/*.ts", path: "src" },
        },
        {
          type: "tool",
          id: "semantic-1",
          tool: "CodebaseSearch",
          status: "completed",
          input: { query: "context accounting", path: "src" },
        },
      ],
    }
    const explored = buildChatRenderItems([assistant], false).find(
      (item) => item.type === "explored",
    )
    if (!explored || explored.type !== "explored") {
      throw new Error("expected explored projection")
    }

    expect(countExplorationMetricsFromItems(explored.prefixItems)).toEqual({
      filesCount: 1,
      listCount: 1,
      searchesCount: 3,
    })
  })
})

describe("completed turn projection", () => {
  it("coalesces adjacent exploration waves across provider continuation messages", () => {
    const messages: SessionMessage[] = [
      {
        id: "user-1",
        ts: 1,
        role: "user",
        content: "Inspect both locations",
      },
      {
        id: "assistant-list-root",
        ts: 2,
        role: "assistant",
        content: [
          {
            type: "reasoning",
            reasoningId: "reasoning-root",
            text: "Listing the workspace.",
            durationMs: 10,
          },
          {
            type: "tool",
            id: "list-root",
            tool: "List",
            status: "completed",
            input: { path: "." },
            output: "src",
          },
        ],
      },
      {
        id: "assistant-list-src",
        ts: 3,
        role: "assistant",
        content: [
          {
            type: "reasoning",
            reasoningId: "reasoning-src",
            text: "Listing the source directory.",
            durationMs: 11,
          },
          {
            type: "tool",
            id: "list-src",
            tool: "List",
            status: "completed",
            input: { path: "src" },
            output: "index.ts",
          },
        ],
      },
      {
        id: "assistant-final",
        ts: 4,
        role: "assistant",
        durationMs: 1_000,
        content: [{ type: "text", text: "Done." }],
      },
    ]

    const items = buildChatRenderItems(messages, false)
    if (items[1]?.type !== "completed_work") {
      throw new Error("expected completed work")
    }
    const exploredItems = items[1].items.filter(
      (item) => item.type === "explored",
    )

    expect(exploredItems).toHaveLength(1)
    expect(
      countExplorationMetricsFromItems(exploredItems[0]!.prefixItems),
    ).toEqual({
      filesCount: 0,
      listCount: 2,
      searchesCount: 0,
    })
  })

  it("collapses all technical work and leaves the final answer outside", () => {
    const messages: SessionMessage[] = [
      {
        id: "user-1",
        ts: 1,
        role: "user",
        content: "Inspect and fix it",
      },
      {
        id: "assistant-tools",
        ts: 2,
        role: "assistant",
        content: [
          {
            type: "reasoning",
            reasoningId: "reasoning-1",
            text: "Inspecting.",
            durationMs: 10,
          },
          {
            type: "tool",
            id: "read-1",
            tool: "Read",
            status: "completed",
            input: { path: "src/index.ts" },
            output: "source",
          },
          {
            type: "tool",
            id: "bash-1",
            tool: "Bash",
            status: "completed",
            input: { command: "pnpm test" },
            output: "passed",
          },
        ],
      },
      {
        id: "assistant-final",
        ts: 3,
        role: "assistant",
        durationMs: 53_000,
        content: [
          {
            type: "reasoning",
            reasoningId: "reasoning-2",
            text: "Summarizing.",
            durationMs: 5,
          },
          { type: "text", text: "Fixed and verified." },
        ],
      },
    ]

    const items = buildChatRenderItems(messages, false)

    expect(items.map((item) => item.type)).toEqual([
      "message",
      "completed_work",
      "assistant_part",
    ])
    expect(items[1]).toMatchObject({
      type: "completed_work",
      durationMs: 53_000,
    })
    if (items[1]?.type !== "completed_work") {
      throw new Error("expected completed work")
    }
    expect(items[1].items.map((item) => item.type)).toEqual([
      "explored",
      "assistant_part",
      "assistant_part",
    ])
    expect(items[2]).toMatchObject({
      type: "assistant_part",
      part: { type: "text", text: "Fixed and verified." },
    })
  })
})
