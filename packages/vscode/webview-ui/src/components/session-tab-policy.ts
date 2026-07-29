export type SessionTabPreview = {
  id: string
  ts: number
  title?: string
  messageCount: number
}

/**
 * The compact strip represents the currently open chat, not all history.
 * Full history remains available from the adjacent dropdown and Sessions view.
 */
export function visibleSessionTabs(
  sessions: readonly SessionTabPreview[],
  sessionId: string,
): SessionTabPreview[] {
  const current = sessions.find((session) => session.id === sessionId)
  if (current) return [current]
  return [{
    id: sessionId,
    ts: 0,
    title: "New chat",
    messageCount: 0,
  }]
}
