import { describe, expect, it } from "vitest"

import {
  catalogSelectionToModel,
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
})
