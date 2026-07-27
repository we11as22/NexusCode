import { createHash, randomUUID } from "node:crypto"
import type {
  AgentEvent,
  Mode,
  PermissionResult,
  SessionMessage,
} from "./types.js"
import { canonicalProjectRoot } from "./session/storage.js"
import {
  MAX_AGENT_EVENT_JSON_CHARS,
  PROTOCOL_VERSION,
  ProtocolEnvelopeSchema,
  ProtocolErrorSchema,
  SessionCommandReceiptSchema,
  SessionProtocolError,
  SessionProtocolSnapshotSchema,
  parseSessionCommand,
  type ProtocolEnvelope,
  type PendingSessionApproval,
  type SessionCommandReceipt,
  type SessionCommandV2,
  type SessionProtocolSnapshot,
  type UserInputPartV2,
} from "./protocol/v2.js"
import {
  RemoteMcpPromptCatalogSchema,
  RemoteMcpPromptResolveRequestSchema,
  RemoteMcpPromptResolveResponseSchema,
  type RemoteMcpPromptCatalog,
  type RemoteMcpPromptResolveRequest,
  type RemoteMcpPromptResolveResponse,
} from "./mcp/prompt-transport.js"

export interface NexusServerClientOptions {
  baseUrl: string
  directory: string
  token: string
}

export const NEXUS_SERVER_TOKEN_SECRET_KEY = "nexuscode_server_token"
const MAX_PROTOCOL_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_PROTOCOL_LINE_CHARACTERS = MAX_AGENT_EVENT_JSON_CHARS + 64 * 1024
const MAX_PROTOCOL_RECONNECTS = 3

export interface SessionTurnIdentity {
  turnId: string
  runId: string
}

export class SessionTurnTerminalError extends Error {
  readonly turnId: string
  readonly runId: string
  readonly sequence: number
  readonly status = "failed" as const

  constructor(options: {
    turnId: string
    runId: string
    sequence: number
    status: "failed"
    message: string
  }) {
    super(options.message)
    this.name = "SessionTurnTerminalError"
    this.turnId = options.turnId
    this.runId = options.runId
    this.sequence = options.sequence
  }
}

export interface SessionApprovalIdentity extends SessionTurnIdentity {
  approvalId: string
  toolName: string
  redactedSummary: string
}

export interface RunSessionTurnOptions {
  sessionId: string
  input: readonly UserInputPartV2[]
  mode: Mode
  selection?: {
    profileId: string
    selectionEpoch: number
  }
  signal?: AbortSignal
  onTurn?: (identity: SessionTurnIdentity) => void
  onApproval?: (identity: SessionApprovalIdentity) => void
  onSequence?: (sequence: number) => void | Promise<void>
}

export interface AttachSessionTurnOptions extends SessionTurnIdentity {
  sessionId: string
  /**
   * Last envelope durably applied by the caller. Omit it to rebuild the
   * complete active turn from its first durable envelope.
   */
  afterSequence?: number
  /**
   * Follow an exact reservation that a prior authoritative snapshot proved
   * was queued. This permits replay when it finishes between snapshots; it
   * never substitutes the session's current active turn.
   */
  followAcceptedTurn?: boolean
  signal?: AbortSignal
  onTurn?: (identity: SessionTurnIdentity) => void
  onApproval?: (identity: SessionApprovalIdentity) => void
  onSequence?: (sequence: number) => void | Promise<void>
}

function protocolIdentifier(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "")}`
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes = MAX_PROTOCOL_RESPONSE_BYTES,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  let total = 0
  let result = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel("Nexus protocol response exceeded its size limit")
        throw new Error(
          `Nexus protocol response exceeds ${maximumBytes} bytes`,
        )
      }
      result += decoder.decode(value, { stream: true })
    }
    result += decoder.decode()
    return result
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The stream may already be errored or cancelled.
    }
  }
}

async function throwProtocolResponseError(response: Response): Promise<never> {
  const text = await readBoundedResponseText(response)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(
      `Nexus protocol request failed with HTTP ${response.status}`,
    )
  }
  const candidate =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "error" in value
      ? (value as { error: unknown }).error
      : value
  const parsed = ProtocolErrorSchema.safeParse(candidate)
  if (parsed.success) throw new SessionProtocolError(parsed.data)
  throw new Error(
    `Nexus protocol request failed with HTTP ${response.status}`,
  )
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "localhost" || normalized === "::1") return true
  const match = normalized.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  return Boolean(
    match &&
      match.slice(1).every((octet) => Number(octet) >= 0 && Number(octet) <= 255),
  )
}

export function isLoopbackNexusServerDestination(input: string): boolean {
  const canonical = canonicalizeNexusServerBaseUrl(input)
  return isLoopbackHostname(new URL(canonical).hostname)
}

export function canonicalizeNexusServerBaseUrl(input: string): string {
  const trimmed = input.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error("NexusCode server URL must be an absolute HTTP(S) URL")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("NexusCode server URL must use HTTP or HTTPS")
  }
  if (parsed.username || parsed.password) {
    throw new Error("NexusCode server URL must not contain credentials")
  }
  if (parsed.search || parsed.hash) {
    throw new Error("NexusCode server URL must not contain a query or fragment")
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      "HTTPS is required for a non-loopback NexusCode server destination",
    )
  }
  const pathname = parsed.pathname.replace(/\/+$/, "")
  return `${parsed.origin}${pathname === "/" ? "" : pathname}`
}

export function getNexusServerTokenSecretKey(baseUrl: string): string {
  const canonical = canonicalizeNexusServerBaseUrl(baseUrl)
  const digest = createHash("sha256").update(canonical).digest("hex")
  return `${NEXUS_SERVER_TOKEN_SECRET_KEY}:${digest}`
}

async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("heartbeat timeout")),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * Client for NexusCode server — list/create sessions, get messages, stream agent events.
 * Shared by extension and CLI when serverUrl is set.
 */
export class NexusServerClient {
  private baseUrl: string
  private directory: string
  private token: string

  constructor(opts: NexusServerClientOptions) {
    this.baseUrl = canonicalizeNexusServerBaseUrl(opts.baseUrl)
    this.directory = canonicalProjectRoot(opts.directory)
    this.token = opts.token.trim()
    if (!this.token) throw new Error("NexusCode server token is required")
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-nexus-directory": this.directory,
      Authorization: `Bearer ${this.token}`,
    }
  }

  private url(path: string, search?: Record<string, string>): string {
    const u = `${this.baseUrl}${path}`
    if (search && Object.keys(search).length > 0) {
      const q = new URLSearchParams(search).toString()
      return `${u}?${q}`
    }
    return u
  }

  private request(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      redirect: "error",
    })
  }

  private sessionPath(sessionId: string): string {
    return `/session/${encodeURIComponent(sessionId)}`
  }

  private sessionV2Path(sessionId: string): string {
    return `/v2/session/${encodeURIComponent(sessionId)}`
  }

  async dispatchSessionCommand(
    command: SessionCommandV2,
  ): Promise<SessionCommandReceipt> {
    const parsed = parseSessionCommand(command)
    if (!parsed.ok) throw new SessionProtocolError(parsed.error)
    const response = await this.request(
      this.url(`${this.sessionV2Path(command.sessionId)}/command`),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(parsed.command),
      },
    )
    if (!response.ok) return throwProtocolResponseError(response)
    const raw = await readBoundedResponseText(response)
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error("Nexus protocol command response is not valid JSON")
    }
    return SessionCommandReceiptSchema.parse(value)
  }

  async getSessionProtocolSnapshot(
    sessionId: string,
    options: { includePendingTurns?: boolean } = {},
  ): Promise<SessionProtocolSnapshot> {
    const response = await this.request(
      this.url(`${this.sessionV2Path(sessionId)}/snapshot`),
      {
        headers: {
          ...this.headers(),
          ...(options.includePendingTurns
            ? { "x-nexus-include-pending-turns": "1" }
            : {}),
        },
      },
    )
    if (!response.ok) return throwProtocolResponseError(response)
    const raw = await readBoundedResponseText(response)
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error("Nexus protocol snapshot response is not valid JSON")
    }
    const snapshot = SessionProtocolSnapshotSchema.parse(value)
    if (snapshot.sessionId !== sessionId) {
      throw new Error("Nexus protocol returned a snapshot for another session")
    }
    return snapshot
  }

  async getMcpPromptCatalog(
    sessionId: string,
  ): Promise<RemoteMcpPromptCatalog> {
    const response = await this.request(
      this.url(`${this.sessionV2Path(sessionId)}/mcp/prompts`),
      { headers: this.headers() },
    )
    if (!response.ok) return throwProtocolResponseError(response)
    const raw = await readBoundedResponseText(response)
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error("Nexus MCP prompt catalog response is not valid JSON")
    }
    return RemoteMcpPromptCatalogSchema.parse(value)
  }

  async resolveMcpPrompt(
    sessionId: string,
    request: RemoteMcpPromptResolveRequest,
    signal?: AbortSignal,
  ): Promise<RemoteMcpPromptResolveResponse> {
    const parsed = RemoteMcpPromptResolveRequestSchema.parse(request)
    const response = await this.request(
      this.url(`${this.sessionV2Path(sessionId)}/mcp/prompts/resolve`),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(parsed),
        ...(signal ? { signal } : {}),
      },
    )
    if (!response.ok) return throwProtocolResponseError(response)
    const raw = await readBoundedResponseText(response)
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error("Nexus MCP prompt resolution response is not valid JSON")
    }
    return RemoteMcpPromptResolveResponseSchema.parse(value)
  }

  async *streamSessionEvents(
    sessionId: string,
    afterSequence: number,
    signal?: AbortSignal,
  ): AsyncGenerator<ProtocolEnvelope> {
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0
    ) {
      throw new RangeError(
        "Nexus protocol cursor must be a non-negative safe integer",
      )
    }
    const response = await this.request(
      this.url(`${this.sessionV2Path(sessionId)}/events`, {
        afterSequence: String(afterSequence),
      }),
      {
        headers: this.headers(),
        signal,
      },
    )
    if (!response.ok) return throwProtocolResponseError(response)
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Nexus protocol event response has no body")

    const decoder = new TextDecoder()
    let cursor = afterSequence
    let buffer = ""
    let streamFinished = false
    const parseLine = (line: string): ProtocolEnvelope | undefined => {
      const trimmed = line.trim()
      if (!trimmed) return undefined
      if (trimmed.length > MAX_PROTOCOL_LINE_CHARACTERS) {
        throw new Error("Nexus protocol event line exceeds its size limit")
      }
      let value: unknown
      try {
        value = JSON.parse(trimmed)
      } catch {
        throw new Error("Nexus protocol event line is not valid JSON")
      }
      const envelope = ProtocolEnvelopeSchema.parse(value)
      if (envelope.sessionId !== sessionId) {
        throw new Error(
          "Nexus protocol event belongs to another session",
        )
      }
      if (envelope.sequence !== cursor + 1) {
        throw new Error(
          `Nexus protocol event stream is not contiguous after sequence ${cursor}`,
        )
      }
      cursor = envelope.sequence
      return envelope
    }

    try {
      while (!signal?.aborted) {
        const { value, done } = await readStreamChunkWithTimeout(
          reader,
          DEFAULT_HEARTBEAT_TIMEOUT_MS,
        )
        if (done) {
          streamFinished = true
          break
        }
        buffer += decoder.decode(value, { stream: true })
        if (buffer.length > MAX_PROTOCOL_LINE_CHARACTERS * 2) {
          throw new Error("Nexus protocol event buffer exceeds its size limit")
        }
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          const envelope = parseLine(line)
          if (envelope) yield envelope
        }
      }
      buffer += decoder.decode()
      const envelope = parseLine(buffer)
      if (envelope) yield envelope
    } catch (error) {
      await reader.cancel(error).catch(() => undefined)
      throw error
    } finally {
      if (signal?.aborted || !streamFinished) {
        await reader.cancel(signal?.reason).catch(() => undefined)
      }
      try {
        reader.releaseLock()
      } catch {
        // A transport failure can release the lock while unwinding.
      }
    }
  }

  async *runSessionTurn(
    options: RunSessionTurnOptions,
  ): AsyncGenerator<AgentEvent> {
    const snapshot = await this.getSessionProtocolSnapshot(options.sessionId)
    const command: SessionCommandV2 = {
      version: PROTOCOL_VERSION,
      commandId: protocolIdentifier("command"),
      sessionId: options.sessionId,
      type: "start_turn",
      inputId: protocolIdentifier("input"),
      input: [...options.input],
      mode: options.mode,
      ...(options.selection ? { selection: options.selection } : {}),
    }

    let receipt: SessionCommandReceipt | undefined
    let dispatchError: unknown
    for (let attempt = 0; attempt <= MAX_PROTOCOL_RECONNECTS; attempt++) {
      try {
        receipt = await this.dispatchSessionCommand(command)
        break
      } catch (error) {
        dispatchError = error
        if (
          options.signal?.aborted ||
          (
            error instanceof SessionProtocolError &&
            !error.protocolError.retryable
          ) ||
          attempt === MAX_PROTOCOL_RECONNECTS
        ) {
          throw error
        }
      }
    }
    if (!receipt || receipt.type !== "start_turn") throw dispatchError
    const identity = {
      turnId: receipt.turnId,
      runId: receipt.runId,
    }
    options.onTurn?.(identity)

    yield* this.streamTurn(
      options.sessionId,
      identity,
      {
        networkAfterSequence: snapshot.throughSequence,
        deliverAfterSequence: snapshot.throughSequence,
        snapshotThroughSequence: snapshot.throughSequence,
        pendingApprovals: [],
        signal: options.signal,
        onApproval: options.onApproval,
        onSequence: options.onSequence,
      },
    )
  }

  async *attachSessionTurn(
    options: AttachSessionTurnOptions,
  ): AsyncGenerator<AgentEvent> {
    if (
      options.afterSequence !== undefined &&
      (
        !Number.isSafeInteger(options.afterSequence) ||
        options.afterSequence < 0
      )
    ) {
      throw new RangeError(
        "Nexus protocol cursor must be a non-negative safe integer",
      )
    }
    const snapshot = await this.getSessionProtocolSnapshot(
      options.sessionId,
      { includePendingTurns: true },
    )
    const activeMatches =
      snapshot.activeTurnId === options.turnId &&
      snapshot.activeRunId === options.runId &&
      snapshot.activeTurnFirstSequence !== undefined
    const pending = snapshot.pendingTurns?.find(
      (turn) =>
        turn.turnId === options.turnId &&
        turn.runId === options.runId,
    )
    const followHistorical =
      !activeMatches &&
      !pending &&
      options.followAcceptedTurn === true &&
      options.afterSequence !== undefined
    if (!activeMatches && !pending && !followHistorical) {
      if (snapshot.activeTurnId !== undefined) {
        throw new SessionProtocolError({
          code: "turn_conflict",
          message:
            "The active or queued Nexus turn does not match the attach identity",
          retryable: false,
        })
      }
      throw new SessionProtocolError({
        code: "no_active_turn",
        message:
          `Nexus session ${options.sessionId} has no matching active or queued turn`,
        retryable: false,
      })
    }
    const identity = {
      turnId: options.turnId,
      runId: options.runId,
    }

    if (followHistorical) {
      const afterSequence = options.afterSequence!
      if (
        afterSequence > snapshot.throughSequence ||
        afterSequence < snapshot.earliestAvailableSequence - 1
      ) {
        throw new SessionProtocolError({
          code: "replay_gap",
          message:
            "The accepted turn replay cursor is outside the durable event window",
          retryable: true,
        })
      }
      options.onTurn?.(identity)
      yield* this.streamTurn(
        options.sessionId,
        identity,
        {
          // Re-read the bounded retained window so a terminal event which was
          // acknowledged immediately before a client crash is still observed.
          // Delivery remains cursor-gated below, so already-rendered output is
          // not duplicated.
          networkAfterSequence: snapshot.earliestAvailableSequence - 1,
          deliverAfterSequence: afterSequence,
          ...(
            (snapshot.pendingTurns?.length ?? 0) >=
              snapshot.pendingQueueCount
              ? {
                  terminalRequiredThroughSequence:
                    snapshot.throughSequence,
                }
              : {}
          ),
          // Everything already committed in this fresh snapshot is history.
          // Replay normal agent output, but do not resurrect an approval which
          // was requested and resolved while the client was disconnected.
          snapshotThroughSequence: snapshot.throughSequence,
          pendingApprovals: [],
          signal: options.signal,
          onApproval: options.onApproval,
          onSequence: options.onSequence,
        },
      )
      return
    }

    if (pending) {
      options.onTurn?.(identity)
      yield* this.streamTurn(
        options.sessionId,
        identity,
        {
          // A queued turn has not emitted turn output yet. Start at the
          // snapshot high-water mark so a concurrently active turn is
          // acknowledged but never delivered as this caller's output.
          networkAfterSequence: snapshot.throughSequence,
          deliverAfterSequence: snapshot.throughSequence,
          snapshotThroughSequence: snapshot.throughSequence,
          pendingApprovals: [],
          signal: options.signal,
          onApproval: options.onApproval,
          onSequence: options.onSequence,
        },
      )
      return
    }

    const minimumCursor = snapshot.activeTurnFirstSequence! - 1
    const deliverAfterSequence =
      options.afterSequence === undefined
        ? minimumCursor
        : Math.max(minimumCursor, options.afterSequence)
    if (deliverAfterSequence > snapshot.throughSequence) {
      throw new SessionProtocolError({
        code: "replay_gap",
        message:
          "The attach cursor is newer than the server snapshot replay window",
        retryable: true,
      })
    }
    options.onTurn?.(identity)
    for (const approval of snapshot.pendingApprovals) {
      options.onApproval?.({
        ...identity,
        approvalId: approval.approvalId,
        toolName: approval.toolName,
        redactedSummary: approval.redactedSummary,
      })
    }
    yield* this.streamTurn(
      options.sessionId,
      identity,
      {
        // Re-read the active turn from its origin so approval state can be
        // reconstructed even when the caller's cursor falls between the
        // durable approval identity and its legacy presentation event.
        networkAfterSequence:
          snapshot.pendingApprovals.length > 0
            ? minimumCursor
            : deliverAfterSequence,
        deliverAfterSequence,
        snapshotThroughSequence: snapshot.throughSequence,
        pendingApprovals: snapshot.pendingApprovals,
        signal: options.signal,
        onApproval: options.onApproval,
        onSequence: options.onSequence,
      },
    )
  }

  private async *streamTurn(
    sessionId: string,
    identity: SessionTurnIdentity,
    options: {
      networkAfterSequence: number
      deliverAfterSequence: number
      snapshotThroughSequence: number
      terminalRequiredThroughSequence?: number
      pendingApprovals: readonly PendingSessionApproval[]
      signal?: AbortSignal
      onApproval?: (identity: SessionApprovalIdentity) => void
      onSequence?: (sequence: number) => void | Promise<void>
    },
  ): AsyncGenerator<AgentEvent> {
    const pendingApprovalIds = new Set(
      options.pendingApprovals.map((approval) => approval.approvalId),
    )
    const announcedApprovalIds = new Set(pendingApprovalIds)
    let cursor = options.networkAfterSequence
    let historicalApproval:
      | { approvalId: string; pending: boolean }
      | undefined
    let reconnects = 0
    while (!options.signal?.aborted) {
      let completed = false
      let terminalFailure: Error | undefined
      let sequenceFailure: unknown
      try {
        for await (const envelope of this.streamSessionEvents(
          sessionId,
          cursor,
          options.signal,
        )) {
          cursor = envelope.sequence
          let sequenceAcknowledged = false
          const acknowledgeSequence = async (): Promise<void> => {
            if (sequenceAcknowledged) return
            try {
              await options.onSequence?.(envelope.sequence)
              sequenceAcknowledged = true
            } catch (error) {
              sequenceFailure = error
              throw error
            }
          }
          const assertTerminalStillReachable = (): void => {
            if (
              options.terminalRequiredThroughSequence !== undefined &&
              envelope.sequence >= options.terminalRequiredThroughSequence
            ) {
              throw new SessionProtocolError({
                code: "replay_gap",
                message:
                  "The accepted turn terminal is no longer present in the durable replay window",
                retryable: false,
              })
            }
          }
          if (
            envelope.turnId !== identity.turnId ||
            envelope.runId !== identity.runId
          ) {
            await acknowledgeSequence()
            assertTerminalStillReachable()
            continue
          }
          const payload = envelope.payload
          if (payload.type === "approval_requested") {
            if (envelope.sequence <= options.snapshotThroughSequence) {
              historicalApproval = {
                approvalId: payload.approvalId,
                pending: pendingApprovalIds.has(payload.approvalId),
              }
            } else if (!announcedApprovalIds.has(payload.approvalId)) {
              announcedApprovalIds.add(payload.approvalId)
              options.onApproval?.({
                ...identity,
                approvalId: payload.approvalId,
                toolName: payload.toolName,
                redactedSummary: payload.redactedSummary,
              })
            }
            await acknowledgeSequence()
            assertTerminalStillReachable()
          } else if (payload.type === "agent_event") {
            const event = payload.event as AgentEvent
            const historical =
              envelope.sequence <= options.snapshotThroughSequence
            if (historical && event.type === "tool_approval_needed") {
              const shouldReplay = historicalApproval?.pending === true
              historicalApproval = undefined
              if (shouldReplay) {
                yield event
                await acknowledgeSequence()
                assertTerminalStillReachable()
                continue
              }
              await acknowledgeSequence()
              assertTerminalStillReachable()
              continue
            }
            if (envelope.sequence > options.deliverAfterSequence) {
              yield event
            }
            await acknowledgeSequence()
            assertTerminalStillReachable()
          } else if (payload.type === "turn_finished") {
            await acknowledgeSequence()
            if (payload.status === "failed") {
              terminalFailure = new SessionTurnTerminalError({
                ...identity,
                sequence: envelope.sequence,
                status: "failed",
                message:
                  payload.error ?? `Nexus turn ${identity.turnId} failed`,
              })
              throw terminalFailure
            }
            completed = true
            return
          } else {
            await acknowledgeSequence()
            assertTerminalStillReachable()
          }
        }
      } catch (error) {
        if (error === terminalFailure) throw error
        if (error === sequenceFailure) throw error
        if (completed || options.signal?.aborted) return
        if (
          error instanceof SessionProtocolError &&
          error.protocolError.code === "replay_gap"
        ) {
          throw error
        }
        if (reconnects >= MAX_PROTOCOL_RECONNECTS) throw error
        reconnects += 1
        continue
      }
      if (completed || options.signal?.aborted) return
      if (reconnects >= MAX_PROTOCOL_RECONNECTS) {
        throw new Error(
          `Nexus protocol event stream ended before turn ${identity.turnId} finished`,
        )
      }
      reconnects += 1
    }
  }

  async interruptSessionTurn(
    sessionId: string,
    expectedTurnId: string,
    reason?: string,
  ): Promise<boolean> {
    const receipt = await this.dispatchSessionCommand({
      version: PROTOCOL_VERSION,
      commandId: protocolIdentifier("command"),
      sessionId,
      type: "interrupt_turn",
      expectedTurnId,
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
    })
    if (receipt.type !== "interrupt_turn") {
      throw new Error("Nexus protocol returned the wrong interrupt receipt")
    }
    return receipt.interrupted
  }

  async resolveSessionApproval(
    sessionId: string,
    expectedTurnId: string,
    approvalId: string,
    result: Pick<PermissionResult, "approved">,
  ): Promise<void> {
    const receipt = await this.dispatchSessionCommand({
      version: PROTOCOL_VERSION,
      commandId: protocolIdentifier("command"),
      sessionId,
      type: "resolve_approval",
      approvalId,
      expectedTurnId,
      status: result.approved ? "approved" : "denied",
    })
    if (receipt.type !== "resolve_approval") {
      throw new Error("Nexus protocol returned the wrong approval receipt")
    }
  }

  async listSessions(): Promise<Array<{ id: string; ts: number; title?: string; messageCount: number; revision: number }>> {
    const res = await this.request(this.url("/session", { directory: this.directory }), {
      headers: this.headers(),
    })
    if (!res.ok) throw new Error(`Server listSessions: ${res.status} ${await res.text()}`)
    return res.json() as Promise<Array<{ id: string; ts: number; title?: string; messageCount: number; revision: number }>>
  }

  async createSession(): Promise<{ id: string; cwd: string; ts: number; messageCount: number; revision: number }> {
    const res = await this.request(this.url("/session"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({}),
    })
    if (!res.ok) throw new Error(`Server createSession: ${res.status} ${await res.text()}`)
    return res.json() as Promise<{ id: string; cwd: string; ts: number; messageCount: number; revision: number }>
  }

  async getMessages(
    sessionId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<SessionMessage[]> {
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50))
    const offset = Math.max(0, opts?.offset ?? 0)
    const res = await this.request(
      this.url(`${this.sessionPath(sessionId)}/message`, {
        directory: this.directory,
        limit: String(limit),
        offset: String(offset),
      }),
      { headers: this.headers() }
    )
    if (!res.ok) throw new Error(`Server getMessages: ${res.status} ${await res.text()}`)
    return res.json() as Promise<SessionMessage[]>
  }

  async getSession(sessionId: string): Promise<{ id: string; cwd: string; ts: number; messageCount: number; revision: number }> {
    const res = await this.request(this.url(this.sessionPath(sessionId), { directory: this.directory }), {
      headers: this.headers(),
    })
    if (!res.ok) throw new Error(`Server getSession: ${res.status} ${await res.text()}`)
    return res.json() as Promise<{ id: string; cwd: string; ts: number; messageCount: number; revision: number }>
  }

  async getRecentMessages(
    sessionId: string,
    limit = 200,
  ): Promise<SessionMessage[]> {
    const boundedLimit = Math.min(200, Math.max(1, Math.floor(limit)))
    const meta = await this.getSession(sessionId)
    return this.getMessages(sessionId, {
      limit: boundedLimit,
      offset: Math.max(0, meta.messageCount - boundedLimit),
    })
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const res = await this.request(this.url(this.sessionPath(sessionId), { directory: this.directory }), {
      method: "DELETE",
      headers: this.headers(),
    })
    if (res.status === 404) return false
    if (!res.ok) throw new Error(`Server deleteSession: ${res.status} ${await res.text()}`)
    return true
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const res = await this.request(
      this.url(`${this.sessionPath(sessionId)}/abort`),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({}),
      },
    )
    if (!res.ok) {
      throw new Error(`Server abortSession: ${res.status} ${await res.text()}`)
    }
    return Boolean((await res.json() as { ok?: unknown }).ok)
  }

  async respondToApproval(
    sessionId: string,
    runId: string,
    partId: string,
    result: PermissionResult,
  ): Promise<void> {
    const res = await this.request(
      this.url(
        `${this.sessionPath(sessionId)}/run/${encodeURIComponent(runId)}/approval`,
      ),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ partId, ...result }),
      },
    )
    if (!res.ok) {
      throw new Error(`Server respondToApproval: ${res.status} ${await res.text()}`)
    }
  }

  /**
   * Send message and stream AgentEvents as NDJSON. Yields each event (heartbeat lines are skipped).
   * Malformed lines yield an error event. Throws on fetch error.
   */
  async *streamMessage(
    sessionId: string,
    content: string,
    mode: Mode,
    presetName?: string,
    signal?: AbortSignal,
    options: { onRunId?: (runId: string) => void } = {},
  ): AsyncGenerator<AgentEvent> {
    const maxReconnects = 3
    let reconnectAttempt = 0
    let runId = ""
    let lastSeq = 0
    const clientRunId = `run_${randomUUID().replaceAll("-", "")}`

    const parseLine = (line: string): { event: AgentEvent | null; seq: number | null } => {
      const t = line.trim()
      if (!t) return { event: null, seq: null }
      try {
        const parsed = JSON.parse(t) as { type?: string; ts?: number; seq?: number; event?: AgentEvent }
        if (parsed?.type === "heartbeat") return { event: null, seq: null }
        if (typeof parsed.seq === "number" && parsed.event) {
          return { event: parsed.event, seq: parsed.seq }
        }
        return { event: parsed as AgentEvent, seq: null }
      } catch {
        const preview = t.length > 80 ? `${t.slice(0, 80)}…` : t
        return { event: { type: "error", error: `Invalid stream line: ${preview}` }, seq: null }
      }
    }

    while (true) {
      let res: Response
      try {
        res = await this.request(this.url(`${this.sessionPath(sessionId)}/message`, { directory: this.directory }), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(
            runId
              ? { runId, afterSeq: lastSeq }
              : { content, mode, presetName, clientRunId, afterSeq: lastSeq },
          ),
          signal,
        })
      } catch (error) {
        if (signal?.aborted) return
        if (reconnectAttempt >= maxReconnects) {
          yield { type: "error", error: `Server request failed: ${(error as Error).message}` }
          return
        }
        reconnectAttempt++
        yield {
          type: "remote_session_updated",
          remoteSession: {
            id: `remote-${sessionId}`,
            url: this.url(this.sessionPath(sessionId)),
            sessionId,
            runId: runId || clientRunId,
            status: "reconnecting",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            reconnectAttempts: reconnectAttempt,
            reconnectable: true,
            metadata: { source: "client-request", lastSeq },
          },
        }
        continue
      }
      if (!res.ok) {
        const text = await res.text()
        yield { type: "error", error: `Server: ${res.status} ${text}` }
        return
      }
      runId = res.headers.get("x-nexus-run-id") ?? (runId || clientRunId)
      options.onRunId?.(runId)
      const reader = res.body?.getReader()
      if (!reader) {
        yield { type: "error", error: "No response body" }
        return
      }
      const decoder = new TextDecoder()
      let buffer = ""
      let completedNormally = false
      try {
        while (true) {
          const chunk = await readStreamChunkWithTimeout(
            reader,
            DEFAULT_HEARTBEAT_TIMEOUT_MS,
          )
          const { value, done } = chunk
          if (done) {
            completedNormally = true
            break
          }
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            const parsed = parseLine(line)
            if (typeof parsed.seq === "number") lastSeq = parsed.seq
            if (parsed.event) yield parsed.event
          }
        }
        for (const line of buffer.split("\n")) {
          const parsed = parseLine(line)
          if (typeof parsed.seq === "number") lastSeq = parsed.seq
          if (parsed.event) yield parsed.event
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined)
        if (signal?.aborted) return
        if (!runId || reconnectAttempt >= maxReconnects) {
          yield {
            type: "remote_session_updated",
            remoteSession: {
              id: `remote-${sessionId}`,
              url: this.url(this.sessionPath(sessionId)),
              sessionId,
              runId,
              status: "error",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              reconnectAttempts: reconnectAttempt,
              reconnectable: false,
              error: `Server stream failed: ${(error as Error).message}`,
              metadata: { source: "client-stream" },
            },
          }
          yield { type: "error", error: `Server stream failed: ${(error as Error).message}` }
          return
        }
        reconnectAttempt++
        yield {
          type: "remote_session_updated",
          remoteSession: {
            id: `remote-${sessionId}`,
            url: this.url(this.sessionPath(sessionId)),
            sessionId,
            runId,
            status: "reconnecting",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            reconnectAttempts: reconnectAttempt,
            reconnectable: true,
            metadata: { source: "client-stream", lastSeq },
          },
        }
        continue
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // A transport can reject while a pending read is unwinding. The
          // response body is already abandoned and reconnect owns the next one.
        }
      }
      if (reconnectAttempt > 0) {
        yield {
          type: "remote_session_updated",
          remoteSession: {
            id: `remote-${sessionId}`,
            url: this.url(`/session/${sessionId}`),
            sessionId,
            runId,
            status: "connected",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            reconnectAttempts: reconnectAttempt,
            reconnectable: true,
            metadata: { source: "client-stream", resumedAfterSeq: lastSeq },
          },
        }
      }
      if (completedNormally) return
    }
  }
}

/** If no event (including heartbeat) received for this long, consider stream dead. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 20_000
