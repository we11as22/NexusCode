import type { MemoryRecord } from "../types.js"

export const MEMORY_SCHEMA_VERSION = 2 as const

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
const SENSITIVITY_LEVELS = new Set<MemoryRecord["sensitivity"]>([
  "normal",
  "sensitive",
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

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
  return items.length > 0 ? items : undefined
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

/**
 * Upgrade a persisted v1 memory in-memory. The next orchestration mutation
 * writes the upgraded record, so old checksummed snapshots remain readable.
 */
export function normalizeMemoryRecord(input: LegacyMemoryRecord): MemoryRecord {
  const now = Date.now()
  const source = inferSource(input)
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
  const author = input.author && AUTHOR_TYPES.has(input.author.type)
    ? {
        type: input.author.type,
        ...(input.author.id ? { id: input.author.id } : {}),
      }
    : {
        type: trust === "user" ? "user" as const : trust === "external" ? "external" as const : "agent" as const,
      }
  const confidence = typeof input.confidence === "number" && Number.isFinite(input.confidence)
    ? Math.max(0, Math.min(1, input.confidence))
    : trust === "user"
      ? 1
      : 0.7

  return {
    id: input.id,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    scope: input.scope,
    kind,
    title: input.title,
    content: input.content,
    source,
    author,
    trust,
    confidence,
    sensitivity: SENSITIVITY_LEVELS.has(input.sensitivity as MemoryRecord["sensitivity"])
      ? input.sensitivity as MemoryRecord["sensitivity"]
      : "normal",
    createdAt: finiteTimestamp(input.createdAt, now),
    updatedAt: finiteTimestamp(input.updatedAt, now),
    accessedAt: finiteTimestamp(input.accessedAt, finiteTimestamp(input.updatedAt, now)),
    accessCount: Number.isSafeInteger(input.accessCount) && input.accessCount! >= 0 ? input.accessCount! : 0,
    ...(typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt)
      ? { expiresAt: input.expiresAt }
      : {}),
    ...(stringArray(input.supersedes) ? { supersedes: stringArray(input.supersedes) } : {}),
    ...(stringArray(input.contradicts) ? { contradicts: stringArray(input.contradicts) } : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  }
}
