import type {
  AgentEvent,
  Mode,
  NexusServerClient,
  PermissionResult,
  SessionProtocolSnapshot,
  SessionTurnIdentity,
  TurnExecutionSnapshot,
  UserInputPartV2,
  PreparedSessionTurnIdentity,
  RemotePreparedTurnRecord,
  RemoteTurnCursorRecord as CoreRemoteTurnCursorRecord,
  RemoteTurnRecoveryStore,
} from "@nexuscode/core"
import {
  selectActiveTurnResumeCursor,
  SessionProtocolError,
  SessionTurnTerminalError,
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

export type VsCodeRemoteCursorRecord = CoreRemoteTurnCursorRecord
export type VsCodeRemoteCursorStore = RemoteTurnRecoveryStore
export type { RemotePreparedTurnRecord }

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
  inputId?: string
  input: readonly UserInputPartV2[]
  mode: Mode
  signal: AbortSignal
  onTurn?: (identity: { turnId: string; runId: string }) => void
  onSequence?: (sequence: number) => void | Promise<void>
  prepared?: PreparedSessionTurnIdentity
  onCommandPrepared?: (
    prepared: PreparedSessionTurnIdentity,
  ) => void | Promise<void>
}

export interface AttachVsCodeRemoteTurnOptions {
  turnId: string
  runId: string
  afterSequence?: number
  followAcceptedTurn?: boolean
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
          ...(options.inputId ? { inputId: options.inputId } : {}),
          input: options.input,
          mode: options.mode,
          ...(this.options.selection
            ? { selection: this.options.selection }
            : {}),
          ...(options.prepared ? { prepared: options.prepared } : {}),
          ...(options.onCommandPrepared
            ? { onCommandPrepared: options.onCommandPrepared }
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
          ...(options.followAcceptedTurn
            ? { followAcceptedTurn: true }
            : {}),
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
      if (
        !sourceCompleted &&
        !signal.aborted &&
        !(sourceFailure instanceof SessionTurnTerminalError)
      ) {
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
  const prepared = await options.cursorStore.loadPrepared(options.sessionId)
  if (prepared) {
    await options.onActiveExecution?.({
      mode: prepared.mode,
      ...(prepared.selection ? { selection: prepared.selection } : {}),
    })
    let liveIdentity: SessionTurnIdentity | undefined
    let acknowledgedSequence = prepared.afterSequence
    let admissionWrite: Promise<void> = Promise.resolve()
    const turn = new VsCodeRemoteTurn({
      client: options.client,
      sessionId: options.sessionId,
      ...(prepared.selection ? { selection: prepared.selection } : {}),
    })
    options.onRemoteTurn?.(turn)
    try {
      for await (const event of turn.run({
        input: prepared.input,
        mode: prepared.mode,
        prepared: {
          commandId: prepared.commandId,
          inputId: prepared.inputId,
          afterSequence: prepared.afterSequence,
        },
        signal: options.signal,
        onTurn: (identity) => {
          liveIdentity = identity
          admissionWrite = options.cursorStore.save(options.sessionId, {
            ...identity,
            afterSequence: acknowledgedSequence,
          })
        },
        onSequence: async (sequence) => {
          await admissionWrite
          if (!liveIdentity) {
            throw new Error(
              "Remote sequence arrived before recovered turn admission",
            )
          }
          acknowledgedSequence = Math.max(acknowledgedSequence, sequence)
          await options.cursorStore.save(options.sessionId, {
            ...liveIdentity,
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
      await admissionWrite
      if (!options.signal.aborted) {
        await options.cursorStore.clear(options.sessionId)
      }
      return true
    } catch (error) {
      await admissionWrite
      if (
        error instanceof SessionTurnTerminalError ||
        (
          !liveIdentity &&
          error instanceof SessionProtocolError &&
          !error.protocolError.retryable
        )
      ) {
        await options.cursorStore.clear(options.sessionId)
      }
      throw error
    } finally {
      options.onRemoteTurn?.(undefined)
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const stored = await options.cursorStore.load(options.sessionId)
    const snapshot = await options.client.getSessionProtocolSnapshot(
      options.sessionId,
      { includePendingTurns: true },
    )
    const activeIdentity = activeTurnIdentity(snapshot)
    const queued = stored
      ? snapshot.pendingTurns?.find(
          (turn) =>
            turn.turnId === stored.turnId &&
            turn.runId === stored.runId,
        )
      : undefined
    const storedMatchesActive =
      stored !== undefined &&
      activeIdentity?.turnId === stored.turnId &&
      activeIdentity.runId === stored.runId
    const recoveringAcceptedTurn =
      stored !== undefined &&
      !storedMatchesActive &&
      queued === undefined
    const identity = stored
      ? storedMatchesActive
        ? activeIdentity
        : queued
          ? { turnId: queued.turnId, runId: queued.runId }
          : { turnId: stored.turnId, runId: stored.runId }
      : activeIdentity
    if (!identity) {
      await options.cursorStore.clear(options.sessionId)
      return false
    }
    const execution = queued?.execution ??
      (storedMatchesActive || stored === undefined
        ? snapshot.activeExecution
        : undefined)
    if (!execution && !recoveringAcceptedTurn) {
      throw new Error(
        "Remote turn snapshot is missing its execution policy",
      )
    }
    if (execution) await options.onActiveExecution?.(execution)

    const afterSequence = queued
      ? snapshot.throughSequence
      : recoveringAcceptedTurn
        ? stored.afterSequence
        : selectActiveTurnResumeCursor(snapshot, stored)

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
        followAcceptedTurn: true,
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
      if (
        error instanceof SessionTurnTerminalError &&
        error.turnId === identity.turnId &&
        error.runId === identity.runId
      ) {
        await options.cursorStore.clear(options.sessionId)
        throw error
      }
      if (
        error instanceof SessionProtocolError &&
        error.protocolError.code === "replay_gap"
      ) {
        await options.cursorStore.clear(options.sessionId)
        throw new Error(
          "Remote turn recovery replay window expired; the stale cursor was cleared so new turns are no longer blocked.",
          { cause: error },
        )
      }
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
