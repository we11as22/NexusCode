import { describe, expect, it, vi } from "vitest"

import { settleRuntimeDependency } from "./run-session.js"

describe("server runtime dependency loading", () => {
  it("returns successful values without leaving the timeout active", async () => {
    vi.useFakeTimers()
    const diagnostic = vi.fn()

    await expect(
      settleRuntimeDependency("rules", Promise.resolve("loaded"), 2_000, "", diagnostic),
    ).resolves.toBe("loaded")

    await vi.advanceTimersByTimeAsync(2_000)
    expect(diagnostic).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("falls back and reports a timeout without blocking server startup", async () => {
    vi.useFakeTimers()
    const diagnostic = vi.fn()
    const never = new Promise<string>(() => undefined)
    const result = settleRuntimeDependency("rules", never, 2_000, "", diagnostic)

    await vi.advanceTimersByTimeAsync(2_000)

    await expect(result).resolves.toBe("")
    expect(diagnostic).toHaveBeenCalledWith(
      "[rules runtime] loading timed out after 2000ms; continuing without it",
    )
    vi.useRealTimers()
  })

  it("falls back and reports loader failures", async () => {
    const diagnostic = vi.fn()

    await expect(
      settleRuntimeDependency(
        "skills",
        Promise.reject(new Error("broken manifest")),
        2_000,
        [],
        diagnostic,
      ),
    ).resolves.toEqual([])
    expect(diagnostic).toHaveBeenCalledWith(
      "[skills runtime] broken manifest; continuing without it",
    )
  })
})
