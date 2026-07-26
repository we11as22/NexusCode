import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  DurableRunEventSink,
  RunEventStore,
  type AgentEvent,
  type ApprovalAction,
  type Mode,
  type PermissionResult,
} from "@nexuscode/core"

export interface StreamEnvelope {
  seq: number
  event: AgentEvent
}

interface ActiveRun {
  id: string
  sessionId: string
  cwd: string
  createdAt: number
  updatedAt: number
  done: boolean
  executionClaimed: boolean
  abortController: AbortController
  store: RunEventStore
  sink?: DurableRunEventSink
  envelopes: StreamEnvelope[]
  listeners: Set<(envelope: StreamEnvelope) => void>
  completionWaiters: Set<() => void>
  pendingApprovals: Map<string, PendingApproval>
}

interface PendingApproval {
  partId: string
  action: ApprovalAction
  claimed: boolean
  promise: Promise<PermissionResult>
  resolve: (result: PermissionResult) => void
}

const activeRuns = new Map<string, ActiveRun>()
const latestRunBySession = new Map<string, string>()
const runCreations = new Map<
  string,
  Promise<{ id: string; abortController: AbortController }>
>()
const sessionRunCreations = new Map<
  string,
  {
    runId: string
    promise: Promise<{ id: string; abortController: AbortController }>
  }
>()

const RUN_BUFFER_LIMIT = 1500
const FINISHED_RUN_TTL_MS = 5 * 60_000

function sessionRunKey(sessionId: string, cwd: string): string {
  return `${canonicalRunCwd(cwd)}\0${sessionId}`
}

function canonicalRunCwd(cwd: string): string {
  const resolved = path.resolve(cwd)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

export class ActiveSessionRunError extends Error {
  override readonly name = "ActiveSessionRunError"

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    readonly runId: string,
  ) {
    super(`Session already has an active run: ${runId}`)
  }
}

function scheduleCleanup(runId: string): void {
  setTimeout(() => {
    const existing = activeRuns.get(runId)
    if (!existing || !existing.done) return
    activeRuns.delete(runId)
    const key = sessionRunKey(existing.sessionId, existing.cwd)
    if (latestRunBySession.get(key) === runId) {
      latestRunBySession.delete(key)
    }
  }, FINISHED_RUN_TTL_MS).unref?.()
}

export async function createActiveRun(
  sessionId: string,
  cwd: string,
  mode: Mode,
  options: { homeDir?: string; runId?: string } = {},
): Promise<{ id: string; abortController: AbortController }> {
  const canonicalCwd = canonicalRunCwd(cwd)
  const id = options.runId ??
    `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
  const existing = activeRuns.get(id)
  if (existing) {
    if (existing.sessionId !== sessionId || existing.cwd !== canonicalCwd) {
      throw new Error(`Run id already belongs to another session: ${id}`)
    }
    return { id, abortController: existing.abortController }
  }
  const pending = runCreations.get(id)
  if (pending) return pending
  const key = sessionRunKey(sessionId, canonicalCwd)
  const pendingSession = sessionRunCreations.get(key)
  if (pendingSession) {
    if (pendingSession.runId === id) return pendingSession.promise
    throw new ActiveSessionRunError(sessionId, canonicalCwd, pendingSession.runId)
  }
  const latestRunId = latestRunBySession.get(key)
  const latestRun = latestRunId ? activeRuns.get(latestRunId) : undefined
  if (latestRun && !latestRun.done && latestRun.id !== id) {
    throw new ActiveSessionRunError(sessionId, canonicalCwd, latestRun.id)
  }
  const creation = createActiveRunInternal(id, sessionId, canonicalCwd, mode, options)
  runCreations.set(id, creation)
  sessionRunCreations.set(key, { runId: id, promise: creation })
  try {
    return await creation
  } finally {
    if (runCreations.get(id) === creation) runCreations.delete(id)
    if (sessionRunCreations.get(key)?.promise === creation) {
      sessionRunCreations.delete(key)
    }
  }
}

async function createActiveRunInternal(
  id: string,
  sessionId: string,
  cwd: string,
  mode: Mode,
  options: { homeDir?: string },
): Promise<{ id: string; abortController: AbortController }> {
  const now = Date.now()
  const store = new RunEventStore(cwd, options)
  await store.createRun({ id, sessionId, mode })
  let run!: ActiveRun
  const sink = await DurableRunEventSink.create({
    cwd,
    sessionId,
    mode,
    deliver: (event) => {
      const record = activeRuns.get(id) ?? run
      const seq = (record.envelopes.at(-1)?.seq ?? 0) + 1
      const envelope: StreamEnvelope = { seq, event }
      record.envelopes.push(envelope)
      if (record.envelopes.length > RUN_BUFFER_LIMIT) {
        record.envelopes.splice(0, record.envelopes.length - RUN_BUFFER_LIMIT)
      }
      record.updatedAt = Date.now()
      for (const listener of record.listeners) listener(envelope)
    },
    options: { ...options, runId: id },
  })
  run = {
    id,
    sessionId,
    cwd,
    createdAt: now,
    updatedAt: now,
    done: false,
    executionClaimed: false,
    abortController: new AbortController(),
    store,
    sink,
    envelopes: [],
    listeners: new Set(),
    completionWaiters: new Set(),
    pendingApprovals: new Map(),
  }
  activeRuns.set(id, run)
  latestRunBySession.set(sessionRunKey(sessionId, cwd), id)
  return { id, abortController: run.abortController }
}

export async function getOrRestoreRun(
  runId: string,
  cwd: string,
  options: { homeDir?: string } = {},
): Promise<{ id: string; sessionId: string; cwd: string; done: boolean } | null> {
  const canonicalCwd = canonicalRunCwd(cwd)
  const active = getActiveRun(runId)
  if (active) return active.cwd === canonicalCwd ? active : null
  const store = new RunEventStore(canonicalCwd, options)
  const durable = await store.getRun(runId)
  if (!durable || canonicalRunCwd(durable.cwd) !== canonicalCwd) return null
  if (durable.status === "running") {
    await store.finishRun(runId, "interrupted")
  }
  const envelopes = (await store.readEvents(runId)).slice(-RUN_BUFFER_LIMIT).map((envelope) => ({
    seq: envelope.seq,
    event: envelope.event,
  }))
  const run: ActiveRun = {
    id: durable.id,
    sessionId: durable.sessionId,
    cwd: durable.cwd,
    createdAt: durable.createdAt,
    updatedAt: Date.now(),
    done: true,
    executionClaimed: true,
    abortController: new AbortController(),
    store,
    envelopes,
    listeners: new Set(),
    completionWaiters: new Set(),
    pendingApprovals: new Map(),
  }
  activeRuns.set(run.id, run)
  latestRunBySession.set(sessionRunKey(run.sessionId, run.cwd), run.id)
  scheduleCleanup(run.id)
  return getActiveRun(run.id)
}

/** Release a completed in-memory buffer; the durable event log remains replayable. */
export function evictFinishedRun(runId: string): boolean {
  const run = activeRuns.get(runId)
  if (!run?.done) return false
  activeRuns.delete(runId)
  const key = sessionRunKey(run.sessionId, run.cwd)
  if (latestRunBySession.get(key) === runId) {
    latestRunBySession.delete(key)
  }
  return true
}

export function getActiveRun(runId: string): { id: string; sessionId: string; cwd: string; done: boolean } | null {
  const run = activeRuns.get(runId)
  if (!run) return null
  return { id: run.id, sessionId: run.sessionId, cwd: run.cwd, done: run.done }
}

/**
 * Grant exactly one request ownership of the agent execution for a run id.
 * Transport retries may all observe the same durable run, but only the winner
 * is allowed to admit the prompt and start side effects.
 */
export function claimRunExecution(runId: string): boolean {
  const run = activeRuns.get(runId)
  if (!run || run.done || run.executionClaimed) return false
  run.executionClaimed = true
  run.updatedAt = Date.now()
  return true
}

export function getLatestRunForSession(
  sessionId: string,
  cwd: string,
): { id: string; sessionId: string; cwd: string; done: boolean } | null {
  const runId = latestRunBySession.get(sessionRunKey(sessionId, cwd))
  return runId ? getActiveRun(runId) : null
}

export function appendRunEvent(runId: string, event: AgentEvent, idempotencyKey?: string): void {
  const run = activeRuns.get(runId)
  if (!run) return
  if (event.type === "tool_approval_needed" && !run.pendingApprovals.has(event.partId)) {
    let resolve!: (result: PermissionResult) => void
    const promise = new Promise<PermissionResult>((done) => {
      resolve = done
    })
    run.pendingApprovals.set(event.partId, {
      partId: event.partId,
      action: event.action,
      claimed: false,
      promise,
      resolve,
    })
  }
  run.sink?.emit(event, idempotencyKey)
}

function actionMatches(left: ApprovalAction, right: ApprovalAction): boolean {
  return (
    left.type === right.type &&
    left.tool === right.tool &&
    left.description === right.description
  )
}

export async function waitForRunApproval(
  runId: string,
  action: ApprovalAction,
  signal?: AbortSignal,
): Promise<PermissionResult> {
  const run = activeRuns.get(runId)
  const pending = run
    ? [...run.pendingApprovals.values()].find(
        (candidate) => !candidate.claimed && actionMatches(candidate.action, action),
      )
    : undefined
  if (!pending) return { approved: false }
  pending.claimed = true
  if (signal?.aborted) {
    run?.pendingApprovals.delete(pending.partId)
    pending.resolve({ approved: false })
    return { approved: false }
  }
  let abortListener: (() => void) | undefined
  const aborted = new Promise<PermissionResult>((resolve) => {
    abortListener = () => resolve({ approved: false })
    signal?.addEventListener("abort", abortListener, { once: true })
  })
  try {
    const result = await Promise.race([pending.promise, aborted])
    run?.pendingApprovals.delete(pending.partId)
    return result
  } finally {
    if (abortListener) signal?.removeEventListener("abort", abortListener)
  }
}

export function resolveRunApproval(
  runId: string,
  partId: string,
  result: PermissionResult,
): boolean {
  const run = activeRuns.get(runId)
  const pending = run?.pendingApprovals.get(partId)
  if (!run || !pending) return false
  run.pendingApprovals.delete(partId)
  pending.resolve(result)
  return true
}

function rejectPendingApprovals(run: ActiveRun): void {
  for (const pending of run.pendingApprovals.values()) {
    pending.resolve({ approved: false })
  }
  run.pendingApprovals.clear()
}

export async function getBufferedRunEvents(runId: string, afterSeq = 0): Promise<StreamEnvelope[]> {
  const run = activeRuns.get(runId)
  if (!run) return []
  const firstBufferedSeq = run.envelopes[0]?.seq
  if (typeof firstBufferedSeq === "number" && afterSeq < firstBufferedSeq - 1) {
    return (await run.store.readEvents(runId, afterSeq)).map((envelope) => ({
      seq: envelope.seq,
      event: envelope.event,
    }))
  }
  return run.envelopes.filter((envelope) => envelope.seq > afterSeq)
}

export async function finishRun(
  runId: string,
  status: "completed" | "failed" | "aborted" = "completed",
): Promise<void> {
  const run = activeRuns.get(runId)
  if (!run) return
  let persistenceFailure: unknown
  try {
    if (run.sink) await run.sink.finish(status)
    else await run.store.finishRun(runId, status)
  } catch (error) {
    persistenceFailure = error
  }
  run.done = true
  rejectPendingApprovals(run)
  run.updatedAt = Date.now()
  for (const waiter of run.completionWaiters) waiter()
  run.completionWaiters.clear()
  scheduleCleanup(runId)
  if (persistenceFailure) throw persistenceFailure
}

/**
 * Atomically bridge durable replay and live delivery. The listener is
 * registered before replay starts, and events arriving during disk I/O are
 * queued and deduplicated by sequence before live delivery begins.
 */
export async function replayAndSubscribeToRun(
  runId: string,
  afterSeq: number,
  onEnvelope: (envelope: StreamEnvelope) => void,
): Promise<{ completion: Promise<void>; unsubscribe: () => void }> {
  const run = activeRuns.get(runId)
  if (!run) {
    return { completion: Promise.resolve(), unsubscribe: () => undefined }
  }
  let cursor = afterSeq
  let replaying = true
  const arrivedDuringReplay: StreamEnvelope[] = []
  const listener = (envelope: StreamEnvelope) => {
    if (envelope.seq <= cursor) return
    if (replaying) {
      arrivedDuringReplay.push(envelope)
      return
    }
    cursor = envelope.seq
    onEnvelope(envelope)
  }
  run.listeners.add(listener)
  let completionWaiter: (() => void) | undefined
  const completion = run.done
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        completionWaiter = resolve
        run.completionWaiters.add(resolve)
      })
  const unsubscribe = () => {
    const current = activeRuns.get(runId)
    current?.listeners.delete(listener)
    if (completionWaiter) current?.completionWaiters.delete(completionWaiter)
  }
  try {
    const replay = await getBufferedRunEvents(runId, afterSeq)
    for (const envelope of replay) {
      if (envelope.seq <= cursor) continue
      cursor = envelope.seq
      onEnvelope(envelope)
    }
    arrivedDuringReplay.sort((a, b) => a.seq - b.seq)
    for (const envelope of arrivedDuringReplay) {
      if (envelope.seq <= cursor) continue
      cursor = envelope.seq
      onEnvelope(envelope)
    }
    replaying = false
    return { completion, unsubscribe }
  } catch (error) {
    unsubscribe()
    throw error
  }
}

export function abortRunBySession(sessionId: string, cwd: string): boolean {
  const runId = latestRunBySession.get(sessionRunKey(sessionId, cwd))
  if (!runId) return false
  const run = activeRuns.get(runId)
  if (!run || run.done) return false
  rejectPendingApprovals(run)
  run.abortController.abort()
  run.updatedAt = Date.now()
  return true
}
