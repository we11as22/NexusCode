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

const CONTEXT_MODE_DEFAULT_PATHS = [
  "sources/claude-context-mode/start.mjs",
  "context-mode/start.mjs",
] as const

function resolveContextModeStart(nexusRoot: string | null | undefined): string | undefined {
  const configured = process.env["NEXUS_CONTEXT_MODE_PATH"]?.trim()
  if (configured) {
    const candidate = path.isAbsolute(configured)
      ? configured
      : nexusRoot
        ? path.resolve(nexusRoot, configured)
        : undefined
    return candidate && fs.existsSync(candidate) ? candidate : undefined
  }
  if (!nexusRoot) return undefined
  const root = path.resolve(nexusRoot)
  return CONTEXT_MODE_DEFAULT_PATHS
    .map((relativePath) => path.join(root, relativePath))
    .find((candidate) => fs.existsSync(candidate))
}

/**
 * Resolves any server with bundle === "context-mode" to a full config
 * (command, args, env with CLAUDE_PROJECT_DIR). An absolute
 * NEXUS_CONTEXT_MODE_PATH also works in installed CLI/VSIX builds that do not
 * have a Nexus repository root. Missing optional bundles are omitted.
 */
export function resolveBundledMcpServers(
  servers: McpServerConfig[],
  options: ResolveBundledOptions
): McpServerConfig[] {
  const { cwd, nexusRoot } = options
  if (!cwd) return servers.filter((server) => !server.bundle)
  const resolved: McpServerConfig[] = []
  for (const server of servers) {
    if (server.bundle === "context-mode") {
      const startPath = resolveContextModeStart(nexusRoot)
      if (!startPath) continue
      resolved.push({
        name: server.name,
        command: "node",
        args: [startPath],
        env: { ...server.env, CLAUDE_PROJECT_DIR: cwd },
        enabled: server.enabled !== false,
      })
    } else if (server.bundle && nexusRoot) {
      resolved.push(server)
    } else if (!server.bundle) {
      resolved.push(server)
    }
  }
  return resolved
}
