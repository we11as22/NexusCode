import {
  constants,
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from "node:sqlite"
import type {
  StateConnection,
  StateInputValue,
  StateOutputValue,
  StateRunResult,
} from "./schema.js"

const PRAGMA_NAME = /^[a-z_][a-z0-9_]*$/i

const SAFE_READ_PRAGMAS = new Set([
  "application_id",
  "busy_timeout",
  "database_list",
  "foreign_key_check",
  "foreign_keys",
  "ignore_check_constraints",
  "integrity_check",
  "journal_mode",
  "query_only",
  "quick_check",
  "schema_version",
  "synchronous",
  "trusted_schema",
  "user_version",
  "wal_autocheckpoint",
])

const READ_ONLY_DENIED_ACTIONS = new Set([
  constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_CREATE_TABLE,
  constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_CREATE_TEMP_VIEW,
  constants.SQLITE_CREATE_TRIGGER,
  constants.SQLITE_CREATE_VIEW,
  constants.SQLITE_DELETE,
  constants.SQLITE_DROP_INDEX,
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_DROP_TEMP_VIEW,
  constants.SQLITE_DROP_TRIGGER,
  constants.SQLITE_DROP_VIEW,
  constants.SQLITE_INSERT,
  constants.SQLITE_TRANSACTION,
  constants.SQLITE_UPDATE,
  constants.SQLITE_ATTACH,
  constants.SQLITE_DETACH,
  constants.SQLITE_ALTER_TABLE,
  constants.SQLITE_REINDEX,
  constants.SQLITE_ANALYZE,
  constants.SQLITE_CREATE_VTABLE,
  constants.SQLITE_DROP_VTABLE,
  constants.SQLITE_SAVEPOINT,
])

const TRANSACTION_SCOPE_DENIED_ACTIONS = new Set([
  constants.SQLITE_TRANSACTION,
  constants.SQLITE_SAVEPOINT,
  constants.SQLITE_ATTACH,
  constants.SQLITE_DETACH,
  constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_CREATE_TEMP_VIEW,
  constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_DROP_TEMP_VIEW,
])

type PublicAccessMode = "read" | "transaction"

function authorizePublicSql(
  mode: PublicAccessMode,
  actionCode: number,
  arg1: string | null,
  arg2: string | null,
): number {
  if (
    (mode === "read" && READ_ONLY_DENIED_ACTIONS.has(actionCode)) ||
    (mode === "transaction" &&
      TRANSACTION_SCOPE_DENIED_ACTIONS.has(actionCode))
  ) {
    return constants.SQLITE_DENY
  }
  if (actionCode === constants.SQLITE_PRAGMA) {
    const pragma = arg1?.toLowerCase()
    if (
      arg2 !== null ||
      pragma === undefined ||
      !SAFE_READ_PRAGMAS.has(pragma)
    ) {
      return constants.SQLITE_DENY
    }
  }
  return constants.SQLITE_OK
}

function parametersForSqlite(
  parameters: readonly StateInputValue[],
): SQLInputValue[] {
  return parameters.map((parameter) => {
    if (typeof parameter === "number") {
      if (!Number.isFinite(parameter)) {
        throw new TypeError("SQLite numeric parameters must be finite")
      }
      if (Number.isInteger(parameter) && !Number.isSafeInteger(parameter)) {
        throw new RangeError(
          "SQLite integer parameters must be safe integers",
        )
      }
      return parameter
    }
    if (typeof parameter === "bigint") {
      if (
        parameter < BigInt(Number.MIN_SAFE_INTEGER) ||
        parameter > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new RangeError(
          "SQLite bigint parameters must fit in the safe integer range",
        )
      }
      return Number(parameter)
    }
    return parameter
  }) as SQLInputValue[]
}

function rowForState<T extends Record<string, StateOutputValue>>(
  row: Record<string, SQLOutputValue>,
): T {
  return row as T
}

export class SqliteStateConnection implements StateConnection {
  readonly #database: DatabaseSync
  readonly #busyTimeoutMs: number

  constructor(path: string, busyTimeoutMs: number) {
    this.#busyTimeoutMs = busyTimeoutMs
    this.#database = new DatabaseSync(path, {
      allowExtension: false,
      timeout: busyTimeoutMs,
      defensive: true,
      readBigInts: false,
      returnArrays: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
    })
  }

  configure(): void {
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = ${this.#busyTimeoutMs};
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA ignore_check_constraints = OFF;
      PRAGMA query_only = OFF;
    `)
  }

  withReadOnlyAccess<T>(callback: () => T): T {
    this.#database.exec("PRAGMA query_only = ON")
    try {
      return this.#withPublicAuthorizer("read", callback)
    } finally {
      this.#database.exec("PRAGMA query_only = OFF")
    }
  }

  withTransactionAccess<T>(callback: () => T): T {
    return this.#withPublicAuthorizer("transaction", callback)
  }

  assertPublicBaseline(): void {
    const expectedPragmas = [
      ["foreign_keys", 1],
      ["trusted_schema", 0],
      ["ignore_check_constraints", 0],
      ["query_only", 0],
    ] as const
    for (const [name, expected] of expectedPragmas) {
      const value = this.pragma(name)
      if (value !== expected) {
        throw new Error(
          `Unsafe SQLite connection baseline: ${name} expected ${expected}, found ${String(value)}`,
        )
      }
    }

    const databases = this.all<{ seq: number; name: string; file: string }>(
      "PRAGMA database_list",
    )
    const databaseNames = databases.map((database) => database.name)
    if (
      databaseNames.filter((name) => name === "main").length !== 1 ||
      databaseNames.some((name) => name !== "main" && name !== "temp")
    ) {
      throw new Error(
        `Unsafe SQLite connection baseline: unexpected databases ${databaseNames.join(", ")}`,
      )
    }
  }

  exec(sql: string): void {
    this.#database.exec(sql)
  }

  run(
    sql: string,
    parameters: readonly StateInputValue[] = [],
  ): StateRunResult {
    return this.#database
      .prepare(sql)
      .run(...parametersForSqlite(parameters))
  }

  get<T extends Record<string, StateOutputValue>>(
    sql: string,
    parameters: readonly StateInputValue[] = [],
  ): T | undefined {
    const row = this.#database
      .prepare(sql)
      .get(...parametersForSqlite(parameters))
    return row ? rowForState<T>(row) : undefined
  }

  all<T extends Record<string, StateOutputValue>>(
    sql: string,
    parameters: readonly StateInputValue[] = [],
  ): T[] {
    return this.#database
      .prepare(sql)
      .all(...parametersForSqlite(parameters))
      .map((row) => rowForState<T>(row))
  }

  pragma(name: string): StateOutputValue {
    if (!PRAGMA_NAME.test(name)) {
      throw new Error(`Invalid SQLite pragma name: ${name}`)
    }
    const row = this.get<Record<string, StateOutputValue>>(`PRAGMA ${name}`)
    const value = row ? Object.values(row)[0] : undefined
    if (value === undefined) {
      throw new Error(`SQLite pragma returned no value: ${name}`)
    }
    return value
  }

  userVersion(): number {
    const value = this.pragma("user_version")
    if (typeof value !== "number") {
      throw new Error(`Invalid SQLite user_version value: ${String(value)}`)
    }
    return value
  }

  get isTransaction(): boolean {
    return this.#database.isTransaction
  }

  close(): void {
    this.#database.close()
  }

  #withPublicAuthorizer<T>(
    mode: PublicAccessMode,
    callback: () => T,
  ): T {
    this.#database.setAuthorizer((actionCode, arg1, arg2) =>
      authorizePublicSql(mode, actionCode, arg1, arg2),
    )
    try {
      return callback()
    } finally {
      this.#database.setAuthorizer(null)
    }
  }
}
