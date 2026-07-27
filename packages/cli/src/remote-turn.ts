import type {
  AgentEvent,
  Mode,
  NexusServerClient,
  PermissionResult,
  SessionApprovalIdentity,
  SessionProtocolSnapshot,
  SessionTurnIdentity,
  TurnExecutionSnapshot,
  UserInputPartV2,
} from '@nexuscode/core'
import {
  selectActiveTurnResumeCursor,
  SessionProtocolError,
  SessionTurnTerminalError,
} from '@nexuscode/core'

export type CliRemoteTurnClient = Pick<
  NexusServerClient,
  'runSessionTurn' | 'interruptSessionTurn' | 'resolveSessionApproval'
>

export type CliRemoteAttachClient = CliRemoteTurnClient &
  Pick<
    NexusServerClient,
    'attachSessionTurn' | 'getSessionProtocolSnapshot'
  >

interface CliModelSelectionLike {
  modelOverride?: string
  temperatureOverride?: number
  reasoningEffortOverride?: string
  profileOverride?: string
}

interface RemoteApprovalIdentity {
  turnId: string
  runId: string
  approvalId: string
  toolName: string
  redactedSummary: string
}

export interface RunRemoteCliTurnOptions {
  client: CliRemoteTurnClient
  sessionId: string
  input: readonly UserInputPartV2[]
  mode: Mode
  signal: AbortSignal
  deliver: (event: AgentEvent) => unknown
  approvalRef?: { current: ((result: PermissionResult) => void) | null }
  selection?: {
    profileId: string
    selectionEpoch: number
  }
  onTurn?: (identity: SessionTurnIdentity) => void
  onSequence?: (sequence: number) => void | Promise<void>
}

export interface RemoteTurnCursorRecord extends SessionTurnIdentity {
  afterSequence: number
}

export interface RemoteTurnCursorStore {
  load(sessionId: string): Promise<RemoteTurnCursorRecord | undefined>
  save(sessionId: string, record: RemoteTurnCursorRecord): Promise<void>
  clear(sessionId: string): Promise<void>
}

export interface ResumeRemoteCliTurnOptions {
  client: CliRemoteAttachClient
  sessionId: string
  signal: AbortSignal
  deliver: (event: AgentEvent) => unknown
  approvalRef?: { current: ((result: PermissionResult) => void) | null }
  cursorStore: RemoteTurnCursorStore
  onActiveExecution?: (
    execution: TurnExecutionSnapshot,
  ) => void | Promise<void>
}

interface RemoteTurnStreamHooks {
  signal: AbortSignal
  onTurn: (identity: SessionTurnIdentity) => void
  onApproval: (identity: SessionApprovalIdentity) => void
  onSequence?: (sequence: number) => void | Promise<void>
}

type ConsumeRemoteCliTurnOptions = Pick<
  RunRemoteCliTurnOptions,
  'client' | 'sessionId' | 'signal' | 'deliver' | 'approvalRef'
> & {
  onTurn?: (identity: SessionTurnIdentity) => void
  onSequence?: (sequence: number) => void | Promise<void>
}

/**
 * A CLI-side model/profile override has no authority over a server workspace.
 * It may be sent only after the server has issued a profile id and selection
 * epoch; the current CLI does not yet expose that server-owned selection UI.
 */
export function assertRemoteCliSelectionSupported(
  selection: CliModelSelectionLike,
): void {
  const hasSelection =
    Boolean(selection.modelOverride?.trim()) ||
    typeof selection.temperatureOverride === 'number' ||
    Boolean(selection.reasoningEffortOverride?.trim()) ||
    Boolean(selection.profileOverride?.trim())
  if (hasSelection) {
    throw new Error(
      'Remote CLI model selection requires a server-owned profile and selection epoch.',
    )
  }
}

/**
 * Run one protocol-v2 turn while binding cancellation and approvals to the
 * opaque identities admitted by the server. UI part ids are presentation-only.
 */
async function consumeRemoteCliTurn(
  options: ConsumeRemoteCliTurnOptions,
  createStream: (
    hooks: RemoteTurnStreamHooks,
  ) => AsyncGenerator<AgentEvent>,
): Promise<void> {
  let turnIdentity: { turnId: string; runId: string } | undefined
  let approvalIdentity: RemoteApprovalIdentity | undefined
  let approvalResolver: ((result: PermissionResult) => void) | undefined
  let requestedInterruptReason: string | undefined
  let interruptIssued = false
  let interruptPromise: Promise<void> | undefined
  let approvalFailure: unknown
  let turnFailure: unknown
  let hasTurnFailure = false
  let cleanupFailure: unknown
  let hasCleanupFailure = false
  const approvalPromises = new Set<Promise<void>>()

  const issueInterrupt = (): void => {
    if (
      interruptIssued ||
      !turnIdentity ||
      !requestedInterruptReason
    ) {
      return
    }
    interruptIssued = true
    interruptPromise = Promise.resolve()
      .then(() =>
        options.client.interruptSessionTurn(
          options.sessionId,
          turnIdentity!.turnId,
          requestedInterruptReason,
        ),
      )
      .then(() => undefined)
  }

  const requestInterrupt = (reason: string): void => {
    requestedInterruptReason ??= reason
    issueInterrupt()
  }

  const onAbort = (): void => {
    requestInterrupt('client aborted the turn')
  }

  const deliver = async (event: AgentEvent): Promise<void> => {
    try {
      await options.deliver(event)
    } catch (error) {
      requestInterrupt('client event delivery failed')
      throw error
    }
  }

  const resolveApproval = (
    identity: RemoteApprovalIdentity,
    result: PermissionResult,
  ): Promise<void> => {
    const promise = options.client
      .resolveSessionApproval(
        options.sessionId,
        identity.turnId,
        identity.approvalId,
        { approved: result.approved },
      )
      .catch((error: unknown) => {
        approvalFailure = error
        requestInterrupt('approval resolution failed')
      })
      .finally(() => {
        approvalPromises.delete(promise)
        if (approvalIdentity?.approvalId === identity.approvalId) {
          approvalIdentity = undefined
        }
      })
    approvalPromises.add(promise)
    return promise
  }

  options.signal.addEventListener('abort', onAbort, { once: true })
  if (options.signal.aborted) onAbort()

  try {
    for await (const event of createStream({
      signal: options.signal,
      onTurn: (identity) => {
        if (
          turnIdentity &&
          (
            turnIdentity.turnId !== identity.turnId ||
            turnIdentity.runId !== identity.runId
          )
        ) {
          throw new Error('Remote turn identity changed after admission')
        }
        turnIdentity = identity
        options.onTurn?.(identity)
        issueInterrupt()
      },
      onApproval: (identity) => {
        if (
          !turnIdentity ||
          identity.turnId !== turnIdentity.turnId ||
          identity.runId !== turnIdentity.runId
        ) {
          throw new Error('Remote approval does not belong to the active turn')
        }
        if (approvalIdentity) {
          throw new Error(
            'Remote server requested another approval before resolving the active approval',
          )
        }
        approvalIdentity = identity
      },
      onSequence: options.onSequence,
    })) {
      if (event.type !== 'tool_approval_needed') {
        await deliver(event)
        continue
      }

      const identity = approvalIdentity
      if (!identity) {
        requestInterrupt('approval identity was missing')
        throw new Error(
          'Remote approval event is missing its protocol approval identity',
        )
      }

      let claimed = false
      const respond = (result: PermissionResult): void => {
        if (claimed) return
        claimed = true
        if (approvalIdentity?.approvalId === identity.approvalId) {
          approvalIdentity = undefined
        }
        if (
          options.approvalRef &&
          options.approvalRef.current === approvalResolver
        ) {
          options.approvalRef.current = null
        }
        void resolveApproval(identity, result)
      }

      if (options.approvalRef) {
        approvalResolver = respond
        options.approvalRef.current = approvalResolver
        await deliver(event)
      } else {
        await resolveApproval(identity, { approved: false })
        await deliver(event)
      }
    }
  } catch (error) {
    if (
      turnIdentity &&
      !options.signal.aborted &&
      !requestedInterruptReason &&
      !(error instanceof SessionTurnTerminalError)
    ) {
      requestInterrupt('client lost the turn event stream')
    }
    turnFailure = error
    hasTurnFailure = true
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    if (
      options.approvalRef &&
      options.approvalRef.current === approvalResolver
    ) {
      options.approvalRef.current = null
    }
    if (interruptPromise) {
      try {
        await interruptPromise
      } catch (error) {
        cleanupFailure = error
        hasCleanupFailure = true
      }
    }
    if (approvalPromises.size > 0) {
      await Promise.all(approvalPromises)
    }
  }

  if (hasTurnFailure) throw turnFailure
  if (approvalFailure) throw approvalFailure
  if (hasCleanupFailure) throw cleanupFailure
}

export function runRemoteCliTurn(
  options: RunRemoteCliTurnOptions,
): Promise<void> {
  return consumeRemoteCliTurn(options, (hooks) =>
    options.client.runSessionTurn({
      sessionId: options.sessionId,
      input: options.input,
      mode: options.mode,
      ...(options.selection ? { selection: options.selection } : {}),
      ...hooks,
    }),
  )
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

function isAttachRace(error: unknown, code: 'no_active_turn' | 'turn_conflict') {
  return (
    error instanceof SessionProtocolError &&
    error.protocolError.code === code
  )
}

export async function resumeRemoteCliTurn(
  options: ResumeRemoteCliTurnOptions,
): Promise<boolean> {
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

    try {
      await consumeRemoteCliTurn(
        {
          client: options.client,
          sessionId: options.sessionId,
          signal: options.signal,
          deliver: options.deliver,
          approvalRef: options.approvalRef,
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
        },
        (hooks) =>
          options.client.attachSessionTurn({
            sessionId: options.sessionId,
            ...identity,
            afterSequence,
            followAcceptedTurn: true,
            ...hooks,
          }),
      )
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
        error.protocolError.code === 'replay_gap'
      ) {
        await options.cursorStore.clear(options.sessionId)
        throw new Error(
          'Remote turn recovery replay window expired; the stale cursor was cleared so new turns are no longer blocked.',
          { cause: error },
        )
      }
      if (isAttachRace(error, 'no_active_turn')) {
        await options.cursorStore.clear(options.sessionId)
        return false
      }
      if (isAttachRace(error, 'turn_conflict') && attempt === 0) {
        continue
      }
      throw error
    }
  }
  return false
}
