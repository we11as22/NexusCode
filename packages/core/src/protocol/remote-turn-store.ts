import { constants, promises as fs } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"

import {
  IdentifierSchema,
  MAX_IMAGES_PER_INPUT,
  MAX_USER_INPUT_TEXT_CHARS,
  ModeSchema,
  ModelSelectionSchema,
  NonnegativeSafeIntegerSchema,
  UserInputPartSchema,
} from "./commands.js"
import {
  atomicWriteFile,
  withFileLock,
} from "../storage/durable-fs.js"

const STORE_VERSION = 1 as const
const MAX_RECORD_BYTES = 48 * 1024 * 1024

export const PreparedSessionTurnIdentitySchema = z
  .object({
    commandId: IdentifierSchema,
    inputId: IdentifierSchema,
    afterSequence: NonnegativeSafeIntegerSchema,
  })
  .strict()

export const RemotePreparedTurnRecordSchema = z
  .object({
    version: z.literal(STORE_VERSION),
    phase: z.literal("prepared"),
    commandId: IdentifierSchema,
    inputId: IdentifierSchema,
    afterSequence: NonnegativeSafeIntegerSchema,
    input: z.array(UserInputPartSchema).min(1).max(64),
    mode: ModeSchema,
    selection: ModelSelectionSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    let textCharacters = 0
    let images = 0
    for (const part of record.input) {
      if (part.type === "text") textCharacters += part.text.length
      if (part.type === "image") images++
    }
    if (textCharacters > MAX_USER_INPUT_TEXT_CHARS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input"],
        message: "Aggregate prepared input text exceeds the protocol limit",
      })
    }
    if (images > MAX_IMAGES_PER_INPUT) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input"],
        message: "Prepared input contains too many images",
      })
    }
  })

const RemoteAdmittedTurnRecordSchema = z
  .object({
    version: z.literal(STORE_VERSION),
    phase: z.literal("admitted"),
    turnId: IdentifierSchema,
    runId: IdentifierSchema,
    afterSequence: NonnegativeSafeIntegerSchema,
  })
  .strict()

const LegacyRemoteCursorSchema = z
  .object({
    turnId: IdentifierSchema,
    runId: IdentifierSchema,
    afterSequence: NonnegativeSafeIntegerSchema,
  })
  .strict()

export type PreparedSessionTurnIdentity = z.infer<
  typeof PreparedSessionTurnIdentitySchema
>
export type RemotePreparedTurnRecord = z.infer<
  typeof RemotePreparedTurnRecordSchema
>
export type RemoteTurnCursorRecord = Pick<
  z.infer<typeof RemoteAdmittedTurnRecordSchema>,
  "turnId" | "runId" | "afterSequence"
>

export interface RemoteTurnRecoveryStore {
  load(sessionId: string): Promise<RemoteTurnCursorRecord | undefined>
  loadPrepared(
    sessionId: string,
  ): Promise<RemotePreparedTurnRecord | undefined>
  save(sessionId: string, record: RemoteTurnCursorRecord): Promise<void>
  savePrepared(
    sessionId: string,
    record: RemotePreparedTurnRecord,
  ): Promise<void>
  clear(sessionId: string): Promise<void>
}

type StoredRemoteTurnRecord =
  | RemotePreparedTurnRecord
  | z.infer<typeof RemoteAdmittedTurnRecordSchema>

function parseStoredRecord(value: unknown): StoredRemoteTurnRecord {
  const prepared = RemotePreparedTurnRecordSchema.safeParse(value)
  if (prepared.success) return prepared.data
  const admitted = RemoteAdmittedTurnRecordSchema.safeParse(value)
  if (admitted.success) return admitted.data
  const legacy = LegacyRemoteCursorSchema.safeParse(value)
  if (legacy.success) {
    return {
      version: STORE_VERSION,
      phase: "admitted",
      ...legacy.data,
    }
  }
  throw new Error("Remote turn recovery record is invalid")
}

export interface FileRemoteTurnRecoveryStoreOptions {
  readonly rootDir: string
  /** Already-canonical server/workspace authority namespace. */
  readonly namespace: string
}

/**
 * One-file state machine for the client half of protocol-v2 admission.
 *
 * `prepared` is fsynced before POST. Replacing it with `admitted` is one
 * atomic rename, so a crash can leave only an idempotently replayable command
 * or an exact turn cursor, never a gap between them.
 */
export class FileRemoteTurnRecoveryStore
  implements RemoteTurnRecoveryStore
{
  readonly #directory: string
  readonly #namespace: string
  readonly #queues = new Map<string, Promise<void>>()

  constructor(options: FileRemoteTurnRecoveryStoreOptions) {
    if (!options.namespace || options.namespace.includes("\0")) {
      throw new TypeError("Remote turn namespace is invalid")
    }
    this.#directory = path.join(
      path.resolve(options.rootDir),
      "remote-turn-recovery",
    )
    this.#namespace = options.namespace
  }

  async load(
    sessionId: string,
  ): Promise<RemoteTurnCursorRecord | undefined> {
    const record = await this.#read(sessionId)
    if (!record || record.phase !== "admitted") return undefined
    return {
      turnId: record.turnId,
      runId: record.runId,
      afterSequence: record.afterSequence,
    }
  }

  async loadPrepared(
    sessionId: string,
  ): Promise<RemotePreparedTurnRecord | undefined> {
    const record = await this.#read(sessionId)
    return record?.phase === "prepared" ? record : undefined
  }

  async save(
    sessionId: string,
    record: RemoteTurnCursorRecord,
  ): Promise<void> {
    const parsed = RemoteAdmittedTurnRecordSchema.parse({
      version: STORE_VERSION,
      phase: "admitted",
      ...record,
    })
    await this.#write(sessionId, parsed)
  }

  async savePrepared(
    sessionId: string,
    record: RemotePreparedTurnRecord,
  ): Promise<void> {
    await this.#write(
      sessionId,
      RemotePreparedTurnRecordSchema.parse(record),
    )
  }

  clear(sessionId: string): Promise<void> {
    return this.#serialized(sessionId, async () => {
      await this.#ensureDirectory()
      const filePath = this.#entryPath(sessionId)
      await withFileLock(filePath, async () => {
        await fs.unlink(filePath).catch((error: unknown) => {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            (error as { code?: string }).code !== "ENOENT"
          ) {
            throw error
          }
        })
      })
    })
  }

  #read(
    sessionId: string,
  ): Promise<StoredRemoteTurnRecord | undefined> {
    return this.#serialized(sessionId, async () => {
      return this.#readPath(this.#entryPath(sessionId))
    })
  }

  #write(
    sessionId: string,
    record: StoredRemoteTurnRecord,
  ): Promise<void> {
    const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8")
    if (payload.byteLength > MAX_RECORD_BYTES) {
      throw new Error("Remote turn recovery entry exceeds its size limit")
    }
    return this.#serialized(sessionId, async () => {
      await this.#ensureDirectory()
      const filePath = this.#entryPath(sessionId)
      await withFileLock(filePath, async () => {
        const current = await this.#readPath(filePath)
        if (current?.phase === "admitted" && record.phase === "prepared") {
          throw new Error(
            "Cannot replace an admitted remote turn with a new prepared command",
          )
        }
        if (current?.phase === "prepared" && record.phase === "prepared") {
          if (JSON.stringify(current) !== JSON.stringify(record)) {
            throw new Error(
              "Another prepared remote command already owns this session",
            )
          }
          return
        }
        if (
          current?.phase === "prepared" &&
          record.phase === "admitted" &&
          record.afterSequence < current.afterSequence
        ) {
          throw new Error(
            "Admitted remote turn cursor cannot precede its prepared replay boundary",
          )
        }
        if (current?.phase === "admitted" && record.phase === "admitted") {
          if (
            current.turnId !== record.turnId ||
            current.runId !== record.runId
          ) {
            throw new Error(
              "Another admitted remote turn already owns this session",
            )
          }
          if (record.afterSequence < current.afterSequence) {
            throw new Error("Remote turn cursor cannot move backwards")
          }
          if (record.afterSequence === current.afterSequence) return
        }
        await atomicWriteFile(filePath, payload, { mode: 0o600 })
      })
    })
  }

  async #readPath(
    filePath: string,
  ): Promise<StoredRemoteTurnRecord | undefined> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(
        filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return undefined
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ELOOP"
      ) {
        throw new Error("Remote turn recovery entry must not be a symlink")
      }
      throw error
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) {
        throw new Error("Remote turn recovery entry is not a regular file")
      }
      if (stat.size > MAX_RECORD_BYTES) {
        throw new Error("Remote turn recovery entry exceeds its size limit")
      }
      const raw = await handle.readFile({ encoding: "utf8" })
      return parseStoredRecord(JSON.parse(raw))
    } finally {
      await handle.close()
    }
  }

  async #ensureDirectory(): Promise<void> {
    await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(this.#directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Remote turn recovery directory must not be a symlink")
    }
    await fs.chmod(this.#directory, 0o700)
  }

  #entryPath(sessionId: string): string {
    IdentifierSchema.parse(sessionId)
    const digest = createHash("sha256")
      .update(this.#namespace)
      .update("\0")
      .update(sessionId)
      .digest("hex")
    return path.join(this.#directory, `${digest}.json`)
  }

  async #serialized<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.catch(() => undefined).then(() => next)
    this.#queues.set(sessionId, queued)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.#queues.get(sessionId) === queued) {
        this.#queues.delete(sessionId)
      }
    }
  }
}
