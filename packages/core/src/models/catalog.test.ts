import { describe, expect, it } from "vitest"

import {
  catalogSelectionToModel,
  parseCatalogData,
  type ModelsCatalog,
} from "./catalog.js"

describe("model catalog selection", () => {
  it("carries the provider-advertised context window into runtime config", () => {
    const catalog: ModelsCatalog = {
      providers: [
        {
          id: "nexus",
          name: "Nexus Gateway",
          baseUrl: "https://example.test/v1",
          models: [
            {
              id: "minimax/minimax-m2.5",
              name: "MiniMax M2.5",
              free: true,
              contextWindow: 196_608,
            },
          ],
        },
      ],
      recommended: [],
    }

    expect(
      catalogSelectionToModel(
        "nexus",
        "minimax/minimax-m2.5",
        catalog,
      ),
    ).toEqual({
      provider: "openai-compatible",
      id: "minimax/minimax-m2.5",
      baseUrl: "https://example.test/v1",
      contextWindow: 196_608,
    })
  })

  it("uses Kilo gateway metadata and keeps gateway-only models", () => {
    const catalog = parseCatalogData(
      {
        kilo: {
          api: "https://stale.example/v1",
          models: {
            "kilo-auto/free": {
              name: "Kilo Auto",
              cost: { input: 0 },
              limit: { context: 128_000 },
            },
          },
        },
      },
      {
        data: [
          {
            id: "kilo-auto/free",
            name: "Kilo Auto (free)",
            context_length: 256_000,
            top_provider: {
              context_length: 200_000,
              max_completion_tokens: 32_000,
            },
          },
          {
            id: "gateway/only-free",
            name: "Gateway only",
            context_length: 300_000,
            top_provider: { max_completion_tokens: 16_000 },
            pricing: { prompt: "0", completion: "0" },
          },
        ],
      },
    )

    expect(catalog.providers).toContainEqual({
      id: "nexus",
      name: "Nexus Gateway",
      baseUrl: "https://api.kilo.ai/api/openrouter",
      models: [
        {
          id: "gateway/only-free",
          name: "Gateway only",
          free: true,
          contextWindow: 300_000,
          maxOutputTokens: 16_000,
          recommendedIndex: undefined,
        },
        {
          id: "kilo-auto/free",
          name: "Kilo Auto (free)",
          free: true,
          contextWindow: 256_000,
          maxOutputTokens: 32_000,
          recommendedIndex: undefined,
        },
      ],
    })
  })
})
