import { z } from "zod"

import {
  FiniteNumberSchema,
  IdentifierSchema,
  ModeSchema,
  NonnegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  PROTOCOL_VERSION,
  ProtocolErrorSchema,
  TurnExecutionSnapshotSchema,
} from "./commands.js"

export {
  InterruptTurnCommandSchema,
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGES_PER_INPUT,
  MAX_INPUT_PARTS,
  MAX_USER_INPUT_TEXT_CHARS,
  ModeSchema,
  ModelSelectionSchema,
  parseSessionCommand,
  PROTOCOL_VERSION,
  ProtocolErrorCodeSchema,
  ProtocolErrorSchema,
  QueueTurnCommandSchema,
  ResolveApprovalCommandSchema,
  SessionCommandSchema,
  SessionProtocolError,
  StartTurnCommandSchema,
  SteerTurnCommandSchema,
  TurnExecutionSnapshotSchema,
  UserInputPartSchema,
} from "./commands.js"
export type {
  ParseSessionCommandResult,
  ProtocolError,
  SessionCommandV2,
  UserInputPartV2,
} from "./commands.js"

export const MAX_AGENT_EVENT_JSON_CHARS = 256 * 1024

const PhaseSchema = z.enum([
  "idle",
  "preparing",
  "streaming",
  "waiting_approval",
  "executing_tools",
  "compacting",
  "settling",
  "failed",
  "interrupted",
])

const LegacyEventIdentifierSchema = z.string().min(1).max(4096)
const LegacyEventRecordSchema = z.record(z.string(), z.unknown())
const LegacyEventTextSchema = z.string().max(MAX_AGENT_EVENT_JSON_CHARS)
const LegacyEventRequiredValueSchema = z
  .unknown()
  .refine((value) => value !== undefined, "Required")

export const PendingSessionApprovalSchema = z
  .object({
    approvalId: IdentifierSchema,
    turnId: IdentifierSchema,
    toolName: z.string().min(1).max(256),
    redactedSummary: z.string().min(1).max(20_000),
  })
  .strict()

const PendingSessionApprovalsSchema = z
  .array(PendingSessionApprovalSchema)
  .max(1024)

const LegacyAgentEventValueSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("assistant_message_started"),
      messageId: LegacyEventIdentifierSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("assistant_content_complete"),
      messageId: LegacyEventIdentifierSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("text_delta"),
      delta: LegacyEventTextSchema,
      messageId: LegacyEventIdentifierSchema,
      user_message_delta: LegacyEventTextSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("reasoning_start"),
      messageId: LegacyEventIdentifierSchema,
      reasoningId: LegacyEventIdentifierSchema,
      providerMetadata: LegacyEventRecordSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("reasoning_delta"),
      delta: LegacyEventTextSchema,
      messageId: LegacyEventIdentifierSchema,
      reasoningId: LegacyEventIdentifierSchema.optional(),
      providerMetadata: LegacyEventRecordSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("reasoning_end"),
      messageId: LegacyEventIdentifierSchema,
      reasoningId: LegacyEventIdentifierSchema.optional(),
      providerMetadata: LegacyEventRecordSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("tool_start"),
      tool: LegacyEventIdentifierSchema,
      partId: LegacyEventIdentifierSchema,
      messageId: LegacyEventIdentifierSchema,
      input: LegacyEventRecordSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("tool_end"),
      tool: LegacyEventIdentifierSchema,
      partId: LegacyEventIdentifierSchema,
      messageId: LegacyEventIdentifierSchema,
      success: z.boolean(),
      output: LegacyEventTextSchema.optional(),
      error: LegacyEventTextSchema.optional(),
      attachments: z.array(z.unknown()).optional(),
      compacted: z.boolean().optional(),
      path: LegacyEventTextSchema.optional(),
      writtenContent: LegacyEventTextSchema.optional(),
      diffStats: z
        .object({
          added: NonnegativeSafeIntegerSchema,
          removed: NonnegativeSafeIntegerSchema,
        })
        .strict()
        .optional(),
      diffHunks: z
        .array(
          z
            .object({
              type: LegacyEventIdentifierSchema,
              lineNum: NonnegativeSafeIntegerSchema,
              line: LegacyEventTextSchema,
            })
            .strict(),
        )
        .optional(),
      appliedReplacements: z
        .array(
          z
            .object({
              oldSnippet: LegacyEventTextSchema,
              newSnippet: LegacyEventTextSchema,
            })
            .strict(),
        )
        .optional(),
      metadata: LegacyEventRecordSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("subagent_start"),
      subagentId: LegacyEventIdentifierSchema,
      mode: ModeSchema,
      task: LegacyEventTextSchema,
      parentPartId: LegacyEventIdentifierSchema.optional(),
      depth: NonnegativeSafeIntegerSchema.optional(),
      parentSubagentId: LegacyEventIdentifierSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("subagent_tool_start"),
      subagentId: LegacyEventIdentifierSchema,
      tool: LegacyEventIdentifierSchema,
      input: LegacyEventRecordSchema.optional(),
      parentPartId: LegacyEventIdentifierSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("subagent_tool_end"),
      subagentId: LegacyEventIdentifierSchema,
      tool: LegacyEventIdentifierSchema,
      success: z.boolean(),
      parentPartId: LegacyEventIdentifierSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("subagent_done"),
      subagentId: LegacyEventIdentifierSchema,
      success: z.boolean(),
      outputPreview: LegacyEventTextSchema.optional(),
      error: LegacyEventTextSchema.optional(),
      parentPartId: LegacyEventIdentifierSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("tool_approval_needed"),
      action: LegacyEventRequiredValueSchema,
      partId: LegacyEventIdentifierSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("question_request"),
      request: LegacyEventRequiredValueSchema,
      partId: LegacyEventIdentifierSchema.optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("compaction_start") }).passthrough(),
  z.object({ type: z.literal("compaction_end") }).passthrough(),
  z
    .object({
      type: z.literal("run_context"),
      mode: ModeSchema,
      memoryCitations: z.array(LegacyEventTextSchema),
      taskIds: z.array(LegacyEventIdentifierSchema),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("index_update"),
      status: LegacyEventRequiredValueSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("vector_db_progress"),
      message: LegacyEventTextSchema.optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("vector_db_ready") }).passthrough(),
  z
    .object({
      type: z.literal("session_saved"),
      sessionId: LegacyEventIdentifierSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("context_usage"),
      usedTokens: NonnegativeSafeIntegerSchema,
      limitTokens: NonnegativeSafeIntegerSchema,
      percent: FiniteNumberSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("error"),
      error: LegacyEventTextSchema,
      fatal: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("done"),
      messageId: LegacyEventIdentifierSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("todo_updated"),
      todo: LegacyEventTextSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("doom_loop_detected"),
      tool: LegacyEventIdentifierSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("plan_followup_ask"),
      planText: LegacyEventTextSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("task_created"),
      task: LegacyEventRequiredValueSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("task_updated"),
      task: LegacyEventRequiredValueSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("task_progress"),
      task: LegacyEventRequiredValueSchema,
      outputPreview: LegacyEventTextSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("task_tool_start"),
      taskId: LegacyEventIdentifierSchema,
      taskKind: z.enum([
        "agent",
        "shell",
        "tracking",
        "workflow",
        "external",
      ]),
      tool: LegacyEventIdentifierSchema,
      input: LegacyEventRecordSchema.optional(),
      parentPartId: LegacyEventIdentifierSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("task_tool_end"),
      taskId: LegacyEventIdentifierSchema,
      taskKind: z.enum([
        "agent",
        "shell",
        "tracking",
        "workflow",
        "external",
      ]),
      tool: LegacyEventIdentifierSchema,
      success: z.boolean(),
      parentPartId: LegacyEventIdentifierSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("task_completed"),
      task: LegacyEventRequiredValueSchema,
      outputPreview: LegacyEventTextSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("team_updated"),
      team: LegacyEventRequiredValueSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("team_message"),
      message: LegacyEventRequiredValueSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("background_task_updated"),
      task: LegacyEventRequiredValueSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("remote_session_updated"),
      remoteSession: LegacyEventRequiredValueSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("plugin_hook"),
      pluginName: LegacyEventIdentifierSchema,
      hookEvent: LegacyEventIdentifierSchema,
      output: LegacyEventTextSchema,
      success: z.boolean(),
    })
    .passthrough(),
])

function isBoundedJsonValue(value: unknown, maximumChars: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ]
  const seen = new WeakSet<object>()
  let visitedNodes = 0

  try {
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) break
      const item = current.value
      visitedNodes += 1
      if (visitedNodes > 100_000 || current.depth > 128) return false
      if (
        item === null ||
        typeof item === "string" ||
        typeof item === "boolean"
      ) {
        continue
      }
      if (typeof item === "number") {
        if (!Number.isFinite(item)) return false
        continue
      }
      if (typeof item !== "object") return false

      if (seen.has(item)) return false
      seen.add(item)
      const prototype = Object.getPrototypeOf(item)
      if (
        !Array.isArray(item) &&
        prototype !== Object.prototype &&
        prototype !== null
      ) {
        return false
      }
      const descriptors = Object.getOwnPropertyDescriptors(item)
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === "symbol") return false
        const descriptor = descriptors[key]
        if (!descriptor || !("value" in descriptor)) return false
        stack.push({
          value: descriptor.value,
          depth: current.depth + 1,
        })
      }
    }
    const serialized = JSON.stringify(value)
    return serialized !== undefined && serialized.length <= maximumChars
  } catch {
    return false
  }
}

export const LegacyAgentEventSchema = LegacyAgentEventValueSchema.superRefine(
  (event, context) => {
    if (!isBoundedJsonValue(event, MAX_AGENT_EVENT_JSON_CHARS)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Legacy agent event must be JSON-safe and at most ` +
          `${MAX_AGENT_EVENT_JSON_CHARS} serialized characters`,
      })
    }
  },
)

export const ProtocolPayloadSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("input_admitted"),
      inputId: IdentifierSchema,
      reservedTurnId: IdentifierSchema,
      reservedRunId: IdentifierSchema,
      delivery: z.enum(["steer", "queue"]),
      expectedTurnId: IdentifierSchema.optional(),
      admittedSequence: PositiveSafeIntegerSchema,
      execution: TurnExecutionSnapshotSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("turn_started"),
      turnId: IdentifierSchema,
      runId: IdentifierSchema,
      configEpoch: NonnegativeSafeIntegerSchema,
      contextEpoch: NonnegativeSafeIntegerSchema,
      execution: TurnExecutionSnapshotSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("phase_changed"),
      phase: PhaseSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("steering_promoted"),
      inputIds: z.array(IdentifierSchema).min(1).max(1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("steering_requeued"),
      inputIds: z.array(IdentifierSchema).min(1).max(1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("interrupt_requested"),
      reason: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("approval_requested"),
      approvalId: IdentifierSchema,
      toolName: z.string().min(1).max(256),
      redactedSummary: z.string().min(1).max(20_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("approval_resolved"),
      approvalId: IdentifierSchema,
      status: z.enum(["approved", "denied", "cancelled"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("agent_event"),
      event: LegacyAgentEventSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("turn_finished"),
      status: z.enum(["completed", "failed", "interrupted"]),
      error: z.string().max(20_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("command_error"),
      commandId: IdentifierSchema,
      error: ProtocolErrorSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("snapshot"),
      phase: PhaseSchema,
      activeTurnId: IdentifierSchema.optional(),
      activeRunId: IdentifierSchema.optional(),
      activeTurnFirstSequence: PositiveSafeIntegerSchema.optional(),
      pendingApprovals: PendingSessionApprovalsSchema,
      pendingQueueCount: NonnegativeSafeIntegerSchema,
      pendingSteerCount: NonnegativeSafeIntegerSchema,
      earliestAvailableSequence: PositiveSafeIntegerSchema,
      throughSequence: NonnegativeSafeIntegerSchema,
    })
    .strict(),
])

export const ProtocolPersistenceSchema = z
  .object({
    state: z.literal("committed"),
    rollout: z.enum(["pending", "projected", "not_applicable"]),
  })
  .strict()

const RunScopedPayloadTypes = new Set([
  "input_admitted",
  "turn_started",
  "phase_changed",
  "steering_promoted",
  "steering_requeued",
  "interrupt_requested",
  "approval_requested",
  "approval_resolved",
  "agent_event",
  "turn_finished",
])

export const ProtocolEnvelopeSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    eventId: IdentifierSchema,
    runId: IdentifierSchema.optional(),
    sequence: PositiveSafeIntegerSchema,
    sessionId: IdentifierSchema,
    turnId: IdentifierSchema.optional(),
    parentEventId: IdentifierSchema.optional(),
    emittedAt: NonnegativeSafeIntegerSchema,
    persistence: ProtocolPersistenceSchema,
    payload: ProtocolPayloadSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    if (
      RunScopedPayloadTypes.has(envelope.payload.type) &&
      (envelope.turnId === undefined || envelope.runId === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: envelope.turnId === undefined ? ["turnId"] : ["runId"],
        message: `${envelope.payload.type} events require turnId and runId`,
      })
    }
    if (
      !RunScopedPayloadTypes.has(envelope.payload.type) &&
      (envelope.turnId !== undefined || envelope.runId !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runId"],
        message: `${envelope.payload.type} events are session-scoped`,
      })
    }
    if (
      envelope.payload.type === "turn_started" &&
      (envelope.turnId !== envelope.payload.turnId ||
        envelope.runId !== envelope.payload.runId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["turnId"],
        message: "Envelope turnId/runId must match the started turn",
      })
    }
    if (
      envelope.payload.type === "input_admitted" &&
      (envelope.turnId !== envelope.payload.reservedTurnId ||
        envelope.runId !== envelope.payload.reservedRunId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["turnId"],
        message: "Envelope turnId/runId must match the admitted reservation",
      })
    }
    if (
      envelope.payload.type === "input_admitted" &&
      ((envelope.payload.delivery === "steer" &&
        envelope.payload.expectedTurnId === undefined) ||
        (envelope.payload.delivery === "queue" &&
          envelope.payload.expectedTurnId !== undefined))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "expectedTurnId"],
        message:
          "Only steering admission requires an expected active turn identity",
      })
    }
    if (envelope.payload.type === "snapshot") {
      const approvalIds = new Set<string>()
      if (
        (envelope.payload.activeTurnId === undefined) !==
        (envelope.payload.activeRunId === undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "activeRunId"],
          message: "Snapshot active turn/run identities must be paired",
        })
      }
      const hasActiveTurn =
        envelope.payload.activeTurnId !== undefined &&
        envelope.payload.activeRunId !== undefined
      if (
        hasActiveTurn !==
        (envelope.payload.activeTurnFirstSequence !== undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "activeTurnFirstSequence"],
          message:
            "Snapshot active turn identity requires its first durable sequence",
        })
      }
      if (
        envelope.payload.activeTurnFirstSequence !== undefined &&
        (
          envelope.payload.activeTurnFirstSequence <
            envelope.payload.earliestAvailableSequence ||
          envelope.payload.activeTurnFirstSequence >
            envelope.payload.throughSequence
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "activeTurnFirstSequence"],
          message:
            "Snapshot active turn first sequence must be inside the replay window",
        })
      }
      for (const [index, approval] of
        envelope.payload.pendingApprovals.entries()) {
        if (approvalIds.has(approval.approvalId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["payload", "pendingApprovals", index, "approvalId"],
            message: "Snapshot pending approval identities must be unique",
          })
        }
        approvalIds.add(approval.approvalId)
        if (approval.turnId !== envelope.payload.activeTurnId) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["payload", "pendingApprovals", index, "turnId"],
            message:
              "Snapshot pending approvals must belong to the active turn",
          })
        }
      }
      if (
        envelope.payload.earliestAvailableSequence >
        envelope.payload.throughSequence + 1
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "earliestAvailableSequence"],
          message: "Snapshot replay window is not contiguous",
        })
      }
    }
  })

const ReceiptBaseShape = {
  version: z.literal(PROTOCOL_VERSION),
  commandId: IdentifierSchema,
  sessionId: IdentifierSchema,
  accepted: z.literal(true),
} as const

export const StartTurnReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    type: z.literal("start_turn"),
    inputId: IdentifierSchema,
    turnId: IdentifierSchema,
    runId: IdentifierSchema,
    started: z.boolean(),
  })
  .strict()

export const QueueTurnReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    type: z.literal("queue_turn"),
    inputId: IdentifierSchema,
    turnId: IdentifierSchema,
    runId: IdentifierSchema,
  })
  .strict()

export const SteerTurnReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    type: z.literal("steer_turn"),
    inputId: IdentifierSchema,
    expectedTurnId: IdentifierSchema,
    reservedTurnId: IdentifierSchema,
    reservedRunId: IdentifierSchema,
  })
  .strict()

export const InterruptTurnReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    type: z.literal("interrupt_turn"),
    expectedTurnId: IdentifierSchema,
    interrupted: z.boolean(),
  })
  .strict()

export const ResolveApprovalReceiptSchema = z
  .object({
    ...ReceiptBaseShape,
    type: z.literal("resolve_approval"),
    approvalId: IdentifierSchema,
    expectedTurnId: IdentifierSchema,
    status: z.enum(["approved", "denied"]),
  })
  .strict()

export const SessionCommandReceiptSchema = z.discriminatedUnion("type", [
  StartTurnReceiptSchema,
  QueueTurnReceiptSchema,
  SteerTurnReceiptSchema,
  InterruptTurnReceiptSchema,
  ResolveApprovalReceiptSchema,
])

export const SessionProtocolSnapshotSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    sessionId: IdentifierSchema,
    phase: PhaseSchema,
    activeTurnId: IdentifierSchema.optional(),
    activeRunId: IdentifierSchema.optional(),
    activeTurnFirstSequence: PositiveSafeIntegerSchema.optional(),
    activeExecution: TurnExecutionSnapshotSchema.optional(),
    pendingApprovals: PendingSessionApprovalsSchema,
    pendingQueueCount: NonnegativeSafeIntegerSchema,
    pendingSteerCount: NonnegativeSafeIntegerSchema,
    earliestAvailableSequence: PositiveSafeIntegerSchema,
    throughSequence: NonnegativeSafeIntegerSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const approvalIds = new Set<string>()
    if (
      (snapshot.activeTurnId === undefined) !==
      (snapshot.activeRunId === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeRunId"],
        message: "Snapshot active turn/run identities must be paired",
      })
    }
    const hasActiveTurn =
      snapshot.activeTurnId !== undefined &&
      snapshot.activeRunId !== undefined
    if (
      hasActiveTurn !== (snapshot.activeTurnFirstSequence !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeTurnFirstSequence"],
        message:
          "Snapshot active turn identity requires its first durable sequence",
      })
    }
    if (hasActiveTurn !== (snapshot.activeExecution !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeExecution"],
        message:
          "Snapshot active turn identity requires its immutable execution snapshot",
      })
    }
    if (
      snapshot.activeTurnFirstSequence !== undefined &&
      (
        snapshot.activeTurnFirstSequence <
          snapshot.earliestAvailableSequence ||
        snapshot.activeTurnFirstSequence > snapshot.throughSequence
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeTurnFirstSequence"],
        message:
          "Snapshot active turn first sequence must be inside the replay window",
      })
    }
    for (const [index, approval] of snapshot.pendingApprovals.entries()) {
      if (approvalIds.has(approval.approvalId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pendingApprovals", index, "approvalId"],
          message: "Snapshot pending approval identities must be unique",
        })
      }
      approvalIds.add(approval.approvalId)
      if (approval.turnId !== snapshot.activeTurnId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pendingApprovals", index, "turnId"],
          message: "Snapshot pending approvals must belong to the active turn",
        })
      }
    }
    if (
      snapshot.earliestAvailableSequence >
      snapshot.throughSequence + 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["earliestAvailableSequence"],
        message: "Snapshot replay window is not contiguous",
      })
    }
  })

export type ProtocolEnvelope = z.infer<typeof ProtocolEnvelopeSchema>
export type SessionCommandReceipt = z.infer<
  typeof SessionCommandReceiptSchema
>
export type SessionProtocolSnapshot = z.infer<
  typeof SessionProtocolSnapshotSchema
>
export type PendingSessionApproval = z.infer<
  typeof PendingSessionApprovalSchema
>
