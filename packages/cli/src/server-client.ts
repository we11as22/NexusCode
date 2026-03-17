/**
 * Re-export server client from core for CLI. Use @nexuscode/core in new code.
 */
export {
  NexusServerClient,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
} from "@nexuscode/core"
export type { NexusServerClientOptions } from "@nexuscode/core"
