import type {
  AdmittedSessionInput,
  CoordinatorEvent,
  DurableSessionTurn,
  SessionInputPart,
  SessionPhase,
  TurnEpochSnapshot,
  TurnExecutionSnapshot,
  TurnRunnerResult,
} from "./types.js"

export type CoordinatorErrorCode =
  | "closed"
  | "no_active_turn"
  | "turn_conflict"
  | "execution_conflict"
  | "invalid_phase"

export class SessionCoordinatorError extends Error {
  readonly code: CoordinatorErrorCode

  constructor(code: CoordinatorErrorCode, message: string) {
    super(message)
    this.name = "SessionCoordinatorError"
    this.code = code
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export interface ActiveTurn {
  readonly turn: DurableSessionTurn
  readonly abortController: AbortController
  readonly settlement: Deferred<TurnRunnerResult>
  phase: SessionPhase
}

export interface ApprovalDelivery {
  readonly sessionId: string
  readonly expectedTurnId: string
  readonly approvalId: string
  readonly status: "approved" | "denied"
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
export const DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS = 5_000
export const MAX_COMPLETED_SETTLEMENTS = 512

const SESSION_MODES = new Set(["agent", "plan", "ask", "debug", "review"])

export const RUNNER_PHASES = new Set<SessionPhase>([
  "preparing",
  "streaming",
  "waiting_approval",
  "executing_tools",
  "compacting",
  "settling",
])

export const PHASE_TRANSITIONS: Readonly<
  Record<SessionPhase, ReadonlySet<SessionPhase>>
> = {
  idle: new Set(["preparing"]),
  preparing: new Set([
    "streaming",
    "waiting_approval",
    "executing_tools",
    "compacting",
    "settling",
  ]),
  streaming: new Set([
    "waiting_approval",
    "executing_tools",
    "compacting",
    "settling",
  ]),
  waiting_approval: new Set([
    "streaming",
    "executing_tools",
    "compacting",
    "settling",
  ]),
  executing_tools: new Set([
    "streaming",
    "waiting_approval",
    "compacting",
    "settling",
  ]),
  compacting: new Set(["streaming", "settling"]),
  settling: new Set(),
  failed: new Set(["preparing"]),
  interrupted: new Set(["preparing"]),
}

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  // Queued turns do not necessarily have an in-process waiter.
  void promise.catch(() => undefined)
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  }
}

export function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`)
  }
}

export function cloneParts(
  parts: readonly SessionInputPart[],
): readonly SessionInputPart[] {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Session input must contain at least one part")
  }
  const cloned = parts.map((part): SessionInputPart => {
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw new Error("Text input parts require text")
      }
      return Object.freeze({ type: "text", text: part.text })
    }
    if (part.type === "image") {
      if (
        typeof part.mimeType !== "string" ||
        !part.mimeType.startsWith("image/") ||
        typeof part.data !== "string" ||
        part.data.length === 0
      ) {
        throw new Error("Image input parts require an image MIME type and data")
      }
      return Object.freeze({
        type: "image",
        mimeType: part.mimeType,
        data: part.data,
      })
    }
    if (part.type === "mention") {
      assertNonEmpty(part.name, "Mention name")
      assertNonEmpty(part.path, "Mention path")
      return Object.freeze({
        type: "mention",
        name: part.name,
        path: part.path,
      })
    }
    if (part.type === "skill") {
      assertNonEmpty(part.name, "Skill name")
      return Object.freeze({ type: "skill", name: part.name })
    }
    throw new Error("Unsupported session input part")
  })
  return Object.freeze(cloned)
}

export function freezeEpochs(epochs: TurnEpochSnapshot): TurnEpochSnapshot {
  if (
    !Number.isSafeInteger(epochs.configEpoch) ||
    epochs.configEpoch < 0 ||
    !Number.isSafeInteger(epochs.contextEpoch) ||
    epochs.contextEpoch < 0
  ) {
    throw new Error("Turn epochs must be non-negative safe integers")
  }
  return Object.freeze({
    configEpoch: epochs.configEpoch,
    contextEpoch: epochs.contextEpoch,
  })
}

export function freezeExecution(
  execution: TurnExecutionSnapshot,
): TurnExecutionSnapshot {
  if (!execution || !SESSION_MODES.has(execution.mode)) {
    throw new Error("Turn execution requires a supported mode")
  }
  if (execution.selection === undefined) {
    return Object.freeze({ mode: execution.mode })
  }
  assertNonEmpty(execution.selection.profileId, "Model profile id")
  if (
    !Number.isSafeInteger(execution.selection.selectionEpoch) ||
    execution.selection.selectionEpoch < 0
  ) {
    throw new Error(
      "Model selection epoch must be a non-negative safe integer",
    )
  }
  return Object.freeze({
    mode: execution.mode,
    selection: Object.freeze({
      profileId: execution.selection.profileId,
      selectionEpoch: execution.selection.selectionEpoch,
    }),
  })
}

export function sameExecution(
  left: TurnExecutionSnapshot,
  right: TurnExecutionSnapshot,
): boolean {
  return (
    left.mode === right.mode &&
    left.selection?.profileId === right.selection?.profileId &&
    left.selection?.selectionEpoch === right.selection?.selectionEpoch
  )
}

export function sameParts(
  left: readonly SessionInputPart[],
  right: readonly SessionInputPart[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((part, index) => {
    const candidate = right[index]
    if (!candidate || part.type !== candidate.type) return false
    if (part.type === "text" && candidate.type === "text") {
      return part.text === candidate.text
    }
    if (part.type === "image" && candidate.type === "image") {
      return (
        part.mimeType === candidate.mimeType &&
        part.data === candidate.data
      )
    }
    if (part.type === "mention" && candidate.type === "mention") {
      return part.name === candidate.name && part.path === candidate.path
    }
    return (
      part.type === "skill" &&
      candidate.type === "skill" &&
      part.name === candidate.name
    )
  })
}

export function freezeAdmittedInput(
  input: AdmittedSessionInput,
): AdmittedSessionInput {
  assertNonEmpty(input.id, "Admitted input id")
  assertNonEmpty(input.reservedTurnId, "Reserved turn id")
  assertNonEmpty(input.reservedRunId, "Reserved run id")
  assertNonEmpty(input.sessionId, "Admitted input session id")
  if (input.delivery !== "queue" && input.delivery !== "steer") {
    throw new Error(`Unsupported admitted input delivery ${input.delivery}`)
  }
  if (
    !Number.isSafeInteger(input.admittedSequence) ||
    input.admittedSequence < 1
  ) {
    throw new Error("Admitted sequence must be a positive safe integer")
  }
  if (
    input.promotedSequence !== undefined &&
    (!Number.isSafeInteger(input.promotedSequence) ||
      input.promotedSequence < 1)
  ) {
    throw new Error("Promoted sequence must be a positive safe integer")
  }
  const frozen: AdmittedSessionInput = {
    id: input.id,
    reservedTurnId: input.reservedTurnId,
    reservedRunId: input.reservedRunId,
    sessionId: input.sessionId,
    delivery: input.delivery,
    parts: cloneParts(input.parts),
    execution: freezeExecution(input.execution),
    admittedSequence: input.admittedSequence,
    ...(input.promotedSequence === undefined
      ? {}
      : { promotedSequence: input.promotedSequence }),
    ...(input.expectedTurnId === undefined
      ? {}
      : { expectedTurnId: input.expectedTurnId }),
  }
  return Object.freeze(frozen)
}

export function resultFromError(
  error: unknown,
  interrupted: boolean,
): TurnRunnerResult {
  const message = error instanceof Error ? error.message : String(error)
  return interrupted
    ? { status: "interrupted", ...(message ? { error: message } : {}) }
    : { status: "failed", error: message }
}

export function normalizedResult(
  result: TurnRunnerResult,
  interrupted: boolean,
): TurnRunnerResult {
  if (interrupted) {
    return result.status === "interrupted"
      ? result
      : { status: "interrupted" }
  }
  if (
    result.status === "completed" ||
    result.status === "failed" ||
    result.status === "interrupted"
  ) {
    return result
  }
  return {
    status: "failed",
    error: "Turn runner returned an unsupported terminal status",
  }
}

export function terminalEvent(
  sessionId: string,
  turnId: string,
  runId: string,
  result: TurnRunnerResult,
): CoordinatorEvent {
  return {
    type: "turn_finished",
    sessionId,
    turnId,
    runId,
    status: result.status,
    ...("error" in result && result.error ? { error: result.error } : {}),
  }
}
