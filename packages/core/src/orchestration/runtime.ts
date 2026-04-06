import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
  type BackgroundTaskRecord,
  type BackgroundTaskStatus,
  type MemoryRecord,
  type RemoteSessionRecord,
  type TaskKind,
  type TaskRecord,
  type TaskStatus,
  type TeamMemberRecord,
  type TeamMessageRecord,
  type TeamRecord,
  type WorktreeSession,
} from "../types.js"
import { canonicalProjectRoot } from "../session/storage.js"

type StoredRuntimeState = {
  tasks: TaskRecord[]
  teams: TeamRecord[]
  worktrees: WorktreeSession[]
  backgroundTasks: BackgroundTaskRecord[]
  memories: MemoryRecord[]
  remoteSessions: RemoteSessionRecord[]
}

function projectHash(cwd: string): string {
  return crypto.createHash("sha1").update(canonicalProjectRoot(cwd)).digest("hex").slice(0, 12)
}

export function getRuntimeDir(cwd: string): string {
  return path.join(os.homedir(), ".nexus", "runtime", projectHash(cwd))
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
}

function mapBackgroundKindToTaskKind(kind: BackgroundTaskRecord["kind"]): TaskKind {
  switch (kind) {
    case "subagent":
      return "agent"
    case "bash":
      return "shell"
    case "workflow":
      return "workflow"
    default:
      return "external"
  }
}

function mapBackgroundStatusToTaskStatus(status: BackgroundTaskStatus): TaskStatus {
  switch (status) {
    case "running":
      return "in_progress"
    case "failed":
      return "failed"
    case "killed":
      return "killed"
    case "completed":
      return "completed"
    default:
      return "pending"
  }
}

export class OrchestrationRuntime {
  private readonly root: string
  private readonly stateFile: string
  private loaded = false
  private tasks = new Map<string, TaskRecord>()
  private teams = new Map<string, TeamRecord>()
  private worktrees = new Map<string, WorktreeSession>()
  private backgroundTasks = new Map<string, BackgroundTaskRecord>()
  private memories = new Map<string, MemoryRecord>()
  private remoteSessions = new Map<string, RemoteSessionRecord>()

  constructor(readonly cwd: string) {
    this.root = getRuntimeDir(cwd)
    this.stateFile = path.join(this.root, "state.json")
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    await fs.mkdir(this.root, { recursive: true })
    try {
      const raw = await fs.readFile(this.stateFile, "utf8")
      const parsed = JSON.parse(raw) as Partial<StoredRuntimeState>
      for (const task of parsed.tasks ?? []) {
        this.tasks.set(task.id, {
          ...task,
          kind: task.kind ?? "tracking",
        })
      }
      for (const team of parsed.teams ?? []) this.teams.set(team.name, team)
      for (const worktree of parsed.worktrees ?? []) this.worktrees.set(worktree.id, worktree)
      for (const backgroundTask of parsed.backgroundTasks ?? []) this.backgroundTasks.set(backgroundTask.id, backgroundTask)
      for (const memory of parsed.memories ?? []) this.memories.set(memory.id, memory)
      for (const remoteSession of parsed.remoteSessions ?? []) this.remoteSessions.set(remoteSession.id, remoteSession)
      for (const backgroundTask of this.backgroundTasks.values()) {
        if (this.tasks.has(backgroundTask.id)) continue
        this.tasks.set(backgroundTask.id, {
          id: backgroundTask.id,
          kind: mapBackgroundKindToTaskKind(backgroundTask.kind),
          subject: backgroundTask.description,
          description: backgroundTask.description,
          status: mapBackgroundStatusToTaskStatus(backgroundTask.status),
          createdAt: backgroundTask.createdAt,
          updatedAt: backgroundTask.updatedAt,
          ...(backgroundTask.command ? { command: backgroundTask.command } : {}),
          ...(typeof backgroundTask.processId === "number" ? { processId: backgroundTask.processId } : {}),
          ...(typeof backgroundTask.exitCode === "number" ? { exitCode: backgroundTask.exitCode } : {}),
          ...(backgroundTask.sessionId ? { sessionId: backgroundTask.sessionId } : {}),
          ...(typeof backgroundTask.output === "string" ? { output: backgroundTask.output } : {}),
          ...(backgroundTask.outputFile ? { outputFile: backgroundTask.outputFile } : {}),
          ...(typeof backgroundTask.metadata?.snapshotFile === "string" ? { snapshotFile: backgroundTask.metadata.snapshotFile } : {}),
          ...(backgroundTask.error ? { error: backgroundTask.error } : {}),
          ...(typeof backgroundTask.metadata?.resumeOf === "string" ? { resumeOf: backgroundTask.metadata.resumeOf } : {}),
          ...(typeof backgroundTask.metadata?.forkOf === "string" ? { forkOf: backgroundTask.metadata.forkOf } : {}),
          ...(typeof backgroundTask.metadata?.agentType === "string" ? { agentType: backgroundTask.metadata.agentType } : {}),
          ...(backgroundTask.metadata ? { metadata: backgroundTask.metadata } : {}),
        })
      }
    } catch {
      // Fresh runtime state.
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    const state: StoredRuntimeState = {
      tasks: Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt),
      teams: Array.from(this.teams.values()).sort((a, b) => a.createdAt - b.createdAt),
      worktrees: Array.from(this.worktrees.values()).sort((a, b) => a.createdAt - b.createdAt),
      backgroundTasks: Array.from(this.backgroundTasks.values()).sort((a, b) => a.createdAt - b.createdAt),
      memories: Array.from(this.memories.values()).sort((a, b) => a.createdAt - b.createdAt),
      remoteSessions: Array.from(this.remoteSessions.values()).sort((a, b) => a.createdAt - b.createdAt),
    }
    await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf8")
  }

  async createTask(input: {
    id?: string
    kind?: TaskKind
    subject: string
    description: string
    status?: TaskStatus
    activeForm?: string
    owner?: string
    teamName?: string
    metadata?: Record<string, unknown>
    blocks?: string[]
    blockedBy?: string[]
    command?: string
    shellRunner?: "bash" | "powershell"
    processId?: number
    exitCode?: number
    sessionId?: string
    output?: string
    outputFile?: string
    snapshotFile?: string
    error?: string
    parentTaskId?: string
    resumeOf?: string
    forkOf?: string
    agentType?: string
    toolUseId?: string
  }): Promise<TaskRecord> {
    await this.ensureLoaded()
    const now = Date.now()
    const task: TaskRecord = {
      id: input.id ?? newId("task"),
      kind: input.kind ?? "tracking",
      subject: input.subject,
      description: input.description,
      status: input.status ?? "pending",
      createdAt: now,
      updatedAt: now,
      ...(input.activeForm ? { activeForm: input.activeForm } : {}),
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.teamName ? { teamName: input.teamName } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.blocks?.length ? { blocks: [...input.blocks] } : {}),
      ...(input.blockedBy?.length ? { blockedBy: [...input.blockedBy] } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.shellRunner ? { shellRunner: input.shellRunner } : {}),
      ...(typeof input.processId === "number" ? { processId: input.processId } : {}),
      ...(typeof input.exitCode === "number" ? { exitCode: input.exitCode } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(typeof input.output === "string" ? { output: input.output } : {}),
      ...(input.outputFile ? { outputFile: input.outputFile } : {}),
      ...(input.snapshotFile ? { snapshotFile: input.snapshotFile } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.resumeOf ? { resumeOf: input.resumeOf } : {}),
      ...(input.forkOf ? { forkOf: input.forkOf } : {}),
      ...(input.agentType ? { agentType: input.agentType } : {}),
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
    }
    this.tasks.set(task.id, task)
    await this.persist()
    return task
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    await this.ensureLoaded()
    return this.tasks.get(taskId) ?? null
  }

  async listTasks(filters?: {
    kind?: TaskKind | TaskKind[]
    teamName?: string
    owner?: string
    status?: TaskStatus | TaskStatus[]
    includeDeleted?: boolean
  }): Promise<TaskRecord[]> {
    await this.ensureLoaded()
    const statuses = Array.isArray(filters?.status)
      ? new Set(filters?.status)
      : filters?.status
        ? new Set([filters.status])
        : null
    const kinds = Array.isArray(filters?.kind)
      ? new Set(filters.kind)
      : filters?.kind
        ? new Set([filters.kind])
        : null
    return Array.from(this.tasks.values())
      .filter((task) => (filters?.includeDeleted ? true : task.status !== "deleted"))
      .filter((task) => (kinds ? kinds.has(task.kind) : true))
      .filter((task) => (filters?.teamName ? task.teamName === filters.teamName : true))
      .filter((task) => (filters?.owner ? task.owner === filters.owner : true))
      .filter((task) => (statuses ? statuses.has(task.status) : true))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async updateTask(
    taskId: string,
    updates: Partial<Pick<TaskRecord, "status" | "subject" | "description" | "activeForm" | "owner" | "teamName" | "command" | "shellRunner" | "processId" | "exitCode" | "sessionId" | "output" | "outputFile" | "snapshotFile" | "error" | "parentTaskId" | "resumeOf" | "forkOf" | "agentType">> & {
      metadata?: Record<string, unknown | null>
      addBlocks?: string[]
      addBlockedBy?: string[]
    },
  ): Promise<TaskRecord | null> {
    await this.ensureLoaded()
    const existing = this.tasks.get(taskId)
    if (!existing) return null
    const nextMetadata = { ...(existing.metadata ?? {}) }
    for (const [key, value] of Object.entries(updates.metadata ?? {})) {
      if (value === null) delete nextMetadata[key]
      else nextMetadata[key] = value
    }
    const next: TaskRecord = {
      ...existing,
      ...(updates.status ? { status: updates.status } : {}),
      ...(typeof updates.subject === "string" ? { subject: updates.subject } : {}),
      ...(typeof updates.description === "string" ? { description: updates.description } : {}),
      ...(typeof updates.activeForm === "string" ? { activeForm: updates.activeForm } : {}),
      ...(typeof updates.owner === "string" ? { owner: updates.owner } : {}),
      ...(typeof updates.teamName === "string" ? { teamName: updates.teamName } : {}),
      ...(typeof updates.command === "string" ? { command: updates.command } : {}),
      ...(updates.shellRunner ? { shellRunner: updates.shellRunner } : {}),
      ...(typeof updates.processId === "number" ? { processId: updates.processId } : {}),
      ...(typeof updates.exitCode === "number" ? { exitCode: updates.exitCode } : {}),
      ...(typeof updates.sessionId === "string" ? { sessionId: updates.sessionId } : {}),
      ...(typeof updates.output === "string" ? { output: updates.output } : {}),
      ...(typeof updates.outputFile === "string" ? { outputFile: updates.outputFile } : {}),
      ...(typeof updates.snapshotFile === "string" ? { snapshotFile: updates.snapshotFile } : {}),
      ...(typeof updates.error === "string" ? { error: updates.error } : {}),
      ...(typeof updates.parentTaskId === "string" ? { parentTaskId: updates.parentTaskId } : {}),
      ...(typeof updates.resumeOf === "string" ? { resumeOf: updates.resumeOf } : {}),
      ...(typeof updates.forkOf === "string" ? { forkOf: updates.forkOf } : {}),
      ...(typeof updates.agentType === "string" ? { agentType: updates.agentType } : {}),
      ...(updates.metadata ? { metadata: nextMetadata } : {}),
      ...(updates.addBlocks?.length
        ? { blocks: Array.from(new Set([...(existing.blocks ?? []), ...updates.addBlocks])) }
        : {}),
      ...(updates.addBlockedBy?.length
        ? { blockedBy: Array.from(new Set([...(existing.blockedBy ?? []), ...updates.addBlockedBy])) }
        : {}),
      updatedAt: Date.now(),
    }
    this.tasks.set(taskId, next)
    await this.persist()
    return next
  }

  async createTeam(input: {
    teamName: string
    description: string
    members?: TeamMemberRecord[]
  }): Promise<TeamRecord> {
    await this.ensureLoaded()
    const existing = this.teams.get(input.teamName)
    if (existing) return existing
    const team: TeamRecord = {
      name: input.teamName,
      description: input.description,
      createdAt: Date.now(),
      members: input.members ?? [],
      messages: [],
    }
    this.teams.set(team.name, team)
    await this.persist()
    return team
  }

  async getTeam(teamName: string): Promise<TeamRecord | null> {
    await this.ensureLoaded()
    return this.teams.get(teamName) ?? null
  }

  async listTeams(): Promise<TeamRecord[]> {
    await this.ensureLoaded()
    return Array.from(this.teams.values()).sort((a, b) => a.createdAt - b.createdAt)
  }

  async deleteTeam(teamName: string): Promise<boolean> {
    await this.ensureLoaded()
    const existed = this.teams.delete(teamName)
    if (existed) await this.persist()
    return existed
  }

  async addTeamMember(teamName: string, member: TeamMemberRecord): Promise<TeamRecord | null> {
    await this.ensureLoaded()
    const team = this.teams.get(teamName)
    if (!team) return null
    const existing = team.members.find((item) => item.name === member.name)
    const next: TeamRecord = {
      ...team,
      members: [
        ...team.members.filter((item) => item.name !== member.name),
        {
          ...(existing ?? {}),
          ...member,
          joinedAt: existing?.joinedAt ?? member.joinedAt,
        },
      ],
    }
    this.teams.set(teamName, next)
    await this.persist()
    return next
  }

  async updateTeamMember(
    teamName: string,
    memberName: string,
    updates: Partial<Omit<TeamMemberRecord, "name" | "joinedAt" | "note">> & { note?: string | null },
  ): Promise<TeamRecord | null> {
    await this.ensureLoaded()
    const team = this.teams.get(teamName)
    if (!team) return null
    const existing = team.members.find((item) => item.name === memberName)
    if (!existing) return null
    const nextMember: TeamMemberRecord = {
      ...existing,
      ...(typeof updates.agentId === "string" ? { agentId: updates.agentId } : {}),
      ...(typeof updates.agentType === "string" ? { agentType: updates.agentType } : {}),
      ...(typeof updates.status === "string" ? { status: updates.status } : {}),
      ...(typeof updates.lastActiveAt === "number" ? { lastActiveAt: updates.lastActiveAt } : {}),
      ...(typeof updates.lastIdleAt === "number" ? { lastIdleAt: updates.lastIdleAt } : {}),
      ...(updates.note === null ? {} : typeof updates.note === "string" ? { note: updates.note } : {}),
    }
    if (updates.note === null) delete nextMember.note
    const next: TeamRecord = {
      ...team,
      members: [
        ...team.members.filter((item) => item.name !== memberName),
        nextMember,
      ],
    }
    this.teams.set(teamName, next)
    await this.persist()
    return next
  }

  async sendMessage(input: {
    from: string
    to: string
    message: string
    teamName?: string
  }): Promise<TeamMessageRecord> {
    await this.ensureLoaded()
    const record: TeamMessageRecord = {
      id: newId("teammsg"),
      ts: Date.now(),
      from: input.from,
      to: input.to,
      message: input.message,
      ...(input.teamName ? { teamName: input.teamName } : {}),
    }
    if (input.teamName && this.teams.has(input.teamName)) {
      const team = this.teams.get(input.teamName)!
      this.teams.set(input.teamName, {
        ...team,
        messages: [...team.messages, record],
      })
      await this.persist()
    }
    return record
  }

  async registerBackgroundTask(
    task: Omit<BackgroundTaskRecord, "createdAt" | "updatedAt">,
  ): Promise<BackgroundTaskRecord> {
    await this.ensureLoaded()
    const now = Date.now()
    const record: BackgroundTaskRecord = {
      ...task,
      createdAt: now,
      updatedAt: now,
    }
    this.backgroundTasks.set(record.id, record)
    const existingTask = this.tasks.get(record.id)
    const mirrored: TaskRecord = {
      id: record.id,
      kind: mapBackgroundKindToTaskKind(record.kind),
      subject: existingTask?.subject ?? record.description,
      description: record.description,
      status: mapBackgroundStatusToTaskStatus(record.status),
      createdAt: existingTask?.createdAt ?? now,
      updatedAt: now,
      ...(existingTask?.activeForm ? { activeForm: existingTask.activeForm } : {}),
      ...(existingTask?.owner ? { owner: existingTask.owner } : {}),
      ...(existingTask?.teamName ? { teamName: existingTask.teamName } : {}),
      metadata: {
        ...(existingTask?.metadata ?? {}),
        ...(record.metadata ?? {}),
      },
      ...(existingTask?.blocks?.length ? { blocks: existingTask.blocks } : {}),
      ...(existingTask?.blockedBy?.length ? { blockedBy: existingTask.blockedBy } : {}),
      ...(record.command ? { command: record.command } : {}),
      ...(record.metadata?.shellRunner === "powershell" ? { shellRunner: "powershell" as const } : record.kind === "bash" ? { shellRunner: "bash" as const } : {}),
      ...(typeof record.processId === "number" ? { processId: record.processId } : {}),
      ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(typeof record.output === "string" ? { output: record.output } : {}),
      ...(record.outputFile ? { outputFile: record.outputFile } : {}),
      ...(typeof record.metadata?.snapshotFile === "string" ? { snapshotFile: record.metadata.snapshotFile } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(typeof record.metadata?.parentTaskId === "string" ? { parentTaskId: record.metadata.parentTaskId } : {}),
      ...(typeof record.metadata?.resumeOf === "string" ? { resumeOf: record.metadata.resumeOf } : {}),
      ...(typeof record.metadata?.forkOf === "string" ? { forkOf: record.metadata.forkOf } : {}),
      ...(typeof record.metadata?.agentType === "string" ? { agentType: record.metadata.agentType } : {}),
      ...(existingTask?.toolUseId ? { toolUseId: existingTask.toolUseId } : {}),
    }
    this.tasks.set(record.id, mirrored)
    await this.persist()
    return record
  }

  async updateBackgroundTask(
    taskId: string,
    updates: Partial<Omit<BackgroundTaskRecord, "id" | "kind" | "createdAt">>,
  ): Promise<BackgroundTaskRecord | null> {
    await this.ensureLoaded()
    const existing = this.backgroundTasks.get(taskId)
    if (!existing) return null
    const next: BackgroundTaskRecord = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    }
    this.backgroundTasks.set(taskId, next)
    const mirrored = this.tasks.get(taskId)
    if (mirrored) {
      this.tasks.set(taskId, {
        ...mirrored,
        kind: mapBackgroundKindToTaskKind(next.kind),
        description: next.description,
        status: mapBackgroundStatusToTaskStatus(next.status),
        updatedAt: next.updatedAt,
        ...(next.command ? { command: next.command } : {}),
        ...(typeof next.processId === "number" ? { processId: next.processId } : {}),
        ...(typeof next.exitCode === "number" ? { exitCode: next.exitCode } : {}),
        ...(next.sessionId ? { sessionId: next.sessionId } : {}),
        ...(typeof next.output === "string" ? { output: next.output } : {}),
        ...(next.outputFile ? { outputFile: next.outputFile } : {}),
        ...(typeof next.metadata?.snapshotFile === "string" ? { snapshotFile: next.metadata.snapshotFile } : {}),
        ...(next.error ? { error: next.error } : {}),
        ...(typeof next.metadata?.resumeOf === "string" ? { resumeOf: next.metadata.resumeOf } : {}),
        ...(typeof next.metadata?.forkOf === "string" ? { forkOf: next.metadata.forkOf } : {}),
        ...(typeof next.metadata?.agentType === "string" ? { agentType: next.metadata.agentType } : {}),
        metadata: {
          ...(mirrored.metadata ?? {}),
          ...(next.metadata ?? {}),
        },
      })
    }
    await this.persist()
    return next
  }

  async setBackgroundTaskStatus(
    taskId: string,
    status: BackgroundTaskStatus,
    extra?: Partial<BackgroundTaskRecord>,
  ): Promise<BackgroundTaskRecord | null> {
    return this.updateBackgroundTask(taskId, { status, ...(extra ?? {}) })
  }

  async getBackgroundTask(taskId: string): Promise<BackgroundTaskRecord | null> {
    await this.ensureLoaded()
    return this.backgroundTasks.get(taskId) ?? null
  }

  async listBackgroundTasks(): Promise<BackgroundTaskRecord[]> {
    await this.ensureLoaded()
    return Array.from(this.backgroundTasks.values()).sort((a, b) => a.createdAt - b.createdAt)
  }

  async createWorktreeSession(input: {
    originalCwd: string
    worktreePath: string
    branch: string
    metadata?: Record<string, unknown>
  }): Promise<WorktreeSession> {
    await this.ensureLoaded()
    const session: WorktreeSession = {
      id: newId("worktree"),
      originalCwd: input.originalCwd,
      worktreePath: input.worktreePath,
      branch: input.branch,
      createdAt: Date.now(),
      status: "active",
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }
    this.worktrees.set(session.id, session)
    await this.persist()
    return session
  }

  async findActiveWorktree(worktreePath?: string): Promise<WorktreeSession | null> {
    await this.ensureLoaded()
    const items = Array.from(this.worktrees.values())
      .filter((item) => item.status === "active")
      .sort((a, b) => b.createdAt - a.createdAt)
    if (!worktreePath) return items[0] ?? null
    const abs = path.resolve(worktreePath)
    return items.find((item) => path.resolve(item.worktreePath) === abs) ?? null
  }

  async updateWorktreeSession(
    worktreeId: string,
    updates: Partial<Pick<WorktreeSession, "status" | "metadata">>,
  ): Promise<WorktreeSession | null> {
    await this.ensureLoaded()
    const current = this.worktrees.get(worktreeId)
    if (!current) return null
    const next: WorktreeSession = { ...current, ...updates }
    this.worktrees.set(worktreeId, next)
    await this.persist()
    return next
  }

  async createMemory(input: {
    scope: MemoryRecord["scope"]
    title: string
    content: string
    metadata?: Record<string, unknown>
  }): Promise<MemoryRecord> {
    await this.ensureLoaded()
    const now = Date.now()
    const memory: MemoryRecord = {
      id: newId("memory"),
      scope: input.scope,
      title: input.title,
      content: input.content,
      createdAt: now,
      updatedAt: now,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }
    this.memories.set(memory.id, memory)
    await this.persist()
    return memory
  }

  async getMemory(memoryId: string): Promise<MemoryRecord | null> {
    await this.ensureLoaded()
    return this.memories.get(memoryId) ?? null
  }

  async listMemories(filters?: {
    scope?: MemoryRecord["scope"] | MemoryRecord["scope"][]
    limit?: number
    metadataMatch?: Record<string, string | number | boolean>
  }): Promise<MemoryRecord[]> {
    await this.ensureLoaded()
    const scopes = Array.isArray(filters?.scope)
      ? new Set(filters.scope)
      : filters?.scope
        ? new Set([filters.scope])
        : null
    let items = Array.from(this.memories.values())
      .filter((memory) => (scopes ? scopes.has(memory.scope) : true))
      .filter((memory) => {
        if (!filters?.metadataMatch) return true
        for (const [key, expected] of Object.entries(filters.metadataMatch)) {
          if ((memory.metadata ?? {})[key] !== expected) return false
        }
        return true
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
    if (typeof filters?.limit === "number" && filters.limit > 0) {
      items = items.slice(0, filters.limit)
    }
    return items
  }

  async updateMemory(
    memoryId: string,
    updates: Partial<Pick<MemoryRecord, "title" | "content">> & {
      metadata?: Record<string, unknown | null>
    },
  ): Promise<MemoryRecord | null> {
    await this.ensureLoaded()
    const existing = this.memories.get(memoryId)
    if (!existing) return null
    const nextMetadata = { ...(existing.metadata ?? {}) }
    for (const [key, value] of Object.entries(updates.metadata ?? {})) {
      if (value === null) delete nextMetadata[key]
      else nextMetadata[key] = value
    }
    const next: MemoryRecord = {
      ...existing,
      ...(typeof updates.title === "string" ? { title: updates.title } : {}),
      ...(typeof updates.content === "string" ? { content: updates.content } : {}),
      ...(updates.metadata ? { metadata: nextMetadata } : {}),
      updatedAt: Date.now(),
    }
    this.memories.set(memoryId, next)
    await this.persist()
    return next
  }

  async upsertMemoryByTitle(input: {
    scope: MemoryRecord["scope"]
    title: string
    content: string
    metadata?: Record<string, unknown>
  }): Promise<MemoryRecord> {
    await this.ensureLoaded()
    const existing = Array.from(this.memories.values()).find(
      (memory) =>
        memory.scope === input.scope &&
        memory.title === input.title &&
        JSON.stringify(memory.metadata ?? {}) === JSON.stringify(input.metadata ?? {}),
    )
    if (!existing) return this.createMemory(input)
    return (await this.updateMemory(existing.id, {
      content: input.content,
      metadata: input.metadata
        ? Object.fromEntries(Object.entries(input.metadata).map(([key, value]) => [key, value]))
        : undefined,
    })) ?? existing
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    await this.ensureLoaded()
    const existed = this.memories.delete(memoryId)
    if (existed) await this.persist()
    return existed
  }

  async createRemoteSession(input: {
    url: string
    sessionId?: string
    runId?: string
    status?: RemoteSessionRecord["status"]
    viewerOnly?: boolean
    reconnectable?: boolean
    metadata?: Record<string, unknown>
  }): Promise<RemoteSessionRecord> {
    await this.ensureLoaded()
    const now = Date.now()
    const record: RemoteSessionRecord = {
      id: newId("remote"),
      url: input.url,
      createdAt: now,
      updatedAt: now,
      status: input.status ?? "connecting",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(typeof input.viewerOnly === "boolean" ? { viewerOnly: input.viewerOnly } : {}),
      ...(typeof input.reconnectable === "boolean" ? { reconnectable: input.reconnectable } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }
    this.remoteSessions.set(record.id, record)
    await this.persist()
    return record
  }

  async getRemoteSession(remoteSessionId: string): Promise<RemoteSessionRecord | null> {
    await this.ensureLoaded()
    return this.remoteSessions.get(remoteSessionId) ?? null
  }

  async listRemoteSessions(filters?: {
    sessionId?: string
    runId?: string
    status?: RemoteSessionRecord["status"] | RemoteSessionRecord["status"][]
  }): Promise<RemoteSessionRecord[]> {
    await this.ensureLoaded()
    const statuses = Array.isArray(filters?.status)
      ? new Set(filters.status)
      : filters?.status
        ? new Set([filters.status])
        : null
    return Array.from(this.remoteSessions.values())
      .filter((record) => (filters?.sessionId ? record.sessionId === filters.sessionId : true))
      .filter((record) => (filters?.runId ? record.runId === filters.runId : true))
      .filter((record) => (statuses ? statuses.has(record.status) : true))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async updateRemoteSession(
    remoteSessionId: string,
    updates: Partial<Omit<RemoteSessionRecord, "id" | "createdAt" | "url">> & {
      metadata?: Record<string, unknown | null>
    },
  ): Promise<RemoteSessionRecord | null> {
    await this.ensureLoaded()
    const existing = this.remoteSessions.get(remoteSessionId)
    if (!existing) return null
    const nextMetadata = { ...(existing.metadata ?? {}) }
    for (const [key, value] of Object.entries(updates.metadata ?? {})) {
      if (value === null) delete nextMetadata[key]
      else nextMetadata[key] = value
    }
    const next: RemoteSessionRecord = {
      ...existing,
      ...updates,
      ...(updates.metadata ? { metadata: nextMetadata } : {}),
      updatedAt: Date.now(),
    }
    this.remoteSessions.set(remoteSessionId, next)
    await this.persist()
    return next
  }
}

const runtimeRegistry = new Map<string, OrchestrationRuntime>()

export async function getOrchestrationRuntime(cwd: string): Promise<OrchestrationRuntime> {
  const root = canonicalProjectRoot(cwd)
  let runtime = runtimeRegistry.get(root)
  if (!runtime) {
    runtime = new OrchestrationRuntime(root)
    runtimeRegistry.set(root, runtime)
  }
  return runtime
}
