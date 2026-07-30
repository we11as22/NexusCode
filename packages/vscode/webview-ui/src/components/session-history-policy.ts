export const SESSION_HISTORY_PAGE_SIZE = 30

export interface SessionHistoryItem {
  id: string
  title?: string
}

export interface VisibleSessionHistoryOptions {
  query: string
  visibleCount: number
  activeSessionId?: string
}

export interface VisibleSessionHistoryResult<T extends SessionHistoryItem> {
  sessions: T[]
  hasMore: boolean
  totalMatches: number
}

/**
 * Keep the session-history DOM bounded without making older conversations
 * unreachable. The host still owns the complete metadata list; the webview
 * progressively reveals it and can search the full list client-side.
 */
export function visibleSessionHistory<T extends SessionHistoryItem>(
  sessions: readonly T[],
  options: VisibleSessionHistoryOptions,
): VisibleSessionHistoryResult<T> {
  const query = options.query.trim().toLocaleLowerCase()
  const matches = query
    ? sessions.filter((session) => {
        const title = session.title?.toLocaleLowerCase() ?? ""
        return title.includes(query) || session.id.toLocaleLowerCase().includes(query)
      })
    : [...sessions]

  const requestedCount =
    Number.isFinite(options.visibleCount) && options.visibleCount > 0
      ? Math.floor(options.visibleCount)
      : SESSION_HISTORY_PAGE_SIZE
  const visible = matches.slice(0, requestedCount)

  if (!query && options.activeSessionId) {
    const active = sessions.find((session) => session.id === options.activeSessionId)
    if (active && !visible.some((session) => session.id === active.id)) {
      visible.push(active)
    }
  }

  return {
    sessions: visible,
    hasMore: matches.length > requestedCount,
    totalMatches: matches.length,
  }
}
