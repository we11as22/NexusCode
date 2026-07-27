import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { hostname } from "node:os"
import { isDeepStrictEqual } from "node:util"
import {
  type AgentMailboxMessage,
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
import {
  assertMemoryWriteInput,
  normalizeMemoryRecord,
  redactMemorySecrets,
  sanitizeMemoryValue,
} from "../memory/index.js"

type StoredRuntimeState = {
  tasks: TaskRecord[]
  teams: TeamRecord[]
  worktrees: WorktreeSession[]
  backgroundTasks: BackgroundTaskRecord[]
  memories: MemoryRecord[]
  remoteSessions: RemoteSessionRecord[]
  /**
   * Optional only for checksum-compatible reads of schema-v2 snapshots written
   * before the delegated-agent mailbox was introduced.
   */
  agentMessages?: AgentMailboxMessage[]
}

type RuntimeWriter = {
  pid: number
  hostname: string
  instanceId: string
  /** Stable for this Node process and changes when a PID is reused. */
  processStartTime?: number
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

export interface SessionRecordDeletionResult {
  removedTasks: number
  removedBackgroundTasks: number
  removedRemoteSessions: number
  removedAgentMessages: number
  removedMemories: number
  removedTeams: number
  updatedTeams: number
  removedSnapshots: number
  retainedSnapshots: number
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
const AGENT_MESSAGE_MAX_BYTES = 64 * 1024
const AGENT_MESSAGE_MAX_PENDING_PER_TARGET = 1_000
const AGENT_MESSAGE_MAX_ACKED_PER_TARGET = 1_000
const AGENT_MESSAGE_MAX_ACK_BATCH = 128
const AGENT_MESSAGE_MAX_ID_CHARS = 256
const AGENT_MESSAGE_MAX_LABEL_CHARS = 256
const MAX_SESSION_SNAPSHOT_DELETIONS = 2_048
const CURRENT_PROCESS_START_TIME = Math.round(
  Date.now() - process.uptime() * 1000,
)

function emptyRuntimeState(): StoredRuntimeState {
  return {
    tasks: [],
    teams: [],
    worktrees: [],
    backgroundTasks: [],
    memories: [],
    remoteSessions: [],
    agentMessages: [],
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
    "agentMessages",
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
    ...(candidate.agentMessages === undefined
      ? {}
      : { agentMessages: [...candidate.agentMessages] }),
  }
}

function boundedMailboxString(
  value: unknown,
  label: string,
  maxChars = AGENT_MESSAGE_MAX_LABEL_CHARS,
): string {
  if (typeof value !== "string") {
    throw new OrchestrationInvariantError(`${label} must be a string`)
  }
  const normalized = value.trim()
  if (!normalized) {
    throw new OrchestrationInvariantError(`${label} must not be empty`)
  }
  if (normalized.length > maxChars || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new OrchestrationInvariantError(`${label} is too long or contains control characters`)
  }
  return normalized
}

function boundedMailboxBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new OrchestrationInvariantError("Agent message must be a string")
  }
  const normalized = value.trim()
  if (!normalized) {
    throw new OrchestrationInvariantError("Agent message must not be empty")
  }
  if (Buffer.byteLength(normalized, "utf8") > AGENT_MESSAGE_MAX_BYTES) {
    throw new OrchestrationInvariantError(
      `Agent message is too long (maximum ${AGENT_MESSAGE_MAX_BYTES} bytes)`,
    )
  }
  return normalized
}

function normalizeStoredAgentMessage(
  value: unknown,
  statePath: string,
): AgentMailboxMessage {
  if (!value || typeof value !== "object") {
    throw new OrchestrationCorruptionError(
      statePath,
      "agentMessages contains a non-object record",
    )
  }
  const candidate = value as Partial<AgentMailboxMessage>
  try {
    const record: AgentMailboxMessage = {
      id: boundedMailboxString(
        candidate.id,
        "Agent message id",
        AGENT_MESSAGE_MAX_ID_CHARS,
      ),
      ownerSessionId: boundedMailboxString(
        candidate.ownerSessionId,
        "Agent message owner session id",
      ),
      targetAgentId: boundedMailboxString(
        candidate.targetAgentId,
        "Agent message target id",
      ),
      sequence: candidate.sequence as number,
      from: boundedMailboxString(candidate.from, "Agent message sender"),
      message: boundedMailboxBody(candidate.message),
      createdAt: candidate.createdAt as number,
      ...(candidate.ackedAt === undefined
        ? {}
        : { ackedAt: candidate.ackedAt }),
      ...(candidate.acknowledgedBySessionId === undefined
        ? {}
        : {
            acknowledgedBySessionId: boundedMailboxString(
              candidate.acknowledgedBySessionId,
              "Agent message acknowledgement session id",
            ),
          }),
    }
    if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) {
      throw new Error("sequence must be a positive safe integer")
    }
    if (!Number.isFinite(record.createdAt) || record.createdAt < 0) {
      throw new Error("createdAt must be a non-negative finite timestamp")
    }
    if (
      record.ackedAt !== undefined &&
      (!Number.isFinite(record.ackedAt) || record.ackedAt < record.createdAt)
    ) {
      throw new Error("ackedAt must be a finite timestamp after createdAt")
    }
    if (
      (record.ackedAt === undefined) !==
      (record.acknowledgedBySessionId === undefined)
    ) {
      throw new Error(
        "ackedAt and acknowledgedBySessionId must be present together",
      )
    }
    return record
  } catch (error) {
    throw new OrchestrationCorruptionError(
      statePath,
      `invalid agentMessages record: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
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
    candidate.instanceId.length > 0 &&
    (candidate.processStartTime === undefined ||
      (Number.isSafeInteger(candidate.processStartTime) &&
        candidate.processStartTime > 0))
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

function isCurrentRuntimeProcess(writer: RuntimeWriter | undefined): boolean {
  return (
    writer?.pid === process.pid &&
    writer.hostname === hostname() &&
    writer.processStartTime === CURRENT_PROCESS_START_TIME
  )
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

function isInsideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
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
  private agentMessages = new Map<string, AgentMailboxMessage>()

  constructor(readonly cwd: string, options: OrchestrationRuntimeOptions = {}) {
    this.root = getRuntimeDir(cwd, path.resolve(options.homeDir ?? path.join(os.homedir(), ".nexus")))
    this.stateFile = path.join(this.root, "state.json")
    this.journalFile = path.join(this.root, "state.journal.jsonl")
    this.writer = {
      pid: process.pid,
      hostname: hostname(),
      instanceId: crypto.randomBytes(12).toString("hex"),
      processStartTime: CURRENT_PROCESS_START_TIME,
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

  getRuntimeDirectory(): string {
    return this.root
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
    this.agentMessages.clear()
    for (const task of state.tasks) {
        this.tasks.set(task.id, {
          ...task,
          kind: task.kind ?? "tracking",
        })
      }
    for (const team of state.teams) {
      const sessionIds = Array.isArray(team.sessionIds)
        ? Array.from(new Set(
            team.sessionIds.filter(
              (sessionId): sessionId is string =>
                typeof sessionId === "string" && sessionId.length > 0,
            ),
          ))
        : []
      this.teams.set(team.name, {
        ...team,
        ...(sessionIds.length > 0 ? { sessionIds } : {}),
      })
    }
    for (const worktree of state.worktrees) this.worktrees.set(worktree.id, worktree)
    for (const backgroundTask of state.backgroundTasks) this.backgroundTasks.set(backgroundTask.id, backgroundTask)
    for (const memory of state.memories) {
      const normalized = normalizeMemoryRecord(memory)
      this.memories.set(normalized.id, normalized)
    }
    for (const remoteSession of state.remoteSessions) this.remoteSessions.set(remoteSession.id, remoteSession)
    for (const value of state.agentMessages ?? []) {
      const message = normalizeStoredAgentMessage(value, this.stateFile)
      if (this.agentMessages.has(message.id)) {
        throw new OrchestrationCorruptionError(
          this.stateFile,
          `duplicate agent message id: ${message.id}`,
        )
      }
      this.agentMessages.set(message.id, message)
    }
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
      agentMessages: Array.from(this.agentMessages.values()).sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.sequence - right.sequence ||
          left.id.localeCompare(right.id),
      ),
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
    if (isCurrentRuntimeProcess(previousWriter)) return false
    let changed = false
    const now = Date.now()
    state.backgroundTasks = state.backgroundTasks.map((task) => {
      if (task.status !== "running") return task
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

  private bindTeamToSession(teamName: string, sessionId: string): void {
    const team = this.teams.get(teamName)
    if (!team || !sessionId) return
    const sessionIds = Array.from(new Set([...(team.sessionIds ?? []), sessionId]))
    if (
      sessionIds.length === team.sessionIds?.length &&
      sessionIds.every((candidate, index) => candidate === team.sessionIds?.[index])
    ) {
      return
    }
    this.teams.set(teamName, {
      ...team,
      sessionIds,
    })
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
      if (task.teamName && task.sessionId) {
        this.bindTeamToSession(task.teamName, task.sessionId)
      }
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
      if (next.teamName && next.sessionId) {
        this.bindTeamToSession(next.teamName, next.sessionId)
      }
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
    sessionId?: string
  }): Promise<TeamRecord> {
    return this.mutate(() => {
      const existing = this.teams.get(input.teamName)
      if (existing) {
        if (input.sessionId) this.bindTeamToSession(input.teamName, input.sessionId)
        return this.teams.get(input.teamName)!
      }
      const team: TeamRecord = {
        name: input.teamName,
        description: input.description,
        createdAt: Date.now(),
        members: input.members ?? [],
        messages: [],
        ...(input.sessionId ? { sessionIds: [input.sessionId] } : {}),
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

  async listTeamNamesForSession(sessionId: string): Promise<string[]> {
    await this.ensureLoaded()
    const names = new Set<string>()
    for (const team of this.teams.values()) {
      if (team.sessionIds?.includes(sessionId)) names.add(team.name)
    }
    // Legacy snapshots did not persist TeamRecord.sessionIds. A task carrying
    // both fields is nevertheless an explicit, durable binding.
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId && task.teamName) names.add(task.teamName)
    }
    return Array.from(names).sort()
  }

  /**
   * Transactionally remove session-bound orchestration projections.
   *
   * Running work is an ownership conflict, matching Codex thread deletion:
   * callers must stop it first. Snapshot paths are treated as untrusted
   * metadata and are unlinked only when they remain regular files inside this
   * workspace runtime's private `agent-runs` directory.
   */
  async deleteSessionRecords(
    sessionId: string,
  ): Promise<SessionRecordDeletionResult> {
    const normalizedSessionId = boundedMailboxString(
      sessionId,
      "Session deletion id",
    )
    const plan = await this.mutate(async () => {
      const sessionTasks = Array.from(this.tasks.values()).filter(
        (task) => task.sessionId === normalizedSessionId,
      )
      const sessionBackgroundTasks = Array.from(
        this.backgroundTasks.values(),
      ).filter((task) => task.sessionId === normalizedSessionId)
      const sessionRemoteSessions = Array.from(
        this.remoteSessions.values(),
      ).filter((remote) => remote.sessionId === normalizedSessionId)
      const activeTask = sessionTasks.find(
        (task) => task.status === "in_progress",
      )
      const activeBackgroundTask = sessionBackgroundTasks.find(
        (task) => task.status === "pending" || task.status === "running",
      )
      const activeRemoteSession = sessionRemoteSessions.find(
        (remote) =>
          remote.status === "connecting" ||
          remote.status === "connected" ||
          remote.status === "reconnecting",
      )
      if (activeTask || activeBackgroundTask || activeRemoteSession) {
        const activeId =
          activeTask?.id ??
          activeBackgroundTask?.id ??
          activeRemoteSession?.id ??
          "unknown"
        throw new OrchestrationInvariantError(
          `Session ${normalizedSessionId} still owns active orchestration work: ${activeId}`,
        )
      }

      const snapshotFiles = new Set<string>()
      for (const task of sessionTasks) {
        if (typeof task.snapshotFile === "string" && task.snapshotFile) {
          snapshotFiles.add(task.snapshotFile)
        }
      }
      for (const task of sessionBackgroundTasks) {
        const snapshotFile = task.metadata?.snapshotFile
        if (typeof snapshotFile === "string" && snapshotFile) {
          snapshotFiles.add(snapshotFile)
        }
      }
      if (snapshotFiles.size > MAX_SESSION_SNAPSHOT_DELETIONS) {
        throw new OrchestrationInvariantError(
          `Session ${normalizedSessionId} has too many snapshot files for one bounded deletion`,
        )
      }
      // Files go first, while their durable task records still form a retry
      // ledger. If cleanup or the subsequent state commit fails, a retry can
      // safely observe missing files and finish the remaining projection.
      const snapshotCleanup = await this.deleteOwnedSessionSnapshots(
        Array.from(snapshotFiles),
      )

      const sessionTeamNames = new Set(
        sessionTasks
          .map((task) => task.teamName)
          .filter((teamName): teamName is string => Boolean(teamName)),
      )
      const removedTaskIds = new Set(
        sessionTasks.map((task) => task.id),
      )
      for (const taskId of removedTaskIds) this.tasks.delete(taskId)
      for (const taskId of sessionBackgroundTasks.map((task) => task.id)) {
        this.backgroundTasks.delete(taskId)
      }
      for (const remote of sessionRemoteSessions) {
        this.remoteSessions.delete(remote.id)
      }
      let removedAgentMessages = 0
      for (const [messageId, message] of this.agentMessages) {
        if (message.ownerSessionId !== normalizedSessionId) continue
        this.agentMessages.delete(messageId)
        removedAgentMessages += 1
      }

      let removedMemories = 0
      for (const memory of this.memories.values()) {
        const metadataSessionId = memory.metadata?.sessionId
        if (
          memory.scope === "session" &&
          (
            memory.source.sessionId === normalizedSessionId ||
            metadataSessionId === normalizedSessionId
          )
        ) {
          this.memories.delete(memory.id)
          removedMemories += 1
        }
      }

      for (const [taskId, task] of this.tasks) {
        const blocks = (task.blocks ?? []).filter(
          (id) => !removedTaskIds.has(id),
        )
        const blockedBy = (task.blockedBy ?? []).filter(
          (id) => !removedTaskIds.has(id),
        )
        const next: TaskRecord = {
          ...task,
          blocks,
          blockedBy,
          ...(task.parentTaskId && removedTaskIds.has(task.parentTaskId)
            ? { parentTaskId: undefined }
            : {}),
          ...(task.resumeOf && removedTaskIds.has(task.resumeOf)
            ? { resumeOf: undefined }
            : {}),
          ...(task.forkOf && removedTaskIds.has(task.forkOf)
            ? { forkOf: undefined }
            : {}),
        }
        if (
          blocks.length !== (task.blocks ?? []).length ||
          blockedBy.length !== (task.blockedBy ?? []).length ||
          next.parentTaskId !== task.parentTaskId ||
          next.resumeOf !== task.resumeOf ||
          next.forkOf !== task.forkOf
        ) {
          next.updatedAt = Date.now()
          this.tasks.set(taskId, next)
        }
      }

      let removedTeams = 0
      let updatedTeams = 0
      for (const [teamName, team] of this.teams) {
        const hasExplicitBinding =
          team.sessionIds?.includes(normalizedSessionId) ?? false
        if (!hasExplicitBinding && !sessionTeamNames.has(teamName)) continue
        const remainingSessionIds = (team.sessionIds ?? []).filter(
          (id) => id !== normalizedSessionId,
        )
        const stillUsedByTask = Array.from(this.tasks.values()).some(
          (task) => task.teamName === teamName,
        )
        if (remainingSessionIds.length === 0 && !stillUsedByTask) {
          this.teams.delete(teamName)
          removedTeams += 1
          continue
        }
        // A legacy task is itself an explicit durable binding, even though
        // older TeamRecord snapshots did not carry `sessionIds`. If another
        // session still uses that team there is no record field to rewrite.
        if (!hasExplicitBinding) continue
        const { sessionIds: _removed, ...withoutSessionIds } = team
        this.teams.set(teamName, {
          ...withoutSessionIds,
          ...(remainingSessionIds.length > 0
            ? { sessionIds: remainingSessionIds }
            : {}),
        })
        updatedTeams += 1
      }

      return {
        removedTasks: sessionTasks.length,
        removedBackgroundTasks: sessionBackgroundTasks.length,
        removedRemoteSessions: sessionRemoteSessions.length,
        removedAgentMessages,
        removedMemories,
        removedTeams,
        updatedTeams,
        ...snapshotCleanup,
      }
    })

    return {
      removedTasks: plan.removedTasks,
      removedBackgroundTasks: plan.removedBackgroundTasks,
      removedRemoteSessions: plan.removedRemoteSessions,
      removedAgentMessages: plan.removedAgentMessages,
      removedMemories: plan.removedMemories,
      removedTeams: plan.removedTeams,
      updatedTeams: plan.updatedTeams,
      removedSnapshots: plan.removedSnapshots,
      retainedSnapshots: plan.retainedSnapshots,
    }
  }

  private async deleteOwnedSessionSnapshots(
    candidates: readonly string[],
  ): Promise<{
    removedSnapshots: number
    retainedSnapshots: number
  }> {
    if (candidates.length === 0) {
      return { removedSnapshots: 0, retainedSnapshots: 0 }
    }
    const snapshotRoot = path.resolve(this.root, "agent-runs")
    const [runtimeInfo, snapshotRootInfo] = await Promise.all([
      fs.lstat(this.root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      }),
      fs.lstat(snapshotRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      }),
    ])
    if (
      !runtimeInfo?.isDirectory() ||
      runtimeInfo.isSymbolicLink() ||
      !snapshotRootInfo?.isDirectory() ||
      snapshotRootInfo.isSymbolicLink()
    ) {
      return {
        removedSnapshots: 0,
        retainedSnapshots: candidates.length,
      }
    }

    const [realRuntimeRoot, realSnapshotRoot] = await Promise.all([
      fs.realpath(this.root),
      fs.realpath(snapshotRoot),
    ])
    if (!isInsideDirectory(realRuntimeRoot, realSnapshotRoot)) {
      return {
        removedSnapshots: 0,
        retainedSnapshots: candidates.length,
      }
    }

    let removedSnapshots = 0
    let retainedSnapshots = 0
    for (const rawCandidate of candidates) {
      const candidate = path.resolve(rawCandidate)
      if (!isInsideDirectory(snapshotRoot, candidate)) {
        retainedSnapshots += 1
        continue
      }
      const info = await fs.lstat(candidate).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        },
      )
      if (!info) continue
      if (!info.isFile() || info.isSymbolicLink()) {
        retainedSnapshots += 1
        continue
      }
      const realCandidate = await fs.realpath(candidate).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        },
      )
      if (
        !realCandidate ||
        !isInsideDirectory(realSnapshotRoot, realCandidate)
      ) {
        retainedSnapshots += 1
        continue
      }
      try {
        await fs.unlink(candidate)
        removedSnapshots += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    return { removedSnapshots, retainedSnapshots }
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

  private assertOwnedAgentTarget(
    ownerSessionId: string,
    targetAgentId: string,
  ): BackgroundTaskRecord {
    const target = this.backgroundTasks.get(targetAgentId)
    if (
      !target ||
      target.kind !== "subagent" ||
      target.sessionId !== ownerSessionId
    ) {
      throw new OrchestrationInvariantError(
        `Delegated-agent target ${targetAgentId} is not owned by session ${ownerSessionId}`,
      )
    }
    return target
  }

  private pruneAcknowledgedAgentMessages(
    ownerSessionId: string,
    targetAgentId: string,
  ): void {
    const acknowledged = Array.from(this.agentMessages.values())
      .filter(
        (message) =>
          message.ownerSessionId === ownerSessionId &&
          message.targetAgentId === targetAgentId &&
          message.ackedAt !== undefined,
      )
      .sort(
        (left, right) =>
          (left.ackedAt ?? 0) - (right.ackedAt ?? 0) ||
          left.sequence - right.sequence,
      )
    const excess =
      acknowledged.length - AGENT_MESSAGE_MAX_ACKED_PER_TARGET
    for (let index = 0; index < excess; index += 1) {
      this.agentMessages.delete(acknowledged[index]!.id)
    }
  }

  /**
   * Resolve only inside one root-session authority. Display names are useful
   * for model calls, but must be unique among that owner's persisted tasks.
   */
  async resolveAgentMessageTarget(input: {
    ownerSessionId: string
    target: string
  }): Promise<string | null> {
    const ownerSessionId = boundedMailboxString(
      input.ownerSessionId,
      "Agent message owner session id",
    )
    const target = boundedMailboxString(
      input.target,
      "Agent message target",
    )
    await this.ensureLoaded()
    const exact = this.backgroundTasks.get(target)
    if (
      exact?.kind === "subagent" &&
      exact.sessionId === ownerSessionId
    ) {
      return exact.id
    }
    const matches = Array.from(this.backgroundTasks.values()).filter(
      (candidate) =>
        candidate.kind === "subagent" &&
        candidate.sessionId === ownerSessionId &&
        typeof candidate.metadata?.name === "string" &&
        candidate.metadata.name.trim() === target,
    )
    if (matches.length > 1) {
      throw new OrchestrationInvariantError(
        `Delegated-agent target name is ambiguous for this session: ${target}`,
      )
    }
    return matches[0]?.id ?? null
  }

  /**
   * Durably enqueue a message. The explicit id makes retries idempotent; a
   * reused id with different content is rejected rather than overwritten.
   */
  async enqueueAgentMessage(input: {
    id?: string
    ownerSessionId: string
    targetAgentId: string
    from: string
    message: string
  }): Promise<AgentMailboxMessage> {
    const ownerSessionId = boundedMailboxString(
      input.ownerSessionId,
      "Agent message owner session id",
    )
    const targetAgentId = boundedMailboxString(
      input.targetAgentId,
      "Agent message target id",
    )
    const from = boundedMailboxString(input.from, "Agent message sender")
    const message = boundedMailboxBody(input.message)
    const id = input.id === undefined
      ? newId("agentmsg")
      : boundedMailboxString(
          input.id,
          "Agent message id",
          AGENT_MESSAGE_MAX_ID_CHARS,
        )

    return this.mutate(() => {
      this.assertOwnedAgentTarget(ownerSessionId, targetAgentId)
      const existing = this.agentMessages.get(id)
      if (existing) {
        if (
          existing.ownerSessionId === ownerSessionId &&
          existing.targetAgentId === targetAgentId &&
          existing.from === from &&
          existing.message === message
        ) {
          return existing
        }
        throw new OrchestrationInvariantError(
          `Agent message id already exists with different content: ${id}`,
        )
      }

      const records = Array.from(this.agentMessages.values()).filter(
        (candidate) =>
          candidate.ownerSessionId === ownerSessionId &&
          candidate.targetAgentId === targetAgentId,
      )
      const pendingCount = records.filter(
        (candidate) => candidate.ackedAt === undefined,
      ).length
      if (pendingCount >= AGENT_MESSAGE_MAX_PENDING_PER_TARGET) {
        throw new OrchestrationInvariantError(
          `Delegated-agent inbox is full for ${targetAgentId}`,
        )
      }
      const sequence = records.reduce(
        (highest, candidate) => Math.max(highest, candidate.sequence),
        0,
      ) + 1
      const record: AgentMailboxMessage = {
        id,
        ownerSessionId,
        targetAgentId,
        sequence,
        from,
        message,
        createdAt: Date.now(),
      }
      this.agentMessages.set(record.id, record)
      this.pruneAcknowledgedAgentMessages(ownerSessionId, targetAgentId)
      return record
    })
  }

  async listPendingAgentMessages(input: {
    ownerSessionId: string
    targetAgentId: string
    limit?: number
  }): Promise<AgentMailboxMessage[]> {
    const ownerSessionId = boundedMailboxString(
      input.ownerSessionId,
      "Agent message owner session id",
    )
    const targetAgentId = boundedMailboxString(
      input.targetAgentId,
      "Agent message target id",
    )
    const limit = input.limit ?? AGENT_MESSAGE_MAX_ACK_BATCH
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_MESSAGE_MAX_ACK_BATCH) {
      throw new OrchestrationInvariantError(
        `Agent message limit must be between 1 and ${AGENT_MESSAGE_MAX_ACK_BATCH}`,
      )
    }
    await this.ensureLoaded()
    return Array.from(this.agentMessages.values())
      .filter(
        (message) =>
          message.ownerSessionId === ownerSessionId &&
          message.targetAgentId === targetAgentId &&
          message.ackedAt === undefined,
      )
      .sort(
        (left, right) =>
          left.sequence - right.sequence ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map((message) => ({ ...message }))
  }

  /**
   * Acknowledge only the next FIFO prefix. Already-acknowledged ids from the
   * same worker are accepted so crash/retry after a durable checkpoint is safe.
   */
  async acknowledgeAgentMessages(input: {
    ownerSessionId: string
    targetAgentId: string
    messageIds: readonly string[]
    acknowledgedBySessionId: string
  }): Promise<AgentMailboxMessage[]> {
    const ownerSessionId = boundedMailboxString(
      input.ownerSessionId,
      "Agent message owner session id",
    )
    const targetAgentId = boundedMailboxString(
      input.targetAgentId,
      "Agent message target id",
    )
    const acknowledgedBySessionId = boundedMailboxString(
      input.acknowledgedBySessionId,
      "Agent message acknowledgement session id",
    )
    const messageIds = Array.from(new Set(input.messageIds.map((id) =>
      boundedMailboxString(id, "Agent message id", AGENT_MESSAGE_MAX_ID_CHARS))))
    if (
      messageIds.length === 0 ||
      messageIds.length > AGENT_MESSAGE_MAX_ACK_BATCH
    ) {
      throw new OrchestrationInvariantError(
        `Agent message acknowledgement batch must contain 1-${AGENT_MESSAGE_MAX_ACK_BATCH} ids`,
      )
    }

    return this.mutate(() => {
      this.assertOwnedAgentTarget(ownerSessionId, targetAgentId)
      const requested = messageIds.map((id) => {
        const record = this.agentMessages.get(id)
        if (!record) {
          throw new OrchestrationInvariantError(
            `Agent message does not exist: ${id}`,
          )
        }
        if (
          record.ownerSessionId !== ownerSessionId ||
          record.targetAgentId !== targetAgentId
        ) {
          throw new OrchestrationInvariantError(
            `Agent message ${id} belongs to another owner or target`,
          )
        }
        if (
          record.acknowledgedBySessionId !== undefined &&
          record.acknowledgedBySessionId !== acknowledgedBySessionId
        ) {
          throw new OrchestrationInvariantError(
            `Agent message ${id} was acknowledged by another worker session`,
          )
        }
        return record
      })
      const requestedPending = requested.filter(
        (record) => record.ackedAt === undefined,
      )
      const pendingPrefix = Array.from(this.agentMessages.values())
        .filter(
          (record) =>
            record.ownerSessionId === ownerSessionId &&
            record.targetAgentId === targetAgentId &&
            record.ackedAt === undefined,
        )
        .sort(
          (left, right) =>
            left.sequence - right.sequence ||
            left.createdAt - right.createdAt ||
            left.id.localeCompare(right.id),
        )
        .slice(0, requestedPending.length)
      if (
        pendingPrefix.length !== requestedPending.length ||
        pendingPrefix.some(
          (record, index) => record.id !== requestedPending[index]?.id,
        )
      ) {
        throw new OrchestrationInvariantError(
          `Agent messages must be acknowledged as a FIFO prefix for ${targetAgentId}`,
        )
      }

      const ackedAt = Date.now()
      const acknowledged = requested.map((record) => {
        if (record.ackedAt !== undefined) return record
        const next: AgentMailboxMessage = {
          ...record,
          ackedAt: Math.max(ackedAt, record.createdAt),
          acknowledgedBySessionId,
        }
        this.agentMessages.set(next.id, next)
        return next
      })
      this.pruneAcknowledgedAgentMessages(ownerSessionId, targetAgentId)
      return acknowledged.map((record) => ({ ...record }))
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
    assertMemoryWriteInput(input)
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

  async recordMemoryAccess(
    memoryIds: readonly string[],
    accessedAt = Date.now(),
  ): Promise<MemoryRecord[]> {
    const ids = [...new Set(memoryIds)]
    if (ids.length === 0) return []
    return this.mutate(() => {
      const touched: MemoryRecord[] = []
      for (const memoryId of ids) {
        const existing = this.memories.get(memoryId)
        if (!existing) continue
        const next = normalizeMemoryRecord({
          ...existing,
          accessedAt,
          accessCount: existing.accessCount + 1,
        })
        this.memories.set(memoryId, next)
        touched.push(next)
      }
      return touched
    })
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
    assertMemoryWriteInput(updates)
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
    assertMemoryWriteInput(input)
    return this.mutate(() => {
      const title = redactMemorySecrets(input.title)
      const content = redactMemorySecrets(input.content)
      const sanitizedMetadata = input.metadata
        ? sanitizeMemoryValue(input.metadata, {
            strict: true,
            label: "memory metadata",
          }).value as Record<string, unknown>
        : undefined
      const existing = Array.from(this.memories.values()).find(
        (memory) => {
          if (memory.scope !== input.scope) return false
          const legacyUri = sanitizedMetadata?.legacyMemoryUri
          const legacyType = sanitizedMetadata?.legacyMemoryType
          if (
            typeof legacyUri === "string" &&
            typeof legacyType === "string" &&
            memory.metadata?.legacyMemoryUri === legacyUri &&
            memory.metadata?.legacyMemoryType === legacyType
          ) {
            return true
          }
          return (
            memory.title === title.text &&
            isDeepStrictEqual(
              memory.metadata ?? {},
              sanitizedMetadata ?? {},
            )
          )
        },
      )
      const now = Date.now()
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
          ...(sanitizedMetadata ? { metadata: sanitizedMetadata } : {}),
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
        ...(sanitizedMetadata ? { metadata: { ...sanitizedMetadata } } : {}),
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
