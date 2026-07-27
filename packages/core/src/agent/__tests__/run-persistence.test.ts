import { beforeEach, describe, expect, it, vi } from "vitest"

import type { LLMClient } from "../../provider/types.js"
import { createCompaction } from "../../session/compaction.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import { runAgentLoop } from "../loop.js"
import { createNexusRunServices } from "../run-services.js"

const runPluginHooks = vi.hoisted(() => vi.fn(async (
  _cwd: string,
  _host: unknown,
  _config: unknown,
  event: string,
) => event === "turn_complete"
  ? [{
      pluginName: "audit",
      hookEvent: event,
      output: "turn persisted",
      success: true,
    }]
  : []))
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

function textClient(): LLMClient {
  return {
    providerName: "test",
    modelId: "test-model",
    async *stream() {
      yield { type: "text_delta" as const, delta: "final answer" }
      yield { type: "finish" as const, finishReason: "stop" as const }
    },
    supportsStructuredOutput: () => false,
    getModel: () => ({}),
  } as unknown as LLMClient
}

async function runWithSession(
  session: ReturnType<typeof createFakeSession>,
  host: ReturnType<typeof createFakeHost>,
) {
  return runAgentLoop({
    session,
    client: textClient(),
    host,
    config: createTestConfig({
      memory: { sessionMemoryEnabled: false },
    }),
    services: createNexusRunServices({
      orchestrationRuntime: orchestrationRuntime as never,
    }),
    mode: "agent",
    tools: [],
    skills: [],
    rulesContent: "",
    compaction: createCompaction(),
    signal: new AbortController().signal,
  })
}

beforeEach(() => {
  runPluginHooks.mockClear()
})

describe("agent run persistence boundary", () => {
  it("persists the final answer and turn-complete mutations before done", async () => {
    const order: string[] = []
    const cwd = process.cwd()
    const host = createFakeHost({
      cwd,
      emit(event) {
        if (event.type === "done") order.push("done")
      },
    })
    const session = createFakeSession(cwd)
    session.addMessage({ role: "user", content: "answer this" })
    session.updateTodo("- [ ] finish")
    let savedMessages = ""
    let savedTodo = "not-saved"
    const save = vi.spyOn(session, "save").mockImplementation(async () => {
      order.push("save")
      savedMessages = JSON.stringify(session.messages)
      savedTodo = session.getTodo()
    })

    await runWithSession(session, host)

    expect(save).toHaveBeenCalledTimes(1)
    expect(savedMessages).toContain("final answer")
    expect(savedMessages).toContain("turn persisted")
    expect(savedTodo).toBe("- [ ] finish")
    expect(order).toEqual(["save", "done"])
  })

  it("fails the run and withholds done when final persistence fails", async () => {
    const cwd = process.cwd()
    const host = createFakeHost({ cwd })
    const session = createFakeSession(cwd)
    session.addMessage({ role: "user", content: "answer this" })
    const failure = new Error("disk unavailable")
    vi.spyOn(session, "save").mockRejectedValue(failure)

    await expect(runWithSession(session, host)).rejects.toBe(failure)
    expect(host.events.some((event) => event.type === "done")).toBe(false)
  })
})
