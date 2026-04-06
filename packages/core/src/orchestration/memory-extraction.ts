import type { MemoryRecord } from "../types.js"

interface ExtractedMemoryInput {
  scope: MemoryRecord["scope"]
  title: string
  content: string
  metadata?: Record<string, unknown>
}

function parseSections(summary: string): Map<string, string> {
  const sections = new Map<string, string>()
  const matches = Array.from(summary.matchAll(/^##\s+(.+?)\s*$/gm))
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]
    const start = match.index ?? 0
    const end = index + 1 < matches.length ? (matches[index + 1]?.index ?? summary.length) : summary.length
    const title = (match[1] ?? "").trim()
    const body = summary.slice(start + match[0].length, end).trim()
    if (title && body) sections.set(title, body)
  }
  return sections
}

function toBulletLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length >= 12)
}

function cap(text: string, max = 500): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max).trimEnd()}...`
}

function uniqueByTitle(items: ExtractedMemoryInput[]): ExtractedMemoryInput[] {
  const seen = new Set<string>()
  const out: ExtractedMemoryInput[] = []
  for (const item of items) {
    const key = `${item.scope}:${item.title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export function extractMemoriesFromCompactionSummary(
  summary: string,
  sessionId: string,
): ExtractedMemoryInput[] {
  const sections = parseSections(summary)
  const extracted: ExtractedMemoryInput[] = []

  const durable = sections.get("Durable Instructions and Preferences")
  if (durable) {
    extracted.push({
      scope: "project",
      title: "Project instructions and preferences",
      content: cap(toBulletLines(durable).join("\n")),
      metadata: { kind: "compaction.instructions" },
    })
  }

  const discoveries = sections.get("Key Technical Discoveries")
  if (discoveries) {
    for (const line of toBulletLines(discoveries).slice(0, 4)) {
      extracted.push({
        scope: "project",
        title: line.slice(0, 72),
        content: cap(line, 400),
        metadata: { kind: "compaction.discovery" },
      })
    }
  }

  const stableFacts = sections.get("Stable Project Facts and Reusable Commands")
  if (stableFacts) {
    for (const line of toBulletLines(stableFacts).slice(0, 5)) {
      extracted.push({
        scope: "project",
        title: line.slice(0, 72),
        content: cap(line, 420),
        metadata: { kind: "compaction.stable_fact" },
      })
    }
  }

  const pending = sections.get("Pending Work")
  if (pending) {
    extracted.push({
      scope: "session",
      title: "Pending work",
      content: cap(toBulletLines(pending).join("\n")),
      metadata: { kind: "compaction.pending", sessionId },
    })
  }

  const current = sections.get("Current Work")
  if (current) {
    extracted.push({
      scope: "session",
      title: "Current work",
      content: cap(toBulletLines(current).join("\n")),
      metadata: { kind: "compaction.current", sessionId },
    })
  }

  const next = sections.get("Immediate Next Step")
  if (next) {
    extracted.push({
      scope: "session",
      title: "Immediate next step",
      content: cap(toBulletLines(next).join("\n") || next),
      metadata: { kind: "compaction.next_step", sessionId },
    })
  }

  const delegation = sections.get("Delegation and Background State")
  if (delegation) {
    extracted.push({
      scope: "session",
      title: "Delegation and background state",
      content: cap(toBulletLines(delegation).join("\n") || delegation),
      metadata: { kind: "compaction.delegation", sessionId },
    })
  }

  return uniqueByTitle(
    extracted.filter((item) => item.content.trim().length >= 16),
  )
}
