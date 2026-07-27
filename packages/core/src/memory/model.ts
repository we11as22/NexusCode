import type { MemoryRecord } from "../types.js"
import {
  MemoryValueLimitError,
  redactMemorySecrets,
  sanitizeMemoryValue,
} from "./redact.js"

export const MEMORY_SCHEMA_VERSION = 2 as const
export const MAX_MEMORY_TITLE_CHARS = 4_096
export const MAX_MEMORY_CONTENT_CHARS = 256 * 1_024
export const MAX_MEMORY_IDENTIFIER_CHARS = 512
export const MAX_MEMORY_SOURCE_URI_CHARS = 16 * 1_024
export const MAX_MEMORY_RELATION_IDS = 256

export type LegacyMemoryRecord = Pick<
  MemoryRecord,
  "id" | "scope" | "title" | "content" | "createdAt" | "updatedAt"
> &
  Partial<Omit<MemoryRecord, "id" | "scope" | "title" | "content" | "createdAt" | "updatedAt">>

const KINDS = new Set<MemoryRecord["kind"]>([
  "fact",
  "preference",
  "command",
  "architecture",
  "decision",
  "instruction",
  "summary",
  "artifact_reference",
])
const TRUST_LEVELS = new Set<MemoryRecord["trust"]>([
  "user",
  "trusted",
  "agent",
  "external",
  "untrusted",
])
const SOURCE_TYPES = new Set<MemoryRecord["source"]["type"]>([
  "user",
  "tool",
  "compaction",
  "legacy_file",
  "system",
  "external",
])
const AUTHOR_TYPES = new Set<MemoryRecord["author"]["type"]>([
  "user",
  "agent",
  "system",
  "external",
])
const SCOPES = new Set<MemoryRecord["scope"]>([
  "global",
  "project",
  "session",
  "team",
  "task",
  "agent",
])

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function boundedString(
  value: unknown,
  label: string,
  maxChars: number,
): { text: string; redacted: boolean } {
  if (typeof value !== "string") {
    throw new MemoryValueLimitError(`${label} must be a string`)
  }
  if (value.length > maxChars) {
    throw new MemoryValueLimitError(
      `${label} exceeded ${maxChars} characters`,
    )
  }
  return redactMemorySecrets(value)
}

function stringArray(
  value: unknown,
  label: string,
): { values?: string[]; redacted: boolean } | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length > MAX_MEMORY_RELATION_IDS) {
    throw new MemoryValueLimitError(
      `${label} exceeded ${MAX_MEMORY_RELATION_IDS} items`,
    )
  }
  let redacted = false
  const items = [...new Set(value.flatMap((item) => {
    if (typeof item !== "string" || item.length === 0) return []
    const bounded = boundedString(item, `${label} item`, MAX_MEMORY_IDENTIFIER_CHARS)
    redacted ||= bounded.redacted
    return bounded.text
  }))]
  return {
    ...(items.length > 0 ? { values: items } : {}),
    redacted,
  }
}

function inferKind(metadata: Record<string, unknown> | undefined): MemoryRecord["kind"] {
  const legacyKind = typeof metadata?.kind === "string" ? metadata.kind.toLowerCase() : ""
  if (legacyKind.includes("instruction")) return "instruction"
  if (
    legacyKind.includes("pending") ||
    legacyKind.includes("current") ||
    legacyKind.includes("next_step") ||
    legacyKind.includes("delegation") ||
    legacyKind.includes("summary")
  ) {
    return "summary"
  }
  if (legacyKind.includes("command")) return "command"
  if (legacyKind.includes("architecture")) return "architecture"
  if (legacyKind.includes("decision")) return "decision"
  if (legacyKind.includes("preference")) return "preference"
  if (legacyKind.includes("artifact")) return "artifact_reference"
  return "fact"
}

function inferSource(input: LegacyMemoryRecord): MemoryRecord["source"] {
  const source = input.source
  if (source && SOURCE_TYPES.has(source.type)) {
    return {
      type: source.type,
      ...(source.uri ? { uri: source.uri } : {}),
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      ...(typeof source.importedAt === "number" ? { importedAt: source.importedAt } : {}),
    }
  }
  const legacyKind = typeof input.metadata?.kind === "string" ? input.metadata.kind : ""
  const sessionId = typeof input.metadata?.sessionId === "string" ? input.metadata.sessionId : undefined
  return {
    type: legacyKind.startsWith("compaction.") ? "compaction" : "system",
    ...(sessionId ? { sessionId } : {}),
  }
}

export function assertMemoryWriteInput(input: {
  title?: unknown
  content?: unknown
  source?: unknown
  author?: unknown
  metadata?: unknown
  supersedes?: unknown
  contradicts?: unknown
}): void {
  if (input.title !== undefined) {
    boundedString(input.title, "memory title", MAX_MEMORY_TITLE_CHARS)
  }
  if (input.content !== undefined) {
    boundedString(input.content, "memory content", MAX_MEMORY_CONTENT_CHARS)
  }
  if (input.source !== undefined) {
    sanitizeMemoryValue(input.source, {
      strict: true,
      label: "memory source",
    })
  }
  if (input.author !== undefined) {
    sanitizeMemoryValue(input.author, {
      strict: true,
      label: "memory author",
    })
  }
  if (input.metadata !== undefined) {
    sanitizeMemoryValue(input.metadata, {
      strict: true,
      label: "memory metadata",
    })
  }
  if (input.supersedes !== undefined) {
    stringArray(input.supersedes, "memory supersedes")
  }
  if (input.contradicts !== undefined) {
    stringArray(input.contradicts, "memory contradicts")
  }
}

/**
 * Upgrade a persisted v1 memory in-memory. The next orchestration mutation
 * writes the upgraded record, so old checksummed snapshots remain readable.
 */
export function normalizeMemoryRecord(input: LegacyMemoryRecord): MemoryRecord {
  const now = Date.now()
  if (
    typeof input.id !== "string" ||
    input.id.length === 0 ||
    input.id.length > MAX_MEMORY_IDENTIFIER_CHARS
  ) {
    throw new MemoryValueLimitError(
      `memory id must contain 1-${MAX_MEMORY_IDENTIFIER_CHARS} characters`,
    )
  }
  if (!SCOPES.has(input.scope)) {
    throw new MemoryValueLimitError(`unsupported memory scope: ${String(input.scope)}`)
  }
  const title = boundedString(input.title, "memory title", MAX_MEMORY_TITLE_CHARS)
  const content = boundedString(input.content, "memory content", MAX_MEMORY_CONTENT_CHARS)
  const inferredSource = inferSource(input)
  const sourceUri = inferredSource.uri
    ? boundedString(
        inferredSource.uri,
        "memory source URI",
        MAX_MEMORY_SOURCE_URI_CHARS,
      )
    : undefined
  const sourceSessionId = inferredSource.sessionId
    ? boundedString(
        inferredSource.sessionId,
        "memory source session id",
        MAX_MEMORY_IDENTIFIER_CHARS,
      )
    : undefined
  const source: MemoryRecord["source"] = {
    type: inferredSource.type,
    ...(sourceUri ? { uri: sourceUri.text } : {}),
    ...(sourceSessionId ? { sessionId: sourceSessionId.text } : {}),
    ...(typeof inferredSource.importedAt === "number"
      ? { importedAt: finiteTimestamp(inferredSource.importedAt, now) }
      : {}),
  }
  const kind = KINDS.has(input.kind as MemoryRecord["kind"])
    ? input.kind as MemoryRecord["kind"]
    : inferKind(input.metadata)
  const trust = TRUST_LEVELS.has(input.trust as MemoryRecord["trust"])
    ? input.trust as MemoryRecord["trust"]
    : source.type === "user"
      ? "user"
      : source.type === "legacy_file" || source.type === "external"
        ? "external"
        : "agent"
  const rawAuthor = input.author && AUTHOR_TYPES.has(input.author.type)
    ? input.author
    : null
  const authorId = rawAuthor?.id
    ? boundedString(
        rawAuthor.id,
        "memory author id",
        MAX_MEMORY_IDENTIFIER_CHARS,
      )
    : undefined
  const author = rawAuthor
    ? {
        type: rawAuthor.type,
        ...(authorId ? { id: authorId.text } : {}),
      }
    : {
        type: trust === "user" ? "user" as const : trust === "external" ? "external" as const : "agent" as const,
      }
  const confidence = typeof input.confidence === "number" && Number.isFinite(input.confidence)
    ? Math.max(0, Math.min(1, input.confidence))
    : trust === "user"
      ? 1
      : 0.7
  const metadata = input.metadata
    ? sanitizeMemoryValue(input.metadata, { label: "memory metadata" })
    : undefined
  const supersedes = stringArray(input.supersedes, "memory supersedes")
  const contradicts = stringArray(input.contradicts, "memory contradicts")
  const wasRedacted = title.redacted ||
    content.redacted ||
    sourceUri?.redacted === true ||
    sourceSessionId?.redacted === true ||
    authorId?.redacted === true ||
    metadata?.redacted === true ||
    supersedes?.redacted === true ||
    contradicts?.redacted === true

  return {
    id: input.id,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    scope: input.scope,
    kind,
    title: title.text,
    content: content.text,
    source,
    author,
    trust,
    confidence,
    sensitivity: wasRedacted ||
        input.sensitivity === "sensitive"
      ? "sensitive"
      : "normal",
    createdAt: finiteTimestamp(input.createdAt, now),
    updatedAt: finiteTimestamp(input.updatedAt, now),
    accessedAt: finiteTimestamp(input.accessedAt, finiteTimestamp(input.updatedAt, now)),
    accessCount: Number.isSafeInteger(input.accessCount) && input.accessCount! >= 0 ? input.accessCount! : 0,
    ...(typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt)
      ? { expiresAt: input.expiresAt }
      : {}),
    ...(supersedes?.values ? { supersedes: supersedes.values } : {}),
    ...(contradicts?.values ? { contradicts: contradicts.values } : {}),
    ...(metadata ? { metadata: metadata.value } : {}),
  }
}
