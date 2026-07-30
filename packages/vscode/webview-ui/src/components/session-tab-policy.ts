export type SessionTabPreview = {
  id: string
  ts: number
  title?: string
  messageCount: number
}

export const SESSION_DROPDOWN_LIMIT = 8

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

/**
 * The quick switcher is intentionally small. The full searchable history is
 * the progressive session view; mounting every saved session here made a
 * visually clipped dropdown retain an unbounded hidden DOM.
 */
export function visibleSessionDropdown(
  sessions: readonly SessionTabPreview[],
  sessionId: string,
): SessionTabPreview[] {
  const recent = sessions.slice(0, SESSION_DROPDOWN_LIMIT)
  const active = sessions.find((session) => session.id === sessionId)
  if (!active || recent.some((session) => session.id === active.id)) {
    return recent
  }
  return [active, ...recent.slice(0, SESSION_DROPDOWN_LIMIT - 1)]
}
