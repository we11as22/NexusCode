import {
  PROTOCOL_VERSION,
  ProtocolEnvelopeSchema,
  SESSION_PROTOCOL_SERVICE_PORT_VERSION,
  SessionCommandReceiptSchema,
  SessionCoordinator,
  SessionCoordinatorError,
  SessionProtocolError,
  SessionProtocolSnapshotSchema,
  parseSessionCommand,
  type ProtocolEnvelope,
  type SessionCommandReceipt,
  type SessionCommandV2,
  type SessionCoordinatorOptions,
  type SessionProtocolService,
  type SessionProtocolSnapshot,
  type TurnEpochSnapshot,
  type TurnRunner,
} from "@nexuscode/core"
import {
  RuntimeConflictError,
  RuntimeRepository,
  SessionRuntimeConflictError,
  SessionRuntimeRepository,
} from "@nexuscode/state"

import {
  SqliteSessionCoordinatorStorage,
  type SessionStateNotifier,
} from "./sqlite-session-storage.js"

interface SessionEntry {
  readonly coordinator: SessionCoordinator
  readonly sessionId: string
  lease: {
    sessionId: string
    ownerId: string
    epoch: number
    expiresAt: number
    updatedAt: number
  }
  leaseError?: unknown
}

export interface SqliteSessionProtocolServiceOptions {
  readonly canonicalDirectory: string
  readonly workspaceId: string
  readonly ownerId: string
  readonly state: SessionRuntimeRepository
  readonly runtime: RuntimeRepository
  readonly runner: TurnRunner
  readonly epochs: {
    capture(): TurnEpochSnapshot | PromiseLike<TurnEpochSnapshot>
  }
  readonly approvals?: SessionCoordinatorOptions["approvals"]
  readonly leaseTtlMs?: number
  readonly replayPollMs?: number
  readonly onDiagnostic?: (error: unknown) => void
}

class StateSignal implements SessionStateNotifier {
  readonly #waiters = new Map<string, Set<() => void>>()
  #closed = false

  notify(sessionId: string): void {
    const waiters = this.#waiters.get(sessionId)
    if (!waiters) return
    this.#waiters.delete(sessionId)
    for (const resolve of waiters) resolve()
  }

  wait(
    sessionId: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    if (this.#closed || signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const waiters = this.#waiters.get(sessionId) ?? new Set()
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal?.removeEventListener("abort", finish)
        waiters.delete(finish)
        if (waiters.size === 0) this.#waiters.delete(sessionId)
        resolve()
      }
      const timeout = setTimeout(finish, timeoutMs)
      timeout.unref?.()
      waiters.add(finish)
      this.#waiters.set(sessionId, waiters)
      signal?.addEventListener("abort", finish, { once: true })
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiters of this.#waiters.values()) {
      for (const resolve of waiters) resolve()
    }
    this.#waiters.clear()
  }
}

function mapProtocolError(error: unknown): SessionProtocolError {
  if (error instanceof SessionProtocolError) return error
  if (error instanceof SessionRuntimeConflictError) {
    switch (error.code) {
      case "idempotency_conflict":
      case "input_conflict":
        return new SessionProtocolError({
          code: "idempotency_conflict",
          message: "The command id or input id was reused with different content",
          retryable: false,
        })
      case "no_active_turn":
        return new SessionProtocolError({
          code: "no_active_turn",
          message: "The session has no active turn",
          retryable: false,
        })
      case "turn_conflict":
        return new SessionProtocolError({
          code: "turn_conflict",
          message: "The expected active turn no longer matches",
          retryable: false,
        })
      case "approval_conflict":
        return new SessionProtocolError({
          code: "approval_conflict",
          message: "The approval is not pending for the active turn",
          retryable: false,
        })
      case "lease_lost":
        return new SessionProtocolError({
          code: "runtime_unavailable",
          message: "The workspace runtime lost its session lease",
          retryable: true,
        })
      case "invalid_phase":
        break
      case "session_deleted":
        return new SessionProtocolError({
          code: "not_found",
          message: "The session was deleted",
          retryable: false,
        })
      case "session_not_idle":
        return new SessionProtocolError({
          code: "turn_conflict",
          message:
            "The session still has accepted or active work; interrupt and drain it before deleting",
          retryable: false,
        })
    }
  }
  if (error instanceof RuntimeConflictError) {
    if (error.code === "lease_conflict" || error.code === "lease_lost") {
      return new SessionProtocolError({
        code: "runtime_unavailable",
        message: "The session is owned by another live runtime",
        retryable: true,
      })
    }
  }
  if (error instanceof SessionCoordinatorError) {
    if (error.code === "no_active_turn") {
      return new SessionProtocolError({
        code: "no_active_turn",
        message: "The session has no active turn",
        retryable: false,
      })
    }
    if (error.code === "turn_conflict") {
      return new SessionProtocolError({
        code: "turn_conflict",
        message: "The expected active turn no longer matches",
        retryable: false,
      })
    }
    if (error.code === "execution_conflict") {
      return new SessionProtocolError({
        code: "selection_conflict",
        message: "Steering cannot change the active turn execution policy",
        retryable: false,
      })
    }
    if (error.code === "closed") {
      return new SessionProtocolError({
        code: "runtime_unavailable",
        message: "The workspace runtime is closing",
        retryable: true,
      })
    }
  }
  return new SessionProtocolError({
    code: "internal_error",
    message: "The Nexus runtime could not complete the session command",
    retryable: false,
  })
}

export class SqliteSessionProtocolService implements SessionProtocolService {
  readonly portVersion = SESSION_PROTOCOL_SERVICE_PORT_VERSION
  readonly #canonicalDirectory: string
  readonly #workspaceId: string
  readonly #ownerId: string
  readonly #state: SessionRuntimeRepository
  readonly #runtime: RuntimeRepository
  readonly #runner: TurnRunner
  readonly #epochs: SqliteSessionProtocolServiceOptions["epochs"]
  readonly #approvals: SqliteSessionProtocolServiceOptions["approvals"]
  readonly #leaseTtlMs: number
  readonly #replayPollMs: number
  readonly #onDiagnostic: (error: unknown) => void
  readonly #signal = new StateSignal()
  readonly #entries = new Map<string, Promise<SessionEntry>>()
  readonly #commandTails = new Map<string, Promise<void>>()
  readonly #renewTimer: ReturnType<typeof setInterval>
  #closing = false
  #closePromise: Promise<void> | undefined

  constructor(options: SqliteSessionProtocolServiceOptions) {
    this.#canonicalDirectory = options.canonicalDirectory
    this.#workspaceId = options.workspaceId
    this.#ownerId = options.ownerId
    this.#state = options.state
    this.#runtime = options.runtime
    this.#runner = options.runner
    this.#epochs = options.epochs
    this.#approvals = options.approvals
    this.#leaseTtlMs = options.leaseTtlMs ?? 30_000
    this.#replayPollMs = options.replayPollMs ?? 250
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined)
    if (
      !Number.isSafeInteger(this.#leaseTtlMs) ||
      this.#leaseTtlMs < 3_000
    ) {
      throw new Error("Session lease TTL must be at least 3000ms")
    }
    if (
      !Number.isSafeInteger(this.#replayPollMs) ||
      this.#replayPollMs < 10 ||
      this.#replayPollMs > 10_000
    ) {
      throw new Error("Replay poll interval must be from 10 through 10000ms")
    }
    this.#renewTimer = setInterval(
      () => this.#renewLeases(),
      Math.max(1_000, Math.floor(this.#leaseTtlMs / 3)),
    )
    this.#renewTimer.unref?.()
  }

  dispatch(command: SessionCommandV2): Promise<SessionCommandReceipt> {
    const parsed = parseSessionCommand(command)
    if (!parsed.ok) {
      return Promise.reject(new SessionProtocolError(parsed.error))
    }
    const acceptedCommand = parsed.command
    return this.#enqueue(acceptedCommand.sessionId, async () => {
      this.#assertAccepting()
      let entry: SessionEntry
      try {
        entry = await this.#entry(acceptedCommand.sessionId)
        if (entry.leaseError) throw entry.leaseError
        const receipt = SessionCommandReceiptSchema.parse(
          this.#state.prepareCommand({
          command: acceptedCommand,
          fence: {
            ownerId: entry.lease.ownerId,
            leaseEpoch: entry.lease.epoch,
          },
          }),
        )
        this.#signal.notify(acceptedCommand.sessionId)
        await this.#wake(entry.coordinator, acceptedCommand)
        return receipt
      } catch (error) {
        throw mapProtocolError(error)
      }
    })
  }

  async snapshot(sessionId: string): Promise<SessionProtocolSnapshot> {
    this.#assertAccepting()
    try {
      const entry = await this.#entry(sessionId)
      if (entry.leaseError) throw entry.leaseError
      const protocolSnapshot = this.#state.protocolSnapshot(sessionId)
      const current = protocolSnapshot.runtime
      return SessionProtocolSnapshotSchema.parse({
        version: PROTOCOL_VERSION,
        sessionId,
        phase: current.phase,
        ...(current.activeTurn
          ? {
              activeTurnId: current.activeTurn.turnId,
              activeRunId: current.activeTurn.runId,
              activeTurnFirstSequence:
                protocolSnapshot.activeTurnFirstSequence,
              activeExecution: current.activeTurn.execution,
            }
          : {}),
        pendingApprovals: current.pendingApprovals,
        pendingTurns: current.pendingQueue.slice(0, 1024).map((pending) => ({
          inputId: pending.id,
          turnId: pending.reservedTurnId,
          runId: pending.reservedRunId,
          admittedSequence: pending.admittedSequence,
          execution: pending.execution,
        })),
        pendingQueueCount: current.pendingQueue.length,
        pendingSteerCount: current.pendingSteers.length,
        earliestAvailableSequence:
          protocolSnapshot.earliestAvailableSequence,
        throughSequence: protocolSnapshot.throughSequence,
      })
    } catch (error) {
      throw mapProtocolError(error)
    }
  }

  async *events(input: {
    sessionId: string
    afterSequence: number
    signal?: AbortSignal
  }): AsyncIterable<ProtocolEnvelope> {
    let cursor = input.afterSequence
    while (!this.#closing && !input.signal?.aborted) {
      let batch
      try {
        batch = this.#state.events(input.sessionId, cursor, 512)
      } catch (error) {
        throw mapProtocolError(error)
      }
      if (batch.length > 0) {
        for (const envelope of batch) {
          if (envelope.sequence !== cursor + 1) {
            throw new SessionProtocolError({
              code: "replay_gap",
              message: "The durable event stream is not contiguous",
              retryable: true,
            })
          }
          cursor = envelope.sequence
          yield ProtocolEnvelopeSchema.parse(envelope)
        }
        continue
      }
      await this.#signal.wait(
        input.sessionId,
        input.signal,
        this.#replayPollMs,
      )
    }
  }

  deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
    return this.#enqueue(sessionId, async () => {
      this.#assertAccepting()
      if (this.#state.isSessionTombstoned(sessionId)) {
        return { deleted: false }
      }

      let entry: SessionEntry
      try {
        entry = await this.#entry(sessionId)
        if (entry.leaseError) throw entry.leaseError
        const result = this.#state.tombstoneSession({
          sessionId,
          fence: {
            ownerId: entry.lease.ownerId,
            leaseEpoch: entry.lease.epoch,
          },
        })
        this.#entries.delete(sessionId)
        this.#signal.notify(sessionId)

        const cleanupErrors: unknown[] = []
        try {
          await entry.coordinator.close()
        } catch (error) {
          cleanupErrors.push(error)
        }
        try {
          this.#runtime.releaseSessionLease({
            sessionId,
            ownerId: entry.lease.ownerId,
            epoch: entry.lease.epoch,
          })
        } catch (error) {
          cleanupErrors.push(error)
        }
        if (cleanupErrors.length === 1) throw cleanupErrors[0]
        if (cleanupErrors.length > 1) {
          throw new AggregateError(
            cleanupErrors,
            `Failed to drain deleted session ${sessionId}`,
          )
        }
        return { deleted: result.tombstoned }
      } catch (error) {
        throw mapProtocolError(error)
      }
    })
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closing = true
    clearInterval(this.#renewTimer)
    this.#signal.close()
    const attempt = (async () => {
      await Promise.allSettled(this.#commandTails.values())
      const entries = await Promise.allSettled(this.#entries.values())
      const errors: unknown[] = []
      for (const result of entries) {
        if (result.status === "rejected") {
          errors.push(result.reason)
          continue
        }
        const entry = result.value
        try {
          if (entry.leaseError) {
            await entry.coordinator.abandon(entry.leaseError)
          } else {
            await entry.coordinator.close()
          }
        } catch (error) {
          errors.push(error)
        }
        try {
          this.#runtime.releaseSessionLease({
            sessionId: entry.sessionId,
            ownerId: entry.lease.ownerId,
            epoch: entry.lease.epoch,
          })
        } catch (error) {
          if (!entry.leaseError) errors.push(error)
        }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Failed to close one or more SQLite session coordinators",
        )
      }
    })()
    this.#closePromise = attempt.catch((error) => {
      this.#closePromise = undefined
      throw error
    })
    return this.#closePromise
  }

  #assertAccepting(): void {
    if (this.#closing) {
      throw new SessionProtocolError({
        code: "runtime_unavailable",
        message: "The workspace runtime is closing",
        retryable: true,
      })
    }
  }

  #enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#commandTails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#commandTails.set(sessionId, tail)
    void tail.finally(() => {
      if (this.#commandTails.get(sessionId) === tail) {
        this.#commandTails.delete(sessionId)
      }
    })
    return result
  }

  #entry(sessionId: string): Promise<SessionEntry> {
    let existing = this.#entries.get(sessionId)
    if (existing) return existing
    const creating = this.#createEntry(sessionId)
    const guarded = creating.catch((error) => {
      if (this.#entries.get(sessionId) === guarded) {
        this.#entries.delete(sessionId)
      }
      throw error
    })
    existing = guarded
    this.#entries.set(sessionId, existing)
    return existing
  }

  async #createEntry(sessionId: string): Promise<SessionEntry> {
    this.#state.ensureWorkspaceSession({
      workspaceId: this.#workspaceId,
      canonicalPath: this.#canonicalDirectory,
      sessionId,
    })
    const lease = this.#runtime.claimSession({
      sessionId,
      ownerId: this.#ownerId,
      ttlMs: this.#leaseTtlMs,
    })
    const storage = new SqliteSessionCoordinatorStorage(
      this.#state,
      this.#signal,
    )
    const coordinator = new SessionCoordinator({
      sessionId,
      ownership: {
        fence: {
          ownerId: lease.ownerId,
          leaseEpoch: lease.epoch,
        },
      },
      storage,
      runner: this.#runner,
      epochs: this.#epochs,
      events: {
        // State storage commits protocol envelopes in the same transaction.
        // Coordinator publication is only a best-effort in-process wake.
        publish: () => this.#signal.notify(sessionId),
        onError: (error) => this.#onDiagnostic(error),
      },
      ...(this.#approvals ? { approvals: this.#approvals } : {}),
    })
    const entry: SessionEntry = { coordinator, sessionId, lease }
    try {
      await coordinator.recover()
      return entry
    } catch (error) {
      try {
        this.#runtime.releaseSessionLease({
          sessionId,
          ownerId: lease.ownerId,
          epoch: lease.epoch,
        })
      } catch {
        // Preserve the recovery error.
      }
      throw error
    }
  }

  async #wake(
    coordinator: SessionCoordinator,
    command: SessionCommandV2,
  ): Promise<void> {
    try {
      switch (command.type) {
        case "start_turn":
          await coordinator.start({
            inputId: command.inputId,
            parts: command.input,
            mode: command.mode,
            ...(command.selection === undefined
              ? {}
              : { selection: command.selection }),
          })
          break
        case "queue_turn":
          await coordinator.queue({
            inputId: command.inputId,
            parts: command.input,
            mode: command.mode,
            ...(command.selection === undefined
              ? {}
              : { selection: command.selection }),
          })
          break
        case "steer_turn":
          await coordinator.steer({
            inputId: command.inputId,
            expectedTurnId: command.expectedTurnId,
            parts: command.input,
          })
          break
        case "interrupt_turn":
          void coordinator.interrupt({
            expectedTurnId: command.expectedTurnId,
            ...(command.reason === undefined
              ? {}
              : { reason: command.reason }),
          }).catch((error) => this.#onDiagnostic(error))
          break
        case "resolve_approval":
          await coordinator.approve({
            approvalId: command.approvalId,
            expectedTurnId: command.expectedTurnId,
            status: command.status,
          })
          break
      }
      await Promise.resolve()
    } catch (error) {
      // The command and receipt are already durable. A later retry/restart can
      // reconcile scheduling without repeating provider or tool side effects.
      this.#onDiagnostic(error)
    }
  }

  #renewLeases(): void {
    for (const pending of this.#entries.values()) {
      void pending.then(async (entry) => {
        if (this.#closing || entry.leaseError) return
        try {
          entry.lease = this.#runtime.renewSessionLease({
            sessionId: entry.sessionId,
            ownerId: entry.lease.ownerId,
            epoch: entry.lease.epoch,
            ttlMs: this.#leaseTtlMs,
          })
        } catch (error) {
          this.#onDiagnostic(error)
          if (
            error instanceof RuntimeConflictError &&
            error.code === "lease_lost"
          ) {
            entry.leaseError = error
            try {
              await entry.coordinator.abandon(error)
            } catch (abandonError) {
              this.#onDiagnostic(abandonError)
            }
          }
        }
      }).catch((error) => this.#onDiagnostic(error))
    }
  }
}
