import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises"
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

  it("upgrades legacy memories and redacts secrets on the next mutation", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    const statePath = runtime.getStatePath()
    await mkdir(path.dirname(statePath), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        tasks: [],
        teams: [],
        worktrees: [],
        backgroundTasks: [],
        memories: [{
          id: "memory_legacy",
          scope: "project",
          title: "Legacy convention",
          content: "Use pnpm",
          createdAt: 1,
          updatedAt: 2,
          metadata: { kind: "compaction.discovery" },
        }],
        remoteSessions: [],
      }),
      "utf8",
    )

    expect(await runtime.getMemory("memory_legacy")).toMatchObject({
      schemaVersion: 2,
      kind: "fact",
      trust: "agent",
      source: { type: "compaction" },
    })
    const secret = await runtime.createMemory({
      scope: "project",
      title: "Credential",
      content: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
    })
    expect(secret.content).toBe("[redacted]")
    expect(secret.sensitivity).toBe("sensitive")
    const metadataSecret = await runtime.createMemory({
      scope: "project",
      title: "Provider metadata",
      content: "Use the configured provider.",
      source: {
        type: "external",
        uri: "https://user:password@example.test/config",
      },
      metadata: {
        clientSecret: "do-not-persist",
        nested: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
      },
    })
    expect(metadataSecret).toMatchObject({
      sensitivity: "sensitive",
      source: { uri: "https://[redacted]@example.test/config" },
      metadata: {
        clientSecret: "[redacted]",
        nested: { authorization: "[redacted]" },
      },
    })

    const persisted = JSON.parse(await readFile(statePath, "utf8"))
    expect(JSON.stringify(persisted)).not.toContain("do-not-persist")
    expect(JSON.stringify(persisted)).not.toContain("user:password")
    expect(JSON.stringify(persisted)).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(persisted.state.memories.find((item: { id: string }) => item.id === "memory_legacy"))
      .toMatchObject({ schemaVersion: 2 })
  })

  it("records memory access metadata transactionally and at most once per id per call", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    const first = await runtime.createMemory({
      scope: "project",
      title: "First",
      content: "first",
    })
    const second = await runtime.createMemory({
      scope: "project",
      title: "Second",
      content: "second",
    })

    const touched = await runtime.recordMemoryAccess(
      [first.id, first.id, second.id, "missing"],
      123_456,
    )

    expect(touched.map((memory) => memory.id).sort()).toEqual([first.id, second.id].sort())
    expect(await runtime.getMemory(first.id)).toMatchObject({
      accessedAt: 123_456,
      accessCount: 1,
    })
    expect(await runtime.getMemory(second.id)).toMatchObject({
      accessedAt: 123_456,
      accessCount: 1,
    })
  })

  it("upserts by the redacted canonical title and metadata instead of duplicating secrets", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    const input = {
      scope: "project" as const,
      title: "Token sk-abcdefghijklmnopqrstuvwxyz123456",
      content: "Use the configured token destination.",
      metadata: {
        nested: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456", safe: true },
        order: 1,
      },
    }

    const first = await runtime.upsertMemoryByTitle(input)
    const second = await runtime.upsertMemoryByTitle({
      ...input,
      content: "Updated without creating a duplicate.",
      metadata: {
        order: 1,
        nested: { safe: true, apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456" },
      },
    })

    expect(second.id).toBe(first.id)
    expect(await runtime.listMemories()).toHaveLength(1)
    expect(second.title).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(JSON.stringify(second.metadata)).not.toContain("abcdefghijklmnopqrstuvwxyz")
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

  it("does not trust a live persisted PID as proof that a shell task is still owned", async () => {
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
            id: "shell_stale",
            kind: "bash",
            description: "stale shell with a reused pid",
            status: "running",
            processId: process.pid,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        memories: [],
        remoteSessions: [],
      }),
      "utf8",
    )

    await expect(runtime.getBackgroundTask("shell_stale")).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(/previous Nexus process/i),
    })
    await expect(runtime.getTask("shell_stale")).resolves.toMatchObject({
      status: "failed",
    })
  })

  it("keeps tasks owned by another runtime instance in the same live process running", async () => {
    const { homeDir, cwd } = await fixture()
    const owner = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: true,
    })
    await owner.registerBackgroundTask({
      id: "shell_same_process",
      kind: "bash",
      description: "server-owned shell",
      status: "running",
      processId: process.pid,
      metadata: {
        processIdentity: "live-handle-identity",
      },
    })

    const observer = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: true,
    })

    await expect(observer.getBackgroundTask("shell_same_process")).resolves.toMatchObject({
      status: "running",
    })
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

  it("binds teams to the sessions that explicitly create or use them", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })

    await runtime.createTeam({
      teamName: "core",
      description: "Core team",
      sessionId: "session-a",
    })
    await runtime.createTeam({
      teamName: "other",
      description: "Other team",
    })
    await runtime.createTask({
      subject: "Use the other team",
      description: "Bind through an explicitly session-owned task",
      teamName: "other",
      sessionId: "session-b",
    })

    await expect(runtime.listTeamNamesForSession("session-a")).resolves.toEqual(["core"])
    await expect(runtime.listTeamNamesForSession("session-b")).resolves.toEqual(["other"])
    await expect(runtime.listTeamNamesForSession("session-c")).resolves.toEqual([])

    const reopened = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    await expect(reopened.listTeamNamesForSession("session-a")).resolves.toEqual(["core"])
    await expect(reopened.listTeamNamesForSession("session-b")).resolves.toEqual(["other"])
  })

  it("cleans a legacy team binding derived from a session-owned task", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    const statePath = runtime.getStatePath()
    await mkdir(path.dirname(statePath), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        tasks: [{
          id: "task_legacy_team",
          kind: "tracking",
          subject: "legacy team binding",
          description: "predates TeamRecord.sessionIds",
          status: "completed",
          createdAt: 1,
          updatedAt: 1,
          sessionId: "session_legacy_team",
          teamName: "legacy-exclusive",
        }],
        teams: [{
          name: "legacy-exclusive",
          description: "only linked by the legacy task",
          createdAt: 1,
          members: [],
          messages: [{
            id: "message_legacy_team",
            ts: 1,
            from: "lead",
            to: "worker",
            message: "must not become orphaned",
            teamName: "legacy-exclusive",
          }],
        }],
        worktrees: [],
        backgroundTasks: [],
        memories: [],
        remoteSessions: [],
      }),
      "utf8",
    )

    await expect(
      runtime.deleteSessionRecords("session_legacy_team"),
    ).resolves.toMatchObject({
      removedTasks: 1,
      removedTeams: 1,
    })
    await expect(runtime.getTeam("legacy-exclusive")).resolves.toBeNull()
  })

  it("rejects cleanup while the session owns active orchestration work", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    await runtime.createTask({
      id: "task_active",
      subject: "active",
      description: "must finish first",
      status: "in_progress",
      sessionId: "session-active",
    })

    await expect(
      runtime.deleteSessionRecords("session-active"),
    ).rejects.toThrow(/active orchestration work/i)
    await expect(runtime.getTask("task_active")).resolves.toMatchObject({
      status: "in_progress",
      sessionId: "session-active",
    })
  })

  it("removes terminal session records, exclusive team messages, and only owned snapshots", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    await runtime.createTeam({
      teamName: "exclusive",
      description: "owned by one session",
      sessionId: "session-delete",
    })
    await runtime.sendMessage({
      from: "lead",
      to: "worker",
      message: "private session message",
      teamName: "exclusive",
    })
    await runtime.createTeam({
      teamName: "shared",
      description: "shared team",
      sessionId: "session-delete",
    })
    await runtime.createTeam({
      teamName: "shared",
      description: "shared team",
      sessionId: "session-keep",
    })
    await runtime.sendMessage({
      from: "lead",
      to: "worker",
      message: "shared message",
      teamName: "shared",
    })

    const snapshotDir = path.join(
      path.dirname(runtime.getStatePath()),
      "agent-runs",
    )
    await mkdir(snapshotDir, { recursive: true })
    const ownedSnapshot = path.join(snapshotDir, "subagent_owned.json")
    await writeFile(ownedSnapshot, "{}", "utf8")
    const outsideSnapshot = path.join(path.dirname(homeDir), "outside.json")
    await writeFile(outsideSnapshot, "preserve me", "utf8")

    await runtime.registerBackgroundTask({
      id: "subagent_owned",
      kind: "subagent",
      description: "completed delegated work",
      status: "completed",
      sessionId: "session-delete",
      metadata: {
        snapshotFile: ownedSnapshot,
      },
    })
    await runtime.createTask({
      id: "task_outside_snapshot",
      subject: "outside",
      description: "metadata must never authorize arbitrary deletion",
      status: "completed",
      sessionId: "session-delete",
      snapshotFile: outsideSnapshot,
    })
    await runtime.createTask({
      id: "task_keep",
      subject: "keep",
      description: "belongs to another session",
      status: "pending",
      sessionId: "session-keep",
      blockedBy: ["task_outside_snapshot"],
    })
    const memory = await runtime.createMemory({
      scope: "session",
      title: "private",
      content: "session-only memory",
      source: {
        type: "compaction",
        sessionId: "session-delete",
      },
      metadata: {
        sessionId: "session-delete",
      },
    })
    const remote = await runtime.createRemoteSession({
      url: "http://127.0.0.1",
      sessionId: "session-delete",
      status: "completed",
    })

    const result = await runtime.deleteSessionRecords("session-delete")

    expect(result).toMatchObject({
      removedTasks: 2,
      removedSnapshots: 1,
      retainedSnapshots: 1,
    })
    await expect(runtime.getTask("subagent_owned")).resolves.toBeNull()
    await expect(runtime.getTask("task_outside_snapshot")).resolves.toBeNull()
    await expect(runtime.getBackgroundTask("subagent_owned")).resolves.toBeNull()
    await expect(runtime.getMemory(memory.id)).resolves.toBeNull()
    expect(await runtime.listRemoteSessions({ sessionId: "session-delete" })).toEqual([])
    await expect(runtime.getRemoteSession(remote.id)).resolves.toBeNull()
    await expect(runtime.getTeam("exclusive")).resolves.toBeNull()
    await expect(runtime.getTeam("shared")).resolves.toMatchObject({
      sessionIds: ["session-keep"],
      messages: [{ message: "shared message" }],
    })
    await expect(runtime.getTask("task_keep")).resolves.toMatchObject({
      blockedBy: [],
    })
    await expect(access(ownedSnapshot)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(access(outsideSnapshot)).resolves.toBeUndefined()
  })

  it("keeps durable session records as the retry ledger until snapshot cleanup succeeds", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    const snapshotDir = path.join(
      path.dirname(runtime.getStatePath()),
      "agent-runs",
    )
    await mkdir(snapshotDir, { recursive: true })
    const snapshot = path.join(snapshotDir, "retry.json")
    await writeFile(snapshot, "{}", "utf8")
    await runtime.createTask({
      id: "task_snapshot_retry",
      subject: "snapshot retry",
      description: "record must outlive a transient file cleanup failure",
      status: "completed",
      sessionId: "session_snapshot_retry",
      snapshotFile: snapshot,
    })

    const internals = runtime as unknown as {
      deleteOwnedSessionSnapshots(
        candidates: readonly string[],
      ): Promise<{ removedSnapshots: number; retainedSnapshots: number }>
    }
    const deleteOwnedSessionSnapshots =
      internals.deleteOwnedSessionSnapshots.bind(runtime)
    internals.deleteOwnedSessionSnapshots = async () => {
      throw new Error("simulated transient snapshot cleanup failure")
    }

    await expect(
      runtime.deleteSessionRecords("session_snapshot_retry"),
    ).rejects.toThrow(/transient snapshot cleanup failure/i)
    await expect(runtime.getTask("task_snapshot_retry")).resolves.toMatchObject({
      sessionId: "session_snapshot_retry",
    })

    internals.deleteOwnedSessionSnapshots = deleteOwnedSessionSnapshots
    await expect(
      runtime.deleteSessionRecords("session_snapshot_retry"),
    ).resolves.toMatchObject({
      removedTasks: 1,
      removedSnapshots: 1,
    })
    await expect(runtime.getTask("task_snapshot_retry")).resolves.toBeNull()
  })
})

describe("OrchestrationRuntime delegated-agent mailbox", () => {
  async function registerAgent(
    runtime: OrchestrationRuntime,
    input: {
      id: string
      ownerSessionId: string
      name?: string
    },
  ): Promise<void> {
    await runtime.registerBackgroundTask({
      id: input.id,
      kind: "subagent",
      description: `Agent ${input.id}`,
      status: "running",
      sessionId: input.ownerSessionId,
      metadata: input.name ? { name: input.name } : {},
    })
  }

  it("persists FIFO messages across runtime restart and isolates each owner/target inbox", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    await registerAgent(runtime, {
      id: "subagent_owned",
      ownerSessionId: "session_owner",
      name: "reviewer",
    })
    await registerAgent(runtime, {
      id: "subagent_other",
      ownerSessionId: "session_other",
      name: "reviewer",
    })

    await runtime.enqueueAgentMessage({
      id: "mail_first",
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
      from: "lead",
      message: "first",
    })
    await runtime.enqueueAgentMessage({
      id: "mail_second",
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
      from: "lead",
      message: "second",
    })

    const reopened = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    await expect(reopened.listPendingAgentMessages({
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
    })).resolves.toMatchObject([
      { id: "mail_first", sequence: 1, message: "first" },
      { id: "mail_second", sequence: 2, message: "second" },
    ])
    await expect(reopened.listPendingAgentMessages({
      ownerSessionId: "session_other",
      targetAgentId: "subagent_owned",
    })).resolves.toEqual([])
    await expect(reopened.listPendingAgentMessages({
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_other",
    })).resolves.toEqual([])
  })

  it("acknowledges only an idempotent FIFO prefix for the exact owner and target", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    await registerAgent(runtime, {
      id: "subagent_owned",
      ownerSessionId: "session_owner",
    })
    await registerAgent(runtime, {
      id: "subagent_other",
      ownerSessionId: "session_other",
    })
    for (const [id, message] of [
      ["mail_first", "first"],
      ["mail_second", "second"],
    ] as const) {
      await runtime.enqueueAgentMessage({
        id,
        ownerSessionId: "session_owner",
        targetAgentId: "subagent_owned",
        from: "lead",
        message,
      })
    }

    await expect(runtime.acknowledgeAgentMessages({
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
      messageIds: ["mail_second"],
      acknowledgedBySessionId: "worker_session",
    })).rejects.toThrow(/FIFO/i)
    await expect(runtime.acknowledgeAgentMessages({
      ownerSessionId: "session_other",
      targetAgentId: "subagent_other",
      messageIds: ["mail_first"],
      acknowledgedBySessionId: "foreign_worker",
    })).rejects.toThrow(/owner|target/i)

    await runtime.acknowledgeAgentMessages({
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
      messageIds: ["mail_first"],
      acknowledgedBySessionId: "worker_session",
    })
    await runtime.acknowledgeAgentMessages({
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
      messageIds: ["mail_first"],
      acknowledgedBySessionId: "worker_session",
    })

    await expect(runtime.listPendingAgentMessages({
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
    })).resolves.toMatchObject([{ id: "mail_second" }])
  })

  it("resolves only exact owned ids or a unique persisted task name", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    await registerAgent(runtime, {
      id: "subagent_one",
      ownerSessionId: "session_owner",
      name: "reviewer",
    })
    await registerAgent(runtime, {
      id: "subagent_foreign",
      ownerSessionId: "session_other",
      name: "reviewer",
    })

    await expect(runtime.resolveAgentMessageTarget({
      ownerSessionId: "session_owner",
      target: "subagent_one",
    })).resolves.toBe("subagent_one")
    await expect(runtime.resolveAgentMessageTarget({
      ownerSessionId: "session_owner",
      target: "reviewer",
    })).resolves.toBe("subagent_one")
    await expect(runtime.resolveAgentMessageTarget({
      ownerSessionId: "session_other",
      target: "subagent_one",
    })).resolves.toBeNull()

    await registerAgent(runtime, {
      id: "subagent_two",
      ownerSessionId: "session_owner",
      name: "reviewer",
    })
    await expect(runtime.resolveAgentMessageTarget({
      ownerSessionId: "session_owner",
      target: "reviewer",
    })).rejects.toThrow(/ambiguous/i)
  })

  it("rejects malformed, oversized, or non-idempotent mailbox writes", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    await registerAgent(runtime, {
      id: "subagent_owned",
      ownerSessionId: "session_owner",
    })

    await expect(runtime.enqueueAgentMessage({
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
      from: "lead",
      message: "   ",
    })).rejects.toThrow(/empty/i)
    await expect(runtime.enqueueAgentMessage({
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
      from: "lead",
      message: "x".repeat(64 * 1024 + 1),
    })).rejects.toThrow(/too long/i)

    await runtime.enqueueAgentMessage({
      id: "mail_retry",
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
      from: "lead",
      message: "same",
    })
    await expect(runtime.enqueueAgentMessage({
      id: "mail_retry",
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
      from: "lead",
      message: "same",
    })).resolves.toMatchObject({ id: "mail_retry", sequence: 1 })
    await expect(runtime.enqueueAgentMessage({
      id: "mail_retry",
      ownerSessionId: "session_owner",
      targetAgentId: "subagent_owned",
      from: "lead",
      message: "different",
    })).rejects.toThrow(/already exists/i)
  })

  it("removes owner-scoped mailbox records with a terminal session", async () => {
    const { homeDir, cwd } = await fixture()
    const runtime = new OrchestrationRuntime(cwd, {
      homeDir,
      reconcileStaleRuns: false,
    })
    await registerAgent(runtime, {
      id: "subagent_terminal",
      ownerSessionId: "session_delete",
    })
    await runtime.setBackgroundTaskStatus(
      "subagent_terminal",
      "completed",
    )
    await runtime.enqueueAgentMessage({
      id: "mail_orphan",
      ownerSessionId: "session_delete",
      targetAgentId: "subagent_terminal",
      from: "lead",
      message: "must not outlive its owner",
    })

    await expect(runtime.deleteSessionRecords("session_delete")).resolves.toMatchObject({
      removedAgentMessages: 1,
    })
    await expect(runtime.listPendingAgentMessages({
      ownerSessionId: "session_delete",
      targetAgentId: "subagent_terminal",
    })).resolves.toEqual([])
  })
})
