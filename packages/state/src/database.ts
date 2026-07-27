import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants as fileConstants,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs"
import { dirname } from "node:path"
import { isPromise } from "node:util/types"
import {
  applyStateMigrations,
  REQUIRED_RUNTIME_TRIGGER_DEFINITIONS,
  REQUIRED_RUNTIME_TRIGGERS,
} from "./migrations.js"
import type {
  IntegrityCheckResult,
  NexusStateDatabaseOptions,
  StateConnection,
  StateInputValue,
  StateOutputValue,
  StateReadConnection,
  StateRunResult,
} from "./schema.js"
import { SqliteStateConnection } from "./sqlite-driver.js"

const TRANSACTION_CONTROL_KEYWORDS = new Set([
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
])

function skipQuotedSql(sql: string, start: number, quote: string): number {
  const closingQuote = quote === "[" ? "]" : quote
  let index = start + 1
  while (index < sql.length) {
    if (sql[index] !== closingQuote) {
      index += 1
      continue
    }
    if (closingQuote !== "]" && sql[index + 1] === closingQuote) {
      index += 2
      continue
    }
    return index + 1
  }
  return sql.length
}

function assertNoTransactionControl(sql: string): void {
  let index = 0
  let atStatementStart = true

  while (index < sql.length) {
    const character = sql[index]!
    if (/\s/u.test(character)) {
      index += 1
      continue
    }
    if (character === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (character === "/" && sql[index + 1] === "*") {
      const commentEnd = sql.indexOf("*/", index + 2)
      index = commentEnd === -1 ? sql.length : commentEnd + 2
      continue
    }
    if (
      character === "'" ||
      character === '"' ||
      character === "`" ||
      character === "["
    ) {
      if (atStatementStart) atStatementStart = false
      index = skipQuotedSql(sql, index, character)
      continue
    }
    if (character === ";") {
      atStatementStart = true
      index += 1
      continue
    }
    if (/[a-z_]/iu.test(character)) {
      let end = index + 1
      while (end < sql.length && /[a-z0-9_$]/iu.test(sql[end]!)) {
        end += 1
      }
      if (atStatementStart) {
        const keyword = sql.slice(index, end).toUpperCase()
        if (TRANSACTION_CONTROL_KEYWORDS.has(keyword)) {
          throw new Error(
            `Transaction control SQL is not allowed inside a Nexus state transaction: ${keyword}`,
          )
        }
        atStatementStart = false
      }
      index = end
      continue
    }

    if (atStatementStart) atStatementStart = false
    index += 1
  }
}

class ConnectionScope {
  #active = true

  constructor(readonly label: "read" | "transaction") {}

  assertActive(): void {
    if (!this.#active) {
      throw new Error(`Nexus state ${this.label} scope is no longer active`)
    }
  }

  invalidate(): void {
    this.#active = false
  }
}

class ScopedReadConnection implements StateReadConnection {
  readonly #connection: StateReadConnection
  readonly #scope: ConnectionScope

  constructor(connection: StateReadConnection, scope: ConnectionScope) {
    this.#connection = connection
    this.#scope = scope
  }

  get<T extends Record<string, StateOutputValue>>(
    sql: string,
    parameters: readonly StateInputValue[] = [],
  ): T | undefined {
    this.#scope.assertActive()
    return this.#connection.get<T>(sql, parameters)
  }

  all<T extends Record<string, StateOutputValue>>(
    sql: string,
    parameters: readonly StateInputValue[] = [],
  ): T[] {
    this.#scope.assertActive()
    return this.#connection.all<T>(sql, parameters)
  }

  pragma(name: string): StateOutputValue {
    this.#scope.assertActive()
    return this.#connection.pragma(name)
  }

  userVersion(): number {
    this.#scope.assertActive()
    return this.#connection.userVersion()
  }
}

class ScopedTransactionConnection implements StateConnection {
  readonly #connection: StateConnection
  readonly #scope: ConnectionScope

  constructor(connection: StateConnection, scope: ConnectionScope) {
    this.#connection = connection
    this.#scope = scope
  }

  exec(sql: string): void {
    this.#scope.assertActive()
    assertNoTransactionControl(sql)
    this.#connection.exec(sql)
  }

  run(
    sql: string,
    parameters: readonly StateInputValue[] = [],
  ): StateRunResult {
    this.#scope.assertActive()
    assertNoTransactionControl(sql)
    return this.#connection.run(sql, parameters)
  }

  get<T extends Record<string, StateOutputValue>>(
    sql: string,
    parameters: readonly StateInputValue[] = [],
  ): T | undefined {
    this.#scope.assertActive()
    assertNoTransactionControl(sql)
    return this.#connection.get<T>(sql, parameters)
  }

  all<T extends Record<string, StateOutputValue>>(
    sql: string,
    parameters: readonly StateInputValue[] = [],
  ): T[] {
    this.#scope.assertActive()
    assertNoTransactionControl(sql)
    return this.#connection.all<T>(sql, parameters)
  }

  pragma(name: string): StateOutputValue {
    this.#scope.assertActive()
    return this.#connection.pragma(name)
  }

  userVersion(): number {
    this.#scope.assertActive()
    return this.#connection.userVersion()
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false
  }
  return typeof (value as { then?: unknown }).then === "function"
}

function assertSynchronousResult(value: unknown, scope: string): void {
  if (!isThenable(value)) return
  if (isPromise(value)) {
    void value.catch(() => undefined)
  }
  throw new TypeError(`Nexus state ${scope} callbacks must be synchronous`)
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .trim()
    .replace(/;\s*$/u, "")
    .replace(/\s+/gu, " ")
    .toLowerCase()
}

type RejectThenableResult<T> = [
  Extract<T, PromiseLike<unknown>>,
] extends [never]
  ? unknown
  : never

function readProcessId(value: string | undefined): string {
  if (value === undefined) return `${process.pid}:${randomUUID()}`
  if (value.trim().length === 0) {
    throw new Error("Nexus state process id must not be empty")
  }
  if (value.length > 256 || value.includes("\0")) {
    throw new Error(
      "Nexus state process id must be at most 256 characters and contain no NUL",
    )
  }
  return value
}

function assertPrivateStateDirectory(directory: string): void {
  const info = lstatSync(directory)
  if (info.isSymbolicLink()) {
    throw new Error(
      `Nexus state directory must not be a symbolic link: ${directory}`,
    )
  }
  if (!info.isDirectory()) {
    throw new Error(`Nexus state directory is not a directory: ${directory}`)
  }
  if (process.platform === "win32") return
  if ((info.mode & 0o777) !== 0o700) {
    throw new Error(
      `Nexus state directory must be private with mode 0700: ${directory}`,
    )
  }
  if (
    typeof process.getuid === "function" &&
    info.uid !== process.getuid()
  ) {
    throw new Error(
      `Nexus state directory must be owned by the current user: ${directory}`,
    )
  }
}

function secureRegularStateFile(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) return
  if (info.isSymbolicLink()) {
    throw new Error(`Nexus state file must not be a symbolic link: ${path}`)
  }
  if (!info.isFile()) {
    throw new Error(`Nexus state path must be a regular file: ${path}`)
  }
  if (process.platform !== "win32") chmodSync(path, 0o600)
}

function prepareDatabasePath(path: string): void {
  if (path === ":memory:") return
  if (path.length === 0 || path.includes("\0")) {
    throw new Error("Nexus state path must be non-empty and contain no NUL")
  }
  const directory = dirname(path)
  const existingDirectory = lstatSync(directory, { throwIfNoEntry: false })
  if (!existingDirectory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") chmodSync(directory, 0o700)
  }
  assertPrivateStateDirectory(directory)
  secureDatabaseFiles(path)
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    try {
      const descriptor = openSync(
        path,
        fileConstants.O_CREAT |
          fileConstants.O_EXCL |
          fileConstants.O_RDWR,
        0o600,
      )
      closeSync(descriptor)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error
      }
      secureRegularStateFile(path)
    }
  }
  secureRegularStateFile(path)
}

function secureDatabaseFiles(path: string): void {
  if (path === ":memory:") return
  secureRegularStateFile(path)
  secureRegularStateFile(`${path}-wal`)
  secureRegularStateFile(`${path}-shm`)
}

function readBusyTimeoutMs(value: number | undefined): number {
  const busyTimeoutMs = value ?? 5_000
  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 2_147_483_647
  ) {
    throw new RangeError(
      "Nexus state busyTimeoutMs must be a safe integer from 0 through 2147483647",
    )
  }
  return busyTimeoutMs
}

export class NexusStateDatabase {
  readonly #connection: SqliteStateConnection
  readonly processId: string
  #closed = false
  #readActive = false
  #transactionActive = false

  private constructor(
    connection: SqliteStateConnection,
    processId: string,
  ) {
    this.#connection = connection
    this.processId = processId
  }

  static open(options: NexusStateDatabaseOptions): NexusStateDatabase {
    const processId = readProcessId(options.processId)
    const busyTimeoutMs = readBusyTimeoutMs(options.busyTimeoutMs)
    prepareDatabasePath(options.path)
    const connection = new SqliteStateConnection(
      options.path,
      busyTimeoutMs,
    )
    try {
      secureDatabaseFiles(options.path)
      connection.configure()
      secureDatabaseFiles(options.path)
      applyStateMigrations(connection, options.now ?? Date.now)
      connection.assertPublicBaseline()
      const database = new NexusStateDatabase(
        connection,
        processId,
      )
      const integrity = database.integrityCheck()
      if (!integrity.ok) {
        throw new Error(
          `Nexus state integrity check failed: ${integrity.messages.join("; ")}`,
        )
      }
      secureDatabaseFiles(options.path)
      return database
    } catch (error) {
      connection.close()
      throw error
    }
  }

  read<T>(
    callback: ((connection: StateReadConnection) => T) &
      RejectThenableResult<T>,
  ): T {
    this.#assertOpen()
    if (this.#readActive) {
      throw new Error("Nested Nexus state read scopes are not supported")
    }
    if (this.#transactionActive || this.#connection.isTransaction) {
      throw new Error(
        "Cannot enter a Nexus state read scope while a transaction is active",
      )
    }

    this.#connection.assertPublicBaseline()
    this.#connection.exec("BEGIN DEFERRED")
    this.#readActive = true
    const scope = new ConnectionScope("read")
    const scopedConnection = new ScopedReadConnection(this.#connection, scope)
    try {
      let result: T
      try {
        result = this.#connection.withReadOnlyAccess(() =>
          callback(scopedConnection),
        )
      } finally {
        scope.invalidate()
      }
      assertSynchronousResult(result, "read")
      this.#connection.assertPublicBaseline()
      this.#connection.exec("COMMIT")
      return result
    } catch (error) {
      try {
        this.#connection.exec("ROLLBACK")
      } catch {
        // Keep the callback/commit error as the primary failure.
      }
      throw error
    } finally {
      scope.invalidate()
      this.#readActive = false
    }
  }

  transaction<T>(
    callback: ((connection: StateConnection) => T) &
      RejectThenableResult<T>,
  ): T {
    this.#assertOpen()
    if (this.#readActive) {
      throw new Error(
        "Cannot enter a Nexus state transaction while a read scope is active",
      )
    }
    if (this.#transactionActive || this.#connection.isTransaction) {
      throw new Error("Nested Nexus state transactions are not supported")
    }

    this.#connection.assertPublicBaseline()
    this.#connection.exec("BEGIN IMMEDIATE")
    this.#transactionActive = true
    const scope = new ConnectionScope("transaction")
    const scopedConnection = new ScopedTransactionConnection(
      this.#connection,
      scope,
    )
    try {
      let result: T
      try {
        result = this.#connection.withTransactionAccess(() =>
          callback(scopedConnection),
        )
      } finally {
        scope.invalidate()
      }
      assertSynchronousResult(result, "transaction")
      this.#connection.assertPublicBaseline()
      this.#connection.exec("COMMIT")
      return result
    } catch (error) {
      try {
        this.#connection.exec("ROLLBACK")
      } catch {
        // Keep the callback/commit error as the primary failure.
      }
      throw error
    } finally {
      this.#transactionActive = false
    }
  }

  integrityCheck(): IntegrityCheckResult {
    return this.read((connection) => {
      const integrityRows = connection.all<Record<string, StateOutputValue>>(
        "PRAGMA integrity_check",
      )
      const messages = integrityRows
        .map((row) => String(Object.values(row)[0]))
        .filter((message) => message.toLowerCase() !== "ok")

      const foreignKeyRows = connection.all<Record<string, StateOutputValue>>(
        "PRAGMA foreign_key_check",
      )
      messages.push(
        ...foreignKeyRows.map(
          (row) => `foreign key violation: ${JSON.stringify(row)}`,
        ),
      )

      const semanticRows = connection.all<{
        approval_id: string
        approval_session_id: string
        run_id: string
        run_session_id: string | null
      }>(
        `SELECT approval.id AS approval_id,
                approval.session_id AS approval_session_id,
                approval.run_id AS run_id,
                run.session_id AS run_session_id
         FROM approval
         LEFT JOIN run ON run.id = approval.run_id
         WHERE approval.run_id IS NOT NULL
           AND (run.id IS NULL OR run.session_id != approval.session_id)`,
      )
      messages.push(
        ...semanticRows.map(
          (row) =>
            `approval session mismatch: ${row.approval_id} belongs to ${row.approval_session_id}, run ${row.run_id} belongs to ${row.run_session_id ?? "missing"}`,
        ),
      )

      const terminalApprovalRows = connection.all<{
        approval_id: string
        run_id: string
        run_status: string
      }>(
        `SELECT approval.id AS approval_id,
                run.id AS run_id,
                run.status AS run_status
         FROM approval
         JOIN run ON run.id = approval.run_id
         WHERE approval.status = 'pending'
           AND run.status != 'running'`,
      )
      messages.push(
        ...terminalApprovalRows.map(
          (row) =>
            `pending approval ${row.approval_id} belongs to non-running run ${row.run_id} (${row.run_status})`,
        ),
      )

      const triggerRows = connection.all<{ name: string; sql: string | null }>(
        `SELECT name, sql
         FROM sqlite_schema
         WHERE type = 'trigger'`,
      )
      const installedTriggers = new Map(
        triggerRows.map((row) => [row.name, row.sql]),
      )
      for (const trigger of REQUIRED_RUNTIME_TRIGGERS) {
        const installedSql = installedTriggers.get(trigger)
        if (installedSql === undefined) {
          messages.push(`missing required state trigger: ${trigger}`)
          continue
        }
        const expectedSql = REQUIRED_RUNTIME_TRIGGER_DEFINITIONS[trigger]
        if (
          installedSql === null ||
          normalizeSchemaSql(installedSql) !== normalizeSchemaSql(expectedSql)
        ) {
          messages.push(`invalid required state trigger: ${trigger}`)
        }
      }

      return messages.length === 0 ? { ok: true } : { ok: false, messages }
    })
  }

  close(): void {
    if (this.#closed) return
    if (this.#readActive) {
      throw new Error("Cannot close Nexus state while a read scope is active")
    }
    if (this.#transactionActive || this.#connection.isTransaction) {
      throw new Error("Cannot close Nexus state while a transaction is active")
    }
    this.#connection.close()
    this.#closed = true
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Nexus state database is closed")
    }
  }
}
