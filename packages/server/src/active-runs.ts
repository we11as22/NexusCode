import * as crypto from "node:crypto"
import type { AgentEvent } from "@nexuscode/core"

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
  nextSeq: number
  abortController: AbortController
  envelopes: StreamEnvelope[]
  listeners: Set<(envelope: StreamEnvelope) => void>
  completionWaiters: Set<() => void>
}

const activeRuns = new Map<string, ActiveRun>()
const latestRunBySession = new Map<string, string>()

const RUN_BUFFER_LIMIT = 1500
const FINISHED_RUN_TTL_MS = 5 * 60_000

function scheduleCleanup(runId: string): void {
  setTimeout(() => {
    const existing = activeRuns.get(runId)
    if (!existing || !existing.done) return
    activeRuns.delete(runId)
    if (latestRunBySession.get(existing.sessionId) === runId) {
      latestRunBySession.delete(existing.sessionId)
    }
  }, FINISHED_RUN_TTL_MS).unref?.()
}

export function createActiveRun(sessionId: string, cwd: string): { id: string; abortController: AbortController } {
  const now = Date.now()
  const id = `run_${now}_${crypto.randomBytes(4).toString("hex")}`
  const run: ActiveRun = {
    id,
    sessionId,
    cwd,
    createdAt: now,
    updatedAt: now,
    done: false,
    nextSeq: 1,
    abortController: new AbortController(),
    envelopes: [],
    listeners: new Set(),
    completionWaiters: new Set(),
  }
  activeRuns.set(id, run)
  latestRunBySession.set(sessionId, id)
  return { id, abortController: run.abortController }
}

export function getActiveRun(runId: string): { id: string; sessionId: string; cwd: string; done: boolean } | null {
  const run = activeRuns.get(runId)
  if (!run) return null
  return { id: run.id, sessionId: run.sessionId, cwd: run.cwd, done: run.done }
}

export function getLatestRunForSession(sessionId: string): { id: string; sessionId: string; cwd: string; done: boolean } | null {
  const runId = latestRunBySession.get(sessionId)
  return runId ? getActiveRun(runId) : null
}

export function appendRunEvent(runId: string, event: AgentEvent): StreamEnvelope | null {
  const run = activeRuns.get(runId)
  if (!run) return null
  const envelope: StreamEnvelope = { seq: run.nextSeq++, event }
  run.envelopes.push(envelope)
  if (run.envelopes.length > RUN_BUFFER_LIMIT) {
    run.envelopes.splice(0, run.envelopes.length - RUN_BUFFER_LIMIT)
  }
  run.updatedAt = Date.now()
  for (const listener of run.listeners) listener(envelope)
  return envelope
}

export function getBufferedRunEvents(runId: string, afterSeq = 0): StreamEnvelope[] {
  const run = activeRuns.get(runId)
  if (!run) return []
  return run.envelopes.filter((envelope) => envelope.seq > afterSeq)
}

export function finishRun(runId: string): void {
  const run = activeRuns.get(runId)
  if (!run) return
  run.done = true
  run.updatedAt = Date.now()
  for (const waiter of run.completionWaiters) waiter()
  run.completionWaiters.clear()
  scheduleCleanup(runId)
}

export function subscribeToRun(
  runId: string,
  onEnvelope: (envelope: StreamEnvelope) => void,
): { completion: Promise<void>; unsubscribe: () => void } {
  const run = activeRuns.get(runId)
  if (!run) {
    return { completion: Promise.resolve(), unsubscribe: () => undefined }
  }
  run.listeners.add(onEnvelope)
  const completion = run.done
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        run.completionWaiters.add(resolve)
      })
  const unsubscribe = () => {
    const current = activeRuns.get(runId)
    current?.listeners.delete(onEnvelope)
  }
  return { completion, unsubscribe }
}

export function abortRunBySession(sessionId: string): boolean {
  const runId = latestRunBySession.get(sessionId)
  if (!runId) return false
  const run = activeRuns.get(runId)
  if (!run || run.done) return false
  run.abortController.abort()
  run.updatedAt = Date.now()
  return true
}
