import { vi } from "vitest"
import {
  SessionCoordinator,
  type AdmittedSessionInput,
  type CoordinatorEvent,
  type DurableSessionTurn,
  type SessionCoordinatorStorage,
  type SessionInputPart,
  type SessionRuntimeSnapshot,
  type TurnEpochSnapshot,
  type TurnExecutionSnapshot,
  type TurnRunner,
  type TurnRunnerContext,
  type TurnRunnerResult,
} from "./session-coordinator.js"

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export const text = (value: string): readonly SessionInputPart[] => [
  { type: "text", text: value },
]

export class FakeStorage implements SessionCoordinatorStorage {
  readonly portVersion = 1 as const
  readonly inputs: AdmittedSessionInput[] = []
  readonly finished: Array<{ turnId: string; result: TurnRunnerResult }> = []
  readonly phases: string[] = []
  readonly approvals: string[] = []
  readonly order: string[] = []
  activeTurn: DurableSessionTurn | undefined
  phase: SessionRuntimeSnapshot["phase"] = "idle"
  interruptGate: ReturnType<typeof deferred<void>> | undefined
  admitGate: ReturnType<typeof deferred<void>> | undefined
  interruptFailure: "before_commit" | "after_commit" | undefined
  approvalFailure: "before_commit" | "after_commit" | undefined
  finishFailure: "before_commit" | "after_commit" | undefined
  settlingPhaseFailure: "before_commit" | "after_commit" | undefined
  claimFailureBeforeCommit = false
  claimFailureAfterCommit = false
  claimExecutionOverride: TurnExecutionSnapshot | undefined
  claimModeOverride: DurableSessionTurn["modeOverride"]
  recoverLeavesActiveTurn = false
  readonly reservedTurnIds = new Map<string, string>()
  readonly reservedRunIds = new Map<string, string>()
  #sequence = 0
  #promotionSequence = 0

  async admitInput(input: {
    inputId: string
    sessionId: string
    delivery: "steer" | "queue"
    expectedTurnId?: string
    parts: readonly SessionInputPart[]
    execution: TurnExecutionSnapshot
  }): Promise<AdmittedSessionInput> {
    this.order.push(`admit:start:${input.inputId}`)
    await this.admitGate?.promise
    const existing = this.inputs.find(
      (candidate) => candidate.id === input.inputId,
    )
    if (existing) return existing
    const reservedTurnId =
      this.reservedTurnIds.get(input.inputId) ?? input.inputId
    const admitted = {
      id: input.inputId,
      reservedTurnId,
      reservedRunId:
        this.reservedRunIds.get(input.inputId) ?? `run-${reservedTurnId}`,
      sessionId: input.sessionId,
      delivery: input.delivery,
      parts: input.parts,
      execution: input.execution,
      admittedSequence: ++this.#sequence,
      ...(input.expectedTurnId === undefined
        ? {}
        : { expectedTurnId: input.expectedTurnId }),
    } as AdmittedSessionInput & { readonly reservedRunId: string }
    this.inputs.push(admitted)
    this.order.push(`admit:commit:${input.inputId}`)
    return admitted
  }

  async pendingSteers(
    sessionId: string,
    turnId: string,
  ): Promise<readonly AdmittedSessionInput[]> {
    return this.inputs.filter(
      (input) =>
        input.sessionId === sessionId &&
        input.delivery === "steer" &&
        input.expectedTurnId === turnId &&
        input.promotedSequence === undefined,
    )
  }

  async promoteSteers(
    sessionId: string,
    turnId: string,
    cutoff: number,
  ): Promise<readonly AdmittedSessionInput[]> {
    const promoted: AdmittedSessionInput[] = []
    for (const input of this.inputs) {
      if (
        input.sessionId === sessionId &&
        input.delivery === "steer" &&
        input.expectedTurnId === turnId &&
        input.promotedSequence === undefined &&
        input.admittedSequence <= cutoff
      ) {
        input.promotedSequence = ++this.#promotionSequence
        promoted.push(input)
      }
    }
    return promoted
  }

  async claimNextTurn(input: {
    sessionId: string
    epochs: TurnEpochSnapshot
    fence: { ownerId: string; leaseEpoch: number }
  }): Promise<DurableSessionTurn | undefined> {
    if (this.activeTurn) return undefined
    if (this.claimFailureBeforeCommit) {
      this.claimFailureBeforeCommit = false
      throw new Error("claim failed before commit")
    }
    const next = this.inputs.find(
      (candidate) =>
        candidate.sessionId === input.sessionId &&
        candidate.delivery === "queue" &&
        candidate.promotedSequence === undefined,
    )
    if (!next) return undefined
    next.promotedSequence = ++this.#promotionSequence
    this.activeTurn = {
      turnId: next.reservedTurnId,
      runId: next.reservedRunId,
      input: next,
      phase: "preparing",
      epochs: input.epochs,
      execution: this.claimExecutionOverride ?? next.execution,
      ...(this.claimModeOverride === undefined
        ? {}
        : { modeOverride: this.claimModeOverride }),
      fence: input.fence,
    }
    this.phase = "preparing"
    this.order.push(`turn:commit:${next.id}`)
    if (this.claimFailureAfterCommit) {
      this.claimFailureAfterCommit = false
      throw new Error("claim reply lost after commit")
    }
    return this.activeTurn
  }

  async setPhase(input: {
    sessionId: string
    turnId: string
    phase: SessionRuntimeSnapshot["phase"]
  }): Promise<void> {
    if (this.activeTurn?.turnId !== input.turnId) {
      throw new Error(`No active turn ${input.turnId}`)
    }
    if (
      input.phase === "settling" &&
      this.settlingPhaseFailure === "before_commit"
    ) {
      this.settlingPhaseFailure = undefined
      throw new Error("phase failed before commit")
    }
    this.activeTurn = { ...this.activeTurn, phase: input.phase }
    this.phase = input.phase
    this.phases.push(input.phase)
    if (
      input.phase === "settling" &&
      this.settlingPhaseFailure === "after_commit"
    ) {
      this.settlingPhaseFailure = undefined
      throw new Error("phase reply lost after commit")
    }
  }

  async requestInterrupt(input: {
    sessionId: string
    turnId: string
    reason?: string
  }): Promise<void> {
    this.order.push(`interrupt:start:${input.turnId}`)
    await this.interruptGate?.promise
    if (this.interruptFailure === "before_commit") {
      this.interruptFailure = undefined
      throw new Error("interrupt failed before commit")
    }
    this.order.push(`interrupt:commit:${input.turnId}`)
    if (this.interruptFailure === "after_commit") {
      this.interruptFailure = undefined
      throw new Error("interrupt reply lost after commit")
    }
  }

  async finishTurn(input: {
    sessionId: string
    turnId: string
    result: TurnRunnerResult
  }): Promise<{ requeuedInputs: readonly AdmittedSessionInput[] }> {
    if (this.finishFailure === "before_commit") {
      this.finishFailure = undefined
      throw new Error("finish failed before commit")
    }
    const requeuedInputs = this.inputs.filter(
      (candidate) =>
        candidate.delivery === "steer" &&
        candidate.expectedTurnId === input.turnId &&
        candidate.promotedSequence === undefined,
    )
    for (const candidate of requeuedInputs) {
      candidate.delivery = "queue"
      delete candidate.expectedTurnId
    }
    this.finished.push({ turnId: input.turnId, result: input.result })
    this.order.push(`finish:commit:${input.turnId}`)
    this.activeTurn = undefined
    this.phase =
      input.result.status === "failed"
        ? "failed"
        : input.result.status === "interrupted"
          ? "interrupted"
          : "idle"
    if (this.finishFailure === "after_commit") {
      this.finishFailure = undefined
      throw new Error("finish reply lost after commit")
    }
    return { requeuedInputs }
  }

  async forceInterrupt(input: {
    sessionId: string
    turnId: string
    reason: string
  }): Promise<{ requeuedInputs: readonly AdmittedSessionInput[] }> {
    return this.finishTurn({
      sessionId: input.sessionId,
      turnId: input.turnId,
      result: { status: "interrupted", error: input.reason },
    })
  }

  async resolveApproval(input: {
    sessionId: string
    approvalId: string
    expectedTurnId: string
    status: "approved" | "denied"
  }): Promise<void> {
    if (this.approvalFailure === "before_commit") {
      this.approvalFailure = undefined
      throw new Error("approval failed before commit")
    }
    this.approvals.push(
      `${input.expectedTurnId}:${input.approvalId}:${input.status}`,
    )
    if (this.approvalFailure === "after_commit") {
      this.approvalFailure = undefined
      throw new Error("approval reply lost after commit")
    }
  }

  async approvalResolution(input: {
    sessionId: string
    approvalId: string
  }): Promise<
    | {
        expectedTurnId: string
        status: "approved" | "denied"
      }
    | undefined
  > {
    const resolution = this.approvals
      .map((value) => {
        const [expectedTurnId, approvalId, status] = value.split(":")
        return {
          expectedTurnId,
          approvalId,
          status,
        }
      })
      .find((candidate) => candidate.approvalId === input.approvalId)
    if (
      !resolution?.expectedTurnId ||
      (resolution.status !== "approved" && resolution.status !== "denied")
    ) {
      return undefined
    }
    return {
      expectedTurnId: resolution.expectedTurnId,
      status: resolution.status,
    }
  }

  async snapshot(sessionId: string): Promise<SessionRuntimeSnapshot> {
    return {
      sessionId,
      phase: this.phase,
      activeTurn: this.activeTurn,
      pendingApprovals: [],
      pendingQueue: this.inputs.filter(
        (input) =>
          input.sessionId === sessionId &&
          input.delivery === "queue" &&
          input.promotedSequence === undefined,
      ),
      pendingSteers: this.inputs.filter(
        (input) =>
          input.sessionId === sessionId &&
          input.delivery === "steer" &&
          input.promotedSequence === undefined,
      ),
    }
  }

  async recoverSession(input: {
    sessionId: string
    fence: { ownerId: string; leaseEpoch: number }
  }): Promise<{
    snapshot: SessionRuntimeSnapshot
    interruptedTurn?: {
      turnId: string
      runId: string
      result: { status: "interrupted"; error?: string }
      requeuedInputs: readonly AdmittedSessionInput[]
    }
  }> {
    if (!this.activeTurn) {
      return { snapshot: await this.snapshot(input.sessionId) }
    }
    if (this.recoverLeavesActiveTurn) {
      return { snapshot: await this.snapshot(input.sessionId) }
    }
    const turnId = this.activeTurn.turnId
    const runId = this.activeTurn.runId
    const result = {
      status: "interrupted" as const,
      error: "Recovered an ambiguous in-progress turn",
    }
    const commit = await this.finishTurn({
      sessionId: input.sessionId,
      turnId,
      result,
    })
    return {
      snapshot: await this.snapshot(input.sessionId),
      interruptedTurn: {
        turnId,
        runId,
        result,
        requeuedInputs: commit.requeuedInputs,
      },
    }
  }
}

export function setup(options: {
  storage?: FakeStorage
  run?: (context: TurnRunnerContext) => Promise<TurnRunnerResult>
  capture?: () => TurnEpochSnapshot | Promise<TurnEpochSnapshot>
  publish?: (event: CoordinatorEvent) => Promise<void>
  deliverApproval?: (
    command: {
      sessionId: string
      expectedTurnId: string
      approvalId: string
      status: "approved" | "denied"
    },
  ) => Promise<void>
  approvalDeliveryTimeoutMs?: number
  shutdownTimeoutMs?: number
} = {}) {
  const storage = options.storage ?? new FakeStorage()
  const contexts: TurnRunnerContext[] = []
  const run = vi.fn(async (context: TurnRunnerContext) => {
    contexts.push(context)
    return options.run?.(context) ?? { status: "completed" as const }
  })
  const publish = vi.fn(
    options.publish ?? (async (_event: CoordinatorEvent) => {}),
  )
  const publishError = vi.fn(async () => {})
  const capture = vi.fn(
    options.capture ??
      (() => ({ configEpoch: 1, contextEpoch: 1 })),
  )
  const deliverApproval = vi.fn(
    options.deliverApproval ?? (async () => {}),
  )
  const approvalDeliveryError = vi.fn(async () => {})
  const runner: TurnRunner = { run }
  const coordinator = new SessionCoordinator({
    sessionId: "session-1",
    ownership: {
      fence: { ownerId: "owner-1", leaseEpoch: 3 },
    },
    storage,
    runner,
    epochs: { capture },
    events: { publish, onError: publishError },
    approvals: {
      deliver: deliverApproval,
      onError: approvalDeliveryError,
    },
    ...(options.approvalDeliveryTimeoutMs === undefined
      ? {}
      : {
          approvalDeliveryTimeoutMs:
            options.approvalDeliveryTimeoutMs,
        }),
    ...(options.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
  })
  return {
    coordinator,
    storage,
    contexts,
    run,
    publish,
    publishError,
    capture,
    deliverApproval,
    approvalDeliveryError,
  }
}
