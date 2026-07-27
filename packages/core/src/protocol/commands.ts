import { z } from "zod"

export const PROTOCOL_VERSION = 2 as const
export const MAX_USER_INPUT_TEXT_CHARS = 1 << 20
export const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024
export const MAX_INPUT_PARTS = 64
export const MAX_IMAGES_PER_INPUT = 8

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)

export const NonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "Number must be a safe integer")

export const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "Number must be a safe integer")

export const FiniteNumberSchema = z
  .number()
  .refine(Number.isFinite, "Number must be finite")

const ImageMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

function isBase64(value: string): boolean {
  if (value.length > MAX_IMAGE_BASE64_CHARS) return true
  if (value.length === 0 || value.length % 4 !== 0) return false
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
    value,
  )
}

export const UserInputPartSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().min(1).max(MAX_USER_INPUT_TEXT_CHARS),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      mimeType: ImageMimeTypeSchema,
      data: z
        .string()
        .min(1)
        .max(MAX_IMAGE_BASE64_CHARS)
        .refine(isBase64, "Image data must be canonical base64"),
    })
    .strict(),
  z
    .object({
      type: z.literal("mention"),
      name: z.string().trim().min(1).max(256),
      path: z.string().min(1).max(4096).refine((path) => !path.includes("\0"), {
        message: "Mention path cannot contain NUL",
      }),
    })
    .strict(),
  z
    .object({
      type: z.literal("skill"),
      name: z.string().trim().min(1).max(256),
    })
    .strict(),
])

const UserInputSchema = z
  .array(UserInputPartSchema)
  .min(1)
  .max(MAX_INPUT_PARTS)
  .superRefine((parts, context) => {
    let textChars = 0
    let imageCount = 0
    for (const part of parts) {
      if (part.type === "text") textChars += part.text.length
      if (part.type === "image") imageCount++
    }
    if (textChars > MAX_USER_INPUT_TEXT_CHARS) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "string",
        maximum: MAX_USER_INPUT_TEXT_CHARS,
        inclusive: true,
        exact: false,
        message: `Aggregate text exceeds ${MAX_USER_INPUT_TEXT_CHARS} characters`,
      })
    }
    if (imageCount > MAX_IMAGES_PER_INPUT) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: MAX_IMAGES_PER_INPUT,
        inclusive: true,
        exact: false,
        message: `Input contains more than ${MAX_IMAGES_PER_INPUT} images`,
      })
    }
  })

export const ModeSchema = z.enum(["agent", "plan", "ask", "debug", "review"])

export const ModelSelectionSchema = z
  .object({
    profileId: IdentifierSchema,
    selectionEpoch: NonnegativeSafeIntegerSchema,
  })
  .strict()

export const TurnExecutionSnapshotSchema = z
  .object({
    mode: ModeSchema,
    selection: ModelSelectionSchema.optional(),
  })
  .strict()

const CommandBaseShape = {
  version: z.literal(PROTOCOL_VERSION),
  commandId: IdentifierSchema,
  sessionId: IdentifierSchema,
} as const

export const StartTurnCommandSchema = z
  .object({
    ...CommandBaseShape,
    type: z.literal("start_turn"),
    inputId: IdentifierSchema,
    input: UserInputSchema,
    mode: ModeSchema,
    selection: ModelSelectionSchema.optional(),
  })
  .strict()

export const QueueTurnCommandSchema = z
  .object({
    ...CommandBaseShape,
    type: z.literal("queue_turn"),
    inputId: IdentifierSchema,
    input: UserInputSchema,
    mode: ModeSchema,
    selection: ModelSelectionSchema.optional(),
  })
  .strict()

export const SteerTurnCommandSchema = z
  .object({
    ...CommandBaseShape,
    type: z.literal("steer_turn"),
    inputId: IdentifierSchema,
    expectedTurnId: IdentifierSchema,
    input: UserInputSchema,
  })
  .strict()

export const InterruptTurnCommandSchema = z
  .object({
    ...CommandBaseShape,
    type: z.literal("interrupt_turn"),
    expectedTurnId: IdentifierSchema,
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()

export const ResolveApprovalCommandSchema = z
  .object({
    ...CommandBaseShape,
    type: z.literal("resolve_approval"),
    approvalId: IdentifierSchema,
    expectedTurnId: IdentifierSchema,
    status: z.enum(["approved", "denied"]),
  })
  .strict()

export const SessionCommandSchema = z.discriminatedUnion("type", [
  StartTurnCommandSchema,
  QueueTurnCommandSchema,
  SteerTurnCommandSchema,
  InterruptTurnCommandSchema,
  ResolveApprovalCommandSchema,
])

export const ProtocolErrorCodeSchema = z.enum([
  "invalid_command",
  "input_too_large",
  "unsupported_version",
  "idempotency_conflict",
  "no_active_turn",
  "turn_conflict",
  "approval_conflict",
  "selection_conflict",
  "replay_gap",
  "not_found",
  "runtime_unavailable",
  "internal_error",
])

export const ProtocolErrorSchema = z
  .object({
    code: ProtocolErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export type UserInputPartV2 = z.infer<typeof UserInputPartSchema>
export type SessionCommandV2 = z.infer<typeof SessionCommandSchema>
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>

export class SessionProtocolError extends Error {
  readonly protocolError: ProtocolError

  constructor(error: ProtocolError) {
    super(error.message)
    this.name = "SessionProtocolError"
    this.protocolError = ProtocolErrorSchema.parse(error)
  }
}

export type ParseSessionCommandResult =
  | { ok: true; command: SessionCommandV2 }
  | { ok: false; error: ProtocolError }

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function rawInputLimits(
  value: Record<string, unknown>,
): ProtocolError | undefined {
  if (!Array.isArray(value.input)) return undefined
  let textChars = 0
  for (const rawPart of value.input) {
    const part = recordValue(rawPart)
    if (!part) continue
    if (part.type === "text" && typeof part.text === "string") {
      textChars += part.text.length
    }
    if (
      part.type === "image" &&
      typeof part.data === "string" &&
      part.data.length > MAX_IMAGE_BASE64_CHARS
    ) {
      return {
        code: "input_too_large",
        message: `Image exceeds ${MAX_IMAGE_BASE64_CHARS} base64 characters`,
        retryable: false,
        details: {
          kind: "image_base64",
          limit: MAX_IMAGE_BASE64_CHARS,
          actual: part.data.length,
        },
      }
    }
  }
  if (textChars > MAX_USER_INPUT_TEXT_CHARS) {
    return {
      code: "input_too_large",
      message: `Input exceeds ${MAX_USER_INPUT_TEXT_CHARS} text characters`,
      retryable: false,
      details: {
        kind: "text",
        limit: MAX_USER_INPUT_TEXT_CHARS,
        actual: textChars,
      },
    }
  }
  return undefined
}

export function parseSessionCommand(value: unknown): ParseSessionCommandResult {
  const record = recordValue(value)
  if (
    record &&
    typeof record.version === "number" &&
    record.version !== PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      error: {
        code: "unsupported_version",
        message: `Unsupported Nexus protocol version ${record.version}`,
        retryable: false,
        details: {
          supportedVersions: [PROTOCOL_VERSION],
          receivedVersion: record.version,
        },
      },
    }
  }
  if (record) {
    const limitError = rawInputLimits(record)
    if (limitError) return { ok: false, error: limitError }
  }
  const parsed = SessionCommandSchema.safeParse(value)
  if (parsed.success) return { ok: true, command: parsed.data }
  return {
    ok: false,
    error: {
      code: "invalid_command",
      message: "Invalid Nexus session command",
      retryable: false,
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    },
  }
}
