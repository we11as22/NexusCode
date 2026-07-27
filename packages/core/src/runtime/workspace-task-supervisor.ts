export interface WorkspaceTaskHandle {
  readonly started: boolean
  readonly promise: Promise<void>
}

interface RunningWorkspaceTask {
  readonly controller: AbortController
  readonly promise: Promise<void>
}

/**
 * Owns non-turn background work (memory consolidation, maintenance, refresh)
 * for exactly one workspace runtime.
 */
export class WorkspaceTaskSupervisor {
  readonly #running = new Map<string, RunningWorkspaceTask>()
  #closePromise: Promise<void> | undefined
  #closed = false

  start(
    key: string,
    task: (signal: AbortSignal) => Promise<void>,
  ): WorkspaceTaskHandle {
    if (this.#closed || this.#closePromise) {
      throw new Error("Workspace task supervisor is closed.")
    }
    const normalizedKey = key.trim()
    if (!normalizedKey) {
      throw new Error("Workspace task key must not be empty.")
    }
    const existing = this.#running.get(normalizedKey)
    if (existing) {
      return { started: false, promise: existing.promise }
    }

    const controller = new AbortController()
    let execution: Promise<void>
    try {
      execution = task(controller.signal)
    } catch (error) {
      execution = Promise.reject(error)
    }
    let promise!: Promise<void>
    promise = Promise.resolve(execution)
      .finally(() => {
        const current = this.#running.get(normalizedKey)
        if (current?.promise === promise) {
          this.#running.delete(normalizedKey)
        }
      })
    this.#running.set(normalizedKey, { controller, promise })
    return { started: true, promise }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closed = true
    const running = [...this.#running.values()]
    this.#closePromise = (async () => {
      for (const task of running) {
        task.controller.abort(
          new Error("Workspace runtime is shutting down."),
        )
      }
      await Promise.allSettled(running.map((task) => task.promise))
      this.#running.clear()
    })()
    return this.#closePromise
  }
}
