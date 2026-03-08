/**
 * Resolve MCP servers that use bundle id (e.g. "context-mode") to full config
 * so the host can start them with correct paths and env (CLAUDE_PROJECT_DIR).
 */
import * as path from "node:path"
import * as fs from "node:fs"
import type { McpServerConfig } from "../types.js"

export interface ResolveBundledOptions {
  /** Project directory (agent cwd); passed as CLAUDE_PROJECT_DIR to bundled servers */
  cwd: string
  /**
   * NexusCode repo root for resolving relative bundle paths.
   * When null/undefined or path does not exist, bundled entries are skipped.
   */
  nexusRoot: string | null | undefined
}

/** Path to context-mode start script. Override with NEXUS_CONTEXT_MODE_PATH (absolute or relative to nexusRoot). */
const CONTEXT_MODE_START = process.env.NEXUS_CONTEXT_MODE_PATH ?? "context-mode/start.mjs"

/**
 * Resolves any server with bundle === "context-mode" to a full config
 * (command, args, env with CLAUDE_PROJECT_DIR). Skips the entry if nexusRoot
 * is missing or start.mjs is not present.
 */
export function resolveBundledMcpServers(
  servers: McpServerConfig[],
  options: ResolveBundledOptions
): McpServerConfig[] {
  const { cwd, nexusRoot } = options
  if (!nexusRoot || !cwd) {
    return servers.filter((s) => !s.bundle)
  }
  const root = path.resolve(nexusRoot)
  const resolved: McpServerConfig[] = []
  for (const server of servers) {
    if (server.bundle === "context-mode") {
      const startPath = path.isAbsolute(CONTEXT_MODE_START) ? CONTEXT_MODE_START : path.join(root, CONTEXT_MODE_START)
      if (!fs.existsSync(startPath)) {
        continue
      }
      resolved.push({
        name: server.name,
        command: "node",
        args: [startPath],
        env: { ...server.env, CLAUDE_PROJECT_DIR: cwd },
        enabled: server.enabled !== false,
      })
    } else if (server.bundle) {
      resolved.push(server)
    } else {
      resolved.push(server)
    }
  }
  return resolved
}
