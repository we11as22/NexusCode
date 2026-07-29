import { PassThrough } from "node:stream"
import React, { useState } from "react"
import { render, Text } from "ink"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DOUBLE_PRESS_TIMEOUT_MS, useDoublePress } from "./useDoublePress.js"

type HarnessProps = {
  onDoublePress: () => void
  expose: (handler: () => void) => void
}

function Harness({ onDoublePress, expose }: HarnessProps) {
  const [pending, setPending] = useState(false)
  const handler = useDoublePress(setPending, onDoublePress)
  expose(handler)
  return <Text>{pending ? "pending" : "idle"}</Text>
}

describe("useDoublePress", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("recognizes the second press after the pending-state rerender", async () => {
    vi.useFakeTimers()
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream
    Object.defineProperty(stdout, "columns", { value: 80, configurable: true })
    const onDoublePress = vi.fn()
    let currentHandler: (() => void) | undefined
    const view = render(
      <Harness
        onDoublePress={onDoublePress}
        expose={(handler) => {
          currentHandler = handler
        }}
      />,
      { stdout, debug: true },
    )

    try {
      currentHandler?.()
      await vi.advanceTimersByTimeAsync(1)
      currentHandler?.()
      expect(onDoublePress).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
    }
  })

  it("treats a later press as a new first press", async () => {
    vi.useFakeTimers()
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream
    Object.defineProperty(stdout, "columns", { value: 80, configurable: true })
    const onDoublePress = vi.fn()
    let currentHandler: (() => void) | undefined
    const view = render(
      <Harness
        onDoublePress={onDoublePress}
        expose={(handler) => {
          currentHandler = handler
        }}
      />,
      { stdout, debug: true },
    )

    try {
      currentHandler?.()
      await vi.advanceTimersByTimeAsync(DOUBLE_PRESS_TIMEOUT_MS + 1)
      currentHandler?.()
      expect(onDoublePress).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  })
})
