import { describe, expect, it } from "vitest"
import {
  MAX_IMAGE_BASE64_CHARS,
  MAX_USER_INPUT_TEXT_CHARS,
  PROTOCOL_VERSION,
  ProtocolEnvelopeSchema,
  ProtocolPayloadSchema,
  SessionCommandReceiptSchema,
  SessionCommandSchema,
  SessionProtocolSnapshotSchema,
  parseSessionCommand,
} from "./v2.js"

const base = {
  version: PROTOCOL_VERSION,
  commandId: "command-1",
  sessionId: "session-1",
}

describe("protocol v2", () => {
  it("round-trips typed input and a non-secret stable model selection", () => {
    const command = SessionCommandSchema.parse({
      ...base,
      type: "start_turn",
      inputId: "input-1",
      mode: "agent",
      input: [
        { type: "text", text: "inspect this" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        { type: "mention", name: "config", path: "src/config.ts" },
        { type: "skill", name: "review" },
      ],
      selection: {
        profileId: "profile-main",
        selectionEpoch: 4,
      },
    })

    expect(command).toMatchObject({
      type: "start_turn",
      mode: "agent",
      selection: {
        profileId: "profile-main",
        selectionEpoch: 4,
      },
    })
    if (command.type !== "start_turn") {
      throw new Error("Expected a start_turn command")
    }
    expect(command.input.map((part) => part.type)).toEqual([
      "text",
      "image",
      "mention",
      "skill",
    ])
    expect(JSON.parse(JSON.stringify(command))).toEqual(command)
    expect("apiKey" in command).toBe(false)
  })

  it("rejects malformed and oversized images before runtime admission", () => {
    const malformed = parseSessionCommand({
      ...base,
      type: "queue_turn",
      inputId: "input-malformed",
      mode: "agent",
      input: [{ type: "image", mimeType: "image/png", data: "not base64!" }],
    })
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: "invalid_command" },
    })

    const oversized = parseSessionCommand({
      ...base,
      commandId: "command-2",
      type: "queue_turn",
      inputId: "input-large",
      mode: "agent",
      input: [
        {
          type: "image",
          mimeType: "image/png",
          data: "A".repeat(MAX_IMAGE_BASE64_CHARS + 4),
        },
      ],
    })
    expect(oversized).toMatchObject({
      ok: false,
      error: {
        code: "input_too_large",
        details: { limit: MAX_IMAGE_BASE64_CHARS },
      },
    })
  })

  it("rejects aggregate text over the Codex-compatible input bound", () => {
    const result = parseSessionCommand({
      ...base,
      type: "steer_turn",
      inputId: "steer-large",
      expectedTurnId: "turn-1",
      input: [
        { type: "text", text: "a".repeat(MAX_USER_INPUT_TEXT_CHARS / 2) },
        { type: "text", text: "b".repeat(MAX_USER_INPUT_TEXT_CHARS / 2 + 1) },
      ],
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "input_too_large",
        details: {
          limit: MAX_USER_INPUT_TEXT_CHARS,
          actual: MAX_USER_INPUT_TEXT_CHARS + 1,
        },
      },
    })
  })

  it("returns a structured unsupported-version error", () => {
    expect(
      parseSessionCommand({
        ...base,
        version: 3,
        type: "interrupt_turn",
        expectedTurnId: "turn-1",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "unsupported_version",
        message: "Unsupported Nexus protocol version 3",
        retryable: false,
        details: {
          supportedVersions: [PROTOCOL_VERSION],
          receivedVersion: 3,
        },
      },
    })
  })

  it("requires expectedTurnId for steering and forbids secret-shaped fields", () => {
    expect(
      SessionCommandSchema.safeParse({
        ...base,
        type: "steer_turn",
        inputId: "steer-1",
        input: [{ type: "text", text: "change course" }],
      }).success,
    ).toBe(false)
    expect(
      SessionCommandSchema.safeParse({
        ...base,
        type: "start_turn",
        inputId: "turn-1",
        mode: "agent",
        input: [{ type: "text", text: "hello" }],
        apiKey: "must-never-cross-transport",
      }).success,
    ).toBe(false)
  })

  it("requires expectedTurnId for external interrupt commands", () => {
    expect(
      SessionCommandSchema.safeParse({
        ...base,
        type: "interrupt_turn",
        reason: "stop now",
      }).success,
    ).toBe(false)
    expect(
      SessionCommandSchema.safeParse({
        ...base,
        type: "interrupt_turn",
        expectedTurnId: "turn-1",
        reason: "stop now",
      }).success,
    ).toBe(true)
  })

  it("uses command-discriminated receipts with complete durable identities", () => {
    const startReceipt = {
      version: PROTOCOL_VERSION,
      type: "start_turn",
      commandId: "command-start",
      sessionId: "session-1",
      accepted: true,
      inputId: "input-1",
      turnId: "turn-1",
      runId: "run-1",
      started: true,
    } as const
    const interruptReceipt = {
      version: PROTOCOL_VERSION,
      type: "interrupt_turn",
      commandId: "command-interrupt",
      sessionId: "session-1",
      accepted: true,
      expectedTurnId: "turn-1",
      interrupted: true,
    } as const

    expect(SessionCommandReceiptSchema.safeParse(startReceipt).success).toBe(
      true,
    )
    expect(
      SessionCommandReceiptSchema.safeParse(interruptReceipt).success,
    ).toBe(true)
    expect(
      SessionCommandReceiptSchema.safeParse({
        ...startReceipt,
        runId: undefined,
      }).success,
    ).toBe(false)
    expect(
      SessionCommandReceiptSchema.safeParse({
        version: PROTOCOL_VERSION,
        commandId: "command-ambiguous",
        sessionId: "session-1",
        accepted: true,
        inputId: "input-1",
      }).success,
    ).toBe(false)
    expect(
      SessionCommandReceiptSchema.safeParse({
        ...interruptReceipt,
        inputId: "must-not-leak-from-another-receipt-kind",
      }).success,
    ).toBe(false)
  })

  it("rejects unsafe integer epochs, sequences, timestamps, and counters", () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1

    expect(
      SessionCommandSchema.safeParse({
        ...base,
        type: "start_turn",
        inputId: "turn-unsafe-selection",
        mode: "agent",
        input: [{ type: "text", text: "hello" }],
        selection: {
          profileId: "profile-main",
          selectionEpoch: unsafeInteger,
        },
      }).success,
    ).toBe(false)

    expect(
      ProtocolEnvelopeSchema.safeParse({
        version: PROTOCOL_VERSION,
        sequence: unsafeInteger,
        sessionId: "session-1",
        turnId: "turn-1",
        emittedAt: unsafeInteger,
        payload: {
          type: "snapshot",
          phase: "idle",
          pendingApprovals: [],
          pendingQueueCount: unsafeInteger,
          pendingSteerCount: 0,
        },
      }).success,
    ).toBe(false)
  })

  it("requires durable event identity and turn scope in reconnect envelopes", () => {
    const durableEnvelope = {
      version: PROTOCOL_VERSION,
      eventId: "event-12",
      runId: "run-1",
      sequence: 12,
      sessionId: "session-1",
      turnId: "turn-1",
      parentEventId: "event-11",
      emittedAt: 1234,
      persistence: {
        state: "committed",
        rollout: "projected",
      },
      payload: {
        type: "phase_changed",
        phase: "streaming",
      },
    } as const

    expect(ProtocolEnvelopeSchema.safeParse(durableEnvelope).success).toBe(true)
    expect(
      ProtocolEnvelopeSchema.safeParse({
        ...durableEnvelope,
        eventId: undefined,
      }).success,
    ).toBe(false)
    expect(
      ProtocolEnvelopeSchema.safeParse({
        ...durableEnvelope,
        turnId: undefined,
      }).success,
    ).toBe(false)
    expect(
      ProtocolEnvelopeSchema.safeParse({
        ...durableEnvelope,
        turnId: "turn-2",
        payload: {
          type: "turn_started",
          turnId: "turn-1",
          runId: "run-1",
          configEpoch: 1,
          contextEpoch: 1,
          execution: {
            mode: "agent",
          },
        },
      }).success,
    ).toBe(false)
    expect(
      ProtocolEnvelopeSchema.safeParse({
        ...durableEnvelope,
        payload: {
          type: "turn_started",
          turnId: "turn-1",
          runId: "run-1",
          configEpoch: 1,
          contextEpoch: 1,
        },
      }).success,
    ).toBe(false)
    expect(
      ProtocolEnvelopeSchema.safeParse({
        ...durableEnvelope,
        turnId: undefined,
        runId: undefined,
        payload: {
          type: "snapshot",
          phase: "idle",
          pendingApprovals: [],
          pendingQueueCount: 0,
          pendingSteerCount: 0,
          earliestAvailableSequence: 1,
          throughSequence: 12,
        },
      }).success,
    ).toBe(true)
  })

  it("binds admitted and started envelopes to explicit durable turn/run identities", () => {
    const admitted = {
      version: PROTOCOL_VERSION,
      eventId: "event-admitted",
      sequence: 1,
      sessionId: "session-1",
      turnId: "turn-reserved",
      runId: "run-reserved",
      emittedAt: 100,
      persistence: {
        state: "committed",
        rollout: "pending",
      },
      payload: {
        type: "input_admitted",
        inputId: "input-1",
        reservedTurnId: "turn-reserved",
        reservedRunId: "run-reserved",
        delivery: "queue",
        admittedSequence: 1,
        execution: { mode: "agent" },
      },
    } as const
    const started = {
      ...admitted,
      eventId: "event-started",
      sequence: 2,
      persistence: {
        state: "committed",
        rollout: "projected",
      },
      payload: {
        type: "turn_started",
        turnId: "turn-reserved",
        runId: "run-reserved",
        configEpoch: 2,
        contextEpoch: 3,
        execution: { mode: "agent" },
      },
    } as const

    expect(ProtocolEnvelopeSchema.safeParse(admitted).success).toBe(true)
    expect(ProtocolEnvelopeSchema.safeParse(started).success).toBe(true)
    expect(
      ProtocolEnvelopeSchema.safeParse({
        ...admitted,
        runId: "run-other",
      }).success,
    ).toBe(false)
    expect(
      ProtocolEnvelopeSchema.safeParse({
        ...started,
        payload: {
          ...started.payload,
          runId: "run-other",
        },
      }).success,
    ).toBe(false)
  })

  it("omits invented turn/run identities from session-scoped envelopes", () => {
    const snapshot = {
      version: PROTOCOL_VERSION,
      eventId: "event-snapshot",
      sequence: 4,
      sessionId: "session-1",
      emittedAt: 200,
      persistence: {
        state: "committed",
        rollout: "projected",
      },
      payload: {
        type: "snapshot",
        phase: "idle",
        pendingApprovals: [],
        pendingQueueCount: 0,
        pendingSteerCount: 0,
        earliestAvailableSequence: 1,
        throughSequence: 4,
      },
    } as const

    expect(ProtocolEnvelopeSchema.safeParse(snapshot).success).toBe(true)
    expect(
      ProtocolEnvelopeSchema.safeParse({
        ...snapshot,
        runId: "placeholder-run",
        turnId: "placeholder-turn",
      }).success,
    ).toBe(false)
  })

  it("carries a bounded replay window and paired active identities in snapshots", () => {
    const snapshot = {
      version: PROTOCOL_VERSION,
      sessionId: "session-1",
      phase: "streaming",
      activeTurnId: "turn-1",
      activeRunId: "run-1",
      activeTurnFirstSequence: 4,
      activeExecution: {
        mode: "debug",
        selection: {
          profileId: "primary",
          selectionEpoch: 7,
        },
      },
      pendingApprovals: [
        {
          approvalId: "approval-1",
          turnId: "turn-1",
          toolName: "Bash",
          redactedSummary: "Run the focused tests",
        },
      ],
      pendingQueueCount: 2,
      pendingSteerCount: 1,
      earliestAvailableSequence: 3,
      throughSequence: 9,
    } as const

    expect(SessionProtocolSnapshotSchema.safeParse(snapshot).success).toBe(
      true,
    )
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        throughSequence: undefined,
      }).success,
    ).toBe(false)
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        pendingApprovals: undefined,
      }).success,
    ).toBe(false)
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        activeRunId: undefined,
      }).success,
    ).toBe(false)
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        activeTurnFirstSequence: undefined,
      }).success,
    ).toBe(false)
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        activeExecution: undefined,
      }).success,
    ).toBe(false)
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        phase: "idle",
        activeTurnId: undefined,
        activeRunId: undefined,
        activeTurnFirstSequence: undefined,
        activeExecution: undefined,
        pendingApprovals: [],
        earliestAvailableSequence: 11,
        throughSequence: 9,
      }).success,
    ).toBe(false)
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        activeTurnFirstSequence: 2,
      }).success,
    ).toBe(false)
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        activeTurnFirstSequence: 10,
      }).success,
    ).toBe(false)
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        phase: "idle",
        activeTurnId: undefined,
        activeRunId: undefined,
        activeExecution: undefined,
        pendingApprovals: [],
      }).success,
    ).toBe(false)
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        phase: "idle",
        activeTurnId: undefined,
        activeRunId: undefined,
        activeTurnFirstSequence: undefined,
        pendingApprovals: [],
      }).success,
    ).toBe(false)
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        pendingApprovals: [
          {
            approvalId: "approval-1",
            turnId: "turn-other",
            toolName: "Bash",
            redactedSummary: "Run the focused tests",
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      SessionProtocolSnapshotSchema.safeParse({
        ...snapshot,
        pendingApprovals: [
          {
            approvalId: "approval-1",
            turnId: "turn-1",
            toolName: "Bash",
            redactedSummary: "Run the focused tests",
            unredactedParams: { command: "must never cross the protocol" },
          },
        ],
      }).success,
    ).toBe(false)
  })

  it("accepts steering requeues and bounds typed legacy agent events", () => {
    expect(
      ProtocolPayloadSchema.safeParse({
        type: "steering_requeued",
        inputIds: ["steer-1", "steer-2"],
      }).success,
    ).toBe(true)

    expect(
      ProtocolPayloadSchema.safeParse({
        type: "agent_event",
        event: {
          type: "text_delta",
          delta: "hello",
          messageId: "message-1",
        },
      }).success,
    ).toBe(true)
    expect(
      ProtocolPayloadSchema.safeParse({
        type: "agent_event",
        event: {
          type: "text_delta",
          delta: "missing its message identity",
        },
      }).success,
    ).toBe(false)
    expect(
      ProtocolPayloadSchema.safeParse({
        type: "agent_event",
        event: {
          type: "invented_event",
        },
      }).success,
    ).toBe(false)
    expect(
      ProtocolPayloadSchema.safeParse({
        type: "agent_event",
        event: {
          type: "text_delta",
          delta: "x".repeat(300_000),
          messageId: "message-1",
        },
      }).success,
    ).toBe(false)
  })

  it("validates ordered reconnect envelopes and structured errors", () => {
    const event = ProtocolEnvelopeSchema.parse({
      version: PROTOCOL_VERSION,
      eventId: "event-12",
      runId: "run-1",
      sequence: 12,
      sessionId: "session-1",
      turnId: "turn-1",
      emittedAt: 1234,
      persistence: {
        state: "committed",
        rollout: "projected",
      },
      payload: {
        type: "phase_changed",
        phase: "streaming",
      },
    })
    const error = ProtocolEnvelopeSchema.parse({
      version: PROTOCOL_VERSION,
      eventId: "event-13",
      sequence: 13,
      sessionId: "session-1",
      emittedAt: 1235,
      persistence: {
        state: "committed",
        rollout: "projected",
      },
      payload: {
        type: "command_error",
        commandId: "command-1",
        error: {
          code: "turn_conflict",
          message: "Expected turn does not match",
          retryable: false,
        },
      },
    })

    expect(event.sequence).toBe(12)
    expect(error.sequence).toBe(13)
    expect(
      ProtocolEnvelopeSchema.safeParse({ ...event, sequence: 0 }).success,
    ).toBe(false)
  })
})
