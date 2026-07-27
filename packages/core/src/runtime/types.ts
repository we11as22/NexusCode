import type {
  ProtocolEnvelope,
  SessionCommandReceipt,
  SessionCommandV2,
  SessionProtocolSnapshot,
} from "../protocol/v2.js"

export const SESSION_PROTOCOL_SERVICE_PORT_VERSION = 1 as const

export interface WorkspaceOwnedService {
  shutdown?(): void | Promise<void>
  close?(): void | Promise<void>
  dispose?(): void | Promise<void>
}

export interface SessionProtocolService extends WorkspaceOwnedService {
  readonly portVersion: typeof SESSION_PROTOCOL_SERVICE_PORT_VERSION
  /**
   * Dispatch must be backed by a durable idempotency ledger: the command
   * fingerprint, state mutation, and typed receipt commit atomically.
   */
  dispatch(command: SessionCommandV2): Awaitable<SessionCommandReceipt>
  snapshot(sessionId: string): Awaitable<SessionProtocolSnapshot>
  events(input: {
    readonly sessionId: string
    readonly afterSequence: number
    readonly signal?: AbortSignal
  }): AsyncIterable<ProtocolEnvelope>
  /**
   * Atomically tombstone an idle session before the portable JSONL transcript
   * is removed. Implementations reject deletion while accepted work exists.
   */
  deleteSession?(sessionId: string): Awaitable<{ readonly deleted: boolean }>
}

export interface WorkspaceRuntimeServices {
  sessions?: WorkspaceOwnedService
  protocol?: SessionProtocolService
  parallelAgents?: WorkspaceOwnedService
  mcp?: WorkspaceOwnedService
  plugins?: WorkspaceOwnedService
  memory?: WorkspaceOwnedService
  index?: WorkspaceOwnedService
  state?: WorkspaceOwnedService
  [name: string]: unknown
}

export interface WorkspaceRuntime {
  readonly canonicalDirectory: string
  readonly services: Readonly<WorkspaceRuntimeServices>
  readonly closed: boolean
  close(): Promise<void>
}

export interface WorkspaceRuntimeFactory {
  create(canonicalDirectory: string): Promise<WorkspaceRuntime>
}

export interface WorkspaceRuntimeHandle {
  readonly canonicalDirectory: string
  readonly runtime: WorkspaceRuntime
  readonly released: boolean
  release(): Promise<void>
}

export type Awaitable<T> = T | PromiseLike<T>

export type SessionPhase =
  | "idle"
  | "preparing"
  | "streaming"
  | "waiting_approval"
  | "executing_tools"
  | "compacting"
  | "settling"
  | "failed"
  | "interrupted"

export type SessionMode = "agent" | "plan" | "ask" | "debug" | "review"

export interface ModelSelectionSnapshot {
  readonly profileId: string
  readonly selectionEpoch: number
}

export interface TurnExecutionSnapshot {
  readonly mode: SessionMode
  readonly selection?: ModelSelectionSnapshot
}

export type SessionInputPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "mention"; name: string; path: string }
  | { type: "skill"; name: string }

export interface AdmittedSessionInput {
  id: string
  /**
   * Durable turn and run identities allocated atomically during admission.
   * They are intentionally distinct from the idempotent input/command
   * identity and must be reused if this input is retried or requeued.
   */
  reservedTurnId: string
  reservedRunId: string
  sessionId: string
  delivery: "steer" | "queue"
  parts: readonly SessionInputPart[]
  execution: TurnExecutionSnapshot
  admittedSequence: number
  promotedSequence?: number
  expectedTurnId?: string
}

export interface TurnEpochSnapshot {
  readonly configEpoch: number
  readonly contextEpoch: number
}

export interface SessionOwnershipFence {
  readonly ownerId: string
  readonly leaseEpoch: number
}

export interface DurableSessionTurn {
  readonly turnId: string
  readonly runId: string
  readonly input: AdmittedSessionInput
  readonly phase: SessionPhase
  readonly epochs: TurnEpochSnapshot
  readonly execution: TurnExecutionSnapshot
  /**
   * Proof from durable storage that a previously persisted next-turn policy
   * intentionally replaced only the admitted mode at claim time.
   */
  readonly modeOverride?: {
    readonly requestedByTurnId: string
  }
  readonly fence: SessionOwnershipFence
}

export interface PendingSessionApprovalSnapshot {
  readonly approvalId: string
  readonly turnId: string
  readonly toolName: string
  readonly redactedSummary: string
}

export interface SessionRuntimeSnapshot {
  readonly sessionId: string
  readonly phase: SessionPhase
  readonly activeTurn?: DurableSessionTurn
  readonly pendingApprovals: readonly PendingSessionApprovalSnapshot[]
  readonly pendingQueue: readonly AdmittedSessionInput[]
  readonly pendingSteers: readonly AdmittedSessionInput[]
}

export interface AdmitSessionInputCommand {
  readonly inputId: string
  readonly delivery: "steer" | "queue"
  readonly parts: readonly SessionInputPart[]
  readonly execution: TurnExecutionSnapshot
  readonly expectedTurnId?: string
}

export interface StartTurnCommand {
  readonly inputId: string
  readonly parts: readonly SessionInputPart[]
  readonly mode: SessionMode
  readonly selection?: ModelSelectionSnapshot
}

export interface SteerTurnCommand {
  readonly inputId: string
  readonly expectedTurnId: string
  readonly parts: readonly SessionInputPart[]
}

export interface QueueTurnCommand {
  readonly inputId: string
  readonly parts: readonly SessionInputPart[]
  readonly mode: SessionMode
  readonly selection?: ModelSelectionSnapshot
}

export interface InterruptTurnCommand {
  readonly expectedTurnId: string
  readonly reason?: string
}

export interface ResolveApprovalCommand {
  readonly approvalId: string
  readonly expectedTurnId: string
  readonly status: "approved" | "denied"
}

export type TurnRunnerResult =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "interrupted"; readonly error?: string }

export interface FinishTurnCommit {
  /**
   * Steers accepted after the runner's final safe boundary. Storage atomically
   * converts them into queued turns instead of dropping accepted user input.
   */
  readonly requeuedInputs: readonly AdmittedSessionInput[]
}

export interface TurnRunnerContext {
  readonly sessionId: string
  readonly turnId: string
  readonly runId: string
  readonly input: AdmittedSessionInput
  readonly epochs: TurnEpochSnapshot
  readonly execution: TurnExecutionSnapshot
  readonly fence: SessionOwnershipFence
  readonly signal: AbortSignal
  readonly setPhase: (phase: SessionPhase) => Promise<void>
  readonly safeBoundary: () => Promise<readonly AdmittedSessionInput[]>
}

export interface TurnRunner {
  run(context: TurnRunnerContext): Awaitable<TurnRunnerResult>
}

export const SESSION_COORDINATOR_STORAGE_PORT_VERSION = 1 as const

export interface SessionCoordinatorStorage {
  readonly portVersion: typeof SESSION_COORDINATOR_STORAGE_PORT_VERSION
  admitInput(input: {
    readonly inputId: string
    readonly sessionId: string
    readonly fence: SessionOwnershipFence
    readonly delivery: "steer" | "queue"
    readonly expectedTurnId?: string
    readonly parts: readonly SessionInputPart[]
    readonly execution: TurnExecutionSnapshot
  }): Awaitable<AdmittedSessionInput>
  pendingSteers(
    sessionId: string,
    turnId: string,
  ): Awaitable<readonly AdmittedSessionInput[]>
  promoteSteers(
    sessionId: string,
    turnId: string,
    cutoff: number,
    fence: SessionOwnershipFence,
  ): Awaitable<readonly AdmittedSessionInput[]>
  /**
   * Atomically promotes the oldest queued input and persists its turn snapshot.
   * Returning undefined means the queue is empty or another owner has a turn.
   */
  claimNextTurn(input: {
    readonly sessionId: string
    readonly epochs: TurnEpochSnapshot
    readonly fence: SessionOwnershipFence
  }): Awaitable<DurableSessionTurn | undefined>
  setPhase(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly phase: SessionPhase
    readonly fence: SessionOwnershipFence
  }): Awaitable<void>
  requestInterrupt(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly reason?: string
    readonly fence: SessionOwnershipFence
  }): Awaitable<void>
  finishTurn(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly result: TurnRunnerResult
    readonly fence: SessionOwnershipFence
  }): Awaitable<FinishTurnCommit>
  /**
   * Fenced hard-stop used only after bounded cooperative drain expires.
   * Late runner callbacks must be rejected by turn/fence checks.
   */
  forceInterrupt(input: {
    readonly sessionId: string
    readonly turnId: string
    readonly reason: string
    readonly fence: SessionOwnershipFence
  }): Awaitable<FinishTurnCommit>
  resolveApproval(input: {
    readonly sessionId: string
    readonly approvalId: string
    readonly expectedTurnId: string
    readonly status: "approved" | "denied"
    readonly fence: SessionOwnershipFence
  }): Awaitable<void>
  /**
   * Reads the durable decision after a commit-unknown resolveApproval call.
   * Absence means the mutation definitely did not commit and is safe to retry.
   */
  approvalResolution(input: {
    readonly sessionId: string
    readonly approvalId: string
  }): Awaitable<
    | {
        readonly expectedTurnId: string
        readonly status: "approved" | "denied"
      }
    | undefined
  >
  snapshot(sessionId: string): Awaitable<SessionRuntimeSnapshot>
  /**
   * Atomically reconciles ambiguous persisted execution under the current
   * fenced owner. Implementations must never replay uncertain side effects.
   */
  recoverSession(input: {
    readonly sessionId: string
    readonly fence: SessionOwnershipFence
  }): Awaitable<{
    readonly snapshot: SessionRuntimeSnapshot
    readonly interruptedTurn?: {
      readonly turnId: string
      readonly runId: string
      readonly result: Extract<TurnRunnerResult, { status: "interrupted" }>
      readonly requeuedInputs: readonly AdmittedSessionInput[]
    }
  }>
}

export type CoordinatorEvent =
  | {
      readonly type: "input_admitted"
      readonly sessionId: string
      readonly inputId: string
      readonly turnId: string
      readonly runId: string
      readonly delivery: "steer" | "queue"
      readonly expectedTurnId?: string
      readonly admittedSequence: number
      readonly execution: TurnExecutionSnapshot
    }
  | {
      readonly type: "turn_started"
      readonly sessionId: string
      readonly turnId: string
      readonly runId: string
      readonly epochs: TurnEpochSnapshot
      readonly execution: TurnExecutionSnapshot
    }
  | {
      readonly type: "phase_changed"
      readonly sessionId: string
      readonly turnId: string
      readonly runId: string
      readonly phase: SessionPhase
    }
  | {
      readonly type: "steering_promoted"
      readonly sessionId: string
      readonly turnId: string
      readonly runId: string
      readonly inputIds: readonly string[]
    }
  | {
      readonly type: "steering_requeued"
      readonly sessionId: string
      readonly turnId: string
      readonly runId: string
      readonly inputIds: readonly string[]
    }
  | {
      readonly type: "interrupt_requested"
      readonly sessionId: string
      readonly turnId: string
      readonly runId: string
      readonly reason?: string
    }
  | {
      readonly type: "approval_resolved"
      readonly sessionId: string
      readonly turnId: string
      readonly runId: string
      readonly approvalId: string
      readonly status: "approved" | "denied"
    }
  | {
      readonly type: "turn_finished"
      readonly sessionId: string
      readonly turnId: string
      readonly runId: string
      readonly status: TurnRunnerResult["status"]
      readonly error?: string
    }

export interface SessionCoordinatorOptions {
  readonly sessionId: string
  readonly ownership: {
    readonly fence: SessionOwnershipFence
  }
  readonly storage: SessionCoordinatorStorage
  readonly runner: TurnRunner
  readonly epochs: {
    capture(): Awaitable<TurnEpochSnapshot>
  }
  /**
   * Best-effort wake/notification channel only. Storage must persist all
   * replay-relevant state and envelopes in the mutation transaction.
   */
  readonly events?: {
    publish(event: CoordinatorEvent): Awaitable<void>
    /**
     * Notification failures are diagnostic only. Durable state and runner
     * progress must not depend on a connected UI/event subscriber.
     */
    onError?(error: unknown, event: CoordinatorEvent): Awaitable<void>
  }
  readonly approvals?: {
    deliver(command: {
      readonly sessionId: string
      readonly expectedTurnId: string
      readonly approvalId: string
      readonly status: "approved" | "denied"
    }): Awaitable<void>
    onError?(
      error: unknown,
      command: {
        readonly sessionId: string
        readonly expectedTurnId: string
        readonly approvalId: string
        readonly status: "approved" | "denied"
      },
    ): Awaitable<void>
  }
  /** Maximum diagnostic wait for the best-effort approval wake channel. */
  readonly approvalDeliveryTimeoutMs?: number
  /** Maximum cooperative abort drain before a fenced hard-stop. */
  readonly shutdownTimeoutMs?: number
}

export interface TurnHandle {
  readonly turnId: string
  readonly runId: string
  /** True only when this command launched the runner rather than joining a queue. */
  readonly started: boolean
  readonly settled: Promise<TurnRunnerResult>
}
