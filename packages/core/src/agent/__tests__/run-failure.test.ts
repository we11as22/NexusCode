import { beforeEach, describe, expect, it, vi } from "vitest"

import { createCompaction } from "../../session/compaction.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type { LLMClient } from "../../provider/types.js"
import { createNexusRunServices } from "../run-services.js"
import { runAgentLoop } from "../loop.js"

const runPluginHooks = vi.hoisted(() => vi.fn(async () => []))
const orchestrationRuntime = vi.hoisted(() => ({
  listTeams: async () => [],
  listMemories: async () => [],
  listTeamNamesForSession: async () => [],
  recordMemoryAccess: async () => undefined,
  listBackgroundTasks: async () => [],
}))

vi.mock("../../plugins/runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../plugins/runtime.js")>()
  return {
    ...actual,
    runPluginHooks,
  }
})

beforeEach(() => {
  runPluginHooks.mockClear()
})

describe("agent run terminal failures", () => {
  it("rejects a fatal provider event and never emits a successful done event", async () => {
    const cwd = process.cwd()
    const host = createFakeHost({ cwd })
    const session = createFakeSession(cwd)
    session.addMessage({ role: "user", content: "do work" })
    const providerError = new Error("provider unavailable")
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream() {
        yield { type: "error" as const, error: providerError }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    await expect(runAgentLoop({
      session,
      client,
      host,
      config: createTestConfig(),
      services: createNexusRunServices({
        orchestrationRuntime: orchestrationRuntime as never,
      }),
      mode: "agent",
      tools: [],
      skills: [],
      rulesContent: "",
      compaction: createCompaction(),
      signal: new AbortController().signal,
    })).rejects.toBe(providerError)

    expect(host.events).toContainEqual({
      type: "error",
      error: "provider unavailable",
      fatal: true,
    })
    expect(host.events.some((event) => event.type === "done")).toBe(false)
    const hookCalls = runPluginHooks.mock.calls as unknown[][]
    expect(hookCalls.some(
      (call) => call[3] === "turn_complete",
    )).toBe(false)
  })
})
