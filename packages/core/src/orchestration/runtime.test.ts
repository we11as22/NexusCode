import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  OrchestrationCorruptionError,
  OrchestrationInvariantError,
  OrchestrationRuntime,
} from "./runtime.js"

const roots: string[] = []

async function fixture(): Promise<{ homeDir: string; cwd: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-orchestration-"))
  const homeDir = path.join(root, ".nexus")
  const cwd = path.join(root, "workspace")
  await mkdir(cwd)
  roots.push(root)
  return { homeDir, cwd }
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("OrchestrationRuntime durable state", () => {
  it("preserves disjoint concurrent mutations from independent runtime instances", async () => {
    const { homeDir, cwd } = await fixture()
    const first = new OrchestrationRuntime(cwd, { homeDir })
    const second = new OrchestrationRuntime(cwd, { homeDir })

    await Promise.all([
      first.createTask({ id: "task_first", subject: "first", description: "first" }),
      second.createTask({ id: "task_second", subject: "second", description: "second" }),
    ])

    expect((await first.listTasks()).map((task) => task.id).sort()).toEqual([
      "task_first",
      "task_second",
    ])
  })

  it("treats a retried explicit task creation as idempotent", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    const first = await runtime.createTask({
      id: "task_retry",
      subject: "retry",
      description: "same operation",
    })
    const revisionBeforeRetry = JSON.parse(await readFile(runtime.getStatePath(), "utf8")).revision
    const second = await runtime.createTask({
      id: "task_retry",
      subject: "retry",
      description: "same operation",
    })

    expect(second).toEqual(first)
    expect(JSON.parse(await readFile(runtime.getStatePath(), "utf8")).revision).toBe(
      revisionBeforeRetry,
    )
    expect((await runtime.listTasks()).filter((task) => task.id === "task_retry")).toHaveLength(1)
  })

  it("backs up and migrates legacy state.json on the first mutation", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    const statePath = runtime.getStatePath()
    await mkdir(path.dirname(statePath), { recursive: true })
    const legacy = JSON.stringify({
      tasks: [
        {
          id: "task_legacy",
          kind: "tracking",
          subject: "legacy",
          description: "legacy",
          status: "pending",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      teams: [],
      worktrees: [],
      backgroundTasks: [],
      memories: [],
      remoteSessions: [],
    }, null, 2)
    await writeFile(statePath, legacy, "utf8")

    await runtime.createTask({ id: "task_new", subject: "new", description: "new" })

    expect(await readFile(`${statePath}.legacy-v1.bak`, "utf8")).toBe(legacy)
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      revision: 1,
    })
    expect((await runtime.listTasks()).map((task) => task.id).sort()).toEqual([
      "task_legacy",
      "task_new",
    ])
  })

  it("recovers a verified journal revision after a torn tail", async () => {
    const { homeDir, cwd } = await fixture()
    const diagnostics: string[] = []
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    })
    await runtime.createTask({ id: "task_safe", subject: "safe", description: "safe" })
    await appendFile(runtime.getJournalPath(), '{"type":"orchestration_transition"', "utf8")

    expect((await runtime.listTasks()).map((task) => task.id)).toEqual(["task_safe"])
    expect(diagnostics).toContain("corrupt-journal-tail")

    await runtime.createTask({ id: "task_after", subject: "after", description: "after" })
    const files = await import("node:fs/promises").then((fs) =>
      fs.readdir(path.dirname(runtime.getJournalPath())),
    )
    expect(files.some((file) => file.startsWith("state.journal.jsonl.corrupt-"))).toBe(true)
    expect((await runtime.listTasks()).map((task) => task.id).sort()).toEqual([
      "task_after",
      "task_safe",
    ])
  })

  it("throws on corrupt state instead of silently starting empty", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    await mkdir(path.dirname(runtime.getStatePath()), { recursive: true })
    await writeFile(runtime.getStatePath(), "{broken", "utf8")

    await expect(runtime.listTasks()).rejects.toBeInstanceOf(OrchestrationCorruptionError)
  })

  it("rejects a v2 snapshot with an invalid checksum instead of treating it as legacy", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    await mkdir(path.dirname(runtime.getStatePath()), { recursive: true })
    await writeFile(
      runtime.getStatePath(),
      JSON.stringify({
        schemaVersion: 2,
        revision: 7,
        updatedAt: Date.now(),
        writer: { pid: 1, hostname: "other", instanceId: "bad" },
        stateChecksum: "not-the-state-checksum",
        state: {
          tasks: [],
          teams: [],
          worktrees: [],
          backgroundTasks: [],
          memories: [],
          remoteSessions: [],
        },
      }),
      "utf8",
    )

    await expect(runtime.listTasks()).rejects.toBeInstanceOf(OrchestrationCorruptionError)
  })

  it("rejects completing a task while declared blockers remain unresolved", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    await runtime.createTask({
      id: "task_blocker",
      subject: "blocker",
      description: "blocker",
      status: "in_progress",
    })
    await runtime.createTask({
      id: "task_blocked",
      subject: "blocked",
      description: "blocked",
      blockedBy: ["task_blocker"],
    })

    await expect(
      runtime.updateTask("task_blocked", { status: "completed" }),
    ).rejects.toBeInstanceOf(OrchestrationInvariantError)

    await runtime.updateTask("task_blocker", { status: "completed" })
    await expect(runtime.updateTask("task_blocked", { status: "completed" })).resolves.toMatchObject({
      status: "completed",
    })
  })

  it("rejects dependency cycles and completion with unfinished children", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    await runtime.createTask({ id: "task_parent", subject: "parent", description: "parent" })
    await runtime.createTask({
      id: "task_child",
      subject: "child",
      description: "child",
      parentTaskId: "task_parent",
    })

    await expect(
      runtime.updateTask("task_parent", { status: "completed" }),
    ).rejects.toBeInstanceOf(OrchestrationInvariantError)
    await runtime.updateTask("task_child", { status: "completed" })
    await runtime.updateTask("task_parent", { status: "completed" })

    await runtime.createTask({ id: "task_a", subject: "a", description: "a" })
    await runtime.createTask({
      id: "task_b",
      subject: "b",
      description: "b",
      blockedBy: ["task_a"],
    })
    await expect(
      runtime.updateTask("task_a", { addBlockedBy: ["task_b"] }),
    ).rejects.toBeInstanceOf(OrchestrationInvariantError)
  })

  it("keeps blocks and blockedBy edges symmetric", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    await runtime.createTask({ id: "task_a", subject: "a", description: "a" })
    await runtime.createTask({ id: "task_b", subject: "b", description: "b" })

    await runtime.updateTask("task_a", { addBlocks: ["task_b"] })

    expect(await runtime.getTask("task_a")).toMatchObject({ blocks: ["task_b"] })
    expect(await runtime.getTask("task_b")).toMatchObject({ blockedBy: ["task_a"] })
  })

  it("reconciles stale running subagents imported from a previous process", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, { homeDir, reconcileStaleRuns: true })
    const statePath = runtime.getStatePath()
    await mkdir(path.dirname(statePath), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        tasks: [],
        teams: [],
        worktrees: [],
        backgroundTasks: [
          {
            id: "agent_stale",
            kind: "subagent",
            description: "stale",
            status: "running",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        memories: [],
        remoteSessions: [],
      }),
      "utf8",
    )

    const task = await runtime.getBackgroundTask("agent_stale")
    expect(task).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/interrupted/i),
    })
    expect(await runtime.getTask("agent_stale")).toMatchObject({ status: "failed" })
  })

  it("persists every orchestration domain through one transactional repository", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    await runtime.createTeam({ teamName: "core", description: "Core team" })
    await runtime.addTeamMember("core", {
      name: "worker",
      joinedAt: 1,
      status: "active",
    })
    await runtime.sendMessage({ from: "lead", to: "worker", teamName: "core", message: "go" })
    await runtime.registerBackgroundTask({
      id: "job_1",
      kind: "workflow",
      description: "workflow",
      status: "pending",
    })
    await runtime.updateBackgroundTask("job_1", { status: "completed", output: "done" })
    const worktree = await runtime.createWorktreeSession({
      originalCwd: cwd,
      worktreePath: path.join(cwd, ".worktrees", "one"),
      branch: "feature/one",
    })
    await runtime.updateWorktreeSession(worktree.id, { status: "kept" })
    const memory = await runtime.createMemory({
      scope: "project",
      title: "Architecture",
      content: "Use journals",
    })
    await runtime.updateMemory(memory.id, { content: "Use checksummed journals" })
    const remote = await runtime.createRemoteSession({
      url: "http://127.0.0.1",
      status: "connecting",
    })
    await runtime.updateRemoteSession(remote.id, { status: "completed", lastEventSeq: 9 })

    const reopened = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    expect(await reopened.getTeam("core")).toMatchObject({
      members: [{ name: "worker" }],
      messages: [{ message: "go" }],
    })
    expect(await reopened.getBackgroundTask("job_1")).toMatchObject({
      status: "completed",
      output: "done",
    })
    expect(await reopened.findActiveWorktree()).toBeNull()
    expect(await reopened.getMemory(memory.id)).toMatchObject({
      content: "Use checksummed journals",
    })
    expect(await reopened.getRemoteSession(remote.id)).toMatchObject({
      status: "completed",
      lastEventSeq: 9,
    })
    await expect(reopened.deleteMemory(memory.id)).resolves.toBe(true)
    await expect(reopened.deleteTeam("core")).resolves.toBe(true)
  })
})
