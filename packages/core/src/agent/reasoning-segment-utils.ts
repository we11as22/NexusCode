import type { MessagePart, ReasoningPart } from "../types.js"

/** Last reasoning segment for this id that is still open (no durationMs = not yet reasoning_end). */
export function findLastOpenReasoningPartIndex(parts: MessagePart[], reasoningId: string | undefined): number {
  const want = reasoningId ?? "reasoning-0"
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!
    if (p.type !== "reasoning") continue
    const rp = p as ReasoningPart
    if ((rp.reasoningId ?? "reasoning-0") !== want) continue
    if (rp.durationMs != null) continue
    return i
  }
  return -1
}
