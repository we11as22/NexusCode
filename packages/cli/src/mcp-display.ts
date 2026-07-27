import type { McpServerStatus } from "@nexuscode/core"

export type McpDisplayState =
  | "connecting"
  | "connected"
  | "disabled"
  | "failed"
  | "needs_auth"
  | "disconnected"

export interface McpDisplayStatus {
  name: string
  state: McpDisplayState
  error?: string
}

/**
 * The Nexus runtime is the only MCP connection owner. UI consumers receive a
 * value snapshot instead of a protocol client, so rendering can never create
 * a second stdio/HTTP connection.
 */
export function coreMcpDisplayStatuses(
  statuses: Record<string, McpServerStatus>,
): McpDisplayStatus[] {
  return Object.values(statuses)
    .map((status) => ({
      name: status.name,
      state: status.state,
      ...(status.error ? { error: status.error } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}
