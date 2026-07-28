export type RuntimeSessionPhase =
  | "idle"
  | "preparing"
  | "streaming"
  | "waiting_approval"
  | "executing_tools"
  | "compacting"
  | "settling"
  | "failed"
  | "interrupted"

export type RuntimeSessionMode =
  | "agent"
  | "plan"
  | "ask"
  | "debug"
  | "review"

export type RuntimeInputPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "mention"; name: string; path: string }
  | { type: "skill"; name: string }

export interface RuntimeExecutionSnapshot {
  readonly mode: RuntimeSessionMode
  readonly selection?: {
    readonly profileId: string
    readonly selectionEpoch: number
  }
}

export interface RuntimeOwnershipFence {
  readonly ownerId: string
  readonly leaseEpoch: number
}

export interface RuntimeEpochSnapshot {
  readonly configEpoch: number
  readonly contextEpoch: number
}

export interface RuntimeAdmittedInput {
  id: string
  reservedTurnId: string
  reservedRunId: string
  sessionId: string
  delivery: "steer" | "queue"
  parts: readonly RuntimeInputPart[]
  execution: RuntimeExecutionSnapshot
  admittedSequence: number
  promotedSequence?: number
  expectedTurnId?: string
}

export interface RuntimeDurableTurn {
  readonly turnId: string
  readonly runId: string
  readonly input: RuntimeAdmittedInput
  readonly phase: Exclude<RuntimeSessionPhase, "idle">
  readonly epochs: RuntimeEpochSnapshot
  readonly execution: RuntimeExecutionSnapshot
  readonly modeOverride?: {
    readonly requestedByTurnId: string
  }
  readonly fence: RuntimeOwnershipFence
}

export type RuntimeTurnResult =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "interrupted"; readonly error?: string }

export interface RuntimePendingApproval {
  readonly approvalId: string
  readonly turnId: string
  readonly toolName: string
  readonly redactedSummary: string
}

export interface RuntimeSessionSnapshot {
  readonly sessionId: string
  readonly phase: RuntimeSessionPhase
  readonly activeTurn?: RuntimeDurableTurn
  readonly pendingApprovals: readonly RuntimePendingApproval[]
  readonly pendingQueue: readonly RuntimeAdmittedInput[]
  readonly pendingSteers: readonly RuntimeAdmittedInput[]
}

interface RuntimeCommandBase {
  readonly version: 2
  readonly commandId: string
  readonly sessionId: string
}

export type RuntimeSessionCommand =
  | (RuntimeCommandBase & {
      readonly type: "start_turn"
      readonly inputId: string
      readonly input: readonly RuntimeInputPart[]
      readonly mode: RuntimeSessionMode
      readonly selection?: RuntimeExecutionSnapshot["selection"]
    })
  | (RuntimeCommandBase & {
      readonly type: "queue_turn"
      readonly inputId: string
      readonly input: readonly RuntimeInputPart[]
      readonly mode: RuntimeSessionMode
      readonly selection?: RuntimeExecutionSnapshot["selection"]
    })
  | (RuntimeCommandBase & {
      readonly type: "steer_turn"
      readonly inputId: string
      readonly expectedTurnId: string
      readonly input: readonly RuntimeInputPart[]
    })
  | (RuntimeCommandBase & {
      readonly type: "interrupt_turn"
      readonly expectedTurnId: string
      readonly reason?: string
    })
  | (RuntimeCommandBase & {
      readonly type: "resolve_approval"
      readonly approvalId: string
      readonly expectedTurnId: string
      readonly status: "approved" | "denied"
    })

interface RuntimeReceiptBase {
  readonly version: 2
  readonly commandId: string
  readonly sessionId: string
  readonly accepted: true
}

export type RuntimeCommandReceipt =
  | (RuntimeReceiptBase & {
      readonly type: "start_turn"
      readonly inputId: string
      readonly turnId: string
      readonly runId: string
      readonly started: boolean
    })
  | (RuntimeReceiptBase & {
      readonly type: "queue_turn"
      readonly inputId: string
      readonly turnId: string
      readonly runId: string
    })
  | (RuntimeReceiptBase & {
      readonly type: "steer_turn"
      readonly inputId: string
      readonly expectedTurnId: string
      readonly reservedTurnId: string
      readonly reservedRunId: string
    })
  | (RuntimeReceiptBase & {
      readonly type: "interrupt_turn"
      readonly expectedTurnId: string
      readonly interrupted: boolean
    })
  | (RuntimeReceiptBase & {
      readonly type: "resolve_approval"
      readonly approvalId: string
      readonly expectedTurnId: string
      readonly status: "approved" | "denied"
    })

export interface RuntimeProtocolEnvelope {
  readonly version: 2
  readonly eventId: string
  readonly runId?: string
  readonly sequence: number
  readonly sessionId: string
  readonly turnId?: string
  readonly parentEventId?: string
  readonly emittedAt: number
  readonly persistence: {
    readonly state: "committed"
    readonly rollout: "pending" | "projected" | "not_applicable"
  }
  readonly payload: Readonly<Record<string, unknown>> & {
    readonly type: string
  }
}

export interface RuntimeReplayWindow {
  readonly earliestAvailableSequence: number
  readonly throughSequence: number
}

export interface RuntimeSessionProtocolSnapshot extends RuntimeReplayWindow {
  readonly runtime: RuntimeSessionSnapshot
  readonly activeTurnFirstSequence?: number
}

export class SessionRuntimeConflictError extends Error {
  readonly code:
    | "idempotency_conflict"
    | "input_conflict"
    | "lease_lost"
    | "no_active_turn"
    | "turn_conflict"
    | "approval_conflict"
    | "invalid_phase"
    | "session_deleted"
    | "session_not_idle"
    | "queue_full"

  constructor(
    code: SessionRuntimeConflictError["code"],
    message: string,
  ) {
    super(message)
    this.name = "SessionRuntimeConflictError"
    this.code = code
  }
}

export interface SessionRuntimeRepositoryOptions {
  now?: () => number
  createId?: (kind: "turn" | "run" | "event") => string
  /**
   * Maximum accepted inputs which have not yet been promoted into a turn.
   * Must stay within the protocol snapshot's 1024-identity bound.
   */
  maxPendingInputs?: number
}
