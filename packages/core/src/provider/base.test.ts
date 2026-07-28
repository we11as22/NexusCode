import type { LanguageModelV1 } from "ai"
import { beforeEach, describe, expect, it, vi } from "vitest"

const streamTextMock = vi.hoisted(() => vi.fn())

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return {
    ...actual,
    streamText: streamTextMock,
  }
})

import { BaseLLMClient, normalizeLLMUsage } from "./base.js"
import type { LLMStreamEvent } from "./types.js"

function streamResult(
  parts: Array<Record<string, unknown>>,
  error?: Error,
  text = "",
) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part
      if (error) throw error
    })(),
    text: Promise.resolve(text),
    usage: Promise.resolve({ promptTokens: 1, completionTokens: 1 }),
  }
}

function retryableError(): Error {
  return Object.assign(new Error("provider overloaded"), { statusCode: 503 })
}

function createClient(): BaseLLMClient {
  return new BaseLLMClient(
    { specificationVersion: "v1" } as LanguageModelV1,
    "test-provider",
    "test-model",
  )
}

const streamOptions = {
  messages: [{ role: "user" as const, content: "hello" }],
  maxRetries: 2,
  initialRetryDelayMs: 0,
  maxRetryDelayMs: 0,
}

describe("BaseLLMClient stream retry boundary", () => {
  beforeEach(() => {
    streamTextMock.mockReset()
  })

  it("retries a retryable failure before the provider yields an event", async () => {
    streamTextMock
      .mockImplementationOnce(() => streamResult([], retryableError()))
      .mockImplementationOnce(() => streamResult([], retryableError()))
      .mockImplementationOnce(() =>
        streamResult([
          { type: "text-delta", textDelta: "recovered" },
          { type: "finish", finishReason: "stop" },
        ]),
      )

    const events: LLMStreamEvent[] = []
    for await (const event of createClient().stream({
      ...streamOptions,
      maxRetries: 3,
    })) {
      events.push(event)
    }

    expect(streamTextMock).toHaveBeenCalledTimes(3)
    expect(events).toEqual([
      { type: "text_delta", delta: "recovered" },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      },
    ])
  })

  it("propagates a retryable failure after yielding a tool call without retrying", async () => {
    streamTextMock.mockImplementationOnce(() =>
      streamResult(
        [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "Write",
            args: { path: "important.txt", content: "once" },
          },
        ],
        retryableError(),
      ),
    )

    const iterator = createClient().stream(streamOptions)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "Write",
        toolInput: { path: "important.txt", content: "once" },
      },
    })
    await expect(iterator.next()).rejects.toThrow("provider overloaded")
    expect(streamTextMock).toHaveBeenCalledTimes(1)
  })

  it("does not repeat short buffered text when the finish fallback resolves", async () => {
    streamTextMock.mockImplementationOnce(() =>
      streamResult(
        [
          { type: "text-delta", textDelta: "NEXUS_OK" },
          { type: "finish", finishReason: "stop" },
        ],
        undefined,
        "NEXUS_OK",
      ),
    )

    const events: LLMStreamEvent[] = []
    for await (const event of createClient().stream(streamOptions)) {
      events.push(event)
    }

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", delta: "NEXUS_OK" },
    ])
  })
})

describe("normalizeLLMUsage", () => {
  it("splits OpenAI cached input and reasoning without double counting", () => {
    expect(
      normalizeLLMUsage(
        { promptTokens: 100, completionTokens: 30 },
        {
          openai: {
            cachedPromptTokens: 40,
            reasoningTokens: 10,
          },
        },
        "gpt-5",
      ),
    ).toEqual({
      inputTokens: 60,
      outputTokens: 20,
      reasoningTokens: 10,
      cacheReadTokens: 40,
      totalTokens: 130,
      modelId: "gpt-5",
    })
  })

  it("adds Anthropic cache creation and read buckets to current context", () => {
    expect(
      normalizeLLMUsage(
        { promptTokens: 20, completionTokens: 5 },
        {
          anthropic: {
            cacheCreationInputTokens: 50,
            cacheReadInputTokens: 100,
          },
        },
        "claude-sonnet",
      ),
    ).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      totalTokens: 175,
      modelId: "claude-sonnet",
    })
  })

  it("clamps invalid usage buckets", () => {
    expect(
      normalizeLLMUsage(
        {
          promptTokens: Number.NaN,
          completionTokens: -4,
        },
        {
          openai: {
            cachedPromptTokens: -1,
            reasoningTokens: Number.POSITIVE_INFINITY,
          },
        },
      ),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    })
  })
})
