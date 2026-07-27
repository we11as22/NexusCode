import { Hono } from "hono"
import type { Context, MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { stream } from "hono/streaming"
import {
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGES_PER_INPUT,
  MAX_INPUT_PARTS,
  MAX_USER_INPUT_TEXT_CHARS,
  PROTOCOL_VERSION,
  SESSION_PROTOCOL_SERVICE_PORT_VERSION,
  ProtocolEnvelopeSchema,
  RemoteMcpPromptCatalogSchema,
  RemoteMcpPromptResolveRequestSchema,
  RemoteMcpPromptResolveResponseSchema,
  SessionCommandReceiptSchema,
  SessionProtocolError,
  SessionProtocolSnapshotSchema,
  parseSessionCommand,
  type ProtocolError,
  type SessionCommandReceipt,
  type SessionCommandV2,
  type SessionProtocolService,
  type WorkspaceRuntime,
} from "@nexuscode/core"
import type { ServerEnv } from "../security.js"
import {
  getServerMcpPromptCatalog,
  McpPromptCatalogConflictError,
  McpPromptNotFoundError,
  McpPromptRuntimeUnavailableError,
  resolveServerMcpPrompt,
} from "../mcp-prompt-service.js"

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const MAX_UTF8_BYTES_PER_CHARACTER = 4
const MAX_MENTION_PATH_CHARACTERS = 4096
const COMMAND_JSON_OVERHEAD_BYTES = 1 << 20

export const SESSION_EVENT_HEARTBEAT_INTERVAL_MS = 15_000

export const MAX_SESSION_COMMAND_BODY_BYTES =
  MAX_IMAGES_PER_INPUT * MAX_IMAGE_BASE64_CHARS +
  MAX_UTF8_BYTES_PER_CHARACTER * MAX_USER_INPUT_TEXT_CHARS +
  MAX_UTF8_BYTES_PER_CHARACTER *
    MAX_INPUT_PARTS *
    MAX_MENTION_PATH_CHARACTERS +
  COMMAND_JSON_OVERHEAD_BYTES
export const MAX_MCP_PROMPT_RESOLVE_BODY_BYTES = 1024 * 1024

export interface SessionV2RuntimeProvider {
  get(directory: string): Promise<WorkspaceRuntime>
}

export interface SessionV2RouteOptions {
  runtimes: SessionV2RuntimeProvider
  /**
   * Internal test seam. Production callers should use the default, which is
   * deliberately below the client inactivity timeout.
   */
  heartbeatIntervalMs?: number
  /** Internal deterministic seam; production uses the workspace MCP service. */
  mcpPrompts?: {
    catalog: typeof getServerMcpPromptCatalog
    resolve: typeof resolveServerMcpPrompt
  }
}

function protocolResponse(error: ProtocolError) {
  return {
    version: PROTOCOL_VERSION,
    error,
  } as const
}

function statusFor(error: ProtocolError): 400 | 404 | 409 | 413 | 500 | 503 {
  switch (error.code) {
    case "input_too_large":
      return 413
    case "idempotency_conflict":
    case "no_active_turn":
    case "turn_conflict":
    case "approval_conflict":
    case "selection_conflict":
    case "replay_gap":
      return 409
    case "not_found":
      return 404
    case "runtime_unavailable":
      return 503
    case "internal_error":
      return 500
    case "invalid_command":
    case "unsupported_version":
      return 400
  }
}

function invalidCommand(message: string): ProtocolError {
  return {
    code: "invalid_command",
    message,
    retryable: false,
  }
}

function internalError(): ProtocolError {
  return {
    code: "internal_error",
    message: "The Nexus runtime could not complete the request",
    retryable: false,
  }
}

function protocolError(error: unknown): ProtocolError {
  return error instanceof SessionProtocolError
    ? error.protocolError
    : internalError()
}

function receiptMatchesCommand(
  command: SessionCommandV2,
  receipt: SessionCommandReceipt,
): boolean {
  if (
    receipt.commandId !== command.commandId ||
    receipt.sessionId !== command.sessionId
  ) {
    return false
  }
  switch (command.type) {
    case "start_turn":
      return (
        receipt.type === "start_turn" &&
        receipt.inputId === command.inputId
      )
    case "queue_turn":
      return (
        receipt.type === "queue_turn" &&
        receipt.inputId === command.inputId
      )
    case "steer_turn":
      return (
        receipt.type === "steer_turn" &&
        receipt.inputId === command.inputId &&
        receipt.expectedTurnId === command.expectedTurnId
      )
    case "interrupt_turn":
      return (
        receipt.type === "interrupt_turn" &&
        receipt.expectedTurnId === command.expectedTurnId
      )
    case "resolve_approval":
      return (
        receipt.type === "resolve_approval" &&
        receipt.approvalId === command.approvalId &&
        receipt.expectedTurnId === command.expectedTurnId &&
        receipt.status === command.status
      )
  }
}

async function serviceFor(
  context: Context<ServerEnv>,
  runtimes: SessionV2RuntimeProvider,
): Promise<SessionProtocolService> {
  const runtime = await runtimeFor(context, runtimes)
  return protocolFor(runtime)
}

async function runtimeFor(
  context: Context<ServerEnv>,
  runtimes: SessionV2RuntimeProvider,
): Promise<WorkspaceRuntime> {
  let runtime: WorkspaceRuntime
  try {
    runtime = await runtimes.get(context.get("workspaceRoot"))
  } catch (error) {
    if (error instanceof SessionProtocolError) throw error
    throw new SessionProtocolError({
      code: "runtime_unavailable",
      message: "The workspace runtime is unavailable",
      retryable: true,
    })
  }
  return runtime
}

function protocolFor(runtime: WorkspaceRuntime): SessionProtocolService {
  const service = runtime.services.protocol
  if (
    !service ||
    service.portVersion !== SESSION_PROTOCOL_SERVICE_PORT_VERSION
  ) {
    throw new SessionProtocolError({
      code: "runtime_unavailable",
      message: "The workspace runtime does not expose protocol v2",
      retryable: true,
    })
  }
  return service
}

export function createSessionV2Routes(options: SessionV2RouteOptions) {
  const routes = new Hono<ServerEnv>()
  const commandBodyLimit = bodyLimit({
    maxSize: MAX_SESSION_COMMAND_BODY_BYTES,
    onError: (context) => {
      const error: ProtocolError = {
        code: "input_too_large",
        message: "Session command body exceeds the transport limit",
        retryable: false,
        details: {
          kind: "request_body",
          limit: MAX_SESSION_COMMAND_BODY_BYTES,
        },
      }
      return context.json(protocolResponse(error), statusFor(error))
    },
  })
  const promptResolveBodyLimit = bodyLimit({
    maxSize: MAX_MCP_PROMPT_RESOLVE_BODY_BYTES,
    onError: (context) => {
      const error: ProtocolError = {
        code: "input_too_large",
        message: "MCP prompt resolution body exceeds the transport limit",
        retryable: false,
        details: {
          kind: "request_body",
          limit: MAX_MCP_PROMPT_RESOLVE_BODY_BYTES,
        },
      }
      return context.json(protocolResponse(error), statusFor(error))
    },
  })
  const validateSessionId: MiddlewareHandler<ServerEnv> = async (
    context,
    next,
  ) => {
    if (!SESSION_ID_PATTERN.test(context.req.param("id") ?? "")) {
      const error = invalidCommand("Invalid session id")
      return context.json(protocolResponse(error), statusFor(error))
    }
    await next()
  }
  routes.use("/:id", validateSessionId)
  routes.use("/:id/*", validateSessionId)

  routes.post("/:id/command", commandBodyLimit, async (context) => {
    let rawCommand: unknown
    try {
      rawCommand = await context.req.json()
    } catch {
      const error = invalidCommand("Request body must be valid JSON")
      return context.json(protocolResponse(error), statusFor(error))
    }

    const parsed = parseSessionCommand(rawCommand)
    if (!parsed.ok) {
      return context.json(
        protocolResponse(parsed.error),
        statusFor(parsed.error),
      )
    }
    if (parsed.command.sessionId !== context.req.param("id")) {
      const error = invalidCommand(
        "Command sessionId must match the route session",
      )
      return context.json(protocolResponse(error), statusFor(error))
    }

    try {
      const protocol = await serviceFor(context, options.runtimes)
      const receipt = SessionCommandReceiptSchema.parse(
        await protocol.dispatch(parsed.command),
      )
      if (!receiptMatchesCommand(parsed.command, receipt)) {
        throw new Error("Runtime returned a mismatched command receipt")
      }
      return context.json(receipt, 202)
    } catch (error) {
      const mapped = protocolError(error)
      return context.json(protocolResponse(mapped), statusFor(mapped))
    }
  })

  routes.get("/:id/snapshot", async (context) => {
    const sessionId = context.req.param("id")
    try {
      const protocol = await serviceFor(context, options.runtimes)
      const snapshot = SessionProtocolSnapshotSchema.parse(
        await protocol.snapshot(sessionId),
      )
      if (snapshot.sessionId !== sessionId) {
        throw new Error("Runtime returned a snapshot for another session")
      }
      return context.json(snapshot)
    } catch (error) {
      const mapped = protocolError(error)
      return context.json(protocolResponse(mapped), statusFor(mapped))
    }
  })

  routes.get("/:id/mcp/prompts", async (context) => {
    const sessionId = context.req.param("id")
    try {
      const runtime = await runtimeFor(context, options.runtimes)
      const protocol = protocolFor(runtime)
      const snapshot = SessionProtocolSnapshotSchema.parse(
        await protocol.snapshot(sessionId),
      )
      if (snapshot.sessionId !== sessionId) {
        throw new Error("Runtime returned a snapshot for another session")
      }
      const catalog = RemoteMcpPromptCatalogSchema.parse(
        await (options.mcpPrompts?.catalog ?? getServerMcpPromptCatalog)(
          runtime,
          context.get("workspaceRoot"),
        ),
      )
      return context.json(catalog)
    } catch (error) {
      if (error instanceof McpPromptRuntimeUnavailableError) {
        const unavailable: ProtocolError = {
          code: "runtime_unavailable",
          message: error.message,
          retryable: true,
        }
        return context.json(
          protocolResponse(unavailable),
          statusFor(unavailable),
        )
      }
      const mapped = protocolError(error)
      return context.json(protocolResponse(mapped), statusFor(mapped))
    }
  })

  routes.post(
    "/:id/mcp/prompts/resolve",
    promptResolveBodyLimit,
    async (context) => {
      let raw: unknown
      try {
        raw = await context.req.json()
      } catch {
        const error = invalidCommand("Request body must be valid JSON")
        return context.json(protocolResponse(error), statusFor(error))
      }
      const parsed = RemoteMcpPromptResolveRequestSchema.safeParse(raw)
      if (!parsed.success) {
        const error = invalidCommand("Invalid MCP prompt resolution request")
        return context.json(protocolResponse(error), statusFor(error))
      }

      const sessionId = context.req.param("id")
      try {
        const runtime = await runtimeFor(context, options.runtimes)
        const protocol = protocolFor(runtime)
        const snapshot = SessionProtocolSnapshotSchema.parse(
          await protocol.snapshot(sessionId),
        )
        if (snapshot.sessionId !== sessionId) {
          throw new Error("Runtime returned a snapshot for another session")
        }
        const response = RemoteMcpPromptResolveResponseSchema.parse(
          await (options.mcpPrompts?.resolve ?? resolveServerMcpPrompt)(
            runtime,
            context.get("workspaceRoot"),
            parsed.data,
            context.req.raw.signal,
          ),
        )
        return context.json(response)
      } catch (error) {
        if (error instanceof McpPromptCatalogConflictError) {
          const conflict: ProtocolError = {
            code: "selection_conflict",
            message: error.message,
            retryable: true,
            details: { currentRevision: error.currentRevision },
          }
          return context.json(protocolResponse(conflict), statusFor(conflict))
        }
        if (error instanceof McpPromptNotFoundError) {
          const notFound: ProtocolError = {
            code: "not_found",
            message: error.message,
            retryable: false,
          }
          return context.json(protocolResponse(notFound), statusFor(notFound))
        }
        if (error instanceof McpPromptRuntimeUnavailableError) {
          const unavailable: ProtocolError = {
            code: "runtime_unavailable",
            message: error.message,
            retryable: true,
          }
          return context.json(
            protocolResponse(unavailable),
            statusFor(unavailable),
          )
        }
        const mapped = protocolError(error)
        return context.json(protocolResponse(mapped), statusFor(mapped))
      }
    },
  )

  routes.get("/:id/events", async (context) => {
    const rawAfterSequence = context.req.query("afterSequence") ?? "0"
    if (!/^(?:0|[1-9][0-9]*)$/.test(rawAfterSequence)) {
      const error = invalidCommand(
        "afterSequence must be a non-negative safe integer",
      )
      return context.json(protocolResponse(error), statusFor(error))
    }
    const afterSequence = Number(rawAfterSequence)
    if (!Number.isSafeInteger(afterSequence)) {
      const error = invalidCommand(
        "afterSequence must be a non-negative safe integer",
      )
      return context.json(protocolResponse(error), statusFor(error))
    }

    let protocol: SessionProtocolService
    try {
      protocol = await serviceFor(context, options.runtimes)
    } catch (error) {
      const mapped = protocolError(error)
      return context.json(protocolResponse(mapped), statusFor(mapped))
    }

    const sessionId = context.req.param("id")
    try {
      const replayWindow = SessionProtocolSnapshotSchema.parse(
        await protocol.snapshot(sessionId),
      )
      if (replayWindow.sessionId !== sessionId) {
        throw new Error("Runtime returned a snapshot for another session")
      }
      if (
        afterSequence > replayWindow.throughSequence ||
        afterSequence + 1 < replayWindow.earliestAvailableSequence
      ) {
        const error: ProtocolError = {
          code: "replay_gap",
          message:
            "Replay cursor is outside the durable event window; reset from snapshot",
          retryable: true,
          details: {
            earliestAvailableSequence:
              replayWindow.earliestAvailableSequence,
            throughSequence: replayWindow.throughSequence,
            resetAfterSequence: replayWindow.throughSequence,
          },
        }
        return context.json(protocolResponse(error), statusFor(error))
      }
    } catch (error) {
      const mapped = protocolError(error)
      return context.json(protocolResponse(mapped), statusFor(mapped))
    }

    context.header("Content-Type", "application/x-ndjson")
    context.header("Cache-Control", "no-store")
    context.header("X-Accel-Buffering", "no")
    return stream(context, async (output) => {
      let previousSequence = afterSequence
      let writes = Promise.resolve()
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined
      let writeFailed = false
      const outputAbort = new AbortController()
      const subscriptionSignal = AbortSignal.any([
        context.req.raw.signal,
        outputAbort.signal,
      ])
      output.onAbort(() => {
        writeFailed = true
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        outputAbort.abort(new Error("Nexus event response disconnected"))
      })
      const write = (value: string): Promise<void> => {
        const pending = writes.then(async () => {
          await output.write(value)
        })
        writes = pending.catch(() => undefined)
        return pending
      }
      try {
        heartbeatTimer = setInterval(() => {
          if (writeFailed) return
          void write("\n").catch((error) => {
            writeFailed = true
            if (heartbeatTimer) clearInterval(heartbeatTimer)
            outputAbort.abort(error)
          })
        }, options.heartbeatIntervalMs ?? SESSION_EVENT_HEARTBEAT_INTERVAL_MS)
        for await (const candidate of protocol.events({
          sessionId,
          afterSequence,
          signal: subscriptionSignal,
        })) {
          const envelope = ProtocolEnvelopeSchema.parse(candidate)
          if (
            envelope.sessionId !== sessionId ||
            envelope.sequence !== previousSequence + 1
          ) {
            // Never forward a gap: clients treat the cleanly truncated stream
            // as a reset signal and reconnect through the snapshot endpoint.
            break
          }
          previousSequence = envelope.sequence
          try {
            await write(`${JSON.stringify(envelope)}\n`)
          } catch (error) {
            writeFailed = true
            outputAbort.abort(error)
            break
          }
        }
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        outputAbort.abort(new Error("Nexus event stream closed"))
        await writes
        try {
          await output.close()
        } catch {
          // A disconnected response has already stopped delivery.
        }
      }
    })
  })

  return routes
}
