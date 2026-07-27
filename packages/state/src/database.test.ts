import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CURRENT_SCHEMA_VERSION,
  NexusStateDatabase,
} from "./index.js"

const temporaryDirectories: string[] = []

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nexus-state-test-"))
  temporaryDirectories.push(directory)
  return join(directory, "state.sqlite")
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("NexusStateDatabase", () => {
  it("configures a durable SQLite database and applies migrations", () => {
    const database = NexusStateDatabase.open({
      path: temporaryDatabasePath(),
      processId: "database-lifecycle-test",
      now: () => 1_700_000_000_000,
    })

    try {
      expect(database.read((connection) => connection.pragma("journal_mode"))).toBe(
        "wal",
      )
      expect(database.read((connection) => connection.pragma("foreign_keys"))).toBe(
        1,
      )
      expect(database.read((connection) => connection.pragma("busy_timeout"))).toBe(
        5_000,
      )
      expect(database.read((connection) => connection.userVersion())).toBe(
        CURRENT_SCHEMA_VERSION,
      )
      expect(database.integrityCheck()).toEqual({ ok: true })
    } finally {
      database.close()
    }
  })

  it("rolls back the whole transaction when its callback throws", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })

    try {
      expect(() =>
        database.transaction((connection) => {
          connection.run(
            `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
            ["workspace-a", "/tmp/workspace-a", 1, 1],
          )
          connection.run(
            `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
            ["workspace-b", "/tmp/workspace-b", 1, 1],
          )
          throw new Error("abort")
        }),
      ).toThrow("abort")

      expect(
        database.read((connection) =>
          connection.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM workspace",
          ),
        ),
      ).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  })

  it("reopens an existing database without replaying migrations", () => {
    const path = temporaryDatabasePath()
    const first = NexusStateDatabase.open({ path, now: () => 101 })
    first.close()

    const reopened = NexusStateDatabase.open({ path, now: () => 202 })
    try {
      expect(reopened.read((connection) => connection.userVersion())).toBe(
        CURRENT_SCHEMA_VERSION,
      )
      expect(
        reopened.read((connection) =>
          connection.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM schema_migration",
          ),
        ),
      ).toEqual({ count: CURRENT_SCHEMA_VERSION })
    } finally {
      reopened.close()
    }
  })

  it("refuses an applied migration whose checksum was modified", () => {
    const path = temporaryDatabasePath()
    const database = NexusStateDatabase.open({ path })
    database.transaction((connection) => {
      connection.run(
        "UPDATE schema_migration SET checksum = ? WHERE version = ?",
        ["tampered", CURRENT_SCHEMA_VERSION],
      )
    })
    database.close()

    expect(() => NexusStateDatabase.open({ path })).toThrow(
      new RegExp(`migration ${CURRENT_SCHEMA_VERSION} checksum mismatch`, "i"),
    )
  })
})
