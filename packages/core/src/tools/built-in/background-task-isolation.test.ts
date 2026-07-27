import { beforeEach, describe, expect, it, vi } from "vitest"

import { createNexusRunServices } from "../../agent/run-services.js"
import { Session } from "../../session/index.js"
import {
  createFakeHost,
  createTestConfig,
} from "../../test/fakes.js"
import type {
  BackgroundTaskRecord,
  TaskRecord,
  ToolContext,
} from "../../types.js"
import { bashOutputTool } from "./bash-output.js"
import { killBashTool } from "./kill-bash.js"
import {
  taskOutputTool,
  taskStopTool,
} from "./orchestration-tools.js"

const runtime = vi.hoisted(() => ({
  getTask: vi.fn(async () => null as TaskRecord | null),
  getBackgroundTask: vi.fn(async () => null as BackgroundTaskRecord | null),
  setBackgroundTaskStatus: vi.fn(),
  updateTask: vi.fn(),
}))

vi.mock("../../orchestration/runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../orchestration/runtime.js")>()
  return {
    ...actual,
    getOrchestrationRuntime: async () => runtime,
  }
})

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

function foreignTask(): {
  task: TaskRecord
  background: BackgroundTaskRecord
} {
  const task: TaskRecord = {
    id: "run-foreign",
    kind: "shell",
    subject: "foreign",
    description: "foreign",
    status: "in_progress",
    createdAt: 1,
    updatedAt: 1,
    processId: 999_999,
    sessionId: "session-b",
  }
  return {
    task,
    background: {
      id: task.id,
      kind: "bash",
      description: task.description,
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      processId: task.processId,
      logPath: "/tmp/foreign.log",
      sessionId: "session-b",
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  runtime.getTask.mockResolvedValue(null)
  runtime.getBackgroundTask.mockResolvedValue(null)
})

describe("background task session isolation", () => {
  it("does not read output for a task owned by another session", async () => {
    const foreign = foreignTask()
    runtime.getTask.mockResolvedValue(foreign.task)
    runtime.getBackgroundTask.mockResolvedValue(foreign.background)
    const ctx = context()
    ctx.services.backgroundProcesses.register({
      taskId: foreign.task.id,
      pid: foreign.task.processId!,
      processIdentity: "foreign-live-identity",
      logPath: foreign.background.logPath!,
      workspace: ctx.cwd,
      sessionId: "session-b",
      stop: async () => undefined,
    })

    await expect(bashOutputTool.execute(
      { bash_id: foreign.task.id },
      ctx,
    )).resolves.toMatchObject({ success: false })
    await expect(taskOutputTool.execute(
      { taskId: foreign.task.id, block: false },
      ctx,
    )).resolves.toMatchObject({ success: false })
  })

  it("does not stop a task owned by another session", async () => {
    const foreign = foreignTask()
    runtime.getTask.mockResolvedValue(foreign.task)
    runtime.getBackgroundTask.mockResolvedValue(foreign.background)
    const ctx = context()

    await expect(killBashTool.execute(
      { shell_id: foreign.task.id },
      ctx,
    )).resolves.toMatchObject({ success: false })
    await expect(taskStopTool.execute(
      { taskId: foreign.task.id },
      ctx,
    )).resolves.toMatchObject({ success: false })
    expect(runtime.setBackgroundTaskStatus).not.toHaveBeenCalled()
    expect(runtime.updateTask).not.toHaveBeenCalled()
  })
})
