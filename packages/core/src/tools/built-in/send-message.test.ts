import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { ParallelAgentManager } from "../../agent/parallel.js"
import { createNexusRunServices } from "../../agent/run-services.js"
import { OrchestrationRuntime } from "../../orchestration/runtime.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type { ToolContext } from "../../types.js"
import { sendMessageTool } from "./orchestration-tools.js"

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-send-message-"))
  const cwd = path.join(root, "workspace")
  await mkdir(cwd)
  roots.push(root)
  const runtime = new OrchestrationRuntime(cwd, {
    homeDir: path.join(root, ".nexus"),
    reconcileStaleRuns: false,
  })
  const manager = new ParallelAgentManager(runtime)
  const session = createFakeSession(cwd)
  const host = createFakeHost({ cwd })
  const ctx: ToolContext = {
    cwd,
    host,
    session,
    config: createTestConfig(),
    services: createNexusRunServices({
      orchestrationRuntime: runtime,
      parallelAgentManager: manager,
    }),
    signal: new AbortController().signal,
    mode: "agent",
    partId: "send-call-1",
  }
  return { runtime, manager, session, host, ctx }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })),
  )
})

describe("SendMessage durable delivery", () => {
  it("queues to the exact owner-scoped agent and reports queued rather than delivered", async () => {
    const { runtime, ctx } = await fixture()
    await runtime.registerBackgroundTask({
      id: "subagent_review",
      kind: "subagent",
      description: "review",
      status: "completed",
      sessionId: ctx.session.id,
      metadata: { name: "reviewer" },
    })
    await runtime.createTeam({
      teamName: "core",
      description: "Core team",
      sessionId: ctx.session.id,
    })

    const result = await sendMessageTool.execute({
      to: "reviewer",
      from: "lead",
      message: "Inspect the auth path",
      team_name: "core",
    }, ctx)

    expect(result).toMatchObject({
      success: true,
      metadata: {
        queued: true,
        targetAgentId: "subagent_review",
        running: false,
      },
    })
    expect(result.output).toMatch(/queued/i)
    expect(result.output).not.toMatch(/delivered/i)
    await expect(runtime.listPendingAgentMessages({
      ownerSessionId: ctx.session.id,
      targetAgentId: "subagent_review",
    })).resolves.toMatchObject([
      { from: "lead", message: "Inspect the auth path" },
    ])
    await expect(runtime.getTeam("core")).resolves.toMatchObject({
      messages: [{ from: "lead", to: "reviewer", message: "Inspect the auth path" }],
    })
  })

  it("fails closed for an unknown or foreign target without writing a team log", async () => {
    const { runtime, ctx } = await fixture()
    await runtime.createTeam({
      teamName: "core",
      description: "Core team",
      sessionId: ctx.session.id,
    })
    await runtime.registerBackgroundTask({
      id: "subagent_foreign",
      kind: "subagent",
      description: "foreign",
      status: "running",
      sessionId: "another-session",
      metadata: { name: "foreign" },
    })

    const result = await sendMessageTool.execute({
      to: "subagent_foreign",
      message: "private",
      team_name: "core",
    }, ctx)

    expect(result).toMatchObject({ success: false })
    expect(result.output).toMatch(/not found/i)
    await expect(runtime.getTeam("core")).resolves.toMatchObject({
      messages: [],
    })
  })

  it("uses the tool-part identity to make a retried durable enqueue idempotent", async () => {
    const { runtime, ctx } = await fixture()
    await runtime.registerBackgroundTask({
      id: "subagent_review",
      kind: "subagent",
      description: "review",
      status: "running",
      sessionId: ctx.session.id,
    })
    const input = {
      to: "subagent_review",
      message: "Retry-safe message",
    }

    await sendMessageTool.execute(input, ctx)
    await sendMessageTool.execute(input, ctx)

    await expect(runtime.listPendingAgentMessages({
      ownerSessionId: ctx.session.id,
      targetAgentId: "subagent_review",
    })).resolves.toHaveLength(1)
  })
})
