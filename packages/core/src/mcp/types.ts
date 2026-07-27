import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type {
  AuthorizedNetworkRequest,
  McpServerConfig,
} from "../types.js"
import type { McpProtocolClient } from "./protocol-client.js"

export interface McpRemoteAuthorizationRequest {
  /** Canonical HTTP(S) URL for exactly one outbound hop. */
  url: string
  /** Aborted when the SDK request no longer needs this authorization. */
  signal: AbortSignal
}

export type McpRemoteRequestAuthorizer = (
  request: McpRemoteAuthorizationRequest,
) => Promise<AuthorizedNetworkRequest>

export interface McpTransportFactoryOptions {
  remoteRequestAuthorizer?: McpRemoteRequestAuthorizer
}

export interface McpClientOptions {
  startupTimeoutMs?: number
  toolTimeoutMs?: number
  reconnectAttempts?: number
  reconnectBaseDelayMs?: number
  remoteRequestAuthorizer?: McpRemoteRequestAuthorizer
  clientFactory?: () => McpProtocolClient
  transportFactory?: (config: McpServerConfig) => Transport
}

export type McpConnectionState =
  | "connecting"
  | "connected"
  | "disabled"
  | "failed"
  | "needs_auth"
  | "disconnected"

export interface McpServerStatus {
  name: string
  state: McpConnectionState
  toolCount: number
  updatedAt: number
  connectedAt?: number
  error?: string
  transport?: "stdio" | "http" | "sse"
}

export interface McpTool {
  name: string
  originalName: string
  description: string
  inputSchema: Record<string, unknown>
  serverName: string
  readOnly: boolean
}

export interface McpPromptArgument {
  name: string
  description?: string
  required: boolean
}

export interface McpPromptRef {
  serverName: string
  name: string
  title?: string
  description?: string
  arguments: readonly McpPromptArgument[]
}

export type McpPromptContent =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; data: string; mimeType: string }
  | { type: "resource"; uri: string; mimeType?: string; text?: string; blob?: string }
  | { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string }
  | { type: "unsupported"; originalType: string }

export interface McpPromptMessage {
  role: "user" | "assistant"
  content: McpPromptContent
}

export interface McpPromptResult {
  serverName: string
  name: string
  description?: string
  messages: readonly McpPromptMessage[]
}

export interface McpResourceRef {
  serverName: string
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpResourceContent {
  serverName: string
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface McpResourceTemplateRef {
  serverName: string
  uriTemplate: string
  name: string
  description?: string
  mimeType?: string
}
