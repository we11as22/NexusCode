export type SessionTabPreview = {
  id: string
  ts: number
  title?: string
  messageCount: number
}

function uniqueSessionIds(ids: readonly string[]): string[] {
  return ids.filter(
    (id, index) => id.length > 0 && ids.indexOf(id) === index,
  )
}

export type PersistedSessionTabs = {
  openIds: string[]
  activeId: string
}

export function readPersistedSessionTabs(state: unknown): PersistedSessionTabs {
  if (state == null || typeof state !== "object") {
    return { openIds: [], activeId: "" }
  }
  const candidate = (state as { nexusSessionTabs?: unknown }).nexusSessionTabs
  if (candidate == null || typeof candidate !== "object") {
    return { openIds: [], activeId: "" }
  }
  const raw = candidate as { openIds?: unknown; activeId?: unknown }
  const openIds = Array.isArray(raw.openIds)
    ? uniqueSessionIds(raw.openIds.filter((id): id is string => typeof id === "string"))
    : []
  return {
    openIds,
    activeId: typeof raw.activeId === "string" ? raw.activeId : "",
  }
}

export function persistedSessionTabsState(
  previousState: unknown,
  openIds: readonly string[],
  activeId: string,
): Record<string, unknown> {
  const base =
    previousState != null && typeof previousState === "object"
      ? previousState as Record<string, unknown>
      : {}
  return {
    ...base,
    nexusSessionTabs: {
      openIds: uniqueSessionIds(openIds),
      activeId,
    },
  }
}

export function openSessionTab(
  openIds: readonly string[],
  sessionId: string,
): string[] {
  if (!sessionId || openIds.includes(sessionId)) return [...openIds]
  return [...openIds, sessionId]
}

export function reconcileSessionTabs(
  openIds: readonly string[],
  sessions: readonly SessionTabPreview[],
  activeSessionId: string,
): string[] {
  const available = new Set(sessions.map((session) => session.id))
  const restored = uniqueSessionIds(openIds).filter((id) => available.has(id))
  return openSessionTab(restored, activeSessionId)
}

export function closeSessionTab(
  openIds: readonly string[],
  closingId: string,
  activeSessionId: string,
): { openIds: string[]; nextActiveId: string | null } {
  const uniqueIds = uniqueSessionIds(openIds)
  const closingIndex = uniqueIds.indexOf(closingId)
  const remaining = uniqueIds.filter((id) => id !== closingId)
  if (closingId !== activeSessionId) {
    return { openIds: remaining, nextActiveId: activeSessionId || null }
  }
  if (remaining.length === 0) {
    return { openIds: [], nextActiveId: null }
  }
  const neighbourIndex = Math.min(Math.max(closingIndex - 1, 0), remaining.length - 1)
  return { openIds: remaining, nextActiveId: remaining[neighbourIndex] ?? null }
}

/**
 * Only lightweight metadata for open chats is mounted. Message bodies remain
 * loaded solely for the active session, so a long history does not grow the DOM.
 */
export function visibleSessionTabs(
  sessions: readonly SessionTabPreview[],
  openIds: readonly string[],
  activeSessionId: string,
): SessionTabPreview[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  return reconcileSessionTabs(openIds, sessions, activeSessionId).map(
    (id) =>
      byId.get(id) ?? {
        id,
        ts: 0,
        title: "New chat",
        messageCount: 0,
      },
  )
}
