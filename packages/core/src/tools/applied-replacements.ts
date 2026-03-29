/** Snippets actually applied by the Edit tool — for compact CLI/webview previews. */
export type AppliedReplacementSnippet = { oldSnippet: string; newSnippet: string }

/** Normalize metadata from Edit.execute() for host events and UIs. */
export function normalizedAppliedReplacementsFromMetadata(
  metadata: unknown,
): AppliedReplacementSnippet[] | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const raw = (metadata as { appliedReplacements?: unknown }).appliedReplacements
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: AppliedReplacementSnippet[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const o = item as { oldSnippet?: unknown; newSnippet?: unknown }
    if (typeof o.oldSnippet !== "string" || typeof o.newSnippet !== "string") continue
    out.push({ oldSnippet: o.oldSnippet, newSnippet: o.newSnippet })
  }
  return out.length > 0 ? out : undefined
}
