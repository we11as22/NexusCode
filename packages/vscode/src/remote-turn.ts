import type {
  AgentEvent,
  Mode,
  NexusServerClient,
  PermissionResult,
  SessionProtocolSnapshot,
  SessionTurnIdentity,
  TurnExecutionSnapshot,
  UserInputPartV2,
} from "@nexuscode/core"
import {
  selectActiveTurnResumeCursor,
  SessionProtocolError,
} from "@nexuscode/core"

export type VsCodeRemoteTurnClient = Pick<
  NexusServerClient,
  "runSessionTurn" | "interruptSessionTurn" | "resolveSessionApproval"
> &
  Partial<Pick<NexusServerClient, "attachSessionTurn">>

export type VsCodeRemoteAttachClient = VsCodeRemoteTurnClient &
  Pick<
    NexusServerClient,
    "attachSessionTurn" | "getSessionProtocolSnapshot"
  >

export interface VsCodeRemoteCursorRecord extends SessionTurnIdentity {
  afterSequence: number
}

export interface VsCodeRemoteCursorStore {
  load(sessionId: string): Promise<VsCodeRemoteCursorRecord | undefined>
  save(
    sessionId: string,
    record: VsCodeRemoteCursorRecord,
  ): Promise<void>
  clear(sessionId: string): Promise<void>
}

interface RemoteApprovalIdentity {
  turnId: string
  runId: string
  approvalId: string
  toolName: string
  redactedSummary: string
}

export interface VsCodeRemoteTurnOptions {
  client: VsCodeRemoteTurnClient
  sessionId: string
  selection?: {
    profileId: string
    selectionEpoch: number
  }
}

export interface RunVsCodeRemoteTurnOptions {
  input: readonly UserInputPartV2[]
  mode: Mode
  signal: AbortSignal
  onTurn?: (identity: { turnId: string; runId: string }) => void
  onSequence?: (sequence: number) => void | Promise<void>
}

export interface AttachVsCodeRemoteTurnOptions {
  turnId: string
  runId: string
  afterSequence?: number
  signal: AbortSignal
  onSequence?: (sequence: number) => void | Promise<void>
}

export interface ResumeVsCodeRemoteTurnOptions {
  client: VsCodeRemoteAttachClient
  sessionId: string
  signal: AbortSignal
  cursorStore: VsCodeRemoteCursorStore
  deliver: (
    event: AgentEvent,
    turn: VsCodeRemoteTurn,
  ) => void | Promise<void>
  onRemoteTurn?: (turn: VsCodeRemoteTurn | undefined) => void
  onActiveExecution?: (
    execution: TurnExecutionSnapshot,
  ) => void | Promise<void>
}

export function assertRemotePresetSupported(presetName: string): void {
  const normalized = presetName.trim() || "Default"
  if (normalized !== "Default") {
    throw new Error(
      `Agent preset "${normalized}" is not supported by NexusCode Server until server-owned preset revisions are available.`,
    )
  }
}

export function assertRemoteHostSelectionSupported(
  profileName: string | undefined,
): void {
  if (profileName?.trim()) {
    throw new Error(
      "Remote provider profile selection requires a server-owned profile and selection epoch.",
    )
  }
}

/**
 * Owns the identity-sensitive portion of a single remote VS Code turn.
 * The controller may request cancellation before admission; this class waits
 * for the server's opaque turn id and interrupts that exact turn once.
 */
export class VsCodeRemoteTurn {
  private turnIdentity: { turnId: string; runId: string } | undefined
  private approvalIdentity: RemoteApprovalIdentity | undefined
  private approvalPartId: string | undefined
  private requestedInterruptReason: string | undefined
  private interruptIssued = false
  private interruptPromise: Promise<boolean> | undefined
  private running = false
  private finished = false

  constructor(private readonly options: VsCodeRemoteTurnOptions) {}

  bindApprovalPart(partId: string): boolean {
    if (
      !this.running ||
      !this.approvalIdentity ||
      this.approvalPartId ||
      !partId
    ) {
      return false
    }
    this.approvalPartId = partId
    return true
  }

  async resolveApproval(
    partId: string,
    result: PermissionResult,
  ): Promise<boolean> {
    const identity = this.approvalIdentity
    if (
      !this.running ||
      !identity ||
      this.approvalPartId !== partId
    ) {
      return false
    }

    this.approvalIdentity = undefined
    this.approvalPartId = undefined
    try {
      await this.options.client.resolveSessionApproval(
        this.options.sessionId,
        identity.turnId,
        identity.approvalId,
        { approved: result.approved },
      )
    } catch (error) {
      await this.interrupt("approval resolution failed").catch(() => false)
      throw error
    }
    return true
  }

  async interrupt(reason: string): Promise<boolean> {
    if (this.finished || this.interruptIssued) return false
    this.requestedInterruptReason ??= reason.trim() || "client interrupted the turn"
    this.issueInterrupt()
    if (!this.interruptPromise) return false
    return this.interruptPromise
  }

  async *run(
    options: RunVsCodeRemoteTurnOptions,
  ): AsyncGenerator<AgentEvent> {
    yield* this.consume(
      options.signal,
      (hooks) =>
        this.options.client.runSessionTurn({
          sessionId: this.options.sessionId,
          input: options.input,
          mode: options.mode,
          ...(this.options.selection
            ? { selection: this.options.selection }
            : {}),
          ...hooks,
          onSequence: options.onSequence,
        }),
      options.onTurn,
    )
  }

  async *attach(
    options: AttachVsCodeRemoteTurnOptions,
  ): AsyncGenerator<AgentEvent> {
    const attach = this.options.client.attachSessionTurn
    if (!attach) {
      throw new Error("Remote turn attachment is not supported by the client")
    }
    yield* this.consume(
      options.signal,
      (hooks) =>
        attach.call(this.options.client, {
          sessionId: this.options.sessionId,
          turnId: options.turnId,
          runId: options.runId,
          ...(options.afterSequence === undefined
            ? {}
            : { afterSequence: options.afterSequence }),
          ...hooks,
          onSequence: options.onSequence,
        }),
    )
  }

  private async *consume(
    signal: AbortSignal,
    createStream: (hooks: {
      signal: AbortSignal
      onTurn: (identity: { turnId: string; runId: string }) => void
      onApproval: (identity: RemoteApprovalIdentity) => void
    }) => AsyncGenerator<AgentEvent>,
    onTurn?: (identity: { turnId: string; runId: string }) => void,
  ): AsyncGenerator<AgentEvent> {
    if (this.running || this.finished) {
      throw new Error("A remote turn object can run only once")
    }
    this.running = true

    const onAbort = (): void => {
      this.requestedInterruptReason ??= "client aborted the turn"
      this.issueInterrupt()
    }
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()

    let sourceCompleted = false
    let sourceFailure: unknown
    let hasSourceFailure = false
    let interruptFailure: unknown
    let hasInterruptFailure = false
    try {
      for await (const event of createStream({
        signal,
        onTurn: (identity) => {
          if (
            this.turnIdentity &&
            (
              this.turnIdentity.turnId !== identity.turnId ||
              this.turnIdentity.runId !== identity.runId
            )
          ) {
            throw new Error("Remote turn identity changed after admission")
          }
          this.turnIdentity = identity
          onTurn?.(identity)
          this.issueInterrupt()
        },
        onApproval: (identity) => {
          if (
            !this.turnIdentity ||
            identity.turnId !== this.turnIdentity.turnId ||
            identity.runId !== this.turnIdentity.runId
          ) {
            throw new Error(
              "Remote approval does not belong to the active turn",
            )
          }
          if (this.approvalIdentity) {
            throw new Error(
              "Remote server requested another approval before resolving the active approval",
            )
          }
          this.approvalIdentity = identity
          this.approvalPartId = undefined
        },
      })) {
        yield event
      }
      sourceCompleted = true
    } catch (error) {
      sourceFailure = error
      hasSourceFailure = true
    } finally {
      signal.removeEventListener("abort", onAbort)
      if (!sourceCompleted && !signal.aborted) {
        this.requestedInterruptReason ??=
          "client stopped consuming the turn"
        this.issueInterrupt()
      }
      if (this.interruptPromise) {
        try {
          await this.interruptPromise
        } catch (error) {
          interruptFailure = error
          hasInterruptFailure = true
        }
      }
      this.running = false
      this.finished = true
      this.approvalIdentity = undefined
      this.approvalPartId = undefined
      if (hasSourceFailure) throw sourceFailure
      if (hasInterruptFailure) throw interruptFailure
    }
  }

  private issueInterrupt(): void {
    if (
      this.interruptIssued ||
      !this.turnIdentity ||
      !this.requestedInterruptReason
    ) {
      return
    }
    this.interruptIssued = true
    this.interruptPromise = Promise.resolve().then(() =>
      this.options.client.interruptSessionTurn(
        this.options.sessionId,
        this.turnIdentity!.turnId,
        this.requestedInterruptReason,
      ),
    )
  }
}

function activeTurnIdentity(
  snapshot: SessionProtocolSnapshot,
): SessionTurnIdentity | undefined {
  if (!snapshot.activeTurnId || !snapshot.activeRunId) return undefined
  return {
    turnId: snapshot.activeTurnId,
    runId: snapshot.activeRunId,
  }
}

function isAttachRace(
  error: unknown,
  code: "no_active_turn" | "turn_conflict",
): boolean {
  return (
    error instanceof SessionProtocolError &&
    error.protocolError.code === code
  )
}

/**
 * Resume the exact server-owned turn advertised by a fresh snapshot. The
 * persisted cursor is scoped to that opaque turn/run pair; a stale cursor is
 * never carried across turns and this path never dispatches start_turn.
 */
export async function resumeVsCodeRemoteTurn(
  options: ResumeVsCodeRemoteTurnOptions,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const snapshot = await options.client.getSessionProtocolSnapshot(
      options.sessionId,
    )
    const identity = activeTurnIdentity(snapshot)
    if (!identity) {
      await options.cursorStore.clear(options.sessionId)
      return false
    }
    if (!snapshot.activeExecution) {
      throw new Error(
        "Active remote turn snapshot is missing its execution policy",
      )
    }
    await options.onActiveExecution?.(snapshot.activeExecution)

    const stored = await options.cursorStore.load(options.sessionId)
    const afterSequence = selectActiveTurnResumeCursor(snapshot, stored)

    let acknowledgedSequence = afterSequence
    await options.cursorStore.save(options.sessionId, {
      ...identity,
      afterSequence,
    })

    const turn = new VsCodeRemoteTurn({
      client: options.client,
      sessionId: options.sessionId,
    })
    options.onRemoteTurn?.(turn)
    try {
      for await (const event of turn.attach({
        ...identity,
        afterSequence,
        signal: options.signal,
        onSequence: async (sequence) => {
          acknowledgedSequence = Math.max(
            acknowledgedSequence,
            sequence,
          )
          await options.cursorStore.save(options.sessionId, {
            ...identity,
            afterSequence: acknowledgedSequence,
          })
        },
      })) {
        if (
          event.type === "tool_approval_needed" &&
          !turn.bindApprovalPart(event.partId)
        ) {
          throw new Error(
            "Remote approval event is missing its protocol approval identity",
          )
        }
        await options.deliver(event, turn)
      }
      if (!options.signal.aborted) {
        await options.cursorStore.clear(options.sessionId)
      }
      return true
    } catch (error) {
      if (isAttachRace(error, "no_active_turn")) {
        await options.cursorStore.clear(options.sessionId)
        return false
      }
      if (isAttachRace(error, "turn_conflict") && attempt === 0) {
        continue
      }
      throw error
    } finally {
      options.onRemoteTurn?.(undefined)
    }
  }
  return false
}
