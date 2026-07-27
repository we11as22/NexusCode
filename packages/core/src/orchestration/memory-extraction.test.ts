import { describe, expect, it } from "vitest"
import { extractMemoriesFromCompactionSummary } from "./memory-extraction.js"

describe("compaction memory provenance", () => {
  it("keeps model-derived summaries session-scoped until explicitly promoted", () => {
    const memories = extractMemoriesFromCompactionSummary(`
## Durable Instructions and Preferences
- Always use pnpm for this project.

## Key Technical Discoveries
- The authentication layer appears to use rotating refresh tokens.

## Stable Project Facts and Reusable Commands
- Command: pnpm test runs the complete test suite.

## Pending Work
- Verify refresh-token replay protection.
`, "session-a")

    expect(memories.length).toBeGreaterThan(0)
    expect(memories.every((memory) => memory.scope === "session")).toBe(true)
    expect(memories.every(
      (memory) => memory.metadata?.sessionId === "session-a",
    )).toBe(true)
    expect(memories.every((memory) => memory.trust === "agent")).toBe(true)
  })
})
