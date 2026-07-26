import { describe, expect, it, vi } from "vitest"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type { IIndexer, ToolContext } from "../../types.js"
import { createNexusRunServices } from "../../agent/run-services.js"
import { codebaseSearchTool } from "./codebase-search.js"

function context(search: IIndexer["search"]): ToolContext {
  const cwd = process.cwd()
  const config = createTestConfig({
    indexing: { enabled: true, vector: true },
    vectorDb: { enabled: true },
  })
  return {
    cwd,
    host: createFakeHost({ cwd }),
    session: createFakeSession(cwd),
    config,
    services: createNexusRunServices(),
    signal: new AbortController().signal,
    indexer: {
      search,
      status: () => ({ state: "ready", files: 1, symbols: 1 }),
      semanticSearchActive: () => true,
    },
  }
}

describe("CodebaseSearch scope validation", () => {
  it("rejects multiple scopes instead of silently changing the query contract", async () => {
    const search = vi.fn(async () => [])
    const result = await codebaseSearchTool.execute(
      {
        query: "How does auth work?",
        target_directories: ["src", "packages"],
      },
      context(search),
    )

    expect(result.success).toBe(false)
    expect(result.output).toContain("one target directory")
    expect(search).not.toHaveBeenCalled()
  })

  it.each(["../outside", "src/**/auth"])(
    "rejects an unsafe or glob scope: %s",
    async (scope) => {
      const search = vi.fn(async () => [])
      const result = await codebaseSearchTool.execute(
        {
          query: "How does auth work?",
          target_directories: [scope],
        },
        context(search),
      )

      expect(result.success).toBe(false)
      expect(result.output).toContain("Invalid target directory")
      expect(search).not.toHaveBeenCalled()
    },
  )
})
