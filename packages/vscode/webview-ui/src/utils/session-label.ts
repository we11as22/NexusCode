export interface SessionLabelInput {
  readonly id: string
  readonly title?: string
}

/** Opaque persistence identifiers never belong in conversation-facing UI. */
export function sessionDisplayTitle(session: SessionLabelInput): string {
  return session.title?.trim() || "Untitled session"
}
