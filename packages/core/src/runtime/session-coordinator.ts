import type {
  AdmittedSessionInput,
  AdmitSessionInputCommand,
  InterruptTurnCommand,
  QueueTurnCommand,
  ResolveApprovalCommand,
  SessionInputPart,
  SessionRuntimeSnapshot,
  StartTurnCommand,
  SteerTurnCommand,
  TurnHandle,
} from "./types.js"
import { SessionCoordinatorBase } from "./session-coordinator-base.js"
import {
  assertNonEmpty,
  cloneParts,
  freezeExecution,
  sameExecution,
  SessionCoordinatorError,
} from "./session-coordinator-support.js"

export { SessionCoordinatorError } from "./session-coordinator-support.js"
export type {
  AdmittedSessionInput,
  AdmitSessionInputCommand,
  Awaitable,
  CoordinatorEvent,
  DurableSessionTurn,
  FinishTurnCommit,
  InterruptTurnCommand,
  ModelSelectionSnapshot,
  PendingSessionApprovalSnapshot,
  QueueTurnCommand,
  ResolveApprovalCommand,
  SessionCoordinatorOptions,
  SessionCoordinatorStorage,
  SessionInputPart,
  SessionMode,
  SessionOwnershipFence,
  SessionPhase,
  SessionRuntimeSnapshot,
  StartTurnCommand,
  SteerTurnCommand,
  TurnEpochSnapshot,
  TurnExecutionSnapshot,
  TurnHandle,
  TurnRunner,
  TurnRunnerContext,
  TurnRunnerResult,
} from "./types.js"

export class SessionCoordinator extends SessionCoordinatorBase {
  admit(command: AdmitSessionInputCommand): Promise<AdmittedSessionInput> {
    let captured: AdmitSessionInputCommand
    try {
      captured = {
        inputId: command.inputId,
        delivery: command.delivery,
        parts: cloneParts(command.parts),
        execution: freezeExecution(command.execution),
        ...(command.expectedTurnId === undefined
          ? {}
          : { expectedTurnId: command.expectedTurnId }),
      }
    } catch (error) {
      return Promise.reject(error)
    }
    return this.enqueue(async () => {
      this.assertAccepting()
      await this.ensureRecoveredLocked()
      if (captured.delivery === "steer") {
        const active = this.requireActive(captured.expectedTurnId)
        if (!sameExecution(captured.execution, active.turn.execution)) {
          throw new SessionCoordinatorError(
            "execution_conflict",
            `Steering input ${captured.inputId} must inherit the active turn execution policy`,
          )
        }
      }
      return this.admitLocked(captured)
    })
  }

  start(command: StartTurnCommand): Promise<TurnHandle> {
    let captured: AdmitSessionInputCommand
    try {
      captured = {
        inputId: command.inputId,
        delivery: "queue",
        parts: cloneParts(command.parts),
        execution: freezeExecution({
          mode: command.mode,
          ...(command.selection === undefined
            ? {}
            : { selection: command.selection }),
        }),
      }
    } catch (error) {
      return Promise.reject(error)
    }
    return this.enqueue(async () => {
      this.assertAccepting()
      await this.ensureRecoveredLocked()
      const admitted = await this.admitLocked(captured)
      const settlement = this.settlementFor(admitted.reservedTurnId)
      const started = await this.startNextLocked()
      return {
        turnId: admitted.reservedTurnId,
        runId: admitted.reservedRunId,
        started: started?.turnId === admitted.reservedTurnId,
        settled: settlement.promise,
      }
    })
  }

  steer(command: SteerTurnCommand): Promise<AdmittedSessionInput> {
    let parts: readonly SessionInputPart[]
    try {
      parts = cloneParts(command.parts)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.enqueue(async () => {
      this.assertAccepting()
      await this.ensureRecoveredLocked()
      const active = this.requireActive(command.expectedTurnId)
      return this.admitLocked({
        inputId: command.inputId,
        delivery: "steer",
        expectedTurnId: active.turn.turnId,
        parts,
        execution: active.turn.execution,
      })
    })
  }

  queue(command: QueueTurnCommand): Promise<AdmittedSessionInput> {
    let captured: AdmitSessionInputCommand
    try {
      captured = {
        inputId: command.inputId,
        delivery: "queue",
        parts: cloneParts(command.parts),
        execution: freezeExecution({
          mode: command.mode,
          ...(command.selection === undefined
            ? {}
            : { selection: command.selection }),
        }),
      }
    } catch (error) {
      return Promise.reject(error)
    }
    return this.enqueue(async () => {
      this.assertAccepting()
      await this.ensureRecoveredLocked()
      const admitted = await this.admitLocked(captured)
      await this.startNextLocked()
      return admitted
    })
  }

  async interrupt(command: InterruptTurnCommand): Promise<boolean> {
    const request = await this.enqueue(async () => {
      this.assertAccepting()
      await this.ensureRecoveredLocked()
      assertNonEmpty(command.expectedTurnId, "Expected turn id")
      if (!this.active) return { interrupted: false as const }
      const active = this.requireActive(command.expectedTurnId)
      try {
        await this.storage.requestInterrupt({
          sessionId: this.sessionId,
          turnId: active.turn.turnId,
          fence: this.fence,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        })
      } catch (error) {
        await this.reconcileAmbiguousActiveLocked(
          active,
          error,
          {
            status: "interrupted",
            ...(command.reason === undefined
              ? {}
              : { error: command.reason }),
          },
          "interrupt request",
        )
        return {
          interrupted: true as const,
          settled: active.settlement.promise,
        }
      }
      this.publish({
        type: "interrupt_requested",
        sessionId: this.sessionId,
        turnId: active.turn.turnId,
        runId: active.turn.runId,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      })
      active.abortController.abort(
        new Error(command.reason ?? "Turn interrupted"),
      )
      return {
        interrupted: true as const,
        settled: active.settlement.promise,
      }
    })
    if (!request.interrupted) return false
    await this.drainOrForce(
      request.settled,
      command.reason ?? "Turn ignored cooperative interrupt",
    )
    return true
  }

  approve(command: ResolveApprovalCommand): Promise<void> {
    return this.enqueue(async () => {
      this.assertAccepting()
      await this.ensureRecoveredLocked()
      assertNonEmpty(command.approvalId, "Approval id")
      const active = this.requireActive(command.expectedTurnId)
      try {
        await this.storage.resolveApproval({
          sessionId: this.sessionId,
          approvalId: command.approvalId,
          expectedTurnId: active.turn.turnId,
          status: command.status,
          fence: this.fence,
        })
      } catch (error) {
        let durableResolution
        try {
          durableResolution = await this.storage.approvalResolution({
            sessionId: this.sessionId,
            approvalId: command.approvalId,
          })
        } catch (reconciliationError) {
          throw new AggregateError(
            [error, reconciliationError],
            `Failed to reconcile approval ${command.approvalId}`,
          )
        }
        if (!durableResolution) throw error
        if (
          durableResolution.expectedTurnId !== active.turn.turnId ||
          durableResolution.status !== command.status
        ) {
          throw new SessionCoordinatorError(
            "turn_conflict",
            `Durable approval ${command.approvalId} conflicts with the requested decision`,
          )
        }
      }
      const delivery = {
        sessionId: this.sessionId,
        expectedTurnId: active.turn.turnId,
        approvalId: command.approvalId,
        status: command.status,
      } as const
      this.publish({
        type: "approval_resolved",
        sessionId: this.sessionId,
        turnId: active.turn.turnId,
        runId: active.turn.runId,
        approvalId: command.approvalId,
        status: command.status,
      })
      this.deliverApproval(delivery)
    })
  }

  snapshot(): Promise<SessionRuntimeSnapshot> {
    return this.enqueue(async () => {
      await this.ensureRecoveredLocked()
      return this.storage.snapshot(this.sessionId)
    })
  }

  recover(): Promise<SessionRuntimeSnapshot> {
    return this.enqueue(async () => {
      this.assertAccepting()
      const recovered = await this.recoverLocked()
      if (!this.active && recovered.pendingQueue.length > 0) {
        await this.startNextLocked()
        return this.storage.snapshot(this.sessionId)
      }
      return recovered
    })
  }

  /**
   * Stop all in-memory activity after the durable ownership fence is lost.
   *
   * This path deliberately performs no storage mutation: only a replacement
   * owner may reconcile the ambiguous durable turn. Late runner completion is
   * ignored because the active handle is detached before abort is signalled.
   */
  abandon(cause: unknown): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    const closedError = new SessionCoordinatorError(
      "closed",
      `Session coordinator ${this.sessionId} lost durable ownership`,
    )
    this.closePromise = this.enqueue(() => {
      if (this.closed) return
      const active = this.active
      this.active = undefined
      if (active) {
        active.abortController.abort(
          cause instanceof Error
            ? cause
            : new Error("Workspace runtime lost session ownership"),
        )
        const result = {
          status: "interrupted" as const,
          error: "Workspace runtime lost session ownership",
        }
        active.settlement.resolve(result)
        this.rememberCompleted(active.turn.turnId, result)
      }
      for (const settlement of this.settlements.values()) {
        settlement.reject(closedError)
      }
      this.settlements.clear()
      this.closed = true
    })
    return this.closePromise
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      const request = await this.enqueue(async () => {
        await this.ensureRecoveredLocked()
        if (!this.active) return undefined
        const active = this.active
        try {
          await this.storage.requestInterrupt({
            sessionId: this.sessionId,
            turnId: active.turn.turnId,
            reason: "Workspace runtime shutdown",
            fence: this.fence,
          })
        } catch (error) {
          await this.reconcileAmbiguousActiveLocked(
            active,
            error,
            {
              status: "interrupted",
              error: "Workspace runtime shutdown",
            },
            "shutdown interrupt",
          )
          return { settled: active.settlement.promise }
        }
        this.publish({
          type: "interrupt_requested",
          sessionId: this.sessionId,
          turnId: active.turn.turnId,
          runId: active.turn.runId,
          reason: "Workspace runtime shutdown",
        })
        active.abortController.abort(
          new Error("Workspace runtime shutdown"),
        )
        return { settled: active.settlement.promise }
      })
      if (request) {
        await this.drainOrForce(
          request.settled,
          "Turn ignored workspace shutdown",
        )
      }
      await this.enqueue(async () => {})
      const snapshot = await this.storage.snapshot(this.sessionId)
      const closedError = new SessionCoordinatorError(
        "closed",
        `Session coordinator ${this.sessionId} closed with input durably queued`,
      )
      for (const input of [...snapshot.pendingQueue, ...snapshot.pendingSteers]) {
        this.settlements.get(input.reservedTurnId)?.reject(closedError)
        this.settlements.delete(input.reservedTurnId)
      }
      this.closed = true
    })().catch((error) => {
      this.closing = false
      this.closePromise = undefined
      throw error
    })
    return this.closePromise
  }
}
