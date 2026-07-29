import * as fs from "node:fs"
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import type {
  MessagePart,
  Mode,
  ProviderContextAnchor,
  SessionMessage,
  ToolPart,
} from "../types.js"
import {
  atomicWriteFile,
  withFileLock,
} from "../storage/durable-fs.js"
import {
  deleteToolOutputArtifactsOwnedBySession,
} from "../context/tool-output-lifecycle.js"
import {
  TOOL_OUTPUT_ARTIFACT_FILE_PATTERN,
  TOOL_OUTPUT_ARTIFACT_ID_PATTERN,
  TOOL_OUTPUT_SESSION_DIRECTORY_PATTERN,
} from "../context/tool-output-format.js"
import { clearToolSpillsForSession } from "../context/tool-output-registry.js"
import {
  getToolOutputSessionDir,
  getToolOutputWorkspaceDir,
} from "../data-dir.js"

const SESSION_SCHEMA_VERSION = 2
const DEFAULT_COMPACT_AFTER_RECORDS = 64
const DEFAULT_COMPACT_AFTER_BYTES = 4 * 1024 * 1024
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_REFERENCE_SCAN_SESSIONS = 4_096
const MAX_REFERENCE_SCAN_MESSAGES = 200_000
const MAX_REFERENCE_SCAN_FILE_BYTES = 32 * 1024 * 1024
const MAX_REFERENCE_SCAN_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_TOOL_OUTPUT_DELETE_BATCH_SIZE = 2_048

export function canonicalProjectRoot(cwd: string): string {
  const trimmed = (cwd ?? "").trim()
  const base = trimmed.length > 0 ? trimmed : process.cwd()
  const resolved = path.resolve(base)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function projectHash(cwd: string): string {
  return crypto.createHash("sha1").update(canonicalProjectRoot(cwd)).digest("hex").slice(0, 12)
}

export function getSessionsDir(cwd: string, homeDir = path.join(os.homedir(), ".nexus")): string {
  return path.join(homeDir, "sessions", projectHash(cwd))
}

export type StoredContextUsage = {
  usedTokens: number
  limitTokens: number
  percent: number
  source?: "provider" | "hybrid" | "estimated"
  providerTokens?: number
  pendingTokens?: number
  /** Model identity that makes the persisted usage/limit safe to restore. */
  modelId?: string
}

export interface StoredSession {
  id: string
  cwd: string
  ts: number
  title?: string
  todo?: string
  contextUsage?: StoredContextUsage
  providerContextAnchor?: ProviderContextAnchor
  mode?: Mode
  messages: SessionMessage[]
  /** Monotonic durable journal revision. Legacy v1 files load as revision 0. */
  revision?: number
}

export interface StoredSessionMeta {
  id: string
  cwd: string
  ts: number
  title?: string
  todo?: string
  mode?: Mode
  messageCount: number
  revision: number
}

export type SessionStorageDiagnosticCode =
  | "corrupt-journal-tail"
  | "journal-backup-recovered"
  | "legacy-session-detected"
  | "legacy-session-migrated"
  | "session-corrupt"

export interface SessionStorageDiagnostic {
  code: SessionStorageDiagnosticCode
  path: string
  message: string
}

export interface SessionStoreOptions {
  /** Nexus home containing sessions/. Defaults to ~/.nexus. */
  homeDir?: string
  compactAfterRecords?: number
  compactAfterBytes?: number
  /** Bounded artifact cleanup batch; primarily configurable for embedded hosts/tests. */
  toolOutputDeleteBatchSize?: number
  onDiagnostic?: (diagnostic: SessionStorageDiagnostic) => void
}

export interface SaveSessionOptions {
  expectedRevision?: number
}

export interface PersistedToolOutputProtection {
  sessionDirectories: Set<string>
  artifactPaths: Set<string>
  protectAll: boolean
}

export interface DeleteSessionOptions {
  /** Internal/embedded-host seam; defaults to the process-wide store. */
  store?: SessionStore
  /** Runtime projection coordinator. Defaults to the workspace runtime. */
  runtime?: {
    deleteSessionRecords(sessionId: string): Promise<unknown>
  }
}

export class UnsafeSessionIdError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unsafe session id: ${JSON.stringify(sessionId)}`)
    this.name = "UnsafeSessionIdError"
  }
}

export class SessionConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Session ${sessionId} changed concurrently (expected revision ${expectedRevision}, actual ${actualRevision})`,
    )
    this.name = "SessionConflictError"
  }
}

export class SessionCorruptionError extends Error {
  constructor(
    readonly journalPath: string,
    message: string,
  ) {
    super(`Session journal is corrupt: ${journalPath}: ${message}`)
    this.name = "SessionCorruptionError"
  }
}

type SessionHeader = {
  type: "session_header"
  schemaVersion: 2
  sessionId: string
  cwd: string
  createdAt: number
  baseSequence: number
}

type SessionSnapshotPayload = Omit<StoredSession, "revision">

type SessionSnapshot = {
  type: "session_snapshot"
  schemaVersion: 2
  sequence: number
  previousChecksum: string | null
  checksum: string
  state: SessionSnapshotPayload
}

type ParsedJournal = {
  format: "missing" | "legacy-v1" | "v2"
  session: StoredSession | null
  header?: SessionHeader
  lastChecksum: string | null
  snapshotCount: number
  byteLength: number
  raw: string
  corruptTail?: string
}

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new UnsafeSessionIdError(sessionId)
}

function isContextUsage(value: unknown): value is StoredContextUsage {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<StoredContextUsage>
  const validBase =
    typeof candidate.usedTokens === "number" &&
    typeof candidate.limitTokens === "number" &&
    typeof candidate.percent === "number"
  const validSource =
    candidate.source === undefined ||
    candidate.source === "provider" ||
    candidate.source === "hybrid" ||
    candidate.source === "estimated"
  const validOptionalCount = (count: unknown) =>
    count === undefined ||
    (typeof count === "number" && Number.isFinite(count) && count >= 0)
  return (
    validBase &&
    validSource &&
    validOptionalCount(candidate.providerTokens) &&
    validOptionalCount(candidate.pendingTokens) &&
    (candidate.modelId === undefined ||
      typeof candidate.modelId === "string")
  )
}

function isProviderContextAnchor(
  value: unknown,
): value is ProviderContextAnchor {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ProviderContextAnchor>
  return (
    typeof candidate.messageId === "string" &&
    candidate.messageId.length > 0 &&
    typeof candidate.usedTokens === "number" &&
    Number.isFinite(candidate.usedTokens) &&
    candidate.usedTokens >= 0 &&
    typeof candidate.manifestTokens === "number" &&
    Number.isFinite(candidate.manifestTokens) &&
    candidate.manifestTokens >= 0 &&
    typeof candidate.recordedAt === "number" &&
    Number.isSafeInteger(candidate.recordedAt) &&
    candidate.recordedAt >= 0 &&
    (candidate.modelId === undefined ||
      typeof candidate.modelId === "string")
  )
}

function isMode(value: unknown): value is Mode {
  return (
    value === "agent" ||
    value === "plan" ||
    value === "ask" ||
    value === "debug" ||
    value === "review"
  )
}

function normalizeStoredSession(
  value: Partial<StoredSession>,
  expectedId: string,
  cwd: string,
  revision: number,
): StoredSession {
  if (value.id !== expectedId) {
    throw new SessionCorruptionError(expectedId, `record id ${String(value.id)} does not match its file`)
  }
  if (!Number.isFinite(value.ts) || !Array.isArray(value.messages)) {
    throw new SessionCorruptionError(expectedId, "record has invalid timestamp or messages")
  }
  return {
    id: expectedId,
    cwd,
    ts: value.ts!,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    todo: typeof value.todo === "string" ? value.todo : "",
    ...(isContextUsage(value.contextUsage) ? { contextUsage: value.contextUsage } : {}),
    ...(isProviderContextAnchor(value.providerContextAnchor)
      ? { providerContextAnchor: value.providerContextAnchor }
      : {}),
    ...(isMode(value.mode) ? { mode: value.mode } : {}),
    messages: value.messages as SessionMessage[],
    revision,
  }
}

function snapshotChecksum(
  sequence: number,
  previousChecksum: string | null,
  state: SessionSnapshotPayload,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ sequence, previousChecksum, state }))
    .digest("hex")
}

function createSnapshot(
  session: StoredSession,
  cwd: string,
  sequence: number,
  previousChecksum: string | null,
): SessionSnapshot {
  const state: SessionSnapshotPayload = {
    id: session.id,
    cwd,
    ts: session.ts,
    ...(typeof session.title === "string" ? { title: session.title } : {}),
    todo: typeof session.todo === "string" ? session.todo : "",
    ...(session.contextUsage ? { contextUsage: session.contextUsage } : {}),
    ...(session.providerContextAnchor
      ? { providerContextAnchor: session.providerContextAnchor }
      : {}),
    ...(session.mode ? { mode: session.mode } : {}),
    messages: session.messages,
  }
  return {
    type: "session_snapshot",
    schemaVersion: SESSION_SCHEMA_VERSION,
    sequence,
    previousChecksum,
    checksum: snapshotChecksum(sequence, previousChecksum, state),
    state,
  }
}

function serializeCompactedJournal(session: StoredSession, cwd: string, sequence: number): string {
  const header: SessionHeader = {
    type: "session_header",
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: session.id,
    cwd,
    createdAt: session.ts,
    baseSequence: Math.max(0, sequence - 1),
  }
  const snapshot = createSnapshot(session, cwd, sequence, null)
  return `${JSON.stringify(header)}\n${JSON.stringify(snapshot)}\n`
}

function lineEntries(raw: string): Array<{ text: string; start: number; end: number }> {
  const result: Array<{ text: string; start: number; end: number }> = []
  let start = 0
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== "\n") continue
    const text = raw.slice(start, index).replace(/\r$/, "")
    if (text.trim().length > 0) result.push({ text, start, end: index < raw.length ? index + 1 : index })
    start = index + 1
  }
  return result
}

function parseLegacy(raw: string, sessionId: string, cwd: string): ParsedJournal {
  const entries = lineEntries(raw)
  if (entries.length === 0) {
    return {
      format: "missing",
      session: null,
      lastChecksum: null,
      snapshotCount: 0,
      byteLength: raw.length,
      raw,
    }
  }
  let meta: Partial<StoredSession>
  try {
    meta = JSON.parse(entries[0]!.text) as Partial<StoredSession>
  } catch (error) {
    throw new SessionCorruptionError(sessionId, `legacy metadata cannot be parsed: ${String(error)}`)
  }
  const messages: SessionMessage[] = []
  let corruptTail: string | undefined
  for (let index = 1; index < entries.length; index += 1) {
    try {
      messages.push(JSON.parse(entries[index]!.text) as SessionMessage)
    } catch {
      corruptTail = raw.slice(entries[index]!.start)
      break
    }
  }
  return {
    format: "legacy-v1",
    session: normalizeStoredSession({ ...meta, messages }, sessionId, cwd, 0),
    lastChecksum: null,
    snapshotCount: 0,
    byteLength: raw.length,
    raw,
    ...(corruptTail ? { corruptTail } : {}),
  }
}

function isHeader(value: unknown): value is SessionHeader {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<SessionHeader>
  return (
    record.type === "session_header" &&
    record.schemaVersion === SESSION_SCHEMA_VERSION &&
    typeof record.sessionId === "string" &&
    typeof record.cwd === "string" &&
    typeof record.createdAt === "number" &&
    Number.isSafeInteger(record.baseSequence) &&
    record.baseSequence! >= 0
  )
}

function parseV2(raw: string, sessionId: string, cwd: string): ParsedJournal {
  const entries = lineEntries(raw)
  let headerValue: unknown
  try {
    headerValue = JSON.parse(entries[0]!.text)
  } catch (error) {
    throw new SessionCorruptionError(sessionId, `journal header cannot be parsed: ${String(error)}`)
  }
  if (!isHeader(headerValue) || headerValue.sessionId !== sessionId) {
    throw new SessionCorruptionError(sessionId, "invalid or mismatched v2 journal header")
  }

  let sequence = headerValue.baseSequence
  let lastChecksum: string | null = null
  let latest: StoredSession | null = null
  let corruptTail: string | undefined
  let snapshotCount = 0
  for (let index = 1; index < entries.length; index += 1) {
    const entry = entries[index]!
    let candidate: Partial<SessionSnapshot>
    try {
      candidate = JSON.parse(entry.text) as Partial<SessionSnapshot>
    } catch {
      corruptTail = raw.slice(entry.start)
      break
    }
    const expectedSequence = sequence + 1
    if (
      candidate.type !== "session_snapshot" ||
      candidate.schemaVersion !== SESSION_SCHEMA_VERSION ||
      candidate.sequence !== expectedSequence ||
      candidate.previousChecksum !== lastChecksum ||
      !candidate.state ||
      candidate.checksum !== snapshotChecksum(expectedSequence, lastChecksum, candidate.state)
    ) {
      corruptTail = raw.slice(entry.start)
      break
    }
    latest = normalizeStoredSession(candidate.state, sessionId, cwd, expectedSequence)
    sequence = expectedSequence
    lastChecksum = candidate.checksum
    snapshotCount += 1
  }
  if (!latest) {
    throw new SessionCorruptionError(sessionId, "journal contains no verified snapshot")
  }
  return {
    format: "v2",
    session: latest,
    header: headerValue,
    lastChecksum,
    snapshotCount,
    byteLength: raw.length,
    raw,
    ...(corruptTail ? { corruptTail } : {}),
  }
}

async function readRaw(pathname: string): Promise<string | null> {
  try {
    return await readFile(pathname, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export class SessionStore {
  private readonly homeDir: string
  private readonly compactAfterRecords: number
  private readonly compactAfterBytes: number
  private readonly toolOutputDeleteBatchSize: number
  private readonly onDiagnostic?: (diagnostic: SessionStorageDiagnostic) => void
  private readonly diagnostics: SessionStorageDiagnostic[] = []

  constructor(options: SessionStoreOptions = {}) {
    this.homeDir = path.resolve(options.homeDir ?? path.join(os.homedir(), ".nexus"))
    this.compactAfterRecords = Math.max(1, options.compactAfterRecords ?? DEFAULT_COMPACT_AFTER_RECORDS)
    this.compactAfterBytes = Math.max(1, options.compactAfterBytes ?? DEFAULT_COMPACT_AFTER_BYTES)
    this.toolOutputDeleteBatchSize =
      Number.isSafeInteger(options.toolOutputDeleteBatchSize) &&
      options.toolOutputDeleteBatchSize! > 0
        ? Math.min(
            MAX_TOOL_OUTPUT_DELETE_BATCH_SIZE,
            options.toolOutputDeleteBatchSize!,
          )
        : MAX_TOOL_OUTPUT_DELETE_BATCH_SIZE
    this.onDiagnostic = options.onDiagnostic
  }

  getSessionsDir(cwd: string): string {
    return path.join(this.homeDir, "sessions", projectHash(cwd))
  }

  getSessionPath(sessionId: string, cwd: string): string {
    assertSafeSessionId(sessionId)
    return path.join(this.getSessionsDir(cwd), `${sessionId}.jsonl`)
  }

  private diagnostic(diagnostic: SessionStorageDiagnostic): void {
    const duplicate = this.diagnostics.some(
      (existing) =>
        existing.code === diagnostic.code &&
        existing.path === diagnostic.path &&
        existing.message === diagnostic.message,
    )
    if (!duplicate) {
      this.diagnostics.push(diagnostic)
      if (this.diagnostics.length > 100) this.diagnostics.shift()
    }
    this.onDiagnostic?.(diagnostic)
  }

  getDiagnostics(): readonly SessionStorageDiagnostic[] {
    return this.diagnostics.map((diagnostic) => ({ ...diagnostic }))
  }

  private async parseJournal(sessionId: string, cwd: string): Promise<ParsedJournal> {
    const root = canonicalProjectRoot(cwd)
    const journalPath = this.getSessionPath(sessionId, root)
    const raw = await readRaw(journalPath)
    if (raw == null || raw.trim().length === 0) {
      return {
        format: "missing",
        session: null,
        lastChecksum: null,
        snapshotCount: 0,
        byteLength: raw?.length ?? 0,
        raw: raw ?? "",
      }
    }

    const entries = lineEntries(raw)
    let first: unknown
    try {
      first = JSON.parse(entries[0]!.text)
    } catch {
      first = undefined
    }

    try {
      const parsed = isHeader(first) ? parseV2(raw, sessionId, root) : parseLegacy(raw, sessionId, root)
      if (parsed.format === "legacy-v1") {
        this.diagnostic({
          code: "legacy-session-detected",
          path: journalPath,
          message: `Legacy session ${sessionId} will migrate on its next durable write`,
        })
      }
      if (parsed.corruptTail) {
        this.diagnostic({
          code: "corrupt-journal-tail",
          path: journalPath,
          message: `Ignored ${Buffer.byteLength(parsed.corruptTail)} unverified tail bytes`,
        })
      }
      return parsed
    } catch (primaryError) {
      const backup = await readRaw(`${journalPath}.bak`)
      if (backup != null) {
        try {
          const parsed = parseV2(backup, sessionId, root)
          this.diagnostic({
            code: "journal-backup-recovered",
            path: `${journalPath}.bak`,
            message: `Recovered session ${sessionId} from its compacted backup`,
          })
          return { ...parsed, raw: backup, corruptTail: raw }
        } catch {
          // Preserve the primary error below: it names the authoritative path.
        }
      }
      throw primaryError
    }
  }

  private async quarantineTail(journalPath: string, corruptTail: string): Promise<void> {
    const quarantine = `${journalPath}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
    await atomicWriteFile(quarantine, corruptTail)
  }

  private async writeLocked(
    journalPath: string,
    cwd: string,
    session: StoredSession,
    current: ParsedJournal,
  ): Promise<number> {
    const actualRevision = current.session?.revision ?? 0
    const sequence = actualRevision + 1
    const normalized: StoredSession = {
      ...session,
      cwd,
      todo: typeof session.todo === "string" ? session.todo : "",
      revision: sequence,
    }

    if (current.corruptTail) await this.quarantineTail(journalPath, current.corruptTail)
    if (current.format === "legacy-v1") {
      const legacyBackup = `${journalPath}.legacy-v1.bak`
      try {
        await copyFile(journalPath, legacyBackup, fs.constants.COPYFILE_EXCL)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      this.diagnostic({
        code: "legacy-session-migrated",
        path: journalPath,
        message: `Migrated legacy session ${session.id} to journal schema v2`,
      })
    }

    const shouldCompact =
      current.format !== "v2" ||
      Boolean(current.corruptTail) ||
      current.snapshotCount >= this.compactAfterRecords ||
      current.byteLength >= this.compactAfterBytes

    if (shouldCompact) {
      await atomicWriteFile(journalPath, serializeCompactedJournal(normalized, cwd, sequence), {
        backup: current.format === "v2" && !current.corruptTail,
      })
      return sequence
    }

    const snapshot = createSnapshot(normalized, cwd, sequence, current.lastChecksum)
    const handle = await open(journalPath, "a", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    return sequence
  }

  async saveSession(session: StoredSession, options: SaveSessionOptions = {}): Promise<number> {
    assertSafeSessionId(session.id)
    const cwd = canonicalProjectRoot(session.cwd)
    const journalPath = this.getSessionPath(session.id, cwd)
    await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 })
    return withFileLock(journalPath, async () => {
      const current = await this.parseJournal(session.id, cwd)
      const actualRevision = current.session?.revision ?? 0
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== actualRevision
      ) {
        throw new SessionConflictError(session.id, options.expectedRevision, actualRevision)
      }
      return this.writeLocked(journalPath, cwd, session, current)
    })
  }

  async mutateSession(
    sessionId: string,
    cwd: string,
    mutate: (session: StoredSession) => StoredSession | Promise<StoredSession>,
  ): Promise<StoredSession | null> {
    assertSafeSessionId(sessionId)
    const root = canonicalProjectRoot(cwd)
    const journalPath = this.getSessionPath(sessionId, root)
    return withFileLock(journalPath, async () => {
      const current = await this.parseJournal(sessionId, root)
      if (!current.session) return null
      const next = await mutate({
        ...current.session,
        messages: [...current.session.messages],
      })
      if (next.id !== sessionId) {
        throw new UnsafeSessionIdError(next.id)
      }
      const currentComparable = { ...current.session, revision: undefined }
      const nextComparable = { ...next, cwd: root, revision: undefined }
      if (JSON.stringify(currentComparable) === JSON.stringify(nextComparable)) {
        return current.session
      }
      const revision = await this.writeLocked(journalPath, root, next, current)
      return { ...next, cwd: root, revision }
    })
  }

  async loadSession(sessionId: string, cwd: string): Promise<StoredSession | null> {
    assertSafeSessionId(sessionId)
    return (await this.parseJournal(sessionId, canonicalProjectRoot(cwd))).session
  }

  async getSessionMeta(sessionId: string, cwd: string): Promise<StoredSessionMeta | null> {
    const session = await this.loadSession(sessionId, cwd)
    if (!session) return null
    return {
      id: session.id,
      cwd: session.cwd,
      ts: session.ts,
      title: session.title,
      todo: session.todo,
      mode: session.mode,
      messageCount: session.messages.length,
      revision: session.revision ?? 0,
    }
  }

  async loadSessionMessages(
    sessionId: string,
    cwd: string,
    limit: number,
    offset: number,
  ): Promise<{ meta: StoredSessionMeta; messages: SessionMessage[] } | null> {
    const session = await this.loadSession(sessionId, cwd)
    if (!session) return null
    const start = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0)
    const safeLimit = Number.isFinite(limit) ? Math.trunc(limit) : 0
    const end = safeLimit > 0 ? Math.min(session.messages.length, start + safeLimit) : session.messages.length
    return {
      meta: {
        id: session.id,
        cwd: session.cwd,
        ts: session.ts,
        title: session.title,
        todo: session.todo,
        mode: session.mode,
        messageCount: session.messages.length,
        revision: session.revision ?? 0,
      },
      messages: session.messages.slice(start, end),
    }
  }

  async listSessions(
    cwd: string,
  ): Promise<Array<{ id: string; ts: number; title?: string; messageCount: number; revision: number }>> {
    const root = canonicalProjectRoot(cwd)
    const directory = this.getSessionsDir(root)
    const files = await readdir(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]
      throw error
    })
    const sessions: Array<{
      id: string
      ts: number
      title?: string
      messageCount: number
      revision: number
    }> = []
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue
      const sessionId = file.slice(0, -".jsonl".length)
      if (!SAFE_SESSION_ID.test(sessionId)) continue
      try {
        const meta = await this.getSessionMeta(sessionId, root)
        if (meta) {
          sessions.push({
            id: meta.id,
            ts: meta.ts,
            title: meta.title,
            messageCount: meta.messageCount,
            revision: meta.revision,
          })
        }
      } catch (error) {
        this.diagnostic({
          code: "session-corrupt",
          path: path.join(directory, file),
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return sessions.sort((a, b) => b.ts - a.ts)
  }

  async deleteSession(sessionId: string, cwd: string): Promise<boolean> {
    assertSafeSessionId(sessionId)
    const root = canonicalProjectRoot(cwd)
    const journalPath = this.getSessionPath(sessionId, root)
    return withFileLock(journalPath, async () => {
      const directory = path.dirname(journalPath)
      const basename = path.basename(journalPath)
      const candidates = (await readdir(directory).catch(() => []))
        .filter(
          (name) =>
            name === basename ||
            name === `${basename}.bak` ||
            name === `${basename}.legacy-v1.bak` ||
            (
              name.startsWith(basename) &&
              /^\.corrupt-\d+-[0-9a-f]{8}$/i.test(
                name.slice(basename.length),
              )
            ),
        )
      const artifactProtection =
        await this.collectToolOutputProtection(root, sessionId)
      await deleteToolOutputArtifactsOwnedBySession({
        cwd: root,
        sessionId,
        maxArtifacts: this.toolOutputDeleteBatchSize,
        protectedArtifacts: artifactProtection.artifactPaths,
        protectAll: artifactProtection.protectAll,
      })
      await deleteSessionMemoryFiles(directory, sessionId)
      await deleteSessionCheckpointEntry(directory, sessionId)
      clearToolSpillsForSession(sessionId)
      if (candidates.length === 0) return false

      let deleted = false
      const orderedCandidates = candidates.sort((left, right) => {
        if (left === basename) return 1
        if (right === basename) return -1
        return left.localeCompare(right)
      })
      for (const name of orderedCandidates) {
        try {
          await unlink(path.join(directory, name))
          if (name === basename) deleted = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      return deleted
    })
  }

  async collectToolOutputProtection(
    cwd: string,
    excludeSessionId?: string,
  ): Promise<PersistedToolOutputProtection> {
    const directory = this.getSessionsDir(cwd)
    let filenames: string[]
    try {
      filenames = (await readdir(directory))
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          sessionDirectories: new Set(),
          artifactPaths: new Set(),
          protectAll: false,
        }
      }
      return {
        sessionDirectories: new Set(),
        artifactPaths: new Set(),
        protectAll: true,
      }
    }
    if (filenames.length > MAX_REFERENCE_SCAN_SESSIONS) {
      return {
        sessionDirectories: new Set(),
        artifactPaths: new Set(),
        protectAll: true,
      }
    }

    const sessionDirectories = new Set<string>()
    const artifactPaths = new Set<string>()
    const toolOutputWorkspaceRoot = path.resolve(
      getToolOutputWorkspaceDir(cwd),
    )
    let scannedMessages = 0
    let scannedBytes = 0
    for (const filename of filenames) {
      const candidateSessionId = filename.slice(0, -".jsonl".length)
      if (!SAFE_SESSION_ID.test(candidateSessionId)) {
        return {
          sessionDirectories,
          artifactPaths,
          protectAll: true,
        }
      }
      if (candidateSessionId === excludeSessionId) continue
      sessionDirectories.add(
        path.resolve(
          getToolOutputSessionDir(cwd, candidateSessionId),
        ),
      )
      let journalInfo
      try {
        journalInfo = await fs.promises.lstat(
          path.join(directory, filename),
        )
      } catch {
        return {
          sessionDirectories,
          artifactPaths,
          protectAll: true,
        }
      }
      if (
        journalInfo.isSymbolicLink() ||
        !journalInfo.isFile() ||
        journalInfo.size > MAX_REFERENCE_SCAN_FILE_BYTES ||
        scannedBytes + journalInfo.size >
          MAX_REFERENCE_SCAN_TOTAL_BYTES
      ) {
        return {
          sessionDirectories,
          artifactPaths,
          protectAll: true,
        }
      }
      scannedBytes += journalInfo.size
      let parsed: ParsedJournal
      try {
        parsed = await this.parseJournal(candidateSessionId, cwd)
      } catch {
        return {
          sessionDirectories,
          artifactPaths,
          protectAll: true,
        }
      }
      if (parsed.corruptTail) {
        return {
          sessionDirectories,
          artifactPaths,
          protectAll: true,
        }
      }
      for (const message of parsed.session?.messages ?? []) {
        scannedMessages += 1
        if (scannedMessages > MAX_REFERENCE_SCAN_MESSAGES) {
          return {
            sessionDirectories,
            artifactPaths,
            protectAll: true,
          }
        }
        if (!Array.isArray(message.content)) continue
        for (const part of message.content as MessagePart[]) {
          if (part.type !== "tool") continue
          const tool = part as ToolPart
          if (
            typeof tool.outputArtifactOwnerSessionId === "string" &&
            SAFE_SESSION_ID.test(tool.outputArtifactOwnerSessionId) &&
            typeof tool.outputArtifactId === "string" &&
            TOOL_OUTPUT_ARTIFACT_ID_PATTERN.test(tool.outputArtifactId)
          ) {
            artifactPaths.add(
              path.join(
                getToolOutputSessionDir(
                  cwd,
                  tool.outputArtifactOwnerSessionId,
                ),
                `${tool.outputArtifactId.toLowerCase()}.out`,
              ),
            )
          }
          if (typeof tool.outputSpillPath !== "string") continue
          const legacyPath = path.resolve(tool.outputSpillPath)
          const relative = path.relative(
            toolOutputWorkspaceRoot,
            legacyPath,
          )
          const segments = relative.split(path.sep)
          if (
            !path.isAbsolute(relative) &&
            segments.length === 2 &&
            TOOL_OUTPUT_SESSION_DIRECTORY_PATTERN.test(
              segments[0] ?? "",
            ) &&
            TOOL_OUTPUT_ARTIFACT_FILE_PATTERN.test(segments[1] ?? "")
          ) {
            artifactPaths.add(legacyPath)
          }
        }
      }
    }
    return { sessionDirectories, artifactPaths, protectAll: false }
  }
}

async function deleteSessionMemoryFiles(
  sessionsDirectory: string,
  sessionId: string,
): Promise<void> {
  const memoryPath = path.join(
    sessionsDirectory,
    `${sessionId}.session-memory.md`,
  )
  await withFileLock(memoryPath, async () => {
    for (const candidate of [memoryPath, `${memoryPath}.bak`]) {
      await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
    }
  })
}

async function deleteSessionCheckpointEntry(
  sessionsDirectory: string,
  sessionId: string,
): Promise<void> {
  const checkpointsPath = path.join(sessionsDirectory, "checkpoints.json")
  await withFileLock(checkpointsPath, async () => {
    let raw: string
    try {
      const info = await fs.promises.lstat(checkpointsPath)
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(
          `Checkpoint storage is not a regular file: ${checkpointsPath}`,
        )
      }
      raw = await readFile(checkpointsPath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(
        `Refusing to rewrite corrupt checkpoint storage: ${checkpointsPath}`,
      )
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `Refusing to rewrite invalid checkpoint storage: ${checkpointsPath}`,
      )
    }
    const checkpoints = { ...(parsed as Record<string, unknown>) }
    if (!Object.prototype.hasOwnProperty.call(checkpoints, sessionId)) return
    delete checkpoints[sessionId]

    if (Object.keys(checkpoints).length === 0) {
      for (const candidate of [
        checkpointsPath,
        `${checkpointsPath}.bak`,
      ]) {
        await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      }
      return
    }
    await atomicWriteFile(
      checkpointsPath,
      `${JSON.stringify(checkpoints, null, 2)}\n`,
      { mode: 0o600 },
    )
    await unlink(`${checkpointsPath}.bak`).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      },
    )
  })
}

const defaultSessionStore = new SessionStore()

export async function collectPersistedToolOutputProtection(
  cwd: string,
  homeDir?: string,
): Promise<PersistedToolOutputProtection> {
  const store = homeDir === undefined
    ? defaultSessionStore
    : new SessionStore({ homeDir })
  return store.collectToolOutputProtection(
    canonicalProjectRoot(cwd),
  )
}

export function getSessionStorageDiagnostics(): readonly SessionStorageDiagnostic[] {
  return defaultSessionStore.getDiagnostics()
}

export async function saveSession(
  session: StoredSession,
  options: SaveSessionOptions = {},
): Promise<number> {
  return defaultSessionStore.saveSession(session, options)
}

export async function mutateSession(
  sessionId: string,
  cwd: string,
  mutate: (session: StoredSession) => StoredSession | Promise<StoredSession>,
): Promise<StoredSession | null> {
  return defaultSessionStore.mutateSession(sessionId, cwd, mutate)
}

export async function loadSession(sessionId: string, cwd: string): Promise<StoredSession | null> {
  return defaultSessionStore.loadSession(sessionId, cwd)
}

export async function getSessionMeta(sessionId: string, cwd: string): Promise<StoredSessionMeta | null> {
  return defaultSessionStore.getSessionMeta(sessionId, cwd)
}

export async function loadSessionMessages(
  sessionId: string,
  cwd: string,
  limit: number,
  offset: number,
): Promise<{ meta: StoredSessionMeta; messages: SessionMessage[] } | null> {
  return defaultSessionStore.loadSessionMessages(sessionId, cwd, limit, offset)
}

export async function listSessions(
  cwd: string,
): Promise<Array<{ id: string; ts: number; title?: string; messageCount: number; revision: number }>> {
  return defaultSessionStore.listSessions(cwd)
}

export async function deleteSession(
  sessionId: string,
  cwd: string,
  options: DeleteSessionOptions = {},
): Promise<boolean> {
  assertSafeSessionId(sessionId)
  const root = canonicalProjectRoot(cwd)
  const store = options.store ?? defaultSessionStore
  let runtime = options.runtime
  if (!runtime) {
    const { getOrchestrationRuntime } =
      await import("../orchestration/runtime.js")
    runtime = await getOrchestrationRuntime(root)
  }
  await runtime.deleteSessionRecords(sessionId)
  return store.deleteSession(sessionId, root)
}

export function generateSessionId(): string {
  return `session_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
}
