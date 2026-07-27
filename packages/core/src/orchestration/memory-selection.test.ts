import { describe, expect, it } from "vitest"
import type { MemoryRecord } from "../types.js"
import {
  filterPromptMemoryCandidates,
  isMemoryAccessibleFromSession,
  selectRelevantMemories,
} from "./memory-selection.js"

function memory(
  id: string,
  scope: MemoryRecord["scope"],
  metadata?: Record<string, unknown>,
): MemoryRecord {
  return {
    id,
    schemaVersion: 2,
    scope,
    kind: "fact",
    title: `${id} deployment`,
    content: `${id} uses the deployment command`,
    source: { type: "tool" },
    author: { type: "agent" },
    trust: "agent",
    confidence: 0.8,
    sensitivity: "normal",
    createdAt: 1,
    updatedAt: 1,
    accessedAt: 1,
    accessCount: 0,
    ...(metadata ? { metadata } : {}),
  }
}

describe("prompt memory scoping", () => {
  it("includes global, project, current-session, and only explicitly bound team memories", () => {
    const candidates = filterPromptMemoryCandidates([
      memory("global", "global"),
      memory("project", "project"),
      memory("session-current", "session", { sessionId: "session-a" }),
      memory("session-other", "session", { sessionId: "session-b" }),
      memory("team-current", "team", { teamName: "core" }),
      memory("team-other", "team", { teamName: "other" }),
      memory("team-unbound", "team"),
      memory("task-current", "task", { sessionId: "session-a" }),
      memory("task-unbound", "task"),
      memory("agent-other", "agent", { sessionId: "session-b" }),
    ], {
      sessionId: "session-a",
      includeTeam: true,
      teamNames: ["core"],
    })

    expect(candidates.map((item) => item.id)).toEqual([
      "global",
      "project",
      "session-current",
      "team-current",
      "task-current",
    ])
  })

  it("excludes team memory when team memory is disabled", () => {
    expect(filterPromptMemoryCandidates([
      memory("project", "project"),
      memory("team", "team", { teamName: "core" }),
    ], {
      sessionId: "session-a",
      includeTeam: false,
      teamNames: ["core"],
    }).map((item) => item.id)).toEqual(["project"])
  })

  it("fails closed for session, task, and agent records not bound to this session", () => {
    expect(isMemoryAccessibleFromSession(memory("project", "project"), "session-a")).toBe(true)
    expect(isMemoryAccessibleFromSession(
      memory("session-current", "session", { sessionId: "session-a" }),
      "session-a",
    )).toBe(true)
    expect(isMemoryAccessibleFromSession(
      memory("session-other", "session", { sessionId: "session-b" }),
      "session-a",
    )).toBe(false)
    expect(isMemoryAccessibleFromSession(memory("task-unbound", "task"), "session-a")).toBe(false)
    expect(isMemoryAccessibleFromSession(memory("agent-unbound", "agent"), "session-a")).toBe(false)
    expect(isMemoryAccessibleFromSession(
      memory("team-current", "team", { teamName: "core" }),
      "session-a",
      ["core"],
    )).toBe(true)
    expect(isMemoryAccessibleFromSession(
      memory("team-other", "team", { teamName: "other" }),
      "session-a",
      ["core"],
    )).toBe(false)
    expect(isMemoryAccessibleFromSession(
      memory("team-unbound", "team"),
      "session-a",
      ["core"],
    )).toBe(false)
  })

  it("can rank an older relevant record when the caller supplies the complete scope", () => {
    const irrelevant = Array.from({ length: 40 }, (_, index) => ({
      ...memory(`recent-${index}`, "project"),
      title: "Formatting preference",
      content: "Use spaces",
      updatedAt: 1_000 + index,
    }))
    const relevant = {
      ...memory("old-deploy", "project"),
      title: "Production deploy command",
      content: "Run pnpm release:production",
      updatedAt: 1,
    }

    expect(selectRelevantMemories(
      [...irrelevant, relevant],
      "production deploy",
      8,
    ).map((item) => item.memory.id)).toContain("old-deploy")
  })
})
