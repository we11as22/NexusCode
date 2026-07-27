import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  PromptListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"

export interface McpRequestOptions {
  signal?: AbortSignal
}

export interface McpProtocolClient {
  onclose?: () => void
  onerror?: (error: Error) => void
  connect(transport: Transport, options?: McpRequestOptions): Promise<void>
  close(): Promise<void>
  getServerCapabilities?(): {
    prompts?: { listChanged?: boolean }
    resources?: { listChanged?: boolean; subscribe?: boolean }
    tools?: { listChanged?: boolean }
  } | undefined
  listTools(params?: { cursor?: string }, options?: McpRequestOptions): Promise<{
    tools: Array<{
      name: string
      description?: string
      inputSchema: Record<string, unknown>
      annotations?: {
        readOnlyHint?: boolean
        destructiveHint?: boolean
        idempotentHint?: boolean
        openWorldHint?: boolean
      }
    }>
    nextCursor?: string
  }>
  callTool(params: {
    name: string
    arguments: Record<string, unknown>
  }, resultSchema?: unknown, options?: McpRequestOptions): Promise<{
    content?: unknown[]
    structuredContent?: unknown
    isError?: boolean
  }>
  listResources(params?: { cursor?: string }, options?: McpRequestOptions): Promise<{
    resources?: Array<{
      uri: string
      name: string
      description?: string
      mimeType?: string
    }>
    nextCursor?: string
  }>
  listResourceTemplates(
    params?: { cursor?: string },
    options?: McpRequestOptions,
  ): Promise<{
    resourceTemplates?: Array<{
      uriTemplate: string
      name: string
      description?: string
      mimeType?: string
    }>
    nextCursor?: string
  }>
  readResource(params: { uri: string }, options?: McpRequestOptions): Promise<{
    contents?: Array<{
      uri: string
      mimeType?: string
      text?: string
      blob?: string
    }>
  }>
  listPrompts(params?: { cursor?: string }, options?: McpRequestOptions): Promise<{
    prompts: Array<{
      name: string
      title?: string
      description?: string
      arguments?: Array<{
        name: string
        description?: string
        required?: boolean
      }>
    }>
    nextCursor?: string
  }>
  getPrompt(
    params: {
      name: string
      arguments?: Record<string, string>
    },
    options?: McpRequestOptions,
  ): Promise<{
    description?: string
    messages: Array<{
      role: "user" | "assistant"
      content: unknown
    }>
  }>
  setNotificationHandler(
    schema:
      | typeof ToolListChangedNotificationSchema
      | typeof PromptListChangedNotificationSchema,
    handler: () => void | Promise<void>,
  ): void
}

export type McpDiscoveredTool = Awaited<
  ReturnType<McpProtocolClient["listTools"]>
>["tools"][number]

export type McpCallResult = Awaited<
  ReturnType<McpProtocolClient["callTool"]>
>

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isAuthenticationError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true
  if (!error || typeof error !== "object") return false
  const candidate = error as { name?: unknown; code?: unknown }
  return (
    (
      candidate.name === "StreamableHTTPError" ||
      candidate.name === "SseError"
    ) &&
    candidate.code === 401
  )
}

export async function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  parentSignals?: AbortSignal | readonly AbortSignal[],
  onAbort?: (reason: Error) => void | Promise<void>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectCancellation: ((error: Error) => void) | undefined
  let finished = false
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })

  const abort = (reason: Error) => {
    if (finished || controller.signal.aborted) return
    controller.abort(reason)
    void Promise.resolve(onAbort?.(reason)).catch(() => {})
    rejectCancellation?.(reason)
  }
  const parents = parentSignals
    ? Array.isArray(parentSignals) ? parentSignals : [parentSignals]
    : []
  const parentListeners = new Map<AbortSignal, () => void>()
  for (const parentSignal of parents) {
    const onParentAbort = () => {
      const detail = parentSignal.reason instanceof Error
        ? `: ${parentSignal.reason.message}`
        : ""
      abort(new Error(`${label} cancelled${detail}`))
    }
    parentListeners.set(parentSignal, onParentAbort)
    if (parentSignal.aborted) {
      onParentAbort()
      break
    }
    parentSignal.addEventListener("abort", onParentAbort, { once: true })
  }
  timer = setTimeout(() => {
    abort(new Error(`${label} timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  timer.unref?.()

  try {
    if (controller.signal.aborted) {
      return await cancellation
    }
    return await Promise.race([
      operation(controller.signal),
      cancellation,
    ])
  } finally {
    finished = true
    if (timer) clearTimeout(timer)
    for (const [parentSignal, listener] of parentListeners) {
      parentSignal.removeEventListener("abort", listener)
    }
  }
}

export async function closeProtocolClient(
  client: McpProtocolClient,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
