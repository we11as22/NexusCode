import {
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

function parametersForSqlite(
  parameters: readonly StateInputValue[],
): SQLInputValue[] {
  return [...parameters] as SQLInputValue[]
}

function rowForState<T extends Record<string, StateOutputValue>>(
  row: Record<string, SQLOutputValue>,
): T {
  return row as T
}

export class SqliteStateConnection implements StateConnection {
  readonly #database: DatabaseSync

  constructor(path: string) {
    this.#database = new DatabaseSync(path, {
      allowExtension: false,
      timeout: 5_000,
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
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
    `)
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
}
