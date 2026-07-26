import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { hostname } from "node:os"
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
import { atomicWriteFile, atomicWriteJson, withFileLock } from "../storage/durable-fs.js"
import { normalizeMemoryRecord, redactMemorySecrets } from "../memory/index.js"

type StoredRuntimeState = {
  tasks: TaskRecord[]
  teams: TeamRecord[]
  worktrees: WorktreeSession[]
  backgroundTasks: BackgroundTaskRecord[]
  memories: MemoryRecord[]
  remoteSessions: RemoteSessionRecord[]
}

type RuntimeWriter = {
  pid: number
  hostname: string
  instanceId: string
}

type RuntimeSnapshot = {
  schemaVersion: 2
  revision: number
  updatedAt: number
  writer: RuntimeWriter
  stateChecksum: string
  state: StoredRuntimeState
  checksum: string
}

type RuntimeJournalRecord = {
  type: "orchestration_transition"
  schemaVersion: 2
  revision: number
  ts: number
  writer: RuntimeWriter
  previousChecksum: string | null
  stateChecksum: string
  checksum: string
  state: StoredRuntimeState
}

type LoadedRuntimeState = {
  state: StoredRuntimeState
  revision: number
  format: "fresh" | "legacy-v1" | "v2"
  writer?: RuntimeWriter
  snapshotHealthy: boolean
  journalCount: number
  journalBytes: number
  journalLastChecksum: string | null
  corruptJournalTail?: string
  legacyRaw?: string
  reconciled: boolean
}

export type OrchestrationDiagnosticCode =
  | "corrupt-journal-tail"
  | "snapshot-backup-recovered"
  | "journal-recovered"
  | "legacy-state-detected"
  | "legacy-state-migrated"
  | "stale-run-reconciled"

export interface OrchestrationDiagnostic {
  code: OrchestrationDiagnosticCode
  path: string
  message: string
}

export interface OrchestrationRuntimeOptions {
  homeDir?: string
  compactAfterRecords?: number
  compactAfterBytes?: number
  reconcileStaleRuns?: boolean
  onDiagnostic?: (diagnostic: OrchestrationDiagnostic) => void
}

export class OrchestrationCorruptionError extends Error {
  constructor(
    readonly statePath: string,
    message: string,
  ) {
    super(`Orchestration state is corrupt: ${statePath}: ${message}`)
    this.name = "OrchestrationCorruptionError"
  }
}

export class OrchestrationInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OrchestrationInvariantError"
  }
}

const RUNTIME_SCHEMA_VERSION = 2
const DEFAULT_COMPACT_AFTER_RECORDS = 32
const DEFAULT_COMPACT_AFTER_BYTES = 4 * 1024 * 1024

function emptyRuntimeState(): StoredRuntimeState {
  return {
    tasks: [],
    teams: [],
    worktrees: [],
    backgroundTasks: [],
    memories: [],
    remoteSessions: [],
  }
}

function normalizeRuntimeState(value: unknown, statePath: string): StoredRuntimeState {
  if (!value || typeof value !== "object") {
    throw new OrchestrationCorruptionError(statePath, "state is not an object")
  }
  const candidate = value as Partial<StoredRuntimeState>
  const fields: Array<keyof StoredRuntimeState> = [
    "tasks",
    "teams",
    "worktrees",
    "backgroundTasks",
    "memories",
    "remoteSessions",
  ]
  for (const field of fields) {
    if (candidate[field] !== undefined && !Array.isArray(candidate[field])) {
      throw new OrchestrationCorruptionError(statePath, `${field} is not an array`)
    }
  }
  return {
    tasks: [...(candidate.tasks ?? [])],
    teams: [...(candidate.teams ?? [])],
    worktrees: [...(candidate.worktrees ?? [])],
    backgroundTasks: [...(candidate.backgroundTasks ?? [])],
    memories: [...(candidate.memories ?? [])],
    remoteSessions: [...(candidate.remoteSessions ?? [])],
  }
}

function stateChecksum(state: StoredRuntimeState): string {
  return crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex")
}

function journalChecksum(record: Omit<RuntimeJournalRecord, "checksum">): string {
  return crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex")
}

function snapshotChecksum(snapshot: Omit<RuntimeSnapshot, "checksum">): string {
  return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
}

function isRuntimeWriter(value: unknown): value is RuntimeWriter {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<RuntimeWriter>
  return (
    Number.isSafeInteger(candidate.pid) &&
    candidate.pid! > 0 &&
    typeof candidate.hostname === "string" &&
    candidate.hostname.length > 0 &&
    typeof candidate.instanceId === "string" &&
    candidate.instanceId.length > 0
  )
}

function isRuntimeSnapshot(value: unknown, statePath: string): value is RuntimeSnapshot {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<RuntimeSnapshot>
  if (
    candidate.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision! < 0 ||
    typeof candidate.updatedAt !== "number" ||
    !isRuntimeWriter(candidate.writer) ||
    typeof candidate.stateChecksum !== "string" ||
    !candidate.state ||
    typeof candidate.checksum !== "string"
  ) {
    return false
  }
  const normalized = normalizeRuntimeState(candidate.state, statePath)
  if (stateChecksum(normalized) !== candidate.stateChecksum) return false
  const { checksum, ...withoutChecksum } = candidate as RuntimeSnapshot
  return checksum === snapshotChecksum(withoutChecksum)
}

function runtimeJournalLines(raw: string): Array<{ text: string; start: number }> {
  const lines: Array<{ text: string; start: number }> = []
  let start = 0
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== "\n") continue
    const text = raw.slice(start, index).replace(/\r$/, "")
    if (text.trim()) lines.push({ text, start })
    start = index + 1
  }
  return lines
}

async function readOptional(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function projectHash(cwd: string): string {
  return crypto.createHash("sha1").update(canonicalProjectRoot(cwd)).digest("hex").slice(0, 12)
}

export function getRuntimeDir(cwd: string, homeDir = path.join(os.homedir(), ".nexus")): string {
  return path.join(homeDir, "runtime", projectHash(cwd))
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
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
  private readonly journalFile: string
  private readonly writer: RuntimeWriter
  private readonly compactAfterRecords: number
  private readonly compactAfterBytes: number
  private readonly reconcileStaleRuns: boolean
  private readonly onDiagnostic?: (diagnostic: OrchestrationDiagnostic) => void
  private readonly diagnostics: OrchestrationDiagnostic[] = []
  private tasks = new Map<string, TaskRecord>()
  private teams = new Map<string, TeamRecord>()
  private worktrees = new Map<string, WorktreeSession>()
  private backgroundTasks = new Map<string, BackgroundTaskRecord>()
  private memories = new Map<string, MemoryRecord>()
  private remoteSessions = new Map<string, RemoteSessionRecord>()

  constructor(readonly cwd: string, options: OrchestrationRuntimeOptions = {}) {
    this.root = getRuntimeDir(cwd, path.resolve(options.homeDir ?? path.join(os.homedir(), ".nexus")))
    this.stateFile = path.join(this.root, "state.json")
    this.journalFile = path.join(this.root, "state.journal.jsonl")
    this.writer = {
      pid: process.pid,
      hostname: hostname(),
      instanceId: crypto.randomBytes(12).toString("hex"),
    }
    this.compactAfterRecords = Math.max(
      1,
      options.compactAfterRecords ?? DEFAULT_COMPACT_AFTER_RECORDS,
    )
    this.compactAfterBytes = Math.max(
      1,
      options.compactAfterBytes ?? DEFAULT_COMPACT_AFTER_BYTES,
    )
    this.reconcileStaleRuns = options.reconcileStaleRuns ?? true
    this.onDiagnostic = options.onDiagnostic
  }

  getStatePath(): string {
    return this.stateFile
  }

  getJournalPath(): string {
    return this.journalFile
  }

  getDiagnostics(): readonly OrchestrationDiagnostic[] {
    return this.diagnostics.map((diagnostic) => ({ ...diagnostic }))
  }

  private diagnostic(diagnostic: OrchestrationDiagnostic): void {
    if (
      !this.diagnostics.some(
        (existing) =>
          existing.code === diagnostic.code &&
          existing.path === diagnostic.path &&
          existing.message === diagnostic.message,
      )
    ) {
      this.diagnostics.push(diagnostic)
      if (this.diagnostics.length > 100) this.diagnostics.shift()
    }
    this.onDiagnostic?.(diagnostic)
  }

  private applyState(state: StoredRuntimeState): void {
    this.tasks.clear()
    this.teams.clear()
    this.worktrees.clear()
    this.backgroundTasks.clear()
    this.memories.clear()
    this.remoteSessions.clear()
    for (const task of state.tasks) {
        this.tasks.set(task.id, {
          ...task,
          kind: task.kind ?? "tracking",
        })
      }
    for (const team of state.teams) this.teams.set(team.name, team)
    for (const worktree of state.worktrees) this.worktrees.set(worktree.id, worktree)
    for (const backgroundTask of state.backgroundTasks) this.backgroundTasks.set(backgroundTask.id, backgroundTask)
    for (const memory of state.memories) {
      const normalized = normalizeMemoryRecord(memory)
      this.memories.set(normalized.id, normalized)
    }
    for (const remoteSession of state.remoteSessions) this.remoteSessions.set(remoteSession.id, remoteSession)
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
  }

  private captureState(): StoredRuntimeState {
    return {
      tasks: Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt),
      teams: Array.from(this.teams.values()).sort((a, b) => a.createdAt - b.createdAt),
      worktrees: Array.from(this.worktrees.values()).sort((a, b) => a.createdAt - b.createdAt),
      backgroundTasks: Array.from(this.backgroundTasks.values()).sort((a, b) => a.createdAt - b.createdAt),
      memories: Array.from(this.memories.values()).sort((a, b) => a.createdAt - b.createdAt),
      remoteSessions: Array.from(this.remoteSessions.values()).sort((a, b) => a.createdAt - b.createdAt),
    }
  }

  private parseSnapshot(raw: string, sourcePath: string): {
    state: StoredRuntimeState
    revision: number
    format: "legacy-v1" | "v2"
    writer?: RuntimeWriter
  } {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new OrchestrationCorruptionError(sourcePath, `invalid JSON: ${String(error)}`)
    }
    if (isRuntimeSnapshot(parsed, sourcePath)) {
      return {
        state: normalizeRuntimeState(parsed.state, sourcePath),
        revision: parsed.revision,
        format: "v2",
        writer: parsed.writer,
      }
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      ("schemaVersion" in parsed || "state" in parsed || "stateChecksum" in parsed)
    ) {
      throw new OrchestrationCorruptionError(sourcePath, "invalid v2 snapshot or checksum")
    }
    return {
      state: normalizeRuntimeState(parsed, sourcePath),
      revision: 0,
      format: "legacy-v1",
    }
  }

  private parseJournal(raw: string): {
    state: StoredRuntimeState | null
    revision: number
    writer?: RuntimeWriter
    count: number
    lastChecksum: string | null
    corruptTail?: string
  } {
    const lines = runtimeJournalLines(raw)
    let revision = 0
    let lastChecksum: string | null = null
    let state: StoredRuntimeState | null = null
    let writer: RuntimeWriter | undefined
    let count = 0
    let corruptTail: string | undefined
    for (const line of lines) {
      let record: RuntimeJournalRecord
      try {
        record = JSON.parse(line.text) as RuntimeJournalRecord
      } catch {
        corruptTail = raw.slice(line.start)
        break
      }
      let normalized: StoredRuntimeState
      try {
        normalized = normalizeRuntimeState(record.state, this.journalFile)
      } catch {
        corruptTail = raw.slice(line.start)
        break
      }
      const { checksum, ...withoutChecksum } = record
      const validFirstRevision = count === 0 && record.revision >= 1
      const validNextRevision = count > 0 && record.revision === revision + 1
      if (
        record.type !== "orchestration_transition" ||
        record.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
        !isRuntimeWriter(record.writer) ||
        (!validFirstRevision && !validNextRevision) ||
        record.previousChecksum !== lastChecksum ||
        record.stateChecksum !== stateChecksum(normalized) ||
        checksum !== journalChecksum(withoutChecksum)
      ) {
        corruptTail = raw.slice(line.start)
        break
      }
      state = normalized
      revision = record.revision
      writer = record.writer
      lastChecksum = record.checksum
      count += 1
    }
    return { state, revision, writer, count, lastChecksum, ...(corruptTail ? { corruptTail } : {}) }
  }

  private reconcileState(
    state: StoredRuntimeState,
    previousWriter?: RuntimeWriter,
  ): boolean {
    if (!this.reconcileStaleRuns) return false
    if (previousWriter?.hostname === hostname() && isProcessAlive(previousWriter.pid)) return false
    let changed = false
    const now = Date.now()
    state.backgroundTasks = state.backgroundTasks.map((task) => {
      if (task.status !== "running") return task
      if (task.kind === "bash" && task.processId && isProcessAlive(task.processId)) return task
      changed = true
      return {
        ...task,
        status: "failed",
        updatedAt: now,
        error: task.error ?? "Interrupted because the previous Nexus process is no longer running.",
      }
    })
    const failedBackground = new Map(
      state.backgroundTasks
        .filter((task) => task.status === "failed")
        .map((task) => [task.id, task]),
    )
    state.tasks = state.tasks.map((task) => {
      const background = failedBackground.get(task.id)
      if (!background) return task
      changed = true
      return {
        ...task,
        status: "failed",
        updatedAt: background.updatedAt,
        error: background.error,
      }
    })
    state.remoteSessions = state.remoteSessions.map((remote) => {
      if (!["connecting", "connected", "reconnecting"].includes(remote.status)) return remote
      changed = true
      return {
        ...remote,
        status: "disconnected",
        updatedAt: now,
        error: remote.error ?? "Disconnected because the previous Nexus process stopped.",
      }
    })
    if (changed) {
      this.diagnostic({
        code: "stale-run-reconciled",
        path: this.stateFile,
        message: "Reconciled running tasks and remote sessions left by a previous process",
      })
    }
    return changed
  }

  private async loadDurableState(): Promise<LoadedRuntimeState> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    const primaryRaw = await readOptional(this.stateFile)
    const backupRaw = await readOptional(`${this.stateFile}.bak`)
    const journalRaw = await readOptional(this.journalFile)

    let snapshot:
      | { state: StoredRuntimeState; revision: number; format: "legacy-v1" | "v2"; writer?: RuntimeWriter }
      | undefined
    let primaryError: unknown
    let snapshotHealthy = true
    if (primaryRaw != null) {
      try {
        snapshot = this.parseSnapshot(primaryRaw, this.stateFile)
      } catch (error) {
        primaryError = error
        snapshotHealthy = false
      }
    }
    if (!snapshot && backupRaw != null) {
      try {
        snapshot = this.parseSnapshot(backupRaw, `${this.stateFile}.bak`)
        this.diagnostic({
          code: "snapshot-backup-recovered",
          path: `${this.stateFile}.bak`,
          message: "Recovered orchestration snapshot from its backup",
        })
      } catch {
        // The primary error remains authoritative below.
      }
    }

    const journal = journalRaw == null
      ? { state: null, revision: 0, count: 0, lastChecksum: null }
      : this.parseJournal(journalRaw)
    if (journal.corruptTail) {
      this.diagnostic({
        code: "corrupt-journal-tail",
        path: this.journalFile,
        message: `Ignored ${Buffer.byteLength(journal.corruptTail)} unverified journal bytes`,
      })
    }

    if (!snapshot && !journal.state) {
      if (primaryError || (journalRaw != null && journalRaw.trim())) {
        throw primaryError instanceof Error
          ? primaryError
          : new OrchestrationCorruptionError(this.stateFile, "no verified snapshot or journal record")
      }
      return {
        state: emptyRuntimeState(),
        revision: 0,
        format: "fresh",
        snapshotHealthy,
        journalCount: journal.count,
        journalBytes: journalRaw?.length ?? 0,
        journalLastChecksum: journal.lastChecksum,
        ...(journal.corruptTail ? { corruptJournalTail: journal.corruptTail } : {}),
        reconciled: false,
      }
    }

    const useJournal = Boolean(journal.state && journal.revision >= (snapshot?.revision ?? 0))
    const selectedState = useJournal ? journal.state! : snapshot!.state
    const selectedRevision = useJournal ? journal.revision : snapshot!.revision
    const selectedWriter = useJournal ? journal.writer : snapshot?.writer
    if (useJournal && journal.revision > (snapshot?.revision ?? 0)) {
      this.diagnostic({
        code: "journal-recovered",
        path: this.journalFile,
        message: `Recovered orchestration revision ${journal.revision} from the journal`,
      })
    }
    const format = snapshot?.format === "legacy-v1" && !useJournal ? "legacy-v1" : "v2"
    if (format === "legacy-v1") {
      this.diagnostic({
        code: "legacy-state-detected",
        path: this.stateFile,
        message: "Legacy orchestration state will migrate on its next durable mutation",
      })
    }
    const state = normalizeRuntimeState(selectedState, this.stateFile)
    const reconciled = this.reconcileState(state, selectedWriter)
    return {
      state,
      revision: selectedRevision,
      format,
      writer: selectedWriter,
      snapshotHealthy,
      journalCount: journal.count,
      journalBytes: journalRaw?.length ?? 0,
      journalLastChecksum: journal.lastChecksum,
      ...(journal.corruptTail ? { corruptJournalTail: journal.corruptTail } : {}),
      ...(format === "legacy-v1" && primaryRaw != null ? { legacyRaw: primaryRaw } : {}),
      reconciled,
    }
  }

  private async quarantineJournalTail(tail: string): Promise<void> {
    const target = `${this.journalFile}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
    await atomicWriteFile(target, tail)
  }

  private async persistLoaded(loaded: LoadedRuntimeState): Promise<void> {
    const state = this.captureState()
    const revision = loaded.revision + 1
    if (loaded.format === "legacy-v1" && loaded.legacyRaw != null) {
      const legacyBackup = `${this.stateFile}.legacy-v1.bak`
      if ((await readOptional(legacyBackup)) == null) {
        await atomicWriteFile(legacyBackup, loaded.legacyRaw)
      }
      this.diagnostic({
        code: "legacy-state-migrated",
        path: this.stateFile,
        message: "Migrated legacy orchestration state to schema v2",
      })
    }
    if (loaded.corruptJournalTail) {
      await this.quarantineJournalTail(loaded.corruptJournalTail)
    }

    const stateHash = stateChecksum(state)
    const baseRecord: Omit<RuntimeJournalRecord, "checksum"> = {
      type: "orchestration_transition",
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      revision,
      ts: Date.now(),
      writer: this.writer,
      previousChecksum: loaded.corruptJournalTail ? null : loaded.journalLastChecksum,
      stateChecksum: stateHash,
      state,
    }
    const record: RuntimeJournalRecord = {
      ...baseRecord,
      checksum: journalChecksum(baseRecord),
    }
    const compact =
      loaded.format !== "v2" ||
      Boolean(loaded.corruptJournalTail) ||
      loaded.journalCount >= this.compactAfterRecords ||
      loaded.journalBytes >= this.compactAfterBytes
    if (compact) {
      const compactBase = { ...baseRecord, previousChecksum: null }
      const compactRecord: RuntimeJournalRecord = {
        ...compactBase,
        checksum: journalChecksum(compactBase),
      }
      await atomicWriteFile(this.journalFile, `${JSON.stringify(compactRecord)}\n`, {
        backup: loaded.journalCount > 0 && !loaded.corruptJournalTail,
      })
    } else {
      const handle = await fs.open(this.journalFile, "a", 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
    }

    const snapshotBase: Omit<RuntimeSnapshot, "checksum"> = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      revision,
      updatedAt: Date.now(),
      writer: this.writer,
      stateChecksum: stateHash,
      state,
    }
    const snapshot: RuntimeSnapshot = {
      ...snapshotBase,
      checksum: snapshotChecksum(snapshotBase),
    }
    await atomicWriteJson(this.stateFile, snapshot, {
      backup: loaded.snapshotHealthy && loaded.format === "v2",
    })
  }

  private async ensureLoaded(): Promise<void> {
    await withFileLock(this.stateFile, async () => {
      const loaded = await this.loadDurableState()
      this.applyState(loaded.state)
      if (loaded.reconciled) await this.persistLoaded(loaded)
    })
  }

  private async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    return withFileLock(this.stateFile, async () => {
      const loaded = await this.loadDurableState()
      this.applyState(loaded.state)
      const before = JSON.stringify(this.captureState())
      const result = await operation()
      const after = JSON.stringify(this.captureState())
      if (before !== after || loaded.format === "legacy-v1" || loaded.reconciled) {
        await this.persistLoaded(loaded)
      }
      return result
    })
  }

  private assertCanComplete(task: TaskRecord): void {
    const unresolved = (task.blockedBy ?? []).filter((taskId) => {
      const blocker = this.tasks.get(taskId)
      return !blocker || !["completed", "cancelled", "deleted"].includes(blocker.status)
    })
    if (unresolved.length > 0) {
      throw new OrchestrationInvariantError(
        `Task ${task.id} cannot complete while blockers remain unresolved: ${unresolved.join(", ")}`,
      )
    }
    const unfinishedChildren = Array.from(this.tasks.values())
      .filter((candidate) => candidate.parentTaskId === task.id)
      .filter((candidate) => !["completed", "cancelled", "deleted"].includes(candidate.status))
      .map((candidate) => candidate.id)
    if (unfinishedChildren.length > 0) {
      throw new OrchestrationInvariantError(
        `Task ${task.id} cannot complete while child tasks remain unfinished: ${unfinishedChildren.join(", ")}`,
      )
    }
  }

  private assertValidTaskDependencies(taskId: string, blockedBy: readonly string[]): void {
    if (blockedBy.includes(taskId)) {
      throw new OrchestrationInvariantError(`Task ${taskId} cannot block itself`)
    }
    const visit = (currentId: string, seen: Set<string>): boolean => {
      if (currentId === taskId) return true
      if (seen.has(currentId)) return false
      seen.add(currentId)
      const current = this.tasks.get(currentId)
      return (current?.blockedBy ?? []).some((nextId) => visit(nextId, seen))
    }
    for (const blockerId of blockedBy) {
      if (visit(blockerId, new Set())) {
        throw new OrchestrationInvariantError(
          `Adding blocker ${blockerId} would create a dependency cycle for task ${taskId}`,
        )
      }
    }
  }

  private synchronizeTaskEdges(taskId: string): void {
    const original = this.tasks.get(taskId)
    if (!original) return
    const inferredBlockedBy = Array.from(this.tasks.values())
      .filter((candidate) => (candidate.blocks ?? []).includes(taskId))
      .map((candidate) => candidate.id)
    const inferredBlocks = Array.from(this.tasks.values())
      .filter((candidate) => (candidate.blockedBy ?? []).includes(taskId))
      .map((candidate) => candidate.id)
    const task: TaskRecord = {
      ...original,
      ...((original.blockedBy?.length || inferredBlockedBy.length)
        ? { blockedBy: Array.from(new Set([...(original.blockedBy ?? []), ...inferredBlockedBy])) }
        : {}),
      ...((original.blocks?.length || inferredBlocks.length)
        ? { blocks: Array.from(new Set([...(original.blocks ?? []), ...inferredBlocks])) }
        : {}),
    }
    this.assertValidTaskDependencies(task.id, task.blockedBy ?? [])
    this.tasks.set(taskId, task)

    for (const blockedId of task.blocks ?? []) {
      const blocked = this.tasks.get(blockedId)
      if (!blocked) continue
      const blockedBy = Array.from(new Set([...(blocked.blockedBy ?? []), taskId]))
      this.assertValidTaskDependencies(blocked.id, blockedBy)
      this.tasks.set(blocked.id, {
        ...blocked,
        blockedBy,
        updatedAt: Date.now(),
      })
    }
    for (const blockerId of task.blockedBy ?? []) {
      const blocker = this.tasks.get(blockerId)
      if (!blocker) continue
      this.tasks.set(blocker.id, {
        ...blocker,
        blocks: Array.from(new Set([...(blocker.blocks ?? []), taskId])),
        updatedAt: Date.now(),
      })
    }
  }

  private assertValidTaskTransition(previous: TaskStatus, next: TaskStatus, taskId: string): void {
    const terminal = new Set<TaskStatus>(["completed", "failed", "killed", "cancelled", "deleted"])
    if (terminal.has(previous) && previous !== next && !terminal.has(next)) {
      throw new OrchestrationInvariantError(
        `Task ${taskId} cannot transition from terminal status ${previous} back to ${next}; resume or fork it instead`,
      )
    }
    if (previous === "deleted" && next !== "deleted") {
      throw new OrchestrationInvariantError(`Deleted task ${taskId} cannot be changed`)
    }
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
    return this.mutate(() => {
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
      const existing = this.tasks.get(task.id)
      if (
        existing &&
        existing.kind === task.kind &&
        existing.subject === task.subject &&
        existing.description === task.description
      ) {
        return existing
      }
      if (existing) {
        throw new OrchestrationInvariantError(`Task id already exists: ${task.id}`)
      }
      this.assertValidTaskDependencies(task.id, task.blockedBy ?? [])
      this.tasks.set(task.id, task)
      this.synchronizeTaskEdges(task.id)
      const synchronized = this.tasks.get(task.id)!
      if (synchronized.status === "completed") this.assertCanComplete(synchronized)
      return synchronized
    })
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
    return this.mutate(() => {
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
      this.assertValidTaskTransition(existing.status, next.status, taskId)
      this.assertValidTaskDependencies(taskId, next.blockedBy ?? [])
      this.tasks.set(taskId, next)
      this.synchronizeTaskEdges(taskId)
      const synchronized = this.tasks.get(taskId)!
      if (synchronized.status === "completed") this.assertCanComplete(synchronized)
      return synchronized
    })
  }

  async createTeam(input: {
    teamName: string
    description: string
    members?: TeamMemberRecord[]
  }): Promise<TeamRecord> {
    return this.mutate(() => {
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
      return team
    })
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
    return this.mutate(() => this.teams.delete(teamName))
  }

  async addTeamMember(teamName: string, member: TeamMemberRecord): Promise<TeamRecord | null> {
    return this.mutate(() => {
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
      return next
    })
  }

  async updateTeamMember(
    teamName: string,
    memberName: string,
    updates: Partial<Omit<TeamMemberRecord, "name" | "joinedAt" | "note">> & { note?: string | null },
  ): Promise<TeamRecord | null> {
    return this.mutate(() => {
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
      return next
    })
  }

  async sendMessage(input: {
    from: string
    to: string
    message: string
    teamName?: string
  }): Promise<TeamMessageRecord> {
    return this.mutate(() => {
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
      }
      return record
    })
  }

  async registerBackgroundTask(
    task: Omit<BackgroundTaskRecord, "createdAt" | "updatedAt">,
  ): Promise<BackgroundTaskRecord> {
    return this.mutate(() => {
      const now = Date.now()
      const existingBackground = this.backgroundTasks.get(task.id)
      if (existingBackground) return existingBackground
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
      return record
    })
  }

  async updateBackgroundTask(
    taskId: string,
    updates: Partial<Omit<BackgroundTaskRecord, "id" | "kind" | "createdAt">>,
  ): Promise<BackgroundTaskRecord | null> {
    return this.mutate(() => {
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
      return next
    })
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
    return this.mutate(() => {
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
      return session
    })
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
    return this.mutate(() => {
      const current = this.worktrees.get(worktreeId)
      if (!current) return null
      const next: WorktreeSession = { ...current, ...updates }
      this.worktrees.set(worktreeId, next)
      return next
    })
  }

  async createMemory(input: {
    scope: MemoryRecord["scope"]
    title: string
    content: string
    kind?: MemoryRecord["kind"]
    source?: MemoryRecord["source"]
    author?: MemoryRecord["author"]
    trust?: MemoryRecord["trust"]
    confidence?: number
    expiresAt?: number
    supersedes?: string[]
    contradicts?: string[]
    metadata?: Record<string, unknown>
  }): Promise<MemoryRecord> {
    return this.mutate(() => {
      const now = Date.now()
      const title = redactMemorySecrets(input.title)
      const content = redactMemorySecrets(input.content)
      const memory = normalizeMemoryRecord({
        id: newId("memory"),
        scope: input.scope,
        title: title.text,
        content: content.text,
        createdAt: now,
        updatedAt: now,
        ...(input.kind ? { kind: input.kind } : {}),
        source: input.source ?? { type: "tool" },
        author: input.author ?? { type: "agent" },
        trust: input.trust ?? "agent",
        confidence: input.confidence ?? 0.7,
        sensitivity: title.redacted || content.redacted ? "sensitive" : "normal",
        ...(typeof input.expiresAt === "number" ? { expiresAt: input.expiresAt } : {}),
        ...(input.supersedes ? { supersedes: input.supersedes } : {}),
        ...(input.contradicts ? { contradicts: input.contradicts } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      this.memories.set(memory.id, memory)
      return memory
    })
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
      kind?: MemoryRecord["kind"]
      confidence?: number
      expiresAt?: number | null
      supersedes?: string[]
      contradicts?: string[]
      metadata?: Record<string, unknown | null>
    },
  ): Promise<MemoryRecord | null> {
    return this.mutate(() => {
      const existing = this.memories.get(memoryId)
      if (!existing) return null
      const nextMetadata = { ...(existing.metadata ?? {}) }
      for (const [key, value] of Object.entries(updates.metadata ?? {})) {
        if (value === null) delete nextMetadata[key]
        else nextMetadata[key] = value
      }
      const title = typeof updates.title === "string" ? redactMemorySecrets(updates.title) : null
      const content = typeof updates.content === "string" ? redactMemorySecrets(updates.content) : null
      const next = normalizeMemoryRecord({
        ...existing,
        ...(title ? { title: title.text } : {}),
        ...(content ? { content: content.text } : {}),
        ...(updates.kind ? { kind: updates.kind } : {}),
        ...(typeof updates.confidence === "number" ? { confidence: updates.confidence } : {}),
        ...(updates.expiresAt === null ? { expiresAt: undefined } : typeof updates.expiresAt === "number" ? { expiresAt: updates.expiresAt } : {}),
        ...(updates.supersedes ? { supersedes: updates.supersedes } : {}),
        ...(updates.contradicts ? { contradicts: updates.contradicts } : {}),
        ...(updates.metadata ? { metadata: nextMetadata } : {}),
        sensitivity: existing.sensitivity === "sensitive" || title?.redacted || content?.redacted
          ? "sensitive"
          : "normal",
        updatedAt: Date.now(),
      })
      this.memories.set(memoryId, next)
      return next
    })
  }

  async upsertMemoryByTitle(input: {
    scope: MemoryRecord["scope"]
    title: string
    content: string
    kind?: MemoryRecord["kind"]
    source?: MemoryRecord["source"]
    author?: MemoryRecord["author"]
    trust?: MemoryRecord["trust"]
    confidence?: number
    expiresAt?: number
    supersedes?: string[]
    contradicts?: string[]
    metadata?: Record<string, unknown>
  }): Promise<MemoryRecord> {
    return this.mutate(() => {
      const existing = Array.from(this.memories.values()).find(
        (memory) =>
          memory.scope === input.scope &&
          memory.title === input.title &&
          JSON.stringify(memory.metadata ?? {}) === JSON.stringify(input.metadata ?? {}),
      )
      const now = Date.now()
      const title = redactMemorySecrets(input.title)
      const content = redactMemorySecrets(input.content)
      if (!existing) {
        const created = normalizeMemoryRecord({
          id: newId("memory"),
          scope: input.scope,
          title: title.text,
          content: content.text,
          createdAt: now,
          updatedAt: now,
          ...(input.kind ? { kind: input.kind } : {}),
          source: input.source ?? { type: "tool" },
          author: input.author ?? { type: "agent" },
          trust: input.trust ?? "agent",
          confidence: input.confidence ?? 0.7,
          sensitivity: title.redacted || content.redacted ? "sensitive" : "normal",
          ...(typeof input.expiresAt === "number" ? { expiresAt: input.expiresAt } : {}),
          ...(input.supersedes ? { supersedes: input.supersedes } : {}),
          ...(input.contradicts ? { contradicts: input.contradicts } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        })
        this.memories.set(created.id, created)
        return created
      }
      const updated = normalizeMemoryRecord({
        ...existing,
        title: title.text,
        content: content.text,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.author ? { author: input.author } : {}),
        ...(input.trust ? { trust: input.trust } : {}),
        ...(typeof input.confidence === "number" ? { confidence: input.confidence } : {}),
        ...(typeof input.expiresAt === "number" ? { expiresAt: input.expiresAt } : {}),
        ...(input.supersedes ? { supersedes: input.supersedes } : {}),
        ...(input.contradicts ? { contradicts: input.contradicts } : {}),
        sensitivity: existing.sensitivity === "sensitive" || title.redacted || content.redacted
          ? "sensitive"
          : "normal",
        updatedAt: now,
        ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
      })
      this.memories.set(updated.id, updated)
      return updated
    })
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    return this.mutate(() => this.memories.delete(memoryId))
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
    return this.mutate(() => {
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
      return record
    })
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
    return this.mutate(() => {
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
      return next
    })
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
