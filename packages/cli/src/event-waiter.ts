export function waitForEventWake(options: {
  signal: AbortSignal
  setWake: (wake: (() => void) | null) => void
  hasQueuedEvent: () => boolean
}): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      options.signal.removeEventListener("abort", finish)
      options.setWake(null)
      resolve()
    }

    options.setWake(finish)
    options.signal.addEventListener("abort", finish, { once: true })
    if (options.signal.aborted || options.hasQueuedEvent()) {
      finish()
    }
  })
}

export function waitForStreamFrame(
  signal: AbortSignal,
  delayMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }

    signal.addEventListener("abort", finish, { once: true })
    if (signal.aborted) {
      finish()
      return
    }
    timer = setTimeout(finish, Math.max(0, delayMs))
  })
}
