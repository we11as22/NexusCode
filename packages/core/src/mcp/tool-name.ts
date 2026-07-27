import { createHash } from "node:crypto"

export const MAX_MODEL_TOOL_NAME_CHARS = 64
const HASH_CHARS = 12

function safeSegment(value: string): string {
  const normalized = [...value].map((character) =>
    /[A-Za-z0-9_]/u.test(character) ? character : "_"
  ).join("")
  return normalized || "_"
}

/**
 * Preserve existing readable MCP names when already provider-safe. User-
 * controlled or oversized names receive a deterministic hash suffix, keeping
 * raw protocol identity separate and preventing sanitized-name collisions.
 */
export function callableMcpToolName(
  serverName: string,
  toolName: string,
): string {
  const raw = `${serverName}__${toolName}`
  const safe = `${safeSegment(serverName)}__${safeSegment(toolName)}`
  if (safe === raw && safe.length <= MAX_MODEL_TOOL_NAME_CHARS) return safe

  const suffix =
    "_" +
    createHash("sha256")
      .update(serverName)
      .update("\0")
      .update(toolName)
      .digest("hex")
      .slice(0, HASH_CHARS)
  const prefixLength = Math.max(1, MAX_MODEL_TOOL_NAME_CHARS - suffix.length)
  return `${safe.slice(0, prefixLength)}${suffix}`
}
