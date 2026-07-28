import { Hono } from "hono"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ChangeSetService,
  FileChangeSetStore,
  MAX_IMAGE_BASE64_CHARS,
  ManagedWorkspaceRuntime,
  PROTOCOL_VERSION,
  buildRemoteMcpPromptCatalog,
  createNexusRunServices,
  hashFileContent,
  hashWorkspaceIdentity,
  type CapturedFileState,
  type HostFileMutation,
  type NexusRunServices,
  type RemoteMcpPromptResolveRequest,
  type RemoteMcpPromptResolveResponse,
  type ProtocolEnvelope,
  type SessionCommandReceipt,
  type SessionCommandV2,
  type SessionProtocolService,
  type WorkspaceRuntime,
} from "@nexuscode/core"
import type { ServerEnv } from "../security.js"
import { McpPromptCatalogConflictError } from "../mcp-prompt-service.js"
import {
  createSessionV2Routes,
  MAX_SESSION_COMMAND_BODY_BYTES,
  SESSION_EVENT_HEARTBEAT_INTERVAL_MS,
  type SessionV2RuntimeProvider,
} from "./session-v2.js"

const workspace = "/allowed/workspace"
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function command(
  overrides: Partial<SessionCommandV2> = {},
): SessionCommandV2 {
  return {
    version: PROTOCOL_VERSION,
    type: "start_turn",
    commandId: "command-1",
    sessionId: "session-1",
    inputId: "input-1",
    input: [{ type: "text", text: "hello" }],
    mode: "agent",
    ...overrides,
  } as SessionCommandV2
}

function setup(options: {
  dispatch?: (command: SessionCommandV2) => Promise<SessionCommandReceipt>
  events?: SessionProtocolService["events"]
  snapshot?: SessionProtocolService["snapshot"]
  includeProtocol?: boolean
  protocolPortVersion?: number
  heartbeatIntervalMs?: number
  mcpCatalog?: () => Promise<ReturnType<typeof buildRemoteMcpPromptCatalog>>
  mcpResolve?: (
    request: RemoteMcpPromptResolveRequest,
    signal?: AbortSignal,
  ) => Promise<RemoteMcpPromptResolveResponse>
  agentRuns?: NexusRunServices
} = {}) {
  const dispatch = vi.fn(
    options.dispatch ??
      (async (value: SessionCommandV2): Promise<SessionCommandReceipt> => {
        if (value.type !== "start_turn") {
          throw new Error("Default route fixture only accepts start_turn")
        }
        return {
          version: PROTOCOL_VERSION,
          type: "start_turn",
          commandId: value.commandId,
          sessionId: value.sessionId,
          accepted: true,
          inputId: value.inputId,
          turnId: "turn-1",
          runId: "run-1",
          started: true,
        }
      }),
  )
  const snapshot = vi.fn(
    options.snapshot ??
      (async (sessionId: string) => ({
        version: PROTOCOL_VERSION,
        sessionId,
        phase: "idle" as const,
        pendingApprovals: [],
        pendingQueueCount: 0,
        pendingSteerCount: 0,
        earliestAvailableSequence: 1,
        throughSequence: 0,
      })),
  )
  const events =
    options.events ??
    (async function* (): AsyncIterable<ProtocolEnvelope> {
      // Empty finite replay for route tests.
    })
  const protocol = {
    portVersion: options.protocolPortVersion ?? 1,
    dispatch,
    snapshot,
    events,
  } as SessionProtocolService & { readonly portVersion: number }
  const runtime = new ManagedWorkspaceRuntime(
    workspace,
    options.includeProtocol === false
      ? {}
      : {
          protocol,
          ...(options.agentRuns ? { agentRuns: options.agentRuns } : {}),
        },
  )
  const get = vi.fn(async (): Promise<WorkspaceRuntime> => runtime)
  const runtimes: SessionV2RuntimeProvider = { get }
  const app = new Hono<ServerEnv>()
  app.use("*", async (context, next) => {
    context.set("workspaceRoot", workspace)
    await next()
  })
  app.route(
    "/v2/session",
    createSessionV2Routes({
      runtimes,
      ...(options.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.mcpCatalog || options.mcpResolve
        ? {
            mcpPrompts: {
              catalog: vi.fn(async () =>
                options.mcpCatalog
                  ? options.mcpCatalog()
                  : buildRemoteMcpPromptCatalog([])
              ),
              resolve: vi.fn(async (
                _runtime,
                _cwd,
                request,
                signal,
              ) =>
                options.mcpResolve
                  ? options.mcpResolve(request, signal)
                  : { input: [{ type: "text" as const, text: "resolved" }] }
              ),
            },
          }
        : {}),
    }),
  )
  return { app, dispatch, snapshot, get, runtime }
}

describe("session protocol v2 routes", () => {
  it("validates and dispatches one typed command", async () => {
    const { app, dispatch, get } = setup()
    const body = command()

    const response = await app.request("/v2/session/session-1/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      version: PROTOCOL_VERSION,
      commandId: "command-1",
      sessionId: "session-1",
      accepted: true,
      inputId: "input-1",
      runId: "run-1",
      started: true,
      turnId: "turn-1",
      type: "start_turn",
    })
    expect(get).toHaveBeenCalledWith(workspace)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(body)
  })

  it("lists and accepts exact session-owned durable changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-route-changes-"))
    temporaryDirectories.push(root)
    let current: CapturedFileState = {
      exists: true,
      content: Buffer.from("before"),
      mode: 0o644,
    }
    const files = {
      async readFileState(): Promise<CapturedFileState> {
        return current.exists
          ? {
              exists: true,
              content: Buffer.from(current.content),
              mode: current.mode,
            }
          : { exists: false, content: null, mode: null }
      },
      async applyFileMutation(
        mutation: HostFileMutation,
      ): Promise<void> {
        const actual = current.exists
          ? hashFileContent(current.content).hash
          : null
        if (
          current.exists !== mutation.expected.exists ||
          actual !== mutation.expected.hash
        ) {
          throw new Error("fixture precondition failed")
        }
        current = mutation.next.exists
          ? {
              exists: true,
              content: Buffer.from(mutation.next.content),
              mode: mutation.next.mode,
            }
          : { exists: false, content: null, mode: null }
      },
    }
    const workspaceId = hashWorkspaceIdentity(workspace)
    const store = new FileChangeSetStore(workspaceId, {
      rootDir: root,
    })
    const changes = new ChangeSetService({
      workspaceId,
      store,
      files,
      idFactory: () => "change-1",
    })
    const proposed = await changes.propose({
      identity: {
        workspaceId,
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        messageId: "message-1",
        partId: "part-1",
        toolCallId: "call-1",
      },
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after" },
        hunks: [],
        binary: false,
      }],
    })
    await changes.approve(proposed.id, proposed.proposalHash)
    await changes.apply(proposed.id)
    const agentRuns = createNexusRunServices({
      changeSets: { workspaceId, store },
    })
    const { app } = setup({ agentRuns })

    const listed = await app.request(
      "/v2/session/session-1/changes",
    )
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({
      changes: [{
        changeSetId: "change-1",
        originalContent: "before",
        newContent: "after",
        diffStats: { added: 1, removed: 1 },
      }],
      truncated: false,
    })

    const accepted = await app.request(
      "/v2/session/session-1/changes/change-1/accept",
      { method: "POST", body: "{}" },
    )
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toMatchObject({
      changeSetId: "change-1",
      state: "accepted",
    })
  })

  it("rejects an oversized HTTP body before JSON parsing or runtime access", async () => {
    const { app, get } = setup()

    const response = await app.request("/v2/session/session-1/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_SESSION_COMMAND_BODY_BYTES + 1),
      },
      body: "{}",
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      version: PROTOCOL_VERSION,
      error: {
        code: "input_too_large",
        retryable: false,
        details: {
          kind: "request_body",
          limit: MAX_SESSION_COMMAND_BODY_BYTES,
        },
      },
    })
    expect(get).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: "another command kind",
      receipt: {
        version: PROTOCOL_VERSION,
        type: "queue_turn",
        commandId: "command-1",
        sessionId: "session-1",
        accepted: true,
        inputId: "input-1",
        turnId: "turn-1",
        runId: "run-1",
      } as const,
    },
    {
      label: "another input identity",
      receipt: {
        version: PROTOCOL_VERSION,
        type: "start_turn",
        commandId: "command-1",
        sessionId: "session-1",
        accepted: true,
        inputId: "input-other",
        turnId: "turn-1",
        runId: "run-1",
        started: true,
      } as const,
    },
  ])("rejects a runtime receipt for $label", async ({ receipt }) => {
    const { app } = setup({
      dispatch: async () => receipt,
    })

    const response = await app.request("/v2/session/session-1/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command()),
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: { code: "internal_error", retryable: false },
    })
  })

  it("rejects unsupported versions and oversized input before runtime access", async () => {
    const { app, get } = setup()

    const unsupported = await app.request(
      "/v2/session/session-1/command",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...command(), version: 999 }),
      },
    )
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toMatchObject({
      version: PROTOCOL_VERSION,
      error: { code: "unsupported_version", retryable: false },
    })

    const oversized = await app.request("/v2/session/session-1/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...command(),
        input: [{
          type: "image",
          mimeType: "image/png",
          data: "a".repeat(MAX_IMAGE_BASE64_CHARS + 1),
        }],
      }),
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({
      version: PROTOCOL_VERSION,
      error: { code: "input_too_large", retryable: false },
    })
    expect(get).not.toHaveBeenCalled()
  })

  it("rejects a body session that differs from the route", async () => {
    const { app, get } = setup()
    const response = await app.request("/v2/session/session-other/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command()),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_command", retryable: false },
    })
    expect(get).not.toHaveBeenCalled()
  })

  it("returns a structured unavailable error when runtime has no protocol service", async () => {
    const { app } = setup({ includeProtocol: false })
    const response = await app.request("/v2/session/session-1/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command()),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      version: PROTOCOL_VERSION,
      error: { code: "runtime_unavailable", retryable: true },
    })
  })

  it("refuses an incompatible protocol service port", async () => {
    const { app, dispatch } = setup({ protocolPortVersion: 999 })
    const response = await app.request("/v2/session/session-1/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command()),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { code: "runtime_unavailable", retryable: true },
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("returns a redacted protocol snapshot", async () => {
    const { app, snapshot } = setup()
    const response = await app.request("/v2/session/session-1/snapshot")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      version: PROTOCOL_VERSION,
      sessionId: "session-1",
      phase: "idle",
      pendingApprovals: [],
      pendingQueueCount: 0,
      pendingSteerCount: 0,
      earliestAvailableSequence: 1,
      throughSequence: 0,
    })
    expect(snapshot).toHaveBeenCalledWith("session-1")
  })

  it("exposes queued identities only to opt-in clients for v2 compatibility", async () => {
    const pendingTurns = [{
      inputId: "input-queued",
      turnId: "turn-queued",
      runId: "run-queued",
      admittedSequence: 1,
      execution: { mode: "review" as const },
    }]
    const { app } = setup({
      snapshot: async (sessionId) => ({
        version: PROTOCOL_VERSION,
        sessionId,
        phase: "streaming",
        activeTurnId: "turn-active",
        activeRunId: "run-active",
        activeTurnFirstSequence: 1,
        activeExecution: { mode: "agent" },
        pendingApprovals: [],
        pendingTurns,
        pendingQueueCount: 1,
        pendingSteerCount: 0,
        earliestAvailableSequence: 1,
        throughSequence: 4,
      }),
    })

    const legacy = await app.request("/v2/session/session-1/snapshot")
    expect(await legacy.json()).not.toHaveProperty("pendingTurns")

    const optedIn = await app.request("/v2/session/session-1/snapshot", {
      headers: { "x-nexus-include-pending-turns": "1" },
    })
    expect(await optedIn.json()).toMatchObject({ pendingTurns })
  })

  it("serves a session-scoped bounded MCP prompt catalog", async () => {
    const catalog = buildRemoteMcpPromptCatalog([{
      serverName: "docs",
      name: "review",
      arguments: [{ name: "target", required: true }],
    }])
    const mcpCatalog = vi.fn(async () => catalog)
    const { app, snapshot } = setup({ mcpCatalog })

    const response = await app.request(
      "/v2/session/session-1/mcp/prompts",
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(catalog)
    expect(snapshot).toHaveBeenCalledWith("session-1")
    expect(mcpCatalog).toHaveBeenCalledOnce()
  })

  it("resolves an opaque MCP prompt id only for a current catalog revision", async () => {
    const catalog = buildRemoteMcpPromptCatalog([{
      serverName: "docs",
      name: "review",
      arguments: [{ name: "target", required: true }],
    }])
    const request: RemoteMcpPromptResolveRequest = {
      revision: catalog.revision,
      promptId: catalog.commands[0]!.promptId,
      arguments: { target: "src" },
    }
    const mcpResolve = vi.fn(async (
      received: RemoteMcpPromptResolveRequest,
      signal?: AbortSignal,
    ) => {
      expect(received).toEqual(request)
      expect(signal).toBeInstanceOf(AbortSignal)
      return {
        input: [{ type: "text" as const, text: "Review src" }],
      }
    })
    const { app, snapshot } = setup({ mcpResolve })

    const response = await app.request(
      "/v2/session/session-1/mcp/prompts/resolve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      input: [{ type: "text", text: "Review src" }],
    })
    expect(snapshot).toHaveBeenCalledWith("session-1")
    expect(mcpResolve).toHaveBeenCalledOnce()
  })

  it("returns a typed retryable conflict for a stale MCP prompt catalog", async () => {
    const catalog = buildRemoteMcpPromptCatalog([{
      serverName: "docs",
      name: "review",
      arguments: [],
    }])
    const currentRevision = `sha256:${"c".repeat(64)}`
    const { app } = setup({
      mcpResolve: vi.fn(async () => {
        throw new McpPromptCatalogConflictError(currentRevision)
      }),
    })

    const response = await app.request(
      "/v2/session/session-1/mcp/prompts/resolve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: catalog.revision,
          promptId: catalog.commands[0]!.promptId,
          arguments: {},
        }),
      },
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: {
        code: "selection_conflict",
        retryable: true,
        details: { currentRevision },
      },
    })
  })

  it("streams finite durable replay strictly after the requested sequence", async () => {
    const envelopes: ProtocolEnvelope[] = [2, 3].map((sequence) => ({
      version: PROTOCOL_VERSION,
      eventId: `event-${sequence}`,
      runId: "run-1",
      sequence,
      sessionId: "session-1",
      turnId: "turn-1",
      emittedAt: sequence,
      persistence: {
        state: "committed",
        rollout: "projected",
      },
      payload: {
        type: "phase_changed",
        phase: sequence === 2 ? "streaming" : "settling",
      },
    }))
    const events = vi.fn(async function* (input: {
      sessionId: string
      afterSequence: number
      signal?: AbortSignal
    }) {
      expect(input.sessionId).toBe("session-1")
      expect(input.afterSequence).toBe(1)
      for (const envelope of envelopes) yield envelope
    })
    const { app } = setup({
      events,
      snapshot: async (sessionId) => ({
        version: PROTOCOL_VERSION,
        sessionId,
        phase: "streaming",
        activeTurnId: "turn-1",
        activeRunId: "run-1",
        activeTurnFirstSequence: 1,
        activeExecution: { mode: "agent" },
        pendingApprovals: [],
        pendingQueueCount: 0,
        pendingSteerCount: 0,
        earliestAvailableSequence: 1,
        throughSequence: 3,
      }),
    })

    const response = await app.request(
      "/v2/session/session-1/events?afterSequence=1",
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    )
    const lines = (await response.text()).trim().split("\n")
    expect(lines.map((line) => JSON.parse(line))).toEqual(envelopes)
    expect(events).toHaveBeenCalledOnce()
  })

  it("keeps a silent event stream alive with transport-only blank lines", async () => {
    expect(SESSION_EVENT_HEARTBEAT_INTERVAL_MS).toBeLessThan(20_000)
    const envelope: ProtocolEnvelope = {
      version: PROTOCOL_VERSION,
      eventId: "event-1",
      runId: "run-1",
      sequence: 1,
      sessionId: "session-1",
      turnId: "turn-1",
      emittedAt: 1,
      persistence: {
        state: "committed",
        rollout: "projected",
      },
      payload: {
        type: "phase_changed",
        phase: "streaming",
      },
    }
    const events = vi.fn(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 25))
      yield envelope
    })
    const { app } = setup({
      events,
      heartbeatIntervalMs: 5,
      snapshot: async (sessionId) => ({
        version: PROTOCOL_VERSION,
        sessionId,
        phase: "streaming",
        activeTurnId: "turn-1",
        activeRunId: "run-1",
        activeTurnFirstSequence: 1,
        activeExecution: { mode: "agent" },
        pendingApprovals: [],
        pendingQueueCount: 0,
        pendingSteerCount: 0,
        earliestAvailableSequence: 1,
        throughSequence: 1,
      }),
    })

    const response = await app.request(
      "/v2/session/session-1/events?afterSequence=0",
    )
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body.startsWith("\n")).toBe(true)
    const durableRows = body
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProtocolEnvelope)
    expect(durableRows).toEqual([envelope])
  })

  it("cancels the runtime subscription when the response writer disconnects", async () => {
    const requestAbort = new AbortController()
    let subscriptionSignal: AbortSignal | undefined
    let resolveSubscriptionAbort!: () => void
    const subscriptionAborted = new Promise<void>((resolve) => {
      resolveSubscriptionAbort = resolve
    })
    const events = vi.fn(async function* (input: {
      signal?: AbortSignal
    }) {
      subscriptionSignal = input.signal
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) {
          resolve()
          return
        }
        input.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        })
      })
      resolveSubscriptionAbort()
    })
    const { app } = setup({
      events,
      heartbeatIntervalMs: 5,
      snapshot: async (sessionId) => ({
        version: PROTOCOL_VERSION,
        sessionId,
        phase: "idle",
        pendingApprovals: [],
        pendingQueueCount: 0,
        pendingSteerCount: 0,
        earliestAvailableSequence: 1,
        throughSequence: 0,
      }),
    })

    const response = await app.request(
      "/v2/session/session-1/events?afterSequence=0",
      { signal: requestAbort.signal },
    )
    const reader = response.body!.getReader()
    try {
      const heartbeat = await reader.read()
      expect(new TextDecoder().decode(heartbeat.value)).toBe("\n")
      await reader.cancel("client disconnected")
      const outcome = await Promise.race([
        subscriptionAborted.then(() => "aborted" as const),
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 100)
        }),
      ])
      expect(outcome).toBe("aborted")
      expect(subscriptionSignal?.aborted).toBe(true)
    } finally {
      requestAbort.abort()
      reader.releaseLock()
    }
  })

  it.each([
    { afterSequence: 2, label: "older than retention" },
    { afterSequence: 9, label: "ahead of durable state" },
  ])(
    "returns a replay reset when the cursor is $label",
    async ({ afterSequence }) => {
      const events = vi.fn(async function* () {
        throw new Error("events must not start for an invalid cursor")
      })
      const { app } = setup({
        events,
        snapshot: async (sessionId) => ({
          version: PROTOCOL_VERSION,
          sessionId,
          phase: "idle",
          pendingApprovals: [],
          pendingQueueCount: 0,
          pendingSteerCount: 0,
          earliestAvailableSequence: 5,
          throughSequence: 8,
        }),
      })

      const response = await app.request(
        `/v2/session/session-1/events?afterSequence=${afterSequence}`,
      )

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        version: PROTOCOL_VERSION,
        error: {
          code: "replay_gap",
          retryable: true,
          details: {
            earliestAvailableSequence: 5,
            throughSequence: 8,
            resetAfterSequence: 8,
          },
        },
      })
      expect(events).not.toHaveBeenCalled()
    },
  )

  it("closes replay before emitting a non-contiguous envelope", async () => {
    const envelopes: ProtocolEnvelope[] = [2, 4].map((sequence) => ({
      version: PROTOCOL_VERSION,
      eventId: `event-gap-${sequence}`,
      runId: "run-1",
      sequence,
      sessionId: "session-1",
      turnId: "turn-1",
      emittedAt: sequence,
      persistence: {
        state: "committed",
        rollout: "projected",
      },
      payload: {
        type: "phase_changed",
        phase: "streaming",
      },
    }))
    const events = vi.fn(async function* () {
      for (const envelope of envelopes) yield envelope
    })
    const { app } = setup({
      events,
      snapshot: async (sessionId) => ({
        version: PROTOCOL_VERSION,
        sessionId,
        phase: "streaming",
        activeTurnId: "turn-1",
        activeRunId: "run-1",
        activeTurnFirstSequence: 1,
        activeExecution: { mode: "agent" },
        pendingApprovals: [],
        pendingQueueCount: 0,
        pendingSteerCount: 0,
        earliestAvailableSequence: 1,
        throughSequence: 4,
      }),
    })

    const response = await app.request(
      "/v2/session/session-1/events?afterSequence=1",
    )

    expect(response.status).toBe(200)
    const rows = (await response.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProtocolEnvelope)
    expect(rows.map((row) => row.sequence)).toEqual([2])
  })

  it("rejects invalid replay cursors before runtime access", async () => {
    const { app, get } = setup()
    const response = await app.request(
      "/v2/session/session-1/events?afterSequence=-1",
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_command", retryable: false },
    })
    expect(get).not.toHaveBeenCalled()
  })
})
