import { afterEach, describe, expect, it, vi } from "vitest"

import {
  PROTOCOL_VERSION,
  type ProtocolEnvelope,
} from "./protocol/v2.js"
import { buildRemoteMcpPromptCatalog } from "./mcp/prompt-transport.js"
import { NexusServerClient } from "./server-client.js"

const persistence = {
  state: "committed" as const,
  rollout: "projected" as const,
}

function envelope(
  sequence: number,
  payload: ProtocolEnvelope["payload"],
  identities: {
    turnId?: string
    runId?: string
  } = {},
): ProtocolEnvelope {
  return {
    version: PROTOCOL_VERSION,
    eventId: `event-${sequence}`,
    sequence,
    sessionId: "session-test",
    emittedAt: sequence,
    persistence,
    ...identities,
    payload,
  } as ProtocolEnvelope
}

function ndjson(lines: readonly unknown[]): Response {
  return new Response(
    lines.map((line) =>
      typeof line === "string" ? line : JSON.stringify(line)
    ).join("\n") + "\n",
    {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    },
  )
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("NexusServerClient protocol v2", () => {
  it("dispatches a validated idempotent command to the authenticated workspace route", async () => {
    const requests: Array<{
      url: string
      headers: Headers
      body: unknown
    }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        })
        return Response.json({
          version: PROTOCOL_VERSION,
          commandId: "command-test",
          sessionId: "session-test",
          accepted: true,
          type: "start_turn",
          inputId: "input-test",
          turnId: "turn-test",
          runId: "run-test",
          started: true,
        })
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    const receipt = await client.dispatchSessionCommand({
      version: PROTOCOL_VERSION,
      commandId: "command-test",
      sessionId: "session-test",
      type: "start_turn",
      inputId: "input-test",
      input: [{ type: "text", text: "hello" }],
      mode: "agent",
    })

    expect(receipt).toMatchObject({
      type: "start_turn",
      turnId: "turn-test",
      runId: "run-test",
    })
    expect(requests).toEqual([{
      url:
        "http://127.0.0.1:4097/v2/session/session-test/command",
      headers: expect.any(Headers),
      body: expect.objectContaining({
        commandId: "command-test",
        inputId: "input-test",
      }),
    }])
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer secret-token",
    )
    expect(requests[0]?.headers.get("x-nexus-directory")).toBe(process.cwd())
  })

  it("loads and resolves remote MCP prompts through the authenticated session scope", async () => {
    const catalog = buildRemoteMcpPromptCatalog([{
      serverName: "docs",
      name: "review",
      arguments: [{ name: "target", required: true }],
    }])
    const requests: Array<{
      url: string
      method: string
      headers: Headers
      body?: unknown
    }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        requests.push({
          url,
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          ...(init?.body
            ? { body: JSON.parse(String(init.body)) }
            : {}),
        })
        return url.endsWith("/resolve")
          ? Response.json({
              input: [{ type: "text", text: "Review src" }],
            })
          : Response.json(catalog)
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    await expect(
      client.getMcpPromptCatalog("session-test"),
    ).resolves.toEqual(catalog)
    await expect(
      client.resolveMcpPrompt("session-test", {
        revision: catalog.revision,
        promptId: catalog.commands[0]!.promptId,
        arguments: { target: "src" },
      }),
    ).resolves.toEqual({
      input: [{ type: "text", text: "Review src" }],
    })

    expect(requests.map(({ url, method }) => ({ url, method }))).toEqual([
      {
        url:
          "http://127.0.0.1:4097/v2/session/session-test/mcp/prompts",
        method: "GET",
      },
      {
        url:
          "http://127.0.0.1:4097/v2/session/session-test/mcp/prompts/resolve",
        method: "POST",
      },
    ])
    expect(requests.every((request) =>
      request.headers.get("authorization") === "Bearer secret-token"
    )).toBe(true)
  })

  it("runs one turn from a durable cursor and exposes turn and approval identities", async () => {
    const requests: string[] = []
    const turn = { turnId: "turn-test", runId: "run-test" }
    const events = [
      envelope(1, {
        type: "input_admitted",
        inputId: "input-test",
        reservedTurnId: turn.turnId,
        reservedRunId: turn.runId,
        delivery: "queue",
        admittedSequence: 1,
        execution: { mode: "agent" },
      }, turn),
      envelope(2, {
        type: "turn_started",
        ...turn,
        configEpoch: 0,
        contextEpoch: 0,
        execution: { mode: "agent" },
      }, turn),
      envelope(3, {
        type: "agent_event",
        event: {
          type: "text_delta",
          delta: "hello",
          messageId: "message-test",
        },
      }, turn),
      envelope(4, {
        type: "approval_requested",
        approvalId: "approval-test",
        toolName: "Bash",
        redactedSummary: "Run tests",
      }, turn),
      envelope(5, {
        type: "agent_event",
        event: {
          type: "tool_approval_needed",
          partId: "part-test",
          action: {
            type: "command",
            tool: "Bash",
            description: "Run tests",
          },
        },
      }, turn),
      envelope(6, {
        type: "turn_finished",
        status: "completed",
      }, turn),
    ]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        requests.push(url)
        if (url.endsWith("/snapshot")) {
          return Response.json({
            version: PROTOCOL_VERSION,
            sessionId: "session-test",
            phase: "idle",
            pendingApprovals: [],
            pendingQueueCount: 0,
            pendingSteerCount: 0,
            earliestAvailableSequence: 1,
            throughSequence: 0,
          })
        }
        if (url.endsWith("/command")) {
          const command = JSON.parse(String(init?.body)) as {
            commandId: string
            inputId: string
          }
          return Response.json({
            version: PROTOCOL_VERSION,
            commandId: command.commandId,
            sessionId: "session-test",
            accepted: true,
            type: "start_turn",
            inputId: command.inputId,
            ...turn,
            started: true,
          })
        }
        return ndjson(events)
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })
    const identities: string[] = []
    const approvals: unknown[] = []
    const acknowledgedSequences: number[] = []
    const agentEvents = []

    for await (const event of client.runSessionTurn({
      sessionId: "session-test",
      input: [{ type: "text", text: "hello" }],
      mode: "agent",
      onTurn: ({ turnId, runId }) => {
        identities.push(`${turnId}:${runId}`)
      },
      onApproval: (approval) => {
        approvals.push(approval)
      },
      onSequence: async (sequence) => {
        acknowledgedSequences.push(sequence)
      },
    })) {
      agentEvents.push(event)
    }

    expect(agentEvents).toEqual([
      {
        type: "text_delta",
        delta: "hello",
        messageId: "message-test",
      },
      expect.objectContaining({
        type: "tool_approval_needed",
        partId: "part-test",
      }),
    ])
    expect(identities).toEqual(["turn-test:run-test"])
    expect(approvals).toEqual([{
      approvalId: "approval-test",
      turnId: "turn-test",
      runId: "run-test",
      toolName: "Bash",
      redactedSummary: "Run tests",
    }])
    expect(acknowledgedSequences).toEqual([1, 2, 3, 4, 5, 6])
    expect(requests.at(-1)).toContain("afterSequence=0")
  })

  it("uses v2 commands for explicit interruption and approval resolution", async () => {
    const commands: unknown[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const command = JSON.parse(String(init?.body)) as Record<string, unknown>
        commands.push(command)
        if (command.type === "interrupt_turn") {
          return Response.json({
            version: PROTOCOL_VERSION,
            commandId: command.commandId,
            sessionId: "session-test",
            accepted: true,
            type: "interrupt_turn",
            expectedTurnId: "turn-test",
            interrupted: true,
          })
        }
        return Response.json({
          version: PROTOCOL_VERSION,
          commandId: command.commandId,
          sessionId: "session-test",
          accepted: true,
          type: "resolve_approval",
          approvalId: "approval-test",
          expectedTurnId: "turn-test",
          status: "denied",
        })
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    await expect(
      client.interruptSessionTurn(
        "session-test",
        "turn-test",
        "user requested stop",
      ),
    ).resolves.toBe(true)
    await client.resolveSessionApproval(
      "session-test",
      "turn-test",
      "approval-test",
      { approved: false },
    )

    expect(commands).toEqual([
      expect.objectContaining({
        version: PROTOCOL_VERSION,
        type: "interrupt_turn",
        expectedTurnId: "turn-test",
        reason: "user requested stop",
      }),
      expect.objectContaining({
        version: PROTOCOL_VERSION,
        type: "resolve_approval",
        expectedTurnId: "turn-test",
        approvalId: "approval-test",
        status: "denied",
      }),
    ])
  })

  it("reattaches the exact active turn from its durable first sequence without starting another turn", async () => {
    const requests: Array<{ url: string; method: string }> = []
    const turn = { turnId: "turn-active", runId: "run-active" }
    const events = [
      envelope(3, {
        type: "turn_started",
        ...turn,
        configEpoch: 1,
        contextEpoch: 2,
        execution: { mode: "agent" },
      }, turn),
      envelope(4, {
        type: "agent_event",
        event: {
          type: "text_delta",
          delta: "persisted",
          messageId: "message-active",
        },
      }, turn),
      envelope(5, {
        type: "approval_requested",
        approvalId: "approval-active",
        toolName: "Bash",
        redactedSummary: "Run focused tests",
      }, turn),
      envelope(6, {
        type: "agent_event",
        event: {
          type: "tool_approval_needed",
          partId: "part-active",
          action: {
            type: "command",
            tool: "Bash",
            description: "Run focused tests",
          },
        },
      }, turn),
      envelope(7, {
        type: "turn_finished",
        status: "completed",
      }, turn),
    ]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        requests.push({ url, method: init?.method ?? "GET" })
        if (url.endsWith("/snapshot")) {
          return Response.json({
            version: PROTOCOL_VERSION,
            sessionId: "session-test",
            phase: "waiting_approval",
            activeTurnId: turn.turnId,
            activeRunId: turn.runId,
            activeTurnFirstSequence: 3,
            activeExecution: { mode: "agent" },
            pendingApprovals: [{
              approvalId: "approval-active",
              turnId: turn.turnId,
              toolName: "Bash",
              redactedSummary: "Run focused tests",
            }],
            pendingQueueCount: 0,
            pendingSteerCount: 0,
            earliestAvailableSequence: 1,
            throughSequence: 6,
          })
        }
        expect(url).toContain("afterSequence=2")
        return ndjson(events)
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })
    const identities: unknown[] = []
    const approvals: unknown[] = []
    const acknowledgedSequences: number[] = []
    const agentEvents = []

    for await (const event of client.attachSessionTurn({
      sessionId: "session-test",
      ...turn,
      afterSequence: 6,
      onTurn: (identity) => identities.push(identity),
      onApproval: (identity) => approvals.push(identity),
      onSequence: (sequence) => {
        acknowledgedSequences.push(sequence)
      },
    })) {
      agentEvents.push(event)
    }

    expect(agentEvents).toEqual([
      expect.objectContaining({
        type: "tool_approval_needed",
        partId: "part-active",
      }),
    ])
    expect(identities).toEqual([turn])
    expect(approvals).toEqual([{
      ...turn,
      approvalId: "approval-active",
      toolName: "Bash",
      redactedSummary: "Run focused tests",
    }])
    expect(acknowledgedSequences).toEqual([3, 4, 5, 6, 7])
    expect(requests).toHaveLength(2)
    expect(requests.every((request) => request.method === "GET")).toBe(true)
  })

  it("resumes after an acknowledged cursor and observes a finish racing the snapshot", async () => {
    const turn = { turnId: "turn-race", runId: "run-race" }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith("/snapshot")) {
          return Response.json({
            version: PROTOCOL_VERSION,
            sessionId: "session-test",
            phase: "streaming",
            activeTurnId: turn.turnId,
            activeRunId: turn.runId,
            activeTurnFirstSequence: 3,
            activeExecution: { mode: "agent" },
            pendingApprovals: [],
            pendingQueueCount: 0,
            pendingSteerCount: 0,
            earliestAvailableSequence: 1,
            throughSequence: 8,
          })
        }
        expect(url).toContain("afterSequence=8")
        return ndjson([
          envelope(9, {
            type: "turn_finished",
            status: "completed",
          }, turn),
        ])
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    const events = []
    for await (const event of client.attachSessionTurn({
      sessionId: "session-test",
      ...turn,
      afterSequence: 8,
    })) {
      events.push(event)
    }
    expect(events).toEqual([])
  })

  it("refuses to attach a replaced or already-finished turn and never creates a new one", async () => {
    const requests: Array<{ url: string; method: string }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
        })
        return Response.json({
          version: PROTOCOL_VERSION,
          sessionId: "session-test",
          phase: "streaming",
          activeTurnId: "turn-replacement",
          activeRunId: "run-replacement",
          activeTurnFirstSequence: 10,
          activeExecution: { mode: "agent" },
          pendingApprovals: [],
          pendingQueueCount: 0,
          pendingSteerCount: 0,
          earliestAvailableSequence: 1,
          throughSequence: 12,
        })
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })
    const consume = async () => {
      for await (const _event of client.attachSessionTurn({
        sessionId: "session-test",
        turnId: "turn-original",
        runId: "run-original",
      })) {
        // Drain.
      }
    }

    await expect(consume()).rejects.toMatchObject({
      name: "SessionProtocolError",
      protocolError: { code: "turn_conflict", retryable: false },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe("GET")
  })

  it("rejects a non-contiguous or malformed durable event stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjson([
        envelope(2, {
          type: "phase_changed",
          phase: "streaming",
        }, { turnId: "turn-test", runId: "run-test" }),
      ])),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    const consume = async () => {
      for await (const _event of client.streamSessionEvents(
        "session-test",
        0,
      )) {
        // Drain.
      }
    }

    await expect(consume()).rejects.toThrow(/contiguous/i)
  })

  it("does not swallow a durable failed turn", async () => {
    const turn = { turnId: "turn-failed", runId: "run-failed" }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith("/snapshot")) {
          return Response.json({
            version: PROTOCOL_VERSION,
            sessionId: "session-test",
            phase: "idle",
            pendingApprovals: [],
            pendingQueueCount: 0,
            pendingSteerCount: 0,
            earliestAvailableSequence: 1,
            throughSequence: 0,
          })
        }
        if (url.endsWith("/command")) {
          const command = JSON.parse(String(init?.body)) as {
            commandId: string
            inputId: string
          }
          return Response.json({
            version: PROTOCOL_VERSION,
            commandId: command.commandId,
            sessionId: "session-test",
            accepted: true,
            type: "start_turn",
            inputId: command.inputId,
            ...turn,
            started: true,
          })
        }
        return ndjson([
          envelope(1, {
            type: "turn_finished",
            status: "failed",
            error: "provider rejected the request",
          }, turn),
        ])
      }),
    )
    const client = new NexusServerClient({
      baseUrl: "http://127.0.0.1:4097",
      directory: process.cwd(),
      token: "secret-token",
    })

    const consume = async () => {
      for await (const _event of client.runSessionTurn({
        sessionId: "session-test",
        input: [{ type: "text", text: "hello" }],
        mode: "agent",
      })) {
        // Drain.
      }
    }

    await expect(consume()).rejects.toThrow("provider rejected the request")
  })
})
