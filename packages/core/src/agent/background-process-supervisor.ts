import * as path from "node:path"

export type BackgroundProcessStopReason = "requested" | "owner_shutdown"

export interface BackgroundProcessRecord {
  readonly taskId: string
  readonly pid: number
  /** Opaque per-spawn identity. A persisted PID alone is never sufficient. */
  readonly processIdentity: string
  readonly logPath: string
  readonly workspace: string
  readonly sessionId: string
  /** Live child/process-group terminator. Never reconstructed from a stored PID. */
  readonly terminate?: (signal: NodeJS.Signals) => boolean
  /** Await process exit and durable terminal-state publication. */
  readonly stop: (reason: BackgroundProcessStopReason) => Promise<void>
}

function workspaceKey(workspace: string): string {
  return path.resolve(workspace)
}

/**
 * Workspace-runtime-owned live process projection.
 *
 * Durable task state remains authoritative across process restarts. This
 * supervisor only owns live process handles in the current runtime and refuses
 * lookup without the exact workspace + session capability.
 */
export class BackgroundProcessSupervisor {
  readonly #jobs = new Map<string, BackgroundProcessRecord>()
  readonly #stops = new Map<
    string,
    { processIdentity: string; promise: Promise<void> }
  >()
  #closed = false
  #closePromise: Promise<void> | undefined

  register(record: BackgroundProcessRecord): void {
    if (this.#closed || this.#closePromise) {
      throw new Error("Background process supervisor is closed")
    }
    if (this.#jobs.has(record.taskId)) {
      throw new Error(`Background process id already exists: ${record.taskId}`)
    }
    this.#jobs.set(record.taskId, {
      ...record,
      workspace: workspaceKey(record.workspace),
    })
  }

  get(
    taskId: string,
    owner: { workspace: string; sessionId: string },
  ): BackgroundProcessRecord | undefined {
    const record = this.#jobs.get(taskId)
    if (
      !record ||
      record.workspace !== workspaceKey(owner.workspace) ||
      record.sessionId !== owner.sessionId
    ) {
      return undefined
    }
    return record
  }

  remove(
    taskId: string,
    owner: { workspace: string; sessionId: string },
  ): boolean {
    if (!this.get(taskId, owner)) return false
    return this.#jobs.delete(taskId)
  }

  terminate(
    taskId: string,
    owner: { workspace: string; sessionId: string },
    signal: NodeJS.Signals = "SIGTERM",
  ): boolean {
    const record = this.get(taskId, owner)
    if (!record?.terminate) return false
    return record.terminate(signal)
  }

  async stop(
    taskId: string,
    owner: { workspace: string; sessionId: string },
    options: {
      processIdentity: string
      reason?: BackgroundProcessStopReason
    },
  ): Promise<boolean> {
    const record = this.get(taskId, owner)
    if (
      !record ||
      record.processIdentity !== options.processIdentity
    ) {
      return false
    }
    await this.#stopRecord(record, options.reason ?? "requested")
    if (this.#jobs.get(taskId)?.processIdentity === record.processIdentity) {
      this.#jobs.delete(taskId)
    }
    return true
  }

  list(owner: {
    workspace: string
    sessionId: string
  }): BackgroundProcessRecord[] {
    const workspace = workspaceKey(owner.workspace)
    return Array.from(this.#jobs.values()).filter(
      (record) =>
        record.workspace === workspace &&
        record.sessionId === owner.sessionId,
    )
  }

  /** Protect active logs from retention cleanup across sessions/workspaces. */
  ownsLogPath(logPath: string): boolean {
    const candidate = path.resolve(logPath)
    return Array.from(this.#jobs.values()).some(
      (record) => path.resolve(record.logPath) === candidate,
    )
  }

  #stopRecord(
    record: BackgroundProcessRecord,
    reason: BackgroundProcessStopReason,
  ): Promise<void> {
    const existing = this.#stops.get(record.taskId)
    if (existing?.processIdentity === record.processIdentity) {
      return existing.promise
    }
    const promise = Promise.resolve().then(() => record.stop(reason))
    const tracked = {
      processIdentity: record.processIdentity,
      promise,
    }
    this.#stops.set(record.taskId, tracked)
    void promise.finally(() => {
      if (this.#stops.get(record.taskId) === tracked) {
        this.#stops.delete(record.taskId)
      }
    }).catch(() => {})
    return promise
  }

  /**
   * Stop every owner-bound process and wait until each task has published a
   * durable terminal outcome. Handles are retained until the full drain
   * finishes so a partial shutdown can never masquerade as successful.
   */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closed = true
    const records = Array.from(this.#jobs.values())
    this.#closePromise = (async () => {
      const outcomes = await Promise.allSettled(
        records.map((record) =>
          this.#stopRecord(record, "owner_shutdown"),
        ),
      )
      const errors: unknown[] = []
      outcomes.forEach((outcome, index) => {
        const record = records[index]!
        if (outcome.status === "rejected") {
          errors.push(outcome.reason)
          return
        }
        if (this.#jobs.get(record.taskId)?.processIdentity === record.processIdentity) {
          this.#jobs.delete(record.taskId)
        }
      })
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Failed to stop background processes during owner shutdown",
        )
      }
    })()
    return this.#closePromise
  }
}
