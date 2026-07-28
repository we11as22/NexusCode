import { describe, expect, it, vi } from "vitest"

import {
  waitForEventWake,
  waitForStreamFrame,
} from "./event-waiter.js"

describe("CLI event waiter", () => {
  it("removes the abort listener after a normal event wake", async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, "addEventListener")
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    const wakeRef: { current: (() => void) | null } = { current: null }

    const waiting = waitForEventWake({
      signal: controller.signal,
      setWake: (next) => {
        wakeRef.current = next
      },
      hasQueuedEvent: () => false,
    })

    expect(add).toHaveBeenCalledTimes(1)
    expect(wakeRef.current).not.toBeNull()
    wakeRef.current?.()
    await waiting

    expect(remove).toHaveBeenCalledTimes(1)
    expect(wakeRef.current).toBeNull()
  })

  it("does not leave a listener behind when an event is already queued", async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, "removeEventListener")

    await waitForEventWake({
      signal: controller.signal,
      setWake: () => undefined,
      hasQueuedEvent: () => true,
    })

    expect(remove).toHaveBeenCalledTimes(1)
  })

  it("resolves and clears the wake callback when aborted", async () => {
    const controller = new AbortController()
    const wakeRef: { current: (() => void) | null } = { current: null }
    const waiting = waitForEventWake({
      signal: controller.signal,
      setWake: (next) => {
        wakeRef.current = next
      },
      hasQueuedEvent: () => false,
    })

    controller.abort()
    await waiting
    expect(wakeRef.current).toBeNull()
  })

  it("cancels a pending stream-frame delay without retaining an abort listener", async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, "removeEventListener")
      const waiting = waitForStreamFrame(controller.signal, 50)

      controller.abort()
      await waiting

      expect(remove).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
