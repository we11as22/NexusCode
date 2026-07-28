import { afterEach, describe, expect, it, vi } from "vitest"

import { sleep } from "./base.js"

afterEach(() => {
  vi.useRealTimers()
})

describe("provider retry sleep", () => {
  it("removes its abort listener after the timer resolves", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, "removeEventListener")

    const waiting = sleep(25, controller.signal)
    await vi.advanceTimersByTimeAsync(25)
    await waiting

    expect(remove).toHaveBeenCalledTimes(1)
  })

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(sleep(25, controller.signal)).rejects.toThrow("Aborted")
  })
})
