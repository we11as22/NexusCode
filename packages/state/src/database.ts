import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { applyStateMigrations } from "./migrations.js"
import type {
  IntegrityCheckResult,
  NexusStateDatabaseOptions,
  StateConnection,
  StateOutputValue,
} from "./schema.js"
import { SqliteStateConnection } from "./sqlite-driver.js"

function prepareDatabasePath(path: string): void {
  if (path === ":memory:") return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
}

export class NexusStateDatabase {
  readonly #connection: SqliteStateConnection
  readonly processId: string
  #closed = false
  #transactionActive = false

  private constructor(
    connection: SqliteStateConnection,
    processId: string,
  ) {
    this.#connection = connection
    this.processId = processId
  }

  static open(options: NexusStateDatabaseOptions): NexusStateDatabase {
    prepareDatabasePath(options.path)
    const connection = new SqliteStateConnection(options.path)
    try {
      connection.configure()
      applyStateMigrations(connection, options.now ?? Date.now)
      if (options.path !== ":memory:" && process.platform !== "win32") {
        chmodSync(options.path, 0o600)
      }
      return new NexusStateDatabase(
        connection,
        options.processId ?? `${process.pid}`,
      )
    } catch (error) {
      connection.close()
      throw error
    }
  }

  read<T>(callback: (connection: StateConnection) => T): T {
    this.#assertOpen()
    return callback(this.#connection)
  }

  transaction<T>(callback: (connection: StateConnection) => T): T {
    this.#assertOpen()
    if (this.#transactionActive || this.#connection.isTransaction) {
      throw new Error("Nested Nexus state transactions are not supported")
    }

    this.#transactionActive = true
    this.#connection.exec("BEGIN IMMEDIATE")
    try {
      const result = callback(this.#connection)
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

      return messages.length === 0 ? { ok: true } : { ok: false, messages }
    })
  }

  close(): void {
    if (this.#closed) return
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
