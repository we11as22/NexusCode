/**
 * MCP client transports: stdio, SSE (legacy remote), Streamable HTTP (current spec).
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServerConfig } from "../types.js"
import { createMcpAuthorizedFetch } from "./authorized-fetch.js"
import type { McpTransportFactoryOptions } from "./types.js"
import { parseMcpHttpUrl } from "./url.js"

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
export function createMcpTransport(
  config: McpServerConfig,
  options: McpTransportFactoryOptions = {},
): Transport {
  if (config.bundle && !config.command && !config.url) {
    throw new Error(`MCP server "${config.name}": unresolved bundle — host must set command or url`)
  }

  if (config.command) {
    const baseEnv = getDefaultEnvironment() as Record<string, string>
    // Do not forward the entire parent environment: it commonly contains API
    // keys unrelated to this server. The SDK allowlist plus explicit config is
    // the capability boundary.
    const env = { ...baseEnv, ...(config.env ?? {}) }
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env,
      cwd: config.cwd,
    })
  }

  if (config.url) {
    const url = parseMcpHttpUrl(
      config.url,
      `MCP server "${config.name}" remote URL`,
    )
    if (!options.remoteRequestAuthorizer) {
      throw new Error(
        `MCP server "${config.name}": remote transport requires an injected network authorizer`,
      )
    }
    const headers = mergeHeaders(config)
    const kind = effectiveUrlTransport(config)
    const authorizedFetch = createMcpAuthorizedFetch(
      options.remoteRequestAuthorizer,
    )

    if (kind === "http") {
      return new StreamableHTTPClientTransport(url, {
        fetch: authorizedFetch,
        ...(headers ? { requestInit: { headers } } : {}),
      })
    }

    return new SSEClientTransport(url, {
      fetch: authorizedFetch,
      ...(headers ? { requestInit: { headers } } : {}),
    })
  }

  throw new Error(`MCP server "${config.name}" requires command or url`)
}
