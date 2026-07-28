import { constants as fsConstants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import {
  atomicWriteFile,
  withFileLock,
} from "../storage/durable-fs.js"
import {
  assertChangeSetTransition,
  hashChangeProposal,
  hashFileContent,
  sameChangeIdentity,
} from "./hash.js"
import type {
  ChangeSetListQuery,
  ChangeSetRecord,
  ChangeSetStore,
} from "./types.js"

const MANIFEST_SCHEMA_VERSION = 1
const DEFAULT_MAX_RECORDS = 10_000
const DEFAULT_MAX_MANIFEST_BYTES = 64 * 1_024 * 1_024
const DEFAULT_MAX_BLOB_BYTES = 128 * 1_024 * 1_024
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CHANGE_SET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CHANGE_SET_STATES = new Set([
  "proposed",
  "approved",
  "applying",
  "applied",
  "rejected",
  "accepted",
  "reverting",
  "reverted",
  "conflicted",
])
const APPROVED_STATES = new Set([
  "approved",
  "applying",
  "applied",
  "accepted",
  "reverting",
  "reverted",
  "conflicted",
])

interface ManifestPayload {
  schemaVersion: 1
  workspaceId: string
  records: ChangeSetRecord[]
}

interface ManifestEnvelope {
  schemaVersion: 1
  checksum: string
  payload: ManifestPayload
}

type ManifestCandidate =
  | { kind: "missing" }
  | { kind: "valid"; payload: ManifestPayload }
  | { kind: "corrupt"; message: string; fatal?: boolean }

function workspaceDirectoryName(workspaceId: string): string {
  return hashFileContent(`workspace:${workspaceId}`).hash
}

function manifestChecksum(payload: ManifestPayload): string {
  return hashFileContent(JSON.stringify(payload)).hash
}

function cloneRecord(record: ChangeSetRecord): ChangeSetRecord {
  return structuredClone(record)
}

function validateChangeSetId(id: string): void {
  if (!CHANGE_SET_ID_PATTERN.test(id)) {
    throw new Error(
      "Change-set id must be 1-128 safe alphanumeric/dot/dash/underscore characters",
    )
  }
}

function validateRecord(
  record: ChangeSetRecord,
  workspaceId: string,
): void {
  validateChangeSetId(record.id)
  if (record.schemaVersion !== 1) {
    throw new Error(`Unsupported change-set schema version: ${record.schemaVersion}`)
  }
  if (record.identity.workspaceId !== workspaceId) {
    throw new Error(
      `Change set ${record.id} belongs to workspace ${record.identity.workspaceId}, not ${workspaceId}`,
    )
  }
  if (!CHANGE_SET_STATES.has(record.state)) {
    throw new Error(`Change set ${record.id} state is invalid`)
  }
  if (record.supersedes !== undefined) {
    validateChangeSetId(record.supersedes)
    if (record.supersedes === record.id) {
      throw new Error(`Change set ${record.id} cannot supersede itself`)
    }
  }
  if (hashChangeProposal(record.identity, record.files) !== record.proposalHash) {
    throw new Error(`Change set ${record.id} proposal hash does not match its files`)
  }
  if (
    record.approvedHash !== undefined &&
    record.approvedHash !== record.proposalHash
  ) {
    throw new Error(`Change set ${record.id} approval hash is stale`)
  }
  if (
    APPROVED_STATES.has(record.state) &&
    record.approvedHash !== record.proposalHash
  ) {
    throw new Error(
      `Change set ${record.id} state ${record.state} requires an exact approvedHash`,
    )
  }
  if (
    (record.state === "proposed" || record.state === "rejected") &&
    record.approvedHash !== undefined
  ) {
    throw new Error(
      `Change set ${record.id} state ${record.state} cannot retain an approval`,
    )
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new Error(`Change set ${record.id} revision is invalid`)
  }
  for (const [label, value] of [
    ["createdAt", record.createdAt],
    ["updatedAt", record.updatedAt],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Change set ${record.id} ${label} is invalid`)
    }
  }
  if (record.updatedAt < record.createdAt) {
    throw new Error(`Change set ${record.id} updatedAt precedes createdAt`)
  }
}

function assertImmutableRecordFields(
  current: ChangeSetRecord,
  replacement: ChangeSetRecord,
): void {
  const currentImmutable = {
    schemaVersion: current.schemaVersion,
    id: current.id,
    identity: current.identity,
    proposalHash: current.proposalHash,
    supersedes: current.supersedes ?? null,
    files: current.files,
    createdAt: current.createdAt,
  }
  const replacementImmutable = {
    schemaVersion: replacement.schemaVersion,
    id: replacement.id,
    identity: replacement.identity,
    proposalHash: replacement.proposalHash,
    supersedes: replacement.supersedes ?? null,
    files: replacement.files,
    createdAt: replacement.createdAt,
  }
  if (JSON.stringify(currentImmutable) !== JSON.stringify(replacementImmutable)) {
    throw new ChangeSetStoreConflictError(
      `Change set ${current.id} immutable proposal ownership changed`,
    )
  }
  if (replacement.updatedAt < current.updatedAt) {
    throw new ChangeSetStoreConflictError(
      `Change set ${current.id} updatedAt moved backwards`,
    )
  }
  assertChangeSetTransition(current.state, replacement.state)
}

async function ensureSafeDirectoryChain(
  root: string,
  target: string,
): Promise<void> {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Storage path escapes its root: ${resolvedTarget}`)
  }

  const segments = relative === "" ? [] : relative.split(path.sep)
  let current = resolvedRoot
  for (let index = -1; index < segments.length; index++) {
    if (index >= 0) current = path.join(current, segments[index]!)
    try {
      const info = await fs.lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Storage directory is symbolic or not a directory: ${current}`)
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        try {
          await fs.mkdir(current, { mode: 0o700 })
        } catch (mkdirError) {
          if (
            !mkdirError ||
            typeof mkdirError !== "object" ||
            !("code" in mkdirError) ||
            mkdirError.code !== "EEXIST"
          ) {
            throw mkdirError
          }
          const raced = await fs.lstat(current)
          if (raced.isSymbolicLink() || !raced.isDirectory()) {
            throw new Error(
              `Storage directory is symbolic or not a directory: ${current}`,
            )
          }
        }
        continue
      }
      throw error
    }
  }
}

async function readManifestCandidate(
  candidatePath: string,
  expectedWorkspaceId: string,
  maxBytes: number,
): Promise<ManifestCandidate> {
  let info
  try {
    info = await fs.lstat(candidatePath)
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { kind: "missing" }
    }
    return {
      kind: "corrupt",
      message: error instanceof Error ? error.message : String(error),
    }
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return {
      kind: "corrupt",
      message: `Manifest is symbolic or not a regular file: ${candidatePath}`,
      fatal: true,
    }
  }
  if (info.size > maxBytes) {
    return {
      kind: "corrupt",
      message:
        `Manifest exceeds the ${maxBytes}-byte limit: ${candidatePath}`,
    }
  }
  try {
    const bytes = await fs.readFile(candidatePath)
    if (bytes.byteLength > maxBytes) {
      throw new Error(
        `Manifest exceeds the ${maxBytes}-byte limit: ${candidatePath}`,
      )
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<ManifestEnvelope>
    if (
      parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
      typeof parsed.checksum !== "string" ||
      !parsed.payload ||
      parsed.payload.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
      parsed.payload.workspaceId !== expectedWorkspaceId ||
      !Array.isArray(parsed.payload.records)
    ) {
      return {
        kind: "corrupt",
        message: `Manifest envelope is invalid: ${candidatePath}`,
      }
    }
    if (manifestChecksum(parsed.payload) !== parsed.checksum) {
      return {
        kind: "corrupt",
        message: `Manifest checksum mismatch: ${candidatePath}`,
      }
    }
    const ids = new Set<string>()
    for (const record of parsed.payload.records) {
      validateRecord(record, expectedWorkspaceId)
      if (ids.has(record.id)) {
        throw new Error(`Duplicate change-set id in manifest: ${record.id}`)
      }
      ids.add(record.id)
    }
    return {
      kind: "valid",
      payload: parsed.payload,
    }
  } catch (error) {
    return {
      kind: "corrupt",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export class ChangeSetStorageCorruptionError extends Error {
  readonly diagnostics: readonly string[]

  constructor(manifestPath: string, diagnostics: readonly string[]) {
    super(
      `Change-set storage is corrupt at ${manifestPath}: ${diagnostics.join("; ")}`,
    )
    this.name = "ChangeSetStorageCorruptionError"
    this.diagnostics = diagnostics
  }
}

export class ChangeSetStoreConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChangeSetStoreConflictError"
  }
}

export interface FileChangeSetStoreOptions {
  rootDir: string
  maxRecords?: number
  maxManifestBytes?: number
  maxBlobBytes?: number
}

export interface ChangeSetBlobPruneResult {
  readonly deleted: readonly string[]
  readonly retained: number
  readonly errors: readonly string[]
}

export class FileChangeSetStore implements ChangeSetStore {
  readonly #workspaceId: string
  readonly #rootDir: string
  readonly #workspaceDirectory: string
  readonly #blobDirectory: string
  readonly #journalDirectory: string
  readonly #maxRecords: number
  readonly #maxManifestBytes: number
  readonly #maxBlobBytes: number
  readonly manifestPath: string

  constructor(
    workspaceId: string,
    options: FileChangeSetStoreOptions,
  ) {
    if (!workspaceId || workspaceId.includes("\0")) {
      throw new Error("Change-set workspace id must be non-empty and NUL-free")
    }
    if (!options.rootDir) {
      throw new Error("Change-set storage root cannot be empty")
    }
    const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
    if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) {
      throw new RangeError("Change-set record limit must be a positive safe integer")
    }
    const maxManifestBytes =
      options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES
    const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES
    for (const [label, value] of [
      ["manifest", maxManifestBytes],
      ["blob", maxBlobBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(
          `Change-set ${label} byte limit must be a positive safe integer`,
        )
      }
    }
    this.#workspaceId = workspaceId
    this.#rootDir = path.resolve(options.rootDir)
    this.#workspaceDirectory = path.join(
      this.#rootDir,
      "changes",
      workspaceDirectoryName(workspaceId),
    )
    this.#blobDirectory = path.join(this.#workspaceDirectory, "blobs", "sha256")
    this.#journalDirectory = path.join(this.#workspaceDirectory, "journals")
    this.#maxRecords = maxRecords
    this.#maxManifestBytes = maxManifestBytes
    this.#maxBlobBytes = maxBlobBytes
    this.manifestPath = path.join(this.#workspaceDirectory, "manifest.v1.json")
  }

  blobPath(hash: string): string {
    if (!SHA256_PATTERN.test(hash)) {
      throw new Error("Blob id must be a lowercase SHA-256 hash")
    }
    return path.join(this.#blobDirectory, hash.slice(0, 2), hash)
  }

  async putBlob(hash: string, content: Uint8Array): Promise<void> {
    if (!SHA256_PATTERN.test(hash)) {
      throw new Error("Blob id must be a lowercase SHA-256 hash")
    }
    const bytes = Buffer.from(content)
    if (bytes.byteLength > this.#maxBlobBytes) {
      throw new RangeError(
        `Change-set blob exceeds the ${this.#maxBlobBytes}-byte limit`,
      )
    }
    if (hashFileContent(bytes).hash !== hash) {
      throw new Error("Blob content does not match its content hash")
    }
    const blobPath = this.blobPath(hash)
    await ensureSafeDirectoryChain(this.#rootDir, path.dirname(blobPath))
    try {
      const info = await fs.lstat(blobPath)
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Blob is symbolic or not a regular file: ${blobPath}`)
      }
      if (info.size > this.#maxBlobBytes) {
        throw new ChangeSetStorageCorruptionError(blobPath, [
          `Content-addressed blob exceeds the ${this.#maxBlobBytes}-byte limit`,
        ])
      }
      const existing = await fs.readFile(blobPath)
      if (existing.byteLength > this.#maxBlobBytes) {
        throw new ChangeSetStorageCorruptionError(blobPath, [
          `Content-addressed blob exceeds the ${this.#maxBlobBytes}-byte limit`,
        ])
      }
      if (
        existing.byteLength !== bytes.byteLength ||
        hashFileContent(existing).hash !== hash
      ) {
        throw new ChangeSetStorageCorruptionError(blobPath, [
          "Existing content-addressed blob does not match its path",
        ])
      }
      return
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error
      }
    }
    await atomicWriteFile(blobPath, bytes, { mode: 0o600 })
  }

  async getBlob(hash: string): Promise<Buffer> {
    const blobPath = this.blobPath(hash)
    let info
    try {
      info = await fs.lstat(blobPath)
    } catch (error) {
      throw error
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Blob is symbolic or not a regular file: ${blobPath}`)
    }
    if (info.size > this.#maxBlobBytes) {
      throw new ChangeSetStorageCorruptionError(blobPath, [
        `Content-addressed blob exceeds the ${this.#maxBlobBytes}-byte limit`,
      ])
    }
    const content = await fs.readFile(blobPath)
    if (content.byteLength > this.#maxBlobBytes) {
      throw new ChangeSetStorageCorruptionError(blobPath, [
        `Content-addressed blob exceeds the ${this.#maxBlobBytes}-byte limit`,
      ])
    }
    if (hashFileContent(content).hash !== hash) {
      throw new ChangeSetStorageCorruptionError(blobPath, [
        "Content-addressed blob checksum mismatch",
      ])
    }
    return content
  }

  async insert(record: ChangeSetRecord): Promise<void> {
    validateRecord(record, this.#workspaceId)
    if (record.revision !== 0) {
      throw new Error("A newly inserted change set must start at revision 0")
    }
    await this.#mutate(async (payload) => {
      if (payload.records.some((item) => item.id === record.id)) {
        throw new ChangeSetStoreConflictError(
          `Change set already exists: ${record.id}`,
        )
      }
      const identityOwner = payload.records.find((item) =>
        sameChangeIdentity(item.identity, record.identity),
      )
      if (identityOwner) {
        throw new ChangeSetStoreConflictError(
          `Change identity already belongs to ${identityOwner.id}`,
        )
      }
      if (payload.records.length >= this.#maxRecords) {
        throw new Error(
          `Change-set record limit ${this.#maxRecords} has been reached`,
        )
      }
      payload.records.push(cloneRecord(record))
      payload.records.sort((left, right) => left.id.localeCompare(right.id))
      await this.#appendJournal(record)
    })
  }

  async get(id: string): Promise<ChangeSetRecord | undefined> {
    validateChangeSetId(id)
    const payload = await this.#readLocked()
    const record = payload.records.find((item) => item.id === id)
    return record ? cloneRecord(record) : undefined
  }

  async list(
    query: ChangeSetListQuery,
  ): Promise<readonly ChangeSetRecord[]> {
    if (query.workspaceId !== this.#workspaceId) {
      throw new Error(
        `Cannot query workspace ${query.workspaceId} through ${this.#workspaceId}`,
      )
    }
    const states = query.states ? new Set(query.states) : undefined
    const payload = await this.#readLocked()
    return payload.records
      .filter(
        (record) =>
          (!query.sessionId || record.identity.sessionId === query.sessionId) &&
          (!query.turnId || record.identity.turnId === query.turnId) &&
          (!states || states.has(record.state)),
      )
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id),
      )
      .map(cloneRecord)
  }

  async replace(
    record: ChangeSetRecord,
    expectedRevision: number,
  ): Promise<void> {
    validateRecord(record, this.#workspaceId)
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      record.revision !== expectedRevision + 1
    ) {
      throw new Error(
        "Replacement revision must be exactly expectedRevision + 1",
      )
    }
    await this.#mutate(async (payload) => {
      const index = payload.records.findIndex((item) => item.id === record.id)
      if (index < 0) {
        throw new ChangeSetStoreConflictError(
          `Change set does not exist: ${record.id}`,
        )
      }
      const current = payload.records[index]!
      if (current.revision !== expectedRevision) {
        throw new ChangeSetStoreConflictError(
          `Change set ${record.id} revision changed from ${expectedRevision} to ${current.revision}`,
        )
      }
      assertImmutableRecordFields(current, record)
      payload.records[index] = cloneRecord(record)
      await this.#appendJournal(record)
    })
  }

  async pruneOrphanBlobs(
    olderThanMs = 24 * 60 * 60 * 1_000,
  ): Promise<ChangeSetBlobPruneResult> {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) {
      throw new RangeError("Blob prune grace period must be a non-negative safe integer")
    }
    const payload = await this.#readLocked()
    const referenced = new Set<string>()
    for (const record of payload.records) {
      for (const file of record.files) {
        if (file.before.exists) referenced.add(file.before.blob)
        if (file.applyBase.exists) referenced.add(file.applyBase.blob)
        if (file.targetBase?.exists) referenced.add(file.targetBase.blob)
        if (file.after.exists) referenced.add(file.after.blob)
      }
    }
    const deleted: string[] = []
    const errors: string[] = []
    let retained = 0
    const cutoff = Date.now() - olderThanMs
    let prefixes: string[] = []
    try {
      prefixes = await fs.readdir(this.#blobDirectory)
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { deleted, retained, errors }
      }
      throw error
    }
    for (const prefix of prefixes) {
      const prefixPath = path.join(this.#blobDirectory, prefix)
      let prefixInfo
      try {
        prefixInfo = await fs.lstat(prefixPath)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        continue
      }
      if (prefixInfo.isSymbolicLink() || !prefixInfo.isDirectory()) {
        errors.push(`Unsafe blob prefix skipped: ${prefixPath}`)
        continue
      }
      const names = await fs.readdir(prefixPath)
      for (const name of names) {
        const blobPath = path.join(prefixPath, name)
        if (
          !SHA256_PATTERN.test(name) ||
          name.slice(0, 2) !== prefix ||
          referenced.has(name)
        ) {
          retained += 1
          continue
        }
        try {
          const info = await fs.lstat(blobPath)
          if (
            info.isSymbolicLink() ||
            !info.isFile() ||
            info.mtimeMs > cutoff
          ) {
            retained += 1
            continue
          }
          await fs.unlink(blobPath)
          deleted.push(name)
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }
    }
    deleted.sort()
    return { deleted, retained, errors }
  }

  async #ensureStorage(): Promise<void> {
    await ensureSafeDirectoryChain(
      this.#rootDir,
      this.#workspaceDirectory,
    )
  }

  async #readLocked(): Promise<ManifestPayload> {
    await this.#ensureStorage()
    return withFileLock(this.manifestPath, () => this.#readManifest())
  }

  async #mutate(
    operation: (payload: ManifestPayload) => Promise<void>,
  ): Promise<void> {
    await this.#ensureStorage()
    await withFileLock(this.manifestPath, async () => {
      const payload = await this.#readManifest()
      await operation(payload)
      await this.#writeManifest(payload)
    })
  }

  async #readManifest(): Promise<ManifestPayload> {
    const [primary, backup] = await Promise.all([
      readManifestCandidate(
        this.manifestPath,
        this.#workspaceId,
        this.#maxManifestBytes,
      ),
      readManifestCandidate(
        `${this.manifestPath}.bak`,
        this.#workspaceId,
        this.#maxManifestBytes,
      ),
    ])
    if (primary.kind === "corrupt" && primary.fatal) {
      throw new ChangeSetStorageCorruptionError(
        this.manifestPath,
        [primary.message],
      )
    }
    if (primary.kind === "valid") return structuredClone(primary.payload)
    if (backup.kind === "valid") return structuredClone(backup.payload)
    if (primary.kind === "missing" && backup.kind === "missing") {
      return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        workspaceId: this.#workspaceId,
        records: [],
      }
    }
    const diagnostics = [primary, backup]
      .filter(
        (candidate): candidate is Extract<ManifestCandidate, { kind: "corrupt" }> =>
          candidate.kind === "corrupt",
      )
      .map((candidate) => candidate.message)
    throw new ChangeSetStorageCorruptionError(
      this.manifestPath,
      diagnostics,
    )
  }

  async #writeManifest(payload: ManifestPayload): Promise<void> {
    payload.records.sort((left, right) => left.id.localeCompare(right.id))
    const envelope: ManifestEnvelope = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      checksum: manifestChecksum(payload),
      payload,
    }
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`
    if (Buffer.byteLength(serialized, "utf8") > this.#maxManifestBytes) {
      throw new RangeError(
        `Change-set manifest exceeds the ${this.#maxManifestBytes}-byte limit`,
      )
    }
    await atomicWriteFile(
      this.manifestPath,
      serialized,
      { mode: 0o600, backup: true },
    )
  }

  async #appendJournal(record: ChangeSetRecord): Promise<void> {
    validateChangeSetId(record.id)
    await ensureSafeDirectoryChain(
      this.#rootDir,
      this.#journalDirectory,
    )
    const journalPath = path.join(
      this.#journalDirectory,
      `${record.id}.jsonl`,
    )
    try {
      const info = await fs.lstat(journalPath)
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(
          `Change-set journal is symbolic or not a regular file: ${journalPath}`,
        )
      }
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error
      }
    }
    const noFollow = fsConstants.O_NOFOLLOW ?? 0
    const handle = await fs.open(
      journalPath,
      fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        fsConstants.O_WRONLY |
        noFollow,
      0o600,
    )
    try {
      await handle.writeFile(`${JSON.stringify({
        schemaVersion: 1,
        id: record.id,
        revision: record.revision,
        state: record.state,
        proposalHash: record.proposalHash,
        approvedHash: record.approvedHash ?? null,
        updatedAt: record.updatedAt,
      })}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}
