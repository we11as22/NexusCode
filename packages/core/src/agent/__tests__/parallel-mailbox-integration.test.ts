import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  LLMClient,
  StreamOptions,
} from "../../provider/types.js"
import { getRuntimeDir, OrchestrationRuntime } from "../../orchestration/runtime.js"
import {
  createFakeHost,
  createTestConfig,
} from "../../test/fakes.js"
import { ParallelAgentManager } from "../parallel.js"
import { createNexusRunServices } from "../run-services.js"

const providerState = vi.hoisted(() => ({
  client: null as unknown,
}))
const runPluginHooks = vi.hoisted(() => vi.fn(async () => []))

vi.mock("../../provider/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../provider/index.js")>()
  return {
    ...actual,
    createLLMClient: () => providerState.client,
  }
})

vi.mock("../../plugins/runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../plugins/runtime.js")>()
  return {
    ...actual,
    runPluginHooks,
  }
})

const roots: Array<{ root: string; cwd: string }> = []

afterEach(async () => {
  providerState.client = null
  await Promise.all(
    roots.splice(0).flatMap(({ root, cwd }) => [
      rm(root, { recursive: true, force: true }),
      rm(getRuntimeDir(cwd), { recursive: true, force: true }),
    ]),
  )
})

function requestContains(request: StreamOptions, text: string): boolean {
  return request.messages.some((message) => {
    if (typeof message.content === "string") {
      return message.content.includes(text)
    }
    return message.content.some(
      (part) => part.type === "text" && part.text.includes(text),
    )
  })
}

describe("ParallelAgentManager durable mailbox integration", () => {
  it("wakes a running agent at the provider boundary without aborting its run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-agent-live-mail-"))
    const cwd = path.join(root, "workspace")
    await mkdir(cwd)
    roots.push({ root, cwd })
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir: path.join(root, ".nexus"),
      reconcileStaleRuns: false,
    })
    const manager = new ParallelAgentManager(runtime)
    const services = createNexusRunServices({
      orchestrationRuntime: runtime,
      parallelAgentManager: manager,
    })
    const host = createFakeHost({ cwd })
    const config = createTestConfig({
      memory: { sessionMemoryEnabled: false },
      parallelAgents: { maxParallel: 2, maxDepth: 2 },
    })
    const requests: StreamOptions[] = []
    let samplingStarted!: () => void
    const startedSampling = new Promise<void>((resolve) => {
      samplingStarted = resolve
    })
    let providerCall = 0
    providerState.client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(request)
        providerCall += 1
        if (providerCall === 1) {
          samplingStarted()
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 500)
            request.signal?.addEventListener("abort", () => {
              clearTimeout(timeout)
              resolve()
            }, { once: true })
          })
          if (request.signal?.aborted) throw request.signal.reason
        }
        yield { type: "text_delta" as const, delta: "completed" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient
    const rootAbort = new AbortController()
    const started = await manager.spawnInBackground(
      "Inspect auth",
      "agent",
      config,
      cwd,
      rootAbort.signal,
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      { taskName: "reviewer" },
      { host, services, ownerSessionId: "session_owner" },
    )

    await startedSampling
    await manager.queueMessage({
      target: "reviewer",
      from: "lead",
      message: "Check the live boundary",
      ownerSessionId: "session_owner",
    })
    const result = await manager.waitFor(
      started.subagentId,
      "session_owner",
    )

    expect(rootAbort.signal.aborted).toBe(false)
    expect(result).toMatchObject({ status: "completed" })
    expect(requests).toHaveLength(2)
    expect(requestContains(requests[1]!, "Check the live boundary")).toBe(true)
    await expect(runtime.listPendingAgentMessages({
      ownerSessionId: "session_owner",
      targetAgentId: started.subagentId,
    })).resolves.toEqual([])
    await manager.shutdown()
  })

  it("keeps mail queued for an idle completed task and accepts it when TaskResume explicitly wakes the agent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-agent-resume-mail-"))
    const cwd = path.join(root, "workspace")
    await mkdir(cwd)
    roots.push({ root, cwd })
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir: path.join(root, ".nexus"),
      reconcileStaleRuns: false,
    })
    const manager = new ParallelAgentManager(runtime)
    const services = createNexusRunServices({
      orchestrationRuntime: runtime,
      parallelAgentManager: manager,
    })
    const host = createFakeHost({ cwd })
    const config = createTestConfig({
      memory: { sessionMemoryEnabled: false },
      parallelAgents: { maxParallel: 2, maxDepth: 2 },
    })
    const requests: StreamOptions[] = []
    providerState.client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(request)
        yield { type: "text_delta" as const, delta: "completed" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient
    const runtimeContext = {
      host,
      services,
      ownerSessionId: "session_owner",
    }

    const started = await manager.spawnInBackground(
      "Inspect auth",
      "agent",
      config,
      cwd,
      new AbortController().signal,
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      { taskName: "reviewer" },
      runtimeContext,
    )
    await manager.waitFor(started.subagentId, "session_owner")
    await expect(runtime.getBackgroundTask(started.subagentId)).resolves.toMatchObject({
      status: "completed",
      metadata: { snapshotFile: expect.any(String) },
    })

    await manager.queueMessage({
      target: "reviewer",
      from: "lead",
      message: "Check the refresh-token path",
      ownerSessionId: "session_owner",
    })
    await expect(runtime.listPendingAgentMessages({
      ownerSessionId: "session_owner",
      targetAgentId: started.subagentId,
    })).resolves.toHaveLength(1)

    const resumed = await manager.resume(
      started.subagentId,
      {
        followupInstruction: "Continue the review",
        runInBackground: false,
      },
      config,
      cwd,
      new AbortController().signal,
      2,
      undefined,
      undefined,
      runtimeContext,
      "agent",
    )

    expect("background" in resumed).toBe(false)
    expect(requests).toHaveLength(2)
    expect(requestContains(
      requests[1]!,
      "Check the refresh-token path",
    )).toBe(true)
    await expect(runtime.listPendingAgentMessages({
      ownerSessionId: "session_owner",
      targetAgentId: started.subagentId,
    })).resolves.toEqual([])
    const resumedTask = await runtime.getBackgroundTask(resumed.subagentId)
    expect(resumedTask?.metadata).toMatchObject({
      resumeOf: started.subagentId,
      mailboxTargetIds: expect.arrayContaining([
        started.subagentId,
        resumed.subagentId,
      ]),
    })
    await manager.shutdown()
  })

  it("reports the source task as running while an explicit resume consumes its mailbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-agent-resume-live-mail-"))
    const cwd = path.join(root, "workspace")
    await mkdir(cwd)
    roots.push({ root, cwd })
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir: path.join(root, ".nexus"),
      reconcileStaleRuns: false,
    })
    const manager = new ParallelAgentManager(runtime)
    const services = createNexusRunServices({
      orchestrationRuntime: runtime,
      parallelAgentManager: manager,
    })
    const host = createFakeHost({ cwd })
    const config = createTestConfig({
      memory: { sessionMemoryEnabled: false },
      parallelAgents: { maxParallel: 2, maxDepth: 2 },
    })
    const runtimeContext = {
      host,
      services,
      ownerSessionId: "session_owner",
    }
    const requests: StreamOptions[] = []
    let resumedSamplingStarted!: () => void
    const resumedSampling = new Promise<void>((resolve) => {
      resumedSamplingStarted = resolve
    })
    let providerCall = 0
    providerState.client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(request)
        providerCall += 1
        if (providerCall === 2) {
          resumedSamplingStarted()
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 500)
            request.signal?.addEventListener("abort", () => {
              clearTimeout(timeout)
              resolve()
            }, { once: true })
          })
          if (request.signal?.aborted) throw request.signal.reason
        }
        yield { type: "text_delta" as const, delta: "completed" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    const started = await manager.spawnInBackground(
      "Inspect auth",
      "agent",
      config,
      cwd,
      new AbortController().signal,
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      { taskName: "reviewer" },
      runtimeContext,
    )
    await manager.waitFor(started.subagentId, "session_owner")

    const resumedPromise = manager.resume(
      started.subagentId,
      {
        followupInstruction: "Continue the review",
        runInBackground: false,
      },
      config,
      cwd,
      new AbortController().signal,
      2,
      undefined,
      undefined,
      runtimeContext,
      "agent",
    )
    await resumedSampling
    const queued = await manager.queueMessage({
      target: started.subagentId,
      from: "lead",
      message: "Check the source-task mailbox while resumed",
      ownerSessionId: "session_owner",
    })
    const resumed = await resumedPromise

    expect(queued.running).toBe(true)
    expect("background" in resumed).toBe(false)
    expect(requests).toHaveLength(3)
    expect(requestContains(
      requests[2]!,
      "Check the source-task mailbox while resumed",
    )).toBe(true)
    await expect(runtime.listPendingAgentMessages({
      ownerSessionId: "session_owner",
      targetAgentId: started.subagentId,
    })).resolves.toEqual([])
    await manager.shutdown()
  })
})
