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
