import type { SessionProtocolSnapshot } from "./v2.js"

export interface PersistedTurnCursor {
  turnId: string
  runId: string
  afterSequence: number
}

/**
 * Select the durable event cursor for reattaching an already-running turn.
 * Missing, stale, corrupt, and future cursors replay the active turn from its
 * first available event instead of skipping to the snapshot high-water mark.
 */
export function selectActiveTurnResumeCursor(
  snapshot: SessionProtocolSnapshot,
  stored: PersistedTurnCursor | undefined,
): number {
  if (
    !snapshot.activeTurnId ||
    !snapshot.activeRunId ||
    snapshot.activeTurnFirstSequence === undefined
  ) {
    throw new Error("Cannot select a resume cursor without an active turn")
  }
  const minimumCursor = Math.max(
    0,
    snapshot.earliestAvailableSequence - 1,
    snapshot.activeTurnFirstSequence - 1,
  )
  if (
    stored &&
    stored.turnId === snapshot.activeTurnId &&
    stored.runId === snapshot.activeRunId &&
    Number.isSafeInteger(stored.afterSequence) &&
    stored.afterSequence >= minimumCursor &&
    stored.afterSequence <= snapshot.throughSequence
  ) {
    return stored.afterSequence
  }
  return minimumCursor
}
