import {
  SESSION_COORDINATOR_STORAGE_PORT_VERSION,
  type AdmittedSessionInput,
  type AdmitSessionInputCommand,
  type CoordinatorEvent,
  type DurableSessionTurn,
  type FinishTurnCommit,
  type SessionCoordinatorOptions,
  type SessionOwnershipFence,
  type SessionPhase,
  type SessionRuntimeSnapshot,
  type TurnExecutionSnapshot,
  type TurnRunnerContext,
  type TurnRunnerResult,
} from "./types.js"
import {
  type ActiveTurn,
  type ApprovalDelivery,
  assertNonEmpty,
  cloneParts,
  createDeferred,
  DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type Deferred,
  freezeAdmittedInput,
  freezeEpochs,
  freezeExecution,
  MAX_COMPLETED_SETTLEMENTS,
  normalizedResult,
  PHASE_TRANSITIONS,
  resultFromError,
  RUNNER_PHASES,
  sameExecution,
  sameParts,
  SessionCoordinatorError,
  terminalEvent,
} from "./session-coordinator-support.js"

export abstract class SessionCoordinatorBase {
  protected readonly sessionId: string
  protected readonly fence: SessionOwnershipFence
  protected readonly storage: SessionCoordinatorOptions["storage"]
  protected readonly runner: SessionCoordinatorOptions["runner"]
  protected readonly epochs: SessionCoordinatorOptions["epochs"]
  protected readonly events: SessionCoordinatorOptions["events"]
  protected readonly approvals: SessionCoordinatorOptions["approvals"]
  protected readonly approvalDeliveryTimeoutMs: number
  protected readonly shutdownTimeoutMs: number
  protected readonly settlements = new Map<string, Deferred<TurnRunnerResult>>()
  protected readonly completedResults = new Map<string, TurnRunnerResult>()
  protected readonly completedOrder: string[] = []
  protected readonly reservedTurnOwners = new Map<string, string>()
  protected readonly reservedRunOwners = new Map<string, string>()
  protected readonly reservedIdentitiesByInput =
    new Map<string, readonly [string, string]>()
  protected tail: Promise<void> = Promise.resolve()
  protected active: ActiveTurn | undefined
  protected identityError: SessionCoordinatorError | undefined
  protected recovered = false
  protected closing = false
  protected closed = false
  protected closePromise: Promise<void> | undefined

  constructor(options: SessionCoordinatorOptions) {
    assertNonEmpty(options.sessionId, "Session id")
    assertNonEmpty(options.ownership.fence.ownerId, "Session owner id")
    if (
      options.storage.portVersion !==
      SESSION_COORDINATOR_STORAGE_PORT_VERSION
    ) {
      throw new Error(
        `Unsupported session storage port version ${String(options.storage.portVersion)}`,
      )
    }
    if (
      !Number.isSafeInteger(options.ownership.fence.leaseEpoch) ||
      options.ownership.fence.leaseEpoch < 1
    ) {
      throw new Error("Session lease epoch must be a positive safe integer")
    }
    this.sessionId = options.sessionId
    this.fence = Object.freeze({ ...options.ownership.fence })
    this.storage = options.storage
    this.runner = options.runner
    this.epochs = options.epochs
    this.events = options.events
    this.approvals = options.approvals
    this.approvalDeliveryTimeoutMs =
      options.approvalDeliveryTimeoutMs ??
      DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.approvalDeliveryTimeoutMs) ||
      this.approvalDeliveryTimeoutMs < 1
    ) {
      throw new Error(
        "Approval delivery timeout must be a positive safe integer",
      )
    }
    if (
      !Number.isSafeInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs < 1
    ) {
      throw new Error("Shutdown timeout must be a positive safe integer")
    }
  }

  protected enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  protected assertAccepting(): void {
    if (this.closing || this.closed) {
      throw new SessionCoordinatorError(
        "closed",
        `Session coordinator ${this.sessionId} is closed`,
      )
    }
    if (this.identityError) throw this.identityError
  }

  protected async ensureRecoveredLocked(): Promise<void> {
    if (this.recovered) return
    const recovered = await this.recoverLocked()
    if (
      !this.active &&
      !this.closing &&
      recovered.pendingQueue.length > 0
    ) {
      await this.startNextLocked()
    }
  }

  protected async recoverLocked(): Promise<SessionRuntimeSnapshot> {
    if (this.active) {
      this.recovered = true
      return this.storage.snapshot(this.sessionId)
    }
    const recovery = await this.storage.recoverSession({
      sessionId: this.sessionId,
      fence: this.fence,
    })
    try {
      this.registerSnapshotIdentities(recovery.snapshot)
    } catch (error) {
      this.recovered = true
      throw error
    }
    if (recovery.snapshot.activeTurn) {
      this.recovered = false
      throw new SessionCoordinatorError(
        "turn_conflict",
        `Recovery left ambiguous turn ${recovery.snapshot.activeTurn.turnId} active`,
      )
    }
    if (recovery.interruptedTurn) {
      this.publishRequeued(
        recovery.interruptedTurn.turnId,
        recovery.interruptedTurn.runId,
        { requeuedInputs: recovery.interruptedTurn.requeuedInputs },
      )
      this.publish(
        terminalEvent(
          this.sessionId,
          recovery.interruptedTurn.turnId,
          recovery.interruptedTurn.runId,
          recovery.interruptedTurn.result,
        ),
      )
      this.settlements
        .get(recovery.interruptedTurn.turnId)
        ?.resolve(recovery.interruptedTurn.result)
      this.rememberCompleted(
        recovery.interruptedTurn.turnId,
        recovery.interruptedTurn.result,
      )
    }
    this.recovered = true
    return recovery.snapshot
  }

  protected async admitLocked(
    command: AdmitSessionInputCommand,
  ): Promise<AdmittedSessionInput> {
    assertNonEmpty(command.inputId, "Input id")
    if (command.delivery === "steer") {
      assertNonEmpty(command.expectedTurnId ?? "", "Expected turn id")
    } else if (command.expectedTurnId !== undefined) {
      throw new Error("Queued input cannot target an active turn")
    }
    const requestedParts = cloneParts(command.parts)
    const requestedExecution = freezeExecution(command.execution)
    const admitted = freezeAdmittedInput(await this.storage.admitInput({
      inputId: command.inputId,
      sessionId: this.sessionId,
      fence: this.fence,
      delivery: command.delivery,
      parts: requestedParts,
      execution: requestedExecution,
      ...(command.expectedTurnId === undefined
        ? {}
        : { expectedTurnId: command.expectedTurnId }),
    }))
    if (
      admitted.id !== command.inputId ||
      admitted.sessionId !== this.sessionId ||
      admitted.delivery !== command.delivery ||
      admitted.expectedTurnId !== command.expectedTurnId ||
      !sameParts(admitted.parts, requestedParts) ||
      !sameExecution(admitted.execution, requestedExecution)
    ) {
      throw new Error(
        `State adapter returned an idempotency mismatch for input ${command.inputId}`,
      )
    }
    this.registerReservedIdentity(admitted)
    this.publish({
      type: "input_admitted",
      sessionId: this.sessionId,
      inputId: admitted.id,
      turnId: admitted.reservedTurnId,
      runId: admitted.reservedRunId,
      delivery: admitted.delivery,
      ...(admitted.expectedTurnId === undefined
        ? {}
        : { expectedTurnId: admitted.expectedTurnId }),
      admittedSequence: admitted.admittedSequence,
      execution: admitted.execution,
    })
    return admitted
  }

  protected requireActive(expectedTurnId?: string): ActiveTurn {
    const active = this.active
    if (!active) {
      throw new SessionCoordinatorError(
        "no_active_turn",
        `Session ${this.sessionId} has no active turn`,
      )
    }
    if (
      expectedTurnId !== undefined &&
      active.turn.turnId !== expectedTurnId
    ) {
      throw new SessionCoordinatorError(
        "turn_conflict",
        `Expected active turn ${expectedTurnId}, found ${active.turn.turnId}`,
      )
    }
    return active
  }

  protected settlementFor(turnId: string): Deferred<TurnRunnerResult> {
    const existing = this.settlements.get(turnId)
    if (existing) return existing
    const created = createDeferred<TurnRunnerResult>()
    const completed = this.completedResults.get(turnId)
    if (completed) {
      created.resolve(completed)
      return created
    }
    this.settlements.set(turnId, created)
    return created
  }

  protected registerSnapshotIdentities(snapshot: SessionRuntimeSnapshot): void {
    if (snapshot.activeTurn) this.registerReservedIdentity(snapshot.activeTurn.input)
    for (const input of snapshot.pendingQueue) this.registerReservedIdentity(input)
    for (const input of snapshot.pendingSteers) this.registerReservedIdentity(input)
  }

  protected registerReservedIdentity(input: AdmittedSessionInput): void {
    const turnOwner = this.reservedTurnOwners.get(input.reservedTurnId)
    const runOwner = this.reservedRunOwners.get(input.reservedRunId)
    const previous = this.reservedIdentitiesByInput.get(input.id)
    if (
      (turnOwner !== undefined && turnOwner !== input.id) ||
      (runOwner !== undefined && runOwner !== input.id) ||
      (previous !== undefined &&
        (previous[0] !== input.reservedTurnId ||
          previous[1] !== input.reservedRunId))
    ) {
      const collision = new SessionCoordinatorError(
        "turn_conflict",
        `State adapter changed or reused durable identities for input ${input.id}`,
      )
      this.identityError = collision
      throw collision
    }
    this.reservedTurnOwners.set(input.reservedTurnId, input.id)
    this.reservedRunOwners.set(input.reservedRunId, input.id)
    this.reservedIdentitiesByInput.set(
      input.id,
      [input.reservedTurnId, input.reservedRunId],
    )
  }

  protected rememberCompleted(
    turnId: string,
    result: TurnRunnerResult,
  ): void {
    this.settlements.delete(turnId)
    if (this.completedResults.has(turnId)) return
    this.completedResults.set(turnId, result)
    this.completedOrder.push(turnId)
    while (this.completedOrder.length > MAX_COMPLETED_SETTLEMENTS) {
      const oldest = this.completedOrder.shift()
      if (oldest) this.completedResults.delete(oldest)
    }
  }

  protected async reconcileAmbiguousActiveLocked(
    active: ActiveTurn,
    cause: unknown,
    intendedResult: TurnRunnerResult,
    operation: string,
  ): Promise<SessionRuntimeSnapshot> {
    active.abortController.abort(
      cause instanceof Error
        ? cause
        : new Error(`Ambiguous ${operation}: ${String(cause)}`),
    )
    if (this.active === active) this.active = undefined
    this.recovered = false
    let snapshot: SessionRuntimeSnapshot
    try {
      snapshot = await this.recoverLocked()
    } catch (recoveryError) {
      this.recovered = false
      throw new AggregateError(
        [cause, recoveryError],
        `Failed to reconcile an ambiguous ${operation}`,
      )
    }
    if (
      snapshot.activeTurn?.turnId === active.turn.turnId &&
      !this.completedResults.has(active.turn.turnId)
    ) {
      this.recovered = false
      throw new AggregateError(
        [cause],
        `Durable state still contains turn ${active.turn.turnId} after ${operation} reconciliation`,
      )
    }
    if (!this.completedResults.has(active.turn.turnId)) {
      active.settlement.resolve(intendedResult)
      this.rememberCompleted(active.turn.turnId, intendedResult)
      this.publish(
        terminalEvent(
          this.sessionId,
          active.turn.turnId,
          active.turn.runId,
          intendedResult,
        ),
      )
    }
    if (!this.closing && snapshot.pendingQueue.length > 0) {
      await this.startNextLocked()
    }
    return snapshot
  }

  protected async drainOrForce(
    settlement: Promise<TurnRunnerResult>,
    timeoutReason: string,
  ): Promise<TurnRunnerResult> {
    const timedOut = Symbol("timed-out")
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
      timeout = setTimeout(() => resolve(timedOut), this.shutdownTimeoutMs)
    })
    try {
      const outcome = await Promise.race([settlement, timeoutPromise])
      if (outcome !== timedOut) return outcome
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    await this.enqueue(async () => {
      const active = this.active
      if (!active || active.settlement.promise !== settlement) return
      const result: TurnRunnerResult = {
        status: "interrupted",
        error: timeoutReason,
      }
      let commit: FinishTurnCommit
      try {
        commit = await this.storage.forceInterrupt({
          sessionId: this.sessionId,
          turnId: active.turn.turnId,
          reason: timeoutReason,
          fence: this.fence,
        })
      } catch (error) {
        await this.reconcileAmbiguousActiveLocked(
          active,
          error,
          result,
          "fenced hard-stop",
        )
        return
      }
      this.publishRequeued(
        active.turn.turnId,
        active.turn.runId,
        commit,
      )
      this.publish(
        terminalEvent(
          this.sessionId,
          active.turn.turnId,
          active.turn.runId,
          result,
        ),
      )
      this.active = undefined
      active.settlement.resolve(result)
      this.rememberCompleted(active.turn.turnId, result)
      if (!this.closing) await this.startNextLocked()
    })
    return settlement
  }

  protected async startNextLocked(
    retryAfterReconciliation = true,
  ): Promise<DurableSessionTurn | undefined> {
    if (this.active || this.closing || this.identityError) return undefined
    const epochs = freezeEpochs(await this.epochs.capture())
    let turn: DurableSessionTurn | undefined
    try {
      turn = await this.storage.claimNextTurn({
        sessionId: this.sessionId,
        epochs,
        fence: this.fence,
      })
    } catch (claimError) {
      this.recovered = false
      let recovered: SessionRuntimeSnapshot
      try {
        recovered = await this.recoverLocked()
      } catch (recoveryError) {
        this.recovered = false
        throw new AggregateError(
          [claimError, recoveryError],
          "Failed to reconcile an ambiguous turn claim",
        )
      }
      if (!recovered.activeTurn && recovered.pendingQueue.length > 0) {
        if (retryAfterReconciliation) return this.startNextLocked(false)
        this.recovered = false
      }
      return undefined
    }
    if (!turn) return undefined
    let input: AdmittedSessionInput
    let execution: TurnExecutionSnapshot
    let modeOverride: DurableSessionTurn["modeOverride"]
    try {
      input = freezeAdmittedInput(turn.input)
      execution = freezeExecution(turn.execution)
      if (turn.modeOverride !== undefined) {
        assertNonEmpty(
          turn.modeOverride.requestedByTurnId,
          "Mode override requesting turn id",
        )
        if (turn.modeOverride.requestedByTurnId === turn.turnId) {
          throw new Error("A turn cannot request its own mode override")
        }
        modeOverride = Object.freeze({
          requestedByTurnId: turn.modeOverride.requestedByTurnId,
        })
      }
      this.registerReservedIdentity(input)
      const executionMatchesAdmission =
        sameExecution(input.execution, execution) ||
        (modeOverride !== undefined &&
          input.execution.mode !== execution.mode &&
          sameExecution(
            { ...input.execution, mode: execution.mode },
            execution,
          ))
      if (
        input.delivery !== "queue" ||
        input.reservedTurnId !== turn.turnId ||
        input.reservedRunId !== turn.runId ||
        input.sessionId !== this.sessionId ||
        turn.phase !== "preparing" ||
        !executionMatchesAdmission ||
        turn.epochs.configEpoch !== epochs.configEpoch ||
        turn.epochs.contextEpoch !== epochs.contextEpoch ||
        turn.fence.ownerId !== this.fence.ownerId ||
        turn.fence.leaseEpoch !== this.fence.leaseEpoch
      ) {
        throw new Error("claimed turn snapshot did not match its admission")
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const reason =
        `State adapter returned an invalid or stale snapshot for turn ` +
        `${turn.turnId}: ${detail}`
      await this.storage.forceInterrupt({
        sessionId: this.sessionId,
        turnId: turn.turnId,
        reason,
        fence: this.fence,
      })
      throw new Error(reason)
    }
    const settlement = this.settlementFor(turn.turnId)
    const durableTurn: DurableSessionTurn = Object.freeze({
      ...turn,
      input,
      epochs,
      execution,
      ...(modeOverride === undefined ? {} : { modeOverride }),
      fence: this.fence,
    })
    const active: ActiveTurn = {
      turn: durableTurn,
      abortController: new AbortController(),
      settlement,
      phase: turn.phase,
    }
    this.active = active
    this.publish({
      type: "turn_started",
      sessionId: this.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
      epochs,
      execution,
    })
    this.launch(active)
    return durableTurn
  }

  protected launch(active: ActiveTurn): void {
    const context: TurnRunnerContext = Object.freeze({
      sessionId: this.sessionId,
      turnId: active.turn.turnId,
      runId: active.turn.runId,
      input: active.turn.input,
      epochs: active.turn.epochs,
      execution: active.turn.execution,
      fence: active.turn.fence,
      signal: active.abortController.signal,
      setPhase: (phase: SessionPhase) =>
        this.enqueue(() => this.setPhaseLocked(active.turn.turnId, phase)),
      safeBoundary: () =>
        this.enqueue(() => this.safeBoundaryLocked(active.turn.turnId)),
    })
    let intendedResult: TurnRunnerResult | undefined
    void Promise.resolve()
      .then(() => this.runner.run(context))
      .then(
        (result) => this.enqueue(() => {
          intendedResult = normalizedResult(
            result,
            active.abortController.signal.aborted,
          )
          return this.settleLocked(active.turn.turnId, intendedResult)
        }),
        (error) => this.enqueue(() => {
          intendedResult = resultFromError(
            error,
            active.abortController.signal.aborted,
          )
          return this.settleLocked(active.turn.turnId, intendedResult)
        }),
      )
      .catch((error) => {
        void this.enqueue(() =>
          this.reconcilePipelineFailureLocked(
            active,
            error,
            intendedResult,
          ),
        ).catch(() => undefined)
      })
  }

  protected async reconcilePipelineFailureLocked(
    active: ActiveTurn,
    cause: unknown,
    intendedResult: TurnRunnerResult | undefined,
  ): Promise<void> {
    if (this.active !== active) return
    active.abortController.abort(
      cause instanceof Error
        ? cause
        : new Error(`Ambiguous turn settlement: ${String(cause)}`),
    )
    this.active = undefined
    this.recovered = false
    let snapshot: SessionRuntimeSnapshot
    try {
      snapshot = await this.recoverLocked()
    } catch {
      // No runner is live and durable state remains explicitly unrecovered.
      // A later recover/snapshot/close call safely retries.
      this.recovered = false
      return
    }

    if (!this.completedResults.has(active.turn.turnId)) {
      if (snapshot.activeTurn?.turnId === active.turn.turnId) {
        this.recovered = false
        return
      }
      const reconciledResult = intendedResult ?? resultFromError(cause, false)
      active.settlement.resolve(reconciledResult)
      this.rememberCompleted(active.turn.turnId, reconciledResult)
      this.publish(
        terminalEvent(
          this.sessionId,
          active.turn.turnId,
          active.turn.runId,
          reconciledResult,
        ),
      )
    }
    if (!this.closing) await this.startNextLocked()
  }

  protected async setPhaseLocked(
    turnId: string,
    phase: SessionPhase,
  ): Promise<void> {
    const active = this.requireActive(turnId)
    if (!RUNNER_PHASES.has(phase)) {
      throw new SessionCoordinatorError(
        "invalid_phase",
        `Runner cannot enter terminal session phase ${phase}`,
      )
    }
    if (phase === active.phase) return
    if (!PHASE_TRANSITIONS[active.phase].has(phase)) {
      throw new SessionCoordinatorError(
        "invalid_phase",
        `Cannot transition turn ${turnId} from ${active.phase} to ${phase}`,
      )
    }
    await this.storage.setPhase({
      sessionId: this.sessionId,
      turnId,
      phase,
      fence: this.fence,
    })
    active.phase = phase
    this.publish({
      type: "phase_changed",
      sessionId: this.sessionId,
      turnId,
      runId: active.turn.runId,
      phase,
    })
  }

  protected async safeBoundaryLocked(
    turnId: string,
  ): Promise<readonly AdmittedSessionInput[]> {
    const active = this.requireActive(turnId)
    const pending = await this.storage.pendingSteers(
      this.sessionId,
      turnId,
    )
    const cutoff = pending.reduce(
      (maximum, input) => Math.max(maximum, input.admittedSequence),
      0,
    )
    if (cutoff === 0) return []
    const promoted = await this.storage.promoteSteers(
      this.sessionId,
      turnId,
      cutoff,
      this.fence,
    )
    if (promoted.length > 0) {
      this.publish({
        type: "steering_promoted",
        sessionId: this.sessionId,
        turnId,
        runId: active.turn.runId,
        inputIds: promoted.map((input) => input.id),
      })
    }
    return promoted
  }

  protected async settleLocked(
    turnId: string,
    result: TurnRunnerResult,
  ): Promise<void> {
    const active = this.active
    if (!active || active.turn.turnId !== turnId) return
    if (active.phase !== "settling") {
      await this.storage.setPhase({
        sessionId: this.sessionId,
        turnId,
        phase: "settling",
        fence: this.fence,
      })
      active.phase = "settling"
      this.publish({
        type: "phase_changed",
        sessionId: this.sessionId,
        turnId,
        runId: active.turn.runId,
        phase: "settling",
      })
    }
    const commit = await this.storage.finishTurn({
      sessionId: this.sessionId,
      turnId,
      result,
      fence: this.fence,
    })
    this.publishRequeued(turnId, active.turn.runId, commit)
    this.publish(
      terminalEvent(this.sessionId, turnId, active.turn.runId, result),
    )
    this.active = undefined
    active.settlement.resolve(result)
    this.rememberCompleted(turnId, result)
    if (!this.closing) {
      await this.startNextLocked()
    }
  }

  protected publishRequeued(
    turnId: string,
    runId: string,
    commit: FinishTurnCommit,
  ): void {
    if (commit.requeuedInputs.length === 0) return
    this.publish({
      type: "steering_requeued",
      sessionId: this.sessionId,
      turnId,
      runId,
      inputIds: commit.requeuedInputs.map((input) => input.id),
    })
  }

  protected publish(event: CoordinatorEvent): void {
    if (!this.events) return
    try {
      const notification = this.events.publish(event)
      void Promise.resolve(notification).catch((error) => {
        this.reportPublishError(error, event)
      })
    } catch (error) {
      this.reportPublishError(error, event)
    }
  }

  protected deliverApproval(command: ApprovalDelivery): void {
    if (!this.approvals) return
    let delivery: Promise<void>
    try {
      delivery = Promise.resolve(this.approvals.deliver(command))
    } catch (error) {
      this.reportApprovalError(error, command)
      return
    }
    void (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Approval wake delivery exceeded ` +
                  `${this.approvalDeliveryTimeoutMs}ms`,
              ),
            ),
          this.approvalDeliveryTimeoutMs,
        )
        timeout.unref?.()
      })
      try {
        await Promise.race([delivery, timedOut])
      } catch (error) {
        this.reportApprovalError(error, command)
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    })()
  }

  protected reportApprovalError(
    error: unknown,
    command: ApprovalDelivery,
  ): void {
    try {
      const diagnostic = this.approvals?.onError?.(error, command)
      void Promise.resolve(diagnostic).catch(() => undefined)
    } catch {
      // Approval wake diagnostics must never control durable session progress.
    }
  }

  protected reportPublishError(
    error: unknown,
    event: CoordinatorEvent,
  ): void {
    try {
      const diagnostic = this.events?.onError?.(error, event)
      void Promise.resolve(diagnostic).catch(() => undefined)
    } catch {
      // Notification diagnostics must never control durable session progress.
    }
  }
}
