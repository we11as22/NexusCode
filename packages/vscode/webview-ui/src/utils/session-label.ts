const LOCAL_SESSION_PREFIX = "session_"
const SHORT_LABEL_LENGTH = 8

export function formatSessionLabel(sessionId: string): string {
  if (!sessionId) return "—"

  if (sessionId.startsWith(LOCAL_SESSION_PREFIX)) {
    const suffix = sessionId.split("_").at(-1)
    if (suffix) return suffix.slice(-SHORT_LABEL_LENGTH)
  }

  return sessionId.length <= SHORT_LABEL_LENGTH
    ? sessionId
    : sessionId.slice(-SHORT_LABEL_LENGTH)
}
