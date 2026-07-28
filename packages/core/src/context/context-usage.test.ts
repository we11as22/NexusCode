import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  computeContextUsageMetrics,
  estimateToolsDefinitionsTokens,
  getContextWindowLimit,
  reconcilePersistedContextUsage,
} from "./context-usage.js"
import type { SessionMessage } from "../types.js"

describe("context window resolution", () => {
  it("uses an explicit provider/catalog capability before model heuristics", () => {
    expect(getContextWindowLimit("minimax/minimax-m2.5", 204_800)).toBe(
      204_800,
    )
  })

  it("recognizes the Kilo MiniMax M2.5 window for existing manual configs", () => {
    expect(
      getContextWindowLimit("minimax/minimax-m2.5:free"),
    ).toBe(196_608)
  })

  it("does not fabricate a window for an unknown route", () => {
    expect(getContextWindowLimit("vendor/unknown-model")).toBe(0)
  })

  it("uses the verified Kilo Auto fallback for existing configs", () => {
    expect(getContextWindowLimit("kilo-auto/free")).toBe(256_000)
  })
})

describe("context usage metrics", () => {
  const messages: SessionMessage[] = [
    { id: "user-1", ts: 1, role: "user", content: "hello" },
    { id: "assistant-1", ts: 2, role: "assistant", content: "done" },
  ]

  it("uses a provider anchor without recounting prior messages", () => {
    expect(
      computeContextUsageMetrics({
        sessionMessages: messages,
        systemPromptText: "system",
        toolsDefinitionTokens: 20,
        modelId: "kilo-auto/free",
        providerAnchor: {
          messageId: "assistant-1",
          usedTokens: 12_000,
          manifestTokens: 22,
          modelId: "kilo-auto/free",
          recordedAt: 3,
        },
      }),
    ).toMatchObject({
      usedTokens: 12_000,
      limitTokens: 256_000,
      source: "provider",
      providerTokens: 12_000,
      pendingTokens: 0,
    })
  })

  it("adds only content after the anchor as a hybrid pending tail", () => {
    const result = computeContextUsageMetrics({
      sessionMessages: [
        ...messages,
        {
          id: "user-2",
          ts: 3,
          role: "user",
          content: "inspect another file and explain it",
        },
      ],
      modelId: "kilo-auto/free",
      providerAnchor: {
        messageId: "assistant-1",
        usedTokens: 12_000,
        manifestTokens: 0,
        recordedAt: 3,
      },
    })

    expect(result.source).toBe("hybrid")
    expect(result.providerTokens).toBe(12_000)
    expect(result.pendingTokens).toBeGreaterThan(0)
    expect(result.usedTokens).toBe(12_000 + result.pendingTokens)
  })

  it("counts tool output appended to the anchor assistant message", () => {
    const result = computeContextUsageMetrics({
      sessionMessages: [
        messages[0]!,
        {
          id: "assistant-1",
          ts: 2,
          role: "assistant",
          content: [
            { type: "text", text: "running" },
            {
              type: "tool",
              id: "tool-1",
              tool: "Read",
              status: "completed",
              input: { path: "a.ts" },
              output: "export const answer = 42",
            },
          ],
        },
      ],
      modelId: "kilo-auto/free",
      providerAnchor: {
        messageId: "assistant-1",
        usedTokens: 500,
        manifestTokens: 0,
        recordedAt: 3,
      },
    })

    expect(result.source).toBe("hybrid")
    expect(result.pendingTokens).toBeGreaterThan(0)
  })
})

describe("persisted context usage", () => {
  it("rejects legacy snapshots that are not bound to a model", () => {
    expect(
      reconcilePersistedContextUsage(
        {
          usedTokens: 68_100,
          limitTokens: 128_000,
          percent: 53,
        },
        "minimax/minimax-m2.5:free",
      ),
    ).toBeUndefined()
  })

  it("rejects a snapshot recorded for another model", () => {
    expect(
      reconcilePersistedContextUsage(
        {
          usedTokens: 68_100,
          limitTokens: 128_000,
          percent: 53,
          modelId: "old/model",
        },
        "minimax/minimax-m2.5:free",
      ),
    ).toBeUndefined()
  })

  it("refreshes the limit and percentage when model metadata changes", () => {
    expect(
      reconcilePersistedContextUsage(
        {
          usedTokens: 68_100,
          limitTokens: 128_000,
          percent: 53,
          source: "provider",
          providerTokens: 68_100,
          pendingTokens: 0,
          modelId: "minimax/minimax-m2.5:free",
        },
        "minimax/minimax-m2.5:free",
      ),
    ).toEqual({
      usedTokens: 68_100,
      limitTokens: 196_608,
      percent: 35,
      source: "provider",
      providerTokens: 68_100,
      pendingTokens: 0,
      modelId: "minimax/minimax-m2.5:free",
    })
  })
})

describe("tool definition estimates", () => {
  it("uses the serialized schema instead of a fixed per-tool charge", () => {
    const small = estimateToolsDefinitionsTokens([
      {
        name: "Read",
        description: "Read a file",
        parameters: z.object({ path: z.string() }),
      },
    ])
    const large = estimateToolsDefinitionsTokens([
      {
        name: "Read",
        description: "Read a file",
        parameters: z.object({
          path: z.string(),
          lineStart: z.number().optional(),
          lineEnd: z.number().optional(),
          options: z.array(z.enum(["one", "two", "three"])),
        }),
      },
    ])

    expect(small).toBeGreaterThan(0)
    expect(large).toBeGreaterThan(small)
  })
})
