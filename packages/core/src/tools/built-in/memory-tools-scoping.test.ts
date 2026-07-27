import { beforeEach, describe, expect, it, vi } from "vitest"

import { createNexusRunServices } from "../../agent/run-services.js"
import { Session } from "../../session/index.js"
import {
  createFakeHost,
  createTestConfig,
} from "../../test/fakes.js"
import type { MemoryRecord, ToolContext } from "../../types.js"
import {
  memoryCreateTool,
  memoryDeleteTool,
  memoryGetTool,
  memoryListTool,
  memoryUpdateTool,
} from "./orchestration-tools.js"

const runtime = vi.hoisted(() => ({
  listTeamNamesForSession: vi.fn(async () => ["core"]),
  listMemories: vi.fn(async (_filters?: { limit?: number }) => [] as MemoryRecord[]),
  getMemory: vi.fn(async () => null as MemoryRecord | null),
  createMemory: vi.fn(),
  upsertMemoryByTitle: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  recordMemoryAccess: vi.fn(async () => []),
}))

vi.mock("../../orchestration/runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../orchestration/runtime.js")>()
  return {
    ...actual,
    getOrchestrationRuntime: async () => runtime,
  }
})

function memory(id: string, teamName: string): MemoryRecord {
  return {
    id,
    schemaVersion: 2,
    scope: "team",
    kind: "fact",
    title: id,
    content: `content:${id}`,
    source: { type: "tool" },
    author: { type: "agent" },
    trust: "agent",
    confidence: 0.8,
    sensitivity: "normal",
    createdAt: 1,
    updatedAt: 1,
    accessedAt: 1,
    accessCount: 0,
    metadata: { teamName },
  }
}

function context(): ToolContext {
  const cwd = process.cwd()
  return {
    cwd,
    host: createFakeHost({ cwd }),
    session: new Session("session-a", cwd, [], "", true),
    config: createTestConfig(),
    mode: "agent",
    signal: new AbortController().signal,
    services: createNexusRunServices({
      orchestrationRuntime: runtime as never,
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  runtime.listTeamNamesForSession.mockResolvedValue(["core"])
  runtime.listMemories.mockResolvedValue([])
  runtime.getMemory.mockResolvedValue(null)
})

describe("team memory tool isolation", () => {
  it("never lists memories belonging to a different team", async () => {
    runtime.listMemories.mockResolvedValue([
      memory("core-memory", "core"),
      memory("other-memory", "other"),
    ])

    const result = await memoryListTool.execute(
      { scope: ["team"], include_content: true },
      context(),
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain("core-memory")
    expect(result.output).not.toContain("other-memory")
    expect(result.metadata).toMatchObject({
      memories: [{ id: "core-memory" }],
    })
  })

  it("applies the visible limit after scope and expiry filtering", async () => {
    const expired: MemoryRecord = {
      ...memory("expired", "core"),
      scope: "project",
      metadata: {},
      expiresAt: 10,
      updatedAt: 20,
    }
    const valid: MemoryRecord = {
      ...memory("valid", "core"),
      scope: "project",
      metadata: {},
      updatedAt: 15,
    }
    runtime.listMemories.mockImplementation(async (filters) =>
      [expired, valid].slice(0, filters?.limit ?? 2))

    const result = await memoryListTool.execute(
      { scope: ["project"], include_content: true, limit: 1 },
      context(),
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain("valid")
    expect(result.output).not.toContain("expired")
  })

  it("fails closed for guessed ids from another team", async () => {
    runtime.getMemory.mockResolvedValue(memory("other-memory", "other"))
    const ctx = context()

    await expect(memoryGetTool.execute(
      { memory_id: "other-memory" },
      ctx,
    )).resolves.toMatchObject({ success: false })
    await expect(memoryUpdateTool.execute(
      { memory_id: "other-memory", content: "overwrite" },
      ctx,
    )).resolves.toMatchObject({ success: false })
    await expect(memoryDeleteTool.execute(
      { memory_id: "other-memory" },
      ctx,
    )).resolves.toMatchObject({ success: false })

    expect(runtime.updateMemory).not.toHaveBeenCalled()
    expect(runtime.deleteMemory).not.toHaveBeenCalled()
  })

  it("rejects creating team memory without an explicit session binding", async () => {
    const result = await memoryCreateTool.execute(
      {
        scope: "team",
        team_name: "other",
        title: "Secret",
        content: "Do not cross team boundaries",
      },
      context(),
    )

    expect(result).toMatchObject({
      success: false,
      output: expect.stringContaining("not bound"),
    })
    expect(runtime.createMemory).not.toHaveBeenCalled()
  })

  it("does not let agent tools rewrite or delete user-owned memory", async () => {
    runtime.getMemory.mockResolvedValue({
      ...memory("user-memory", "core"),
      scope: "project",
      metadata: {},
      source: { type: "user" },
      author: { type: "user" },
      trust: "user",
    })
    const ctx = context()

    await expect(
      memoryUpdateTool.execute(
        { memory_id: "user-memory", content: "agent replacement" },
        ctx,
      ),
    ).resolves.toMatchObject({
      success: false,
      output: expect.stringContaining("protected"),
    })
    await expect(
      memoryDeleteTool.execute({ memory_id: "user-memory" }, ctx),
    ).resolves.toMatchObject({
      success: false,
      output: expect.stringContaining("protected"),
    })
    expect(runtime.updateMemory).not.toHaveBeenCalled()
    expect(runtime.deleteMemory).not.toHaveBeenCalled()
  })

  it("does not let lower-trust project memory supersede a protected record", async () => {
    runtime.getMemory.mockResolvedValue({
      ...memory("user-memory", "core"),
      scope: "project",
      metadata: {},
      source: { type: "user" },
      author: { type: "user" },
      trust: "user",
    })

    const result = await memoryCreateTool.execute(
      {
        scope: "project",
        title: "Replacement",
        content: "Use an unverified replacement.",
        supersedes: ["user-memory"],
      },
      context(),
    )

    expect(result).toMatchObject({
      success: false,
      output: expect.stringContaining("Protected"),
    })
    expect(runtime.createMemory).not.toHaveBeenCalled()
  })
})
