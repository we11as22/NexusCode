import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const providerOptions = vi.hoisted(() => ({
  compatible: [] as Array<Record<string, unknown>>,
  openRouter: [] as Array<Record<string, unknown>>,
}))

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible(options: Record<string, unknown>) {
    providerOptions.compatible.push(options)
    return {
      chatModel() {
        return { specificationVersion: "v1" }
      },
    }
  },
}))

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter(options: Record<string, unknown>) {
    providerOptions.openRouter.push(options)
    return {
      languageModel() {
        return { specificationVersion: "v1" }
      },
    }
  },
}))

import {
  createOllamaClient,
  createOpenAICompatibleClient,
} from "./openai-compatible.js"

describe("OpenAI-compatible endpoint credential isolation", () => {
  beforeEach(() => {
    vi.stubEnv("KILO_API_KEY", "kilo-secret")
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-secret")
    vi.stubEnv("OPENAI_API_KEY", "openai-secret")
    vi.stubEnv("NEXUS_API_KEY", "nexus-secret")
  })

  afterEach(() => {
    providerOptions.compatible.length = 0
    providerOptions.openRouter.length = 0
    vi.unstubAllEnvs()
  })

  it.each([
    {
      endpoint: "https://API.KILO.AI/api/gateway/",
      expectedProvider: "kilo",
      expectedApiKey: "kilo-secret",
      capturedOptions: providerOptions.openRouter,
    },
    {
      endpoint: "https://openrouter.ai/api/v1",
      expectedProvider: "openrouter",
      expectedApiKey: "openrouter-secret",
      capturedOptions: providerOptions.openRouter,
    },
    {
      endpoint: "https://api.openai.com/v1",
      expectedProvider: "openai",
      expectedApiKey: "openai-secret",
      capturedOptions: providerOptions.compatible,
    },
  ])(
    "uses only the $expectedProvider credential when all provider secrets are set",
    ({ endpoint, expectedProvider, expectedApiKey, capturedOptions }) => {
      const client = createOpenAICompatibleClient({
        provider: "openai-compatible",
        id: "test-model",
        baseUrl: endpoint,
      })

      expect(client.providerName).toBe(expectedProvider)
      expect(capturedOptions).toHaveLength(1)
      expect(capturedOptions[0]?.["apiKey"]).toBe(expectedApiKey)
    },
  )

  it("does not send any ambient provider secret to an unknown custom endpoint", () => {
    expect(() =>
      createOpenAICompatibleClient({
        provider: "openai-compatible",
        id: "test-model",
        baseUrl: "https://compatible.example.test/v1",
      }),
    ).toThrow("Missing API key")

    expect(providerOptions.compatible).toHaveLength(0)
    expect(providerOptions.openRouter).toHaveLength(0)
  })

  it("uses an explicit API key for an unknown custom endpoint", () => {
    createOpenAICompatibleClient({
      provider: "openai-compatible",
      id: "test-model",
      baseUrl: "https://compatible.example.test/v1",
      apiKey: "explicit-secret",
    })

    expect(providerOptions.compatible).toHaveLength(1)
    expect(providerOptions.compatible[0]?.["apiKey"]).toBe("explicit-secret")
  })

  it("keeps Kilo free models available without borrowing other provider credentials", () => {
    vi.stubEnv("KILO_API_KEY", undefined)

    const client = createOpenAICompatibleClient({
      provider: "openai-compatible",
      id: "minimax/minimax-m2.5:free",
      baseUrl: "https://api.kilo.ai/api/openrouter",
    })

    expect(client.providerName).toBe("kilo")
    expect(providerOptions.openRouter).toHaveLength(1)
    expect(providerOptions.openRouter[0]?.["apiKey"]).toBe("dummy")
  })

  it("uses the bound resolver credential for remote Ollama and a sentinel only on loopback", () => {
    createOllamaClient({
      provider: "ollama",
      id: "qwen",
      baseUrl: "https://ollama.example.test",
      apiKey: "remote-ollama-secret",
    })
    expect(providerOptions.compatible.at(-1)?.["apiKey"]).toBe("remote-ollama-secret")

    createOllamaClient({
      provider: "ollama",
      id: "qwen",
      baseUrl: "http://localhost:11434",
    })
    expect(providerOptions.compatible.at(-1)?.["apiKey"]).toBe("dummy")

    expect(() => createOllamaClient({
      provider: "ollama",
      id: "qwen",
      baseUrl: "https://ollama.example.test",
    })).toThrow(/Missing API key/)
  })
})
