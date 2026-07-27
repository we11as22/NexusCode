import { describe, expect, it, vi } from "vitest"

import { settleRuntimeDependency } from "./dependency-readiness.js"

describe("settleRuntimeDependency", () => {
  it("returns a ready dependency without diagnostics", async () => {
    const diagnostic = vi.fn()

    await expect(
      settleRuntimeDependency(
        "skills",
        Promise.resolve(["skill"]),
        2_000,
        [],
        diagnostic,
      ),
    ).resolves.toEqual(["skill"])
    expect(diagnostic).not.toHaveBeenCalled()
  })

  it("reports an explicit degraded result on loader failure", async () => {
    const diagnostic = vi.fn()

    await expect(
      settleRuntimeDependency(
        "skills",
        Promise.reject(new Error("invalid skill")),
        2_000,
        [],
        diagnostic,
      ),
    ).resolves.toEqual([])
    expect(diagnostic).toHaveBeenCalledWith(
      "[skills runtime] invalid skill; continuing without it",
    )
  })

  it("reports an explicit degraded result on timeout", async () => {
    vi.useFakeTimers()
    const diagnostic = vi.fn()
    const pending = settleRuntimeDependency(
      "MCP",
      new Promise<void>(() => undefined),
      2_500,
      undefined,
      diagnostic,
    )

    await vi.advanceTimersByTimeAsync(2_500)

    await expect(pending).resolves.toBeUndefined()
    expect(diagnostic).toHaveBeenCalledWith(
      "[MCP runtime] loading timed out after 2500ms; continuing without it",
    )
    vi.useRealTimers()
  })
})
