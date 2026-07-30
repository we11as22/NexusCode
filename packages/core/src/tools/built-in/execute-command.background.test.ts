import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

import { BackgroundProcessSupervisor } from "../../agent/background-process-supervisor.js"
import type { NexusRunServices } from "../../agent/run-services.js"
import { OrchestrationRuntime } from "../../orchestration/runtime.js"
import { Session } from "../../session/index.js"
import {
  createFakeHost,
  createTestConfig,
} from "../../test/fakes.js"
import type { ToolContext } from "../../types.js"
import { startBackgroundShellTask } from "./execute-command.js"
import {
  taskOutputTool,
  taskStopTool,
} from "./orchestration-tools.js"

const originalDataHome = process.env.NEXUS_DATA_HOME
const roots: string[] = []
const supervisors: BackgroundProcessSupervisor[] = []
const childPids = new Set<number>()

async function fixture(): Promise<{
  cwd: string
  homeDir: string
  runtime: OrchestrationRuntime
  supervisor: BackgroundProcessSupervisor
  services: NexusRunServices
}> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-background-shell-"))
  const cwd = path.join(root, "workspace")
  await mkdir(cwd)
  process.env.NEXUS_DATA_HOME = path.join(root, "data")
  roots.push(root)
  const homeDir = path.join(root, "home")
  const runtime = new OrchestrationRuntime(cwd, {
    homeDir,
  })
  const supervisor = new BackgroundProcessSupervisor()
  supervisors.push(supervisor)
  return {
    cwd,
    homeDir,
    runtime,
    supervisor,
    services: {
      backgroundProcesses: supervisor,
      orchestrationRuntime: runtime,
    } as NexusRunServices,
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function nodeCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function backgroundTestHost(cwd: string) {
  return createFakeHost({
    cwd,
    startSandboxedCommand(request, options) {
      const child = spawn(request.command, [], {
        cwd: request.cwd,
        shell: true,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      child.stdout.on("data", (chunk: Buffer) =>
        options?.onStdout?.(chunk.toString("utf8")),
      )
      child.stderr.on("data", (chunk: Buffer) =>
        options?.onStderr?.(chunk.toString("utf8")),
      )
      return {
        pid: child.pid ?? 0,
        ready: Promise.resolve("seatbelt" as const),
        completion: new Promise((resolve) => {
          child.once("error", (error) =>
            resolve({
              stdout: "",
              stderr: error.message,
              exitCode: 1,
              sandbox: "seatbelt",
              timedOut: false,
              denied: false,
            }),
          )
          child.once("close", (code) =>
            resolve({
              stdout: "",
              stderr: "",
              exitCode: code ?? 1,
              sandbox: "seatbelt",
              timedOut: false,
              denied: false,
            }),
          )
        }),
        stop() {
          if (child.exitCode != null || child.signalCode != null) return false
          try {
            if (process.platform === "win32") return child.kill("SIGTERM")
            process.kill(-(child.pid ?? 0), "SIGTERM")
            return true
          } catch {
            return false
          }
        },
      }
    },
  })
}

afterEach(async () => {
  await Promise.allSettled(supervisors.splice(0).map((supervisor) => supervisor.close()))
  for (const pid of childPids) {
    try {
      if (process.platform === "win32") process.kill(pid, "SIGKILL")
      else process.kill(-pid, "SIGKILL")
    } catch {
      // The expected path already reaped the test process.
    }
    await waitUntil(() => !processIsAlive(pid), 1_000).catch(() => {})
  }
  childPids.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })))
  if (originalDataHome === undefined) delete process.env.NEXUS_DATA_HOME
  else process.env.NEXUS_DATA_HOME = originalDataHome
})

describe.sequential("background shell lifecycle", () => {
  it("publishes a terminal task and preserves its log before owner close resolves", async () => {
    const { cwd, homeDir, runtime, supervisor, services } = await fixture()
    const host = backgroundTestHost(cwd)
    const started = await startBackgroundShellTask({
      command: nodeCommand(
        "process.stdout.write('owner-close-log\\n'); setInterval(() => {}, 1000)",
      ),
      cwd,
      host,
      services,
      sessionId: "session-owner-close",
    })
    childPids.add(started.pid)
    await waitUntil(async () =>
      (await readFile(started.logPath, "utf8").catch(() => ""))
        .includes("owner-close-log"),
    )

    await supervisor.close()

    await expect(runtime.getBackgroundTask(started.taskId)).resolves.toMatchObject({
      status: "killed",
    })
    await expect(runtime.getTask(started.taskId)).resolves.toMatchObject({
      status: "killed",
    })
    await expect(readFile(started.logPath, "utf8")).resolves.toContain(
      "owner-close-log",
    )
    const reopened = new OrchestrationRuntime(cwd, { homeDir })
    await expect(reopened.getBackgroundTask(started.taskId)).resolves.toMatchObject({
      status: "killed",
    })
  })

  it("records command failures as terminal with readable output", async () => {
    const { cwd, runtime, services } = await fixture()
    const host = backgroundTestHost(cwd)
    const started = await startBackgroundShellTask({
      command: nodeCommand(
        "process.stdout.write('failure-log\\n'); process.exit(7)",
      ),
      cwd,
      host,
      services,
      sessionId: "session-failure",
    })
    childPids.add(started.pid)

    await waitUntil(async () =>
      (await runtime.getBackgroundTask(started.taskId))?.status === "failed",
    )

    await expect(runtime.getBackgroundTask(started.taskId)).resolves.toMatchObject({
      status: "failed",
      exitCode: 7,
    })
    await expect(readFile(started.logPath, "utf8")).resolves.toContain(
      "failure-log",
    )
  })

  it("TaskStop waits for live process finalization and flushed output", async () => {
    const { cwd, runtime, supervisor, services } = await fixture()
    const host = backgroundTestHost(cwd)
    const sessionId = "session-stop"
    const started = await startBackgroundShellTask({
      command: nodeCommand(
        "process.stdout.write('stop-ready\\n'); " +
          "process.on('SIGTERM', () => setTimeout(() => { " +
          "process.stdout.write('stop-flushed\\n'); process.exit(0) }, 100)); " +
          "setInterval(() => {}, 1000)",
      ),
      cwd,
      host,
      services,
      sessionId,
    })
    childPids.add(started.pid)
    await waitUntil(async () =>
      (await readFile(started.logPath, "utf8").catch(() => ""))
        .includes("stop-ready"),
    )
    const context: ToolContext = {
      cwd,
      host,
      session: new Session(sessionId, cwd, [], "", true),
      config: createTestConfig(),
      mode: "agent",
      signal: new AbortController().signal,
      services,
    }

    await expect(taskStopTool.execute(
      { taskId: started.taskId },
      context,
    )).resolves.toMatchObject({ success: true })

    await expect(runtime.getBackgroundTask(started.taskId)).resolves.toMatchObject({
      status: "killed",
      metadata: {
        processIdentity: expect.any(String),
        stopReason: "requested",
      },
    })
    await expect(readFile(started.logPath, "utf8")).resolves.toContain(
      "stop-flushed",
    )
    expect(supervisor.get(started.taskId, {
      workspace: cwd,
      sessionId,
    })).toBeUndefined()
  })

  it("TaskOutput terminalizes a running shell task with no matching live identity", async () => {
    const { cwd, runtime, services } = await fixture()
    const host = createFakeHost({ cwd })
    const sessionId = "session-stale-output"
    await runtime.registerBackgroundTask({
      id: "run_stale_output",
      kind: "bash",
      description: "stale output",
      status: "running",
      command: "long-running-command",
      cwd,
      processId: process.pid,
      sessionId,
      metadata: {
        processIdentity: "persisted-only-identity",
        shellRunner: "bash",
      },
    })
    const context: ToolContext = {
      cwd,
      host,
      session: new Session(sessionId, cwd, [], "", true),
      config: createTestConfig(),
      mode: "agent",
      signal: new AbortController().signal,
      services,
    }

    await expect(taskOutputTool.execute(
      { taskId: "run_stale_output", block: false },
      context,
    )).resolves.toMatchObject({
      success: false,
      output: expect.stringMatching(/\[Task status: failed\]/),
    })
    await expect(runtime.getBackgroundTask("run_stale_output")).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(/live runtime-owned process identity/i),
    })
  })

  it("TaskStop refuses a persisted PID but still terminalizes stale running state", async () => {
    const { cwd, runtime, services } = await fixture()
    const host = createFakeHost({ cwd })
    const sessionId = "session-stale-stop"
    await runtime.registerBackgroundTask({
      id: "run_stale_stop",
      kind: "bash",
      description: "stale stop",
      status: "running",
      command: "long-running-command",
      cwd,
      processId: process.pid,
      sessionId,
      metadata: {
        processIdentity: "persisted-only-identity",
        shellRunner: "bash",
      },
    })
    const context: ToolContext = {
      cwd,
      host,
      session: new Session(sessionId, cwd, [], "", true),
      config: createTestConfig(),
      mode: "agent",
      signal: new AbortController().signal,
      services,
    }

    await expect(taskStopTool.execute(
      { taskId: "run_stale_stop" },
      context,
    )).resolves.toMatchObject({
      success: false,
      output: expect.stringMatching(/persisted PID/i),
    })
    await expect(runtime.getBackgroundTask("run_stale_stop")).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(/live runtime-owned process identity/i),
    })
  })
})
