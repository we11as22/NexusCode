import * as crypto from "node:crypto"
import { open, readFile, readdir, stat } from "node:fs/promises"
import * as path from "node:path"
import type { AgentEvent, ApprovalAction, Mode } from "../types.js"
import { getRuntimeDir } from "../orchestration/runtime.js"
import {
  atomicWriteJson,
  atomicWriteFile,
  withFileLock,
} from "../storage/durable-fs.js"

const RUN_SCHEMA_VERSION = 1
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const RECENT_IDEMPOTENCY_KEYS = 512

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted"

export interface RunToolArtifact {
  partId: string
  tool: string
  path?: string
  outputSpillPath?: string
}

export interface PendingRunApproval {
  partId: string
  action: ApprovalAction
  requestedAt: number
}

export interface DurableRunRecord {
  schemaVersion: 1
  id: string
  sessionId: string
  cwd: string
  mode: Mode
  status: RunStatus
  createdAt: number
  updatedAt: number
  lastSeq: number
  lastChecksum: string | null
  recentIdempotencyKeys: Record<string, number>
  pendingApprovals: PendingRunApproval[]
  toolArtifacts: RunToolArtifact[]
  memoryCitations: string[]
  taskIds: string[]
}

type RunSnapshot = {
  type: "run_snapshot"
  schemaVersion: 1
  state: DurableRunRecord
  checksum: string
}

export interface RunEventEnvelope {
  type: "run_event"
  schemaVersion: 1
  runId: string
  seq: number
  ts: number
  idempotencyKey: string
  previousChecksum: string | null
  event: AgentEvent
  checksum: string
  deduplicated?: boolean
}

export interface RunEventDiagnostic {
  code: "corrupt-event-tail" | "snapshot-recovered"
  path: string
  message: string
}

export interface RunEventStoreOptions {
  homeDir?: string
  onDiagnostic?: (diagnostic: RunEventDiagnostic) => void
}

export interface DurableRunEventSinkOptions extends RunEventStoreOptions {
  runId?: string
}

function checksum(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function envelopeChecksum(input: Omit<RunEventEnvelope, "checksum" | "deduplicated">): string {
  return checksum(input)
}

function snapshotChecksum(input: Omit<RunSnapshot, "checksum">): string {
  return checksum(input)
}

function createSnapshot(state: DurableRunRecord): RunSnapshot {
  const base: Omit<RunSnapshot, "checksum"> = {
    type: "run_snapshot",
    schemaVersion: RUN_SCHEMA_VERSION,
    state,
  }
  return { ...base, checksum: snapshotChecksum(base) }
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new Error(`Unsafe run id: ${runId}`)
}

function lines(raw: string): Array<{ text: string; offset: number; terminated: boolean }> {
  const result: Array<{ text: string; offset: number; terminated: boolean }> = []
  let start = 0
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== "\n") continue
    const text = raw.slice(start, index).replace(/\r$/, "")
    if (text.trim()) result.push({ text, offset: start, terminated: index < raw.length })
    start = index + 1
  }
  return result
}

async function readOptional(target: string): Promise<string> {
  try {
    return await import("node:fs/promises").then((fs) => fs.readFile(target, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}

async function appendAndSync(target: string, text: string): Promise<void> {
  const handle = await open(target, "a", 0o600)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function applyEventState(record: DurableRunRecord, envelope: RunEventEnvelope): void {
  const event = envelope.event
  if (event.type === "tool_approval_needed") {
    const without = record.pendingApprovals.filter((item) => item.partId !== event.partId)
    record.pendingApprovals = [
      ...without,
      { partId: event.partId, action: event.action, requestedAt: envelope.ts },
    ]
  } else if (event.type === "tool_end") {
    record.pendingApprovals = record.pendingApprovals.filter((item) => item.partId !== event.partId)
    const metadata = event.metadata ?? {}
    const outputSpillPath = typeof metadata.outputSpillPath === "string"
      ? metadata.outputSpillPath
      : undefined
    if (event.path || outputSpillPath) {
      record.toolArtifacts = [
        ...record.toolArtifacts.filter((item) => item.partId !== event.partId),
        {
          partId: event.partId,
          tool: event.tool,
          ...(event.path ? { path: event.path } : {}),
          ...(outputSpillPath ? { outputSpillPath } : {}),
        },
      ].slice(-200)
    }
  } else if (event.type === "done") {
    record.status = "completed"
  } else if (event.type === "error" && event.fatal) {
    record.status = "failed"
  } else if (event.type === "run_context") {
    record.mode = event.mode
    record.memoryCitations = [...new Set([
      ...record.memoryCitations,
      ...event.memoryCitations.filter((item) => item.startsWith("memory:")),
    ])].slice(-200)
    record.taskIds = [...new Set([...record.taskIds, ...event.taskIds])].slice(-200)
  }
  const citations = event.type === "tool_end" && Array.isArray(event.metadata?.memoryCitations)
    ? event.metadata.memoryCitations.filter((item): item is string => typeof item === "string")
    : []
  if (citations.length > 0) {
    record.memoryCitations = [...new Set([...record.memoryCitations, ...citations])].slice(-200)
  }
}

export class RunEventStore {
  private readonly root: string
  private readonly diagnostics: RunEventDiagnostic[] = []
  private readonly onDiagnostic?: (diagnostic: RunEventDiagnostic) => void
  private readonly mutationCache = new Map<
    string,
    { record: DurableRunRecord; events: RunEventEnvelope[]; journalBytes: number }
  >()

  constructor(readonly cwd: string, options: RunEventStoreOptions = {}) {
    this.root = path.join(getRuntimeDir(cwd, options.homeDir), "runs")
    this.onDiagnostic = options.onDiagnostic
  }

  getSnapshotPath(runId: string): string {
    assertRunId(runId)
    return path.join(this.root, `${runId}.json`)
  }

  getJournalPath(runId: string): string {
    assertRunId(runId)
    return path.join(this.root, `${runId}.events.jsonl`)
  }

  getDiagnostics(): readonly RunEventDiagnostic[] {
    return this.diagnostics.map((item) => ({ ...item }))
  }

  private diagnostic(item: RunEventDiagnostic): void {
    if (!this.diagnostics.some((existing) =>
      existing.code === item.code && existing.path === item.path && existing.message === item.message
    )) {
      this.diagnostics.push(item)
    }
    this.onDiagnostic?.(item)
  }

  private async verifiedEventState(runId: string): Promise<{
    events: RunEventEnvelope[]
    raw: string
    corruptTail?: string
  }> {
    const journalPath = this.getJournalPath(runId)
    const raw = await readOptional(journalPath)
    const events: RunEventEnvelope[] = []
    let previousChecksum: string | null = null
    let expectedSeq = 1
    let corruptTail: string | undefined
    for (const line of lines(raw)) {
      if (!line.terminated) {
        corruptTail = raw.slice(line.offset)
        this.diagnostic({
          code: "corrupt-event-tail",
          path: journalPath,
          message: `Ignored unterminated event record at sequence ${expectedSeq}`,
        })
        break
      }
      let parsed: RunEventEnvelope
      try {
        parsed = JSON.parse(line.text) as RunEventEnvelope
      } catch {
        corruptTail = raw.slice(line.offset)
        this.diagnostic({
          code: "corrupt-event-tail",
          path: journalPath,
          message: `Ignored ${Buffer.byteLength(raw.slice(line.offset))} unverified event bytes`,
        })
        break
      }
      const { checksum: actual, deduplicated: _deduplicated, ...withoutChecksum } = parsed
      if (
        parsed.type !== "run_event" ||
        parsed.schemaVersion !== RUN_SCHEMA_VERSION ||
        parsed.runId !== runId ||
        parsed.seq !== expectedSeq ||
        parsed.previousChecksum !== previousChecksum ||
        actual !== envelopeChecksum(withoutChecksum)
      ) {
        corruptTail = raw.slice(line.offset)
        this.diagnostic({
          code: "corrupt-event-tail",
          path: journalPath,
          message: `Ignored invalid event chain starting at sequence ${expectedSeq}`,
        })
        break
      }
      events.push(parsed)
      previousChecksum = actual
      expectedSeq += 1
    }
    return { events, raw, ...(corruptTail ? { corruptTail } : {}) }
  }

  private async verifiedEvents(runId: string): Promise<RunEventEnvelope[]> {
    return (await this.verifiedEventState(runId)).events
  }

  private validateSnapshot(value: unknown, runId: string): DurableRunRecord | null {
    if (!value || typeof value !== "object") return null
    const candidate = value as Partial<RunSnapshot>
    if (
      candidate.type === "run_snapshot" &&
      candidate.schemaVersion === RUN_SCHEMA_VERSION &&
      candidate.state &&
      typeof candidate.checksum === "string"
    ) {
      const base: Omit<RunSnapshot, "checksum"> = {
        type: "run_snapshot",
        schemaVersion: RUN_SCHEMA_VERSION,
        state: candidate.state,
      }
      if (candidate.checksum !== snapshotChecksum(base)) return null
      return candidate.state
    }
    // Migrate snapshots created by the initial durable-run implementation.
    const legacy = value as Partial<DurableRunRecord>
    return legacy.schemaVersion === RUN_SCHEMA_VERSION && legacy.id === runId
      ? legacy as DurableRunRecord
      : null
  }

  private async readSnapshot(runId: string): Promise<DurableRunRecord | null> {
    const snapshotPath = this.getSnapshotPath(runId)
    let sawCorruption = false
    for (const candidatePath of [snapshotPath, `${snapshotPath}.bak`]) {
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(candidatePath, "utf8"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        sawCorruption = true
        continue
      }
      const record = this.validateSnapshot(parsed, runId)
      if (!record) {
        sawCorruption = true
        continue
      }
      if (candidatePath.endsWith(".bak")) {
        this.diagnostic({
          code: "snapshot-recovered",
          path: candidatePath,
          message: `Recovered ${snapshotPath} from its last verified backup`,
        })
      }
      return this.normalizeSnapshotRecord(record, runId)
    }
    if (sawCorruption) throw new Error(`Invalid run snapshot or checksum: ${snapshotPath}`)
    return null
  }

  private normalizeSnapshotRecord(
    record: DurableRunRecord,
    runId: string,
  ): DurableRunRecord {
    if (
      record.schemaVersion !== RUN_SCHEMA_VERSION ||
      record.id !== runId ||
      !SAFE_RUN_ID.test(record.sessionId) ||
      !Number.isSafeInteger(record.lastSeq)
    ) {
      throw new Error(`Invalid run snapshot: ${this.getSnapshotPath(runId)}`)
    }
    return {
      ...record,
      recentIdempotencyKeys: { ...(record.recentIdempotencyKeys ?? {}) },
      pendingApprovals: [...(record.pendingApprovals ?? [])],
      toolArtifacts: [...(record.toolArtifacts ?? [])],
      memoryCitations: [...(record.memoryCitations ?? [])],
      taskIds: [...(record.taskIds ?? [])],
    }
  }

  private async writeSnapshot(record: DurableRunRecord): Promise<void> {
    await atomicWriteJson(this.getSnapshotPath(record.id), createSnapshot(record), { backup: true })
  }

  private async load(
    runId: string,
    repairCorruptTail = false,
  ): Promise<{ record: DurableRunRecord; events: RunEventEnvelope[]; journalBytes: number } | null> {
    const snapshot = await this.readSnapshot(runId)
    if (!snapshot) return null
    const verified = await this.verifiedEventState(runId)
    const events = verified.events
    let journalBytes = Buffer.byteLength(verified.raw)
    if (repairCorruptTail && verified.corruptTail) {
      const journalPath = this.getJournalPath(runId)
      const quarantine = `${journalPath}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
      await atomicWriteFile(quarantine, verified.corruptTail)
      const clean = events.map((event) => JSON.stringify(event)).join("\n")
      const cleanJournal = clean ? `${clean}\n` : ""
      await atomicWriteFile(journalPath, cleanJournal, { backup: true })
      journalBytes = Buffer.byteLength(cleanJournal)
    }
    const record: DurableRunRecord = {
      ...snapshot,
      lastSeq: 0,
      lastChecksum: null,
      recentIdempotencyKeys: {},
      pendingApprovals: [],
      toolArtifacts: [],
      memoryCitations: [],
      taskIds: [],
    }
    for (const envelope of events) {
      record.lastSeq = envelope.seq
      record.lastChecksum = envelope.checksum
      record.recentIdempotencyKeys[envelope.idempotencyKey] = envelope.seq
      applyEventState(record, envelope)
    }
    return { record, events, journalBytes }
  }

  private async loadForMutation(
    runId: string,
  ): Promise<{ record: DurableRunRecord; events: RunEventEnvelope[]; journalBytes: number } | null> {
    const cached = this.mutationCache.get(runId)
    if (cached) {
      const currentBytes = await stat(this.getJournalPath(runId))
        .then((value) => value.size)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return 0
          throw error
        })
      if (currentBytes === cached.journalBytes) return cached
    }
    const loaded = await this.load(runId, true)
    if (loaded) this.mutationCache.set(runId, loaded)
    return loaded
  }

  async createRun(input: {
    id: string
    sessionId: string
    mode: Mode
  }): Promise<DurableRunRecord> {
    assertRunId(input.id)
    assertRunId(input.sessionId)
    const journalPath = this.getJournalPath(input.id)
    return withFileLock(journalPath, async () => {
      const existing = await this.loadForMutation(input.id)
      if (existing) {
        if (
          existing.record.sessionId !== input.sessionId ||
          existing.record.mode !== input.mode
        ) {
          throw new Error(`Run id already exists with different parameters: ${input.id}`)
        }
        return existing.record
      }
      const now = Date.now()
      const record: DurableRunRecord = {
        schemaVersion: RUN_SCHEMA_VERSION,
        id: input.id,
        sessionId: input.sessionId,
        cwd: this.cwd,
        mode: input.mode,
        status: "running",
        createdAt: now,
        updatedAt: now,
        lastSeq: 0,
        lastChecksum: null,
        recentIdempotencyKeys: {},
        pendingApprovals: [],
        toolArtifacts: [],
        memoryCitations: [],
        taskIds: [],
      }
      await this.writeSnapshot(record)
      this.mutationCache.set(input.id, { record, events: [], journalBytes: 0 })
      return record
    })
  }

  async getRun(runId: string): Promise<DurableRunRecord | null> {
    return (await this.load(runId))?.record ?? null
  }

  async listRuns(filters: {
    sessionId?: string
    status?: RunStatus | RunStatus[]
    limit?: number
  } = {}): Promise<DurableRunRecord[]> {
    const names = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[]
      throw error
    })
    const statuses = Array.isArray(filters.status)
      ? new Set(filters.status)
      : filters.status
        ? new Set([filters.status])
        : null
    const runs: DurableRunRecord[] = []
    for (const name of names) {
      const match = name.match(/^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/)
      if (!match) continue
      const record = await this.getRun(match[1]!).catch(() => null)
      if (!record) continue
      if (filters.sessionId && record.sessionId !== filters.sessionId) continue
      if (statuses && !statuses.has(record.status)) continue
      runs.push(record)
    }
    runs.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    return typeof filters.limit === "number" && filters.limit > 0
      ? runs.slice(0, filters.limit)
      : runs
  }

  async appendEvent(
    runId: string,
    event: AgentEvent,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<RunEventEnvelope> {
    return (await this.appendEvents(runId, [{ event, idempotencyKey }]))[0]!
  }

  async appendEvents(
    runId: string,
    inputs: Array<{ event: AgentEvent; idempotencyKey?: string }>,
  ): Promise<RunEventEnvelope[]> {
    if (inputs.length === 0) return []
    const journalPath = this.getJournalPath(runId)
    return withFileLock(journalPath, async () => {
      const loaded = await this.loadForMutation(runId)
      if (!loaded) throw new Error(`Run not found: ${runId}`)
      const result: RunEventEnvelope[] = []
      const created: RunEventEnvelope[] = []
      for (const input of inputs) {
        const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID()
        const existingSeq = loaded.record.recentIdempotencyKeys[idempotencyKey]
        const existing = typeof existingSeq === "number"
          ? loaded.events.find((item) => item.seq === existingSeq) ??
            created.find((item) => item.seq === existingSeq)
          : loaded.events.find((item) => item.idempotencyKey === idempotencyKey) ??
            created.find((item) => item.idempotencyKey === idempotencyKey)
        if (existing) {
          result.push({ ...existing, deduplicated: true })
          continue
        }
        const base: Omit<RunEventEnvelope, "checksum" | "deduplicated"> = {
          type: "run_event",
          schemaVersion: RUN_SCHEMA_VERSION,
          runId,
          seq: loaded.record.lastSeq + 1,
          ts: Date.now(),
          idempotencyKey,
          previousChecksum: loaded.record.lastChecksum,
          event: input.event,
        }
        const envelope: RunEventEnvelope = {
          ...base,
          checksum: envelopeChecksum(base),
        }
        loaded.record.lastSeq = envelope.seq
        loaded.record.lastChecksum = envelope.checksum
        loaded.record.updatedAt = envelope.ts
        loaded.record.recentIdempotencyKeys[idempotencyKey] = envelope.seq
        applyEventState(loaded.record, envelope)
        created.push(envelope)
        result.push(envelope)
      }
      const serialized = created.map((envelope) => JSON.stringify(envelope)).join("\n")
      const appendText = serialized ? `${serialized}\n` : ""
      if (appendText) await appendAndSync(journalPath, appendText)
      const keys = Object.entries(loaded.record.recentIdempotencyKeys)
        .sort((a, b) => b[1] - a[1])
        .slice(0, RECENT_IDEMPOTENCY_KEYS)
      loaded.record.recentIdempotencyKeys = Object.fromEntries(keys)
      await this.writeSnapshot(loaded.record)
      loaded.events.push(...created)
      loaded.journalBytes += Buffer.byteLength(appendText)
      this.mutationCache.set(runId, loaded)
      return result
    })
  }

  async readEvents(runId: string, afterSeq = 0): Promise<RunEventEnvelope[]> {
    return (await this.verifiedEvents(runId)).filter((event) => event.seq > afterSeq)
  }

  async finishRun(runId: string, status: Exclude<RunStatus, "running">): Promise<DurableRunRecord> {
    const journalPath = this.getJournalPath(runId)
    return withFileLock(journalPath, async () => {
      const loaded = await this.loadForMutation(runId)
      if (!loaded) throw new Error(`Run not found: ${runId}`)
      loaded.record.status = status
      loaded.record.updatedAt = Date.now()
      await this.writeSnapshot(loaded.record)
      return loaded.record
    })
  }
}

/**
 * Persist-before-deliver event adapter for local hosts. `emit` stays
 * synchronous for IHost compatibility while writes and delivery are strictly
 * ordered through one promise chain.
 */
export class DurableRunEventSink {
  private queue: Promise<void> = Promise.resolve()
  private persistenceError: Error | null = null
  private pending: Array<{ event: AgentEvent; idempotencyKey?: string }> = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  private constructor(
    readonly runId: string,
    private readonly store: RunEventStore,
    private readonly deliver: (event: AgentEvent) => void,
  ) {}

  static async create(input: {
    cwd: string
    sessionId: string
    mode: Mode
    deliver: (event: AgentEvent) => void
    options?: DurableRunEventSinkOptions
  }): Promise<DurableRunEventSink> {
    const runId = input.options?.runId ??
      `run_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`
    const store = new RunEventStore(input.cwd, input.options)
    await store.createRun({ id: runId, sessionId: input.sessionId, mode: input.mode })
    return new DurableRunEventSink(runId, store, input.deliver)
  }

  emit(event: AgentEvent, idempotencyKey?: string): void {
    if (this.persistenceError || this.closed) return
    this.pending.push({ event, ...(idempotencyKey ? { idempotencyKey } : {}) })
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushPending()
    }, 8)
  }

  private flushPending(): void {
    if (this.pending.length === 0 || this.persistenceError) return
    const batch = this.pending.splice(0)
    const operation = this.queue.then(async () => {
      const envelopes = await this.store.appendEvents(this.runId, batch)
      for (const envelope of envelopes) {
        if (!envelope.deduplicated) this.deliver(envelope.event)
      }
    })
    this.queue = operation.catch((error) => {
      this.persistenceError = error instanceof Error ? error : new Error(String(error))
      this.deliver({
        type: "error",
        error: `Run event persistence failed: ${this.persistenceError.message}`,
        fatal: true,
      })
    })
  }

  async finish(status: Exclude<RunStatus, "running">): Promise<DurableRunRecord> {
    this.closed = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushPending()
    await this.queue
    if (this.persistenceError) throw this.persistenceError
    return this.store.finishRun(this.runId, status)
  }
}
