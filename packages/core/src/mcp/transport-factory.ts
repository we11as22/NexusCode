/**
 * MCP client transports: stdio, SSE (legacy remote), Streamable HTTP (current spec).
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServerConfig } from "../types.js"

/** Remote URL transport: explicit `transport`, or Roo-style `type`, else SSE (backward compatible). */
export function effectiveUrlTransport(config: McpServerConfig): "http" | "sse" {
  if (config.transport === "http") return "http"
  if (config.transport === "sse") return "sse"
  const t = config.type
  if (t === "streamable-http" || t === "http") return "http"
  if (t === "sse") return "sse"
  return "sse"
}

function mergeHeaders(config: McpServerConfig): Record<string, string> | undefined {
  const h = config.headers
  if (!h || Object.keys(h).length === 0) return undefined
  return { ...h }
}

/**
 * Build MCP transport. `bundle` must already be resolved to `command`/`url` by the host.
 */
export function createMcpTransport(config: McpServerConfig): Transport {
  if (config.bundle && !config.command && !config.url) {
    throw new Error(`MCP server "${config.name}": unresolved bundle — host must set command or url`)
  }

  if (config.command) {
    const baseEnv = getDefaultEnvironment() as Record<string, string>
    const env = { ...baseEnv, ...process.env, ...(config.env ?? {}) } as Record<string, string>
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env,
      cwd: config.cwd,
    })
  }

  if (config.url) {
    const url = new URL(config.url)
    const headers = mergeHeaders(config)
    const kind = effectiveUrlTransport(config)

    if (kind === "http") {
      return new StreamableHTTPClientTransport(
        url,
        headers ? { requestInit: { headers } } : undefined,
      )
    }

    return new SSEClientTransport(
      url,
      headers ? { requestInit: { headers } } : undefined,
    )
  }

  throw new Error(`MCP server "${config.name}" requires command or url`)
}
