import {
  SESSION_COORDINATOR_STORAGE_PORT_VERSION,
  type AdmittedSessionInput,
  type DurableSessionTurn,
  type FinishTurnCommit,
  type SessionCoordinatorStorage,
  type SessionOwnershipFence,
  type SessionPhase,
  type SessionRuntimeSnapshot,
  type TurnEpochSnapshot,
  type TurnExecutionSnapshot,
  type TurnRunnerResult,
} from "@nexuscode/core"
import {
  SessionRuntimeRepository,
  type RuntimeAdmittedInput,
  type RuntimeDurableTurn,
  type RuntimeSessionSnapshot,
} from "@nexuscode/state"

export interface SessionStateNotifier {
  notify(sessionId: string): void
}

function admitted(input: RuntimeAdmittedInput): AdmittedSessionInput {
  return input as AdmittedSessionInput
}

function turn(input: RuntimeDurableTurn): DurableSessionTurn {
  return input as DurableSessionTurn
}

function snapshot(input: RuntimeSessionSnapshot): SessionRuntimeSnapshot {
  return input as SessionRuntimeSnapshot
}

export class SqliteSessionCoordinatorStorage
implements SessionCoordinatorStorage {
  readonly portVersion = SESSION_COORDINATOR_STORAGE_PORT_VERSION
  readonly #state: SessionRuntimeRepository
  readonly #notifier: SessionStateNotifier

  constructor(
    state: SessionRuntimeRepository,
    notifier: SessionStateNotifier,
  ) {
    this.#state = state
    this.#notifier = notifier
  }

  admitInput(input: {
    inputId: string
    sessionId: string
    fence: SessionOwnershipFence
    delivery: "steer" | "queue"
    expectedTurnId?: string
    parts: AdmittedSessionInput["parts"]
    execution: TurnExecutionSnapshot
  }): AdmittedSessionInput {
    const result = this.#state.admitInput(input)
    this.#notifier.notify(input.sessionId)
    return admitted(result)
  }

  pendingSteers(
    sessionId: string,
    turnId: string,
  ): readonly AdmittedSessionInput[] {
    return this.#state
      .pendingSteers(sessionId, turnId)
      .map(admitted)
  }

  promoteSteers(
    sessionId: string,
    turnId: string,
    cutoff: number,
    fence: SessionOwnershipFence,
  ): readonly AdmittedSessionInput[] {
    const result = this.#state
      .promoteSteers(sessionId, turnId, cutoff, fence)
      .map(admitted)
    if (result.length > 0) this.#notifier.notify(sessionId)
    return result
  }

  claimNextTurn(input: {
    sessionId: string
    epochs: TurnEpochSnapshot
    fence: SessionOwnershipFence
  }): DurableSessionTurn | undefined {
    const result = this.#state.claimNextTurn(input)
    if (result) this.#notifier.notify(input.sessionId)
    return result ? turn(result) : undefined
  }

  setPhase(input: {
    sessionId: string
    turnId: string
    phase: SessionPhase
    fence: SessionOwnershipFence
  }): void {
    this.#state.setPhase(input)
    this.#notifier.notify(input.sessionId)
  }

  requestInterrupt(input: {
    sessionId: string
    turnId: string
    reason?: string
    fence: SessionOwnershipFence
  }): void {
    this.#state.requestInterrupt(input)
    this.#notifier.notify(input.sessionId)
  }

  finishTurn(input: {
    sessionId: string
    turnId: string
    result: TurnRunnerResult
    fence: SessionOwnershipFence
  }): FinishTurnCommit {
    const result = this.#state.finishTurn(input)
    this.#notifier.notify(input.sessionId)
    return {
      requeuedInputs: result.requeuedInputs.map(admitted),
    }
  }

  forceInterrupt(input: {
    sessionId: string
    turnId: string
    reason: string
    fence: SessionOwnershipFence
  }): FinishTurnCommit {
    const result = this.#state.forceInterrupt(input)
    this.#notifier.notify(input.sessionId)
    return {
      requeuedInputs: result.requeuedInputs.map(admitted),
    }
  }

  resolveApproval(input: {
    sessionId: string
    approvalId: string
    expectedTurnId: string
    status: "approved" | "denied"
    fence: SessionOwnershipFence
  }): void {
    this.#state.resolveApproval(input)
    this.#notifier.notify(input.sessionId)
  }

  approvalResolution(input: {
    sessionId: string
    approvalId: string
  }):
    | {
        expectedTurnId: string
        status: "approved" | "denied"
      }
    | undefined {
    return this.#state.approvalResolution(input)
  }

  snapshot(sessionId: string): SessionRuntimeSnapshot {
    return snapshot(this.#state.snapshot(sessionId))
  }

  recoverSession(input: {
    sessionId: string
    fence: SessionOwnershipFence
  }): {
    snapshot: SessionRuntimeSnapshot
    interruptedTurn?: {
      turnId: string
      runId: string
      result: { status: "interrupted"; error?: string }
      requeuedInputs: readonly AdmittedSessionInput[]
    }
  } {
    const recovered = this.#state.recoverSession(input)
    if (recovered.interruptedTurn) this.#notifier.notify(input.sessionId)
    return {
      snapshot: snapshot(recovered.snapshot),
      ...(recovered.interruptedTurn
        ? {
            interruptedTurn: {
              ...recovered.interruptedTurn,
              requeuedInputs:
                recovered.interruptedTurn.requeuedInputs.map(admitted),
            },
          }
        : {}),
    }
  }
}
