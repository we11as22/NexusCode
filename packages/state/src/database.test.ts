import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import {
  CURRENT_SCHEMA_VERSION,
  NexusStateDatabase,
  type StateConnection,
  type StateReadConnection,
} from "./index.js"

const temporaryDirectories: string[] = []

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nexus-state-test-"))
  temporaryDirectories.push(directory)
  return join(directory, "state.sqlite")
}

function seedTwoSessions(database: NexusStateDatabase): void {
  database.transaction((connection) => {
    connection.run(
      `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      ["migration-workspace", "/tmp/migration-workspace", 1, 1],
    )
    connection.run(
      `INSERT INTO session (id, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      [
        "migration-session-1",
        "migration-workspace",
        1,
        1,
        "migration-session-2",
        "migration-workspace",
        1,
        1,
      ],
    )
  })
}

function downgradeSchemaToVersion3(path: string): void {
  const database = new DatabaseSync(path)
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS session_turn_run_session_insert;
      DROP TRIGGER IF EXISTS session_turn_input_session_insert;
      DROP TABLE IF EXISTS session_next_mode;
      DROP TABLE IF EXISTS protocol_event;
      DROP TABLE IF EXISTS protocol_event_sequence;
      DROP TABLE IF EXISTS session_command;
      DROP TABLE IF EXISTS session_turn;
      DROP TABLE IF EXISTS runtime_session_input;
      DROP TABLE IF EXISTS runtime_session_sequence;
      DROP TRIGGER approval_run_session_insert;
      DROP TRIGGER approval_run_session_update;
      DROP TRIGGER run_session_update_with_approval;
      DROP TRIGGER IF EXISTS run_terminal_cancel_approvals;
      DROP TRIGGER IF EXISTS approval_pending_run_insert;
      DROP TRIGGER IF EXISTS approval_pending_run_update;
      DROP TABLE IF EXISTS approval_quarantine;
      DELETE FROM schema_migration WHERE version >= 4;
      PRAGMA user_version = 3;
    `)
  } finally {
    database.close()
  }
}

function downgradeSchemaToVersion4(path: string): void {
  const database = new DatabaseSync(path)
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS session_turn_run_session_insert;
      DROP TRIGGER IF EXISTS session_turn_input_session_insert;
      DROP TABLE IF EXISTS session_next_mode;
      DROP TABLE IF EXISTS protocol_event;
      DROP TABLE IF EXISTS protocol_event_sequence;
      DROP TABLE IF EXISTS session_command;
      DROP TABLE IF EXISTS session_turn;
      DROP TABLE IF EXISTS runtime_session_input;
      DROP TABLE IF EXISTS runtime_session_sequence;
      DROP TRIGGER run_terminal_cancel_approvals;
      DROP TRIGGER approval_pending_run_insert;
      DROP TRIGGER approval_pending_run_update;
      DELETE FROM schema_migration WHERE version >= 5;
      PRAGMA user_version = 4;
    `)
  } finally {
    database.close()
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

if (false) {
  const database = undefined as unknown as NexusStateDatabase
  // @ts-expect-error Transaction callbacks must not return promises.
  database.transaction(async () => undefined)
  // @ts-expect-error Read callbacks must not return promises.
  database.read(async () => undefined)
  database.read((connection) => {
    // @ts-expect-error Read connections must not expose write operations.
    connection.run("DELETE FROM workspace")
  })
}

describe("NexusStateDatabase", () => {
  it("uses a unique process identity for every default database handle", () => {
    const first = NexusStateDatabase.open({ path: ":memory:" })
    const second = NexusStateDatabase.open({ path: ":memory:" })

    try {
      expect(first.processId).not.toBe(second.processId)
      expect(first.processId).not.toBe(`${process.pid}`)
      expect(second.processId).not.toBe(`${process.pid}`)
    } finally {
      second.close()
      first.close()
    }
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid busyTimeoutMs %s before opening SQLite",
    (busyTimeoutMs) => {
      expect(() =>
        NexusStateDatabase.open({
          path: temporaryDatabasePath(),
          busyTimeoutMs,
        }),
      ).toThrow(/busyTimeoutMs.*safe integer/i)
    },
  )

  it("rejects an empty explicit process identity", () => {
    expect(() =>
      NexusStateDatabase.open({
        path: temporaryDatabasePath(),
        processId: "   ",
      }),
    ).toThrow(/process.*must not be empty/i)
  })

  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("rejects an unsafe numeric SQLite parameter: %s", (value) => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })

    try {
      expect(() =>
        database.transaction((connection) => {
          connection.run(
            `INSERT INTO workspace
               (id, canonical_path, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
            ["unsafe-number", "/tmp/unsafe-number", value, 1],
          )
        }),
      ).toThrow(/finite|safe integer/i)
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

  it.skipIf(process.platform === "win32")(
    "creates a private state directory and protects the database and WAL files",
    () => {
      const root = mkdtempSync(join(tmpdir(), "nexus-state-mode-test-"))
      temporaryDirectories.push(root)
      const directory = join(root, "private")
      const path = join(directory, "state.sqlite")
      const database = NexusStateDatabase.open({ path })

      try {
        expect(lstatSync(directory).mode & 0o777).toBe(0o700)
        for (const filename of [path, `${path}-wal`, `${path}-shm`]) {
          expect(lstatSync(filename).isFile()).toBe(true)
          expect(lstatSync(filename).mode & 0o777).toBe(0o600)
        }
      } finally {
        database.close()
      }
    },
  )

  it.skipIf(process.platform === "win32")(
    "refuses an existing state directory that is not private",
    () => {
      const root = mkdtempSync(join(tmpdir(), "nexus-state-public-dir-test-"))
      temporaryDirectories.push(root)
      chmodSync(root, 0o755)

      expect(() =>
        NexusStateDatabase.open({ path: join(root, "state.sqlite") }),
      ).toThrow(/private|0700/i)
    },
  )

  it("refuses symbolic links and non-regular database targets", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-state-path-test-"))
    temporaryDirectories.push(root)
    const target = join(root, "target.sqlite")
    const symbolicPath = join(root, "symbolic.sqlite")
    writeFileSync(target, "")
    symlinkSync(target, symbolicPath)

    expect(() => NexusStateDatabase.open({ path: symbolicPath })).toThrow(
      /symbolic link/i,
    )

    const directoryPath = join(root, "directory.sqlite")
    mkdirSync(directoryPath, { mode: 0o700 })
    expect(() => NexusStateDatabase.open({ path: directoryPath })).toThrow(
      /regular file/i,
    )
  })

  it("refuses a symbolic-link state directory", () => {
    const root = mkdtempSync(join(tmpdir(), "nexus-state-dir-link-test-"))
    temporaryDirectories.push(root)
    const targetDirectory = join(root, "target")
    const symbolicDirectory = join(root, "symbolic")
    mkdirSync(targetDirectory, { mode: 0o700 })
    symlinkSync(targetDirectory, symbolicDirectory)

    expect(() =>
      NexusStateDatabase.open({
        path: join(symbolicDirectory, "state.sqlite"),
      }),
    ).toThrow(/state directory.*symbolic link/i)
  })

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

  it("rejects async callbacks before commit without leaking a rejection", async () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on("unhandledRejection", onUnhandledRejection)
    const asyncCallback = (async (connection: StateConnection) => {
      connection.run(
        `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        ["async-workspace", "/tmp/async-workspace", 1, 1],
      )
      throw new Error("async callback failed")
    }) as unknown as (connection: StateConnection) => void

    try {
      expect(() => database.transaction(asyncCallback)).toThrow(/synchronous/i)
      expect(
        database.read((connection) =>
          connection.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM workspace",
          ),
        ),
      ).toEqual({ count: 0 })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandledRejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandledRejection)
      database.close()
    }
  })

  it("rejects custom thenables before commit and rolls back their writes", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })

    try {
      expect(() =>
        database.transaction((connection) => {
          connection.run(
            `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
            ["thenable-workspace", "/tmp/thenable-workspace", 1, 1],
          )
          return { then() {} } as unknown as string
        }),
      ).toThrow(/synchronous/i)
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

  it("invalidates the transaction connection when the callback returns", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    let escapedConnection: StateConnection | undefined

    try {
      database.transaction((connection) => {
        escapedConnection = connection
      })

      expect(() =>
        escapedConnection?.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM workspace",
        ),
      ).toThrow(/transaction scope/i)
    } finally {
      database.close()
    }
  })

  it("never exposes the raw connection through a transaction scope", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    let rawConnectionWasExposed = false

    try {
      expect(() =>
        database.transaction((connection) => {
          connection.run(
            `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
            ["raw-escape", "/tmp/raw-escape", 1, 1],
          )
          const rawConnection = Reflect.get(connection, "connection") as
            | StateConnection
            | undefined
          rawConnectionWasExposed = rawConnection !== undefined
          rawConnection?.exec("COMMIT")
          throw new Error("abort after raw connection probe")
        }),
      ).toThrow("abort after raw connection probe")

      expect(rawConnectionWasExposed).toBe(false)
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

  it.each([
    "BEGIN IMMEDIATE",
    "COMMIT",
    "END",
    "ROLLBACK",
    "SAVEPOINT nested",
    "RELEASE nested",
    "SELECT 1; /* second statement */ cOmMiT",
  ])("rejects transaction control SQL before executing %s", (sql) => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })

    try {
      expect(() =>
        database.transaction((connection) => connection.exec(sql)),
      ).toThrow(/transaction control/i)
    } finally {
      database.close()
    }
  })

  it.each([
    [
      "exec",
      (connection: StateConnection) =>
        connection.exec(" /* comment */\n CoMmIt"),
    ],
    [
      "run",
      (connection: StateConnection) =>
        connection.run("-- comment\n RoLlBaCk"),
    ],
    [
      "get",
      (connection: StateConnection) =>
        connection.get("/* comment */ SAVEPOINT nested"),
    ],
    [
      "all",
      (connection: StateConnection) =>
        connection.all("\n/* comment */ ReLeAsE nested"),
    ],
  ])("rejects transaction control through %s", (_method, execute) => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })

    try {
      expect(() => database.transaction(execute)).toThrow(
        /transaction control/i,
      )
    } finally {
      database.close()
    }
  })

  it("rolls back writes when a callback tries to commit explicitly", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    let caught: unknown

    try {
      try {
        database.transaction((connection) => {
          connection.run(
            `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
            ["early-commit", "/tmp/early-commit", 1, 1],
          )
          connection.exec(" /* bypass attempt */ COMMIT")
          throw new Error("callback failed after early commit")
        })
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toMatch(/transaction control/i)
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

  it.each([
    "PRAGMA foreign_keys = OFF",
    "PRAGMA ignore_check_constraints = ON",
    "PRAGMA defer_foreign_keys = ON",
    "PRAGMA trusted_schema = ON",
    "PRAGMA user_version = 999",
    "PRAGMA optimize",
    "ATTACH DATABASE ':memory:' AS auxiliary",
    "DETACH DATABASE auxiliary",
  ])("denies connection-scoped SQL inside a transaction: %s", (sql) => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })

    try {
      expect(() =>
        database.transaction((connection) => connection.exec(sql)),
      ).toThrow(/not authorized|not allowed/i)
    } finally {
      database.close()
    }
  })

  it("keeps foreign-key, check, trust, and attachment guards intact after denied mutations", () => {
    const path = temporaryDatabasePath()
    const auxiliaryPath = temporaryDatabasePath()
    const database = NexusStateDatabase.open({ path })

    try {
      database.transaction((connection) => {
        for (const sql of [
          "PRAGMA ignore_check_constraints = ON",
          "PRAGMA trusted_schema = ON",
          "PRAGMA defer_foreign_keys = ON",
        ]) {
          expect(() => connection.exec(sql)).toThrow(/not authorized|not allowed/i)
        }
        expect(() =>
          connection.run("ATTACH DATABASE ? AS auxiliary", [auxiliaryPath]),
        ).toThrow(/not authorized|not allowed/i)
      })

      expect(database.read((connection) => connection.pragma("foreign_keys"))).toBe(
        1,
      )
      expect(
        database.read((connection) => connection.pragma("trusted_schema")),
      ).toBe(0)
      expect(
        database.read((connection) =>
          connection.pragma("ignore_check_constraints"),
        ),
      ).toBe(0)
      const attachedDatabaseNames = database.read((connection) =>
          connection
            .all<{ name: string }>("PRAGMA database_list")
            .map((row) => row.name),
        )
      expect(attachedDatabaseNames).toContain("main")
      expect(attachedDatabaseNames).not.toContain("auxiliary")
      expect(
        attachedDatabaseNames.every((name) => name === "main" || name === "temp"),
      ).toBe(true)

      expect(() =>
        database.transaction((connection) => {
          connection.run(
            `INSERT INTO session
              (id, workspace_id, created_at, updated_at)
             VALUES (?, ?, ?, ?)`,
            ["orphan-session", "missing-workspace", 1, 1],
          )
        }),
      ).toThrow()
      expect(() =>
        database.transaction((connection) => {
          connection.run(
            `INSERT INTO session_input
              (id, session_id, delivery, admitted_sequence, payload_checksum,
               parts_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ["invalid-input", "missing-session", "evil", 1, "checksum", "[]", 1],
          )
        }),
      ).toThrow()
    } finally {
      database.close()
    }
  })

  it("blocks database.read re-entry while a transaction is active", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })

    try {
      expect(() =>
        database.transaction(() =>
          database.read((connection) =>
            connection.get("SELECT COUNT(*) AS count FROM workspace"),
          ),
        ),
      ).toThrow(/read.*transaction/i)
    } finally {
      database.close()
    }
  })

  it("does not expose a long-lived writable connection from read", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    let escapedConnection: StateReadConnection | undefined

    try {
      database.read((connection) => {
        escapedConnection = connection
      })

      expect("exec" in escapedConnection!).toBe(false)
      expect("run" in escapedConnection!).toBe(false)
      expect(Reflect.get(escapedConnection!, "connection")).toBeUndefined()
      expect(Object.keys(escapedConnection!)).toEqual([])
      expect(() =>
        escapedConnection?.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM workspace",
        ),
      ).toThrow(/read scope/i)
    } finally {
      database.close()
    }
  })

  it("rejects async read callbacks before releasing the read snapshot", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    const asyncCallback = (async (connection: StateReadConnection) => {
      connection.get("SELECT 1 AS value")
      await Promise.resolve()
      return "late"
    }) as unknown as (connection: StateReadConnection) => void

    try {
      expect(() => database.read(asyncCallback)).toThrow(/synchronous/i)
      expect(database.read(() => "still open")).toBe("still open")
    } finally {
      database.close()
    }
  })

  it("holds one consistent snapshot across every query in a read callback", () => {
    const path = temporaryDatabasePath()
    const reader = NexusStateDatabase.open({ path })
    const writer = NexusStateDatabase.open({ path })
    reader.transaction((connection) => {
      connection.run(
        `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        ["snapshot-workspace", "/tmp/snapshot-workspace", 1, 1],
      )
    })

    try {
      const observed = reader.read((connection) => {
        const before = connection.get<{ updated_at: number }>(
          "SELECT updated_at FROM workspace WHERE id = ?",
          ["snapshot-workspace"],
        )
        writer.transaction((writerConnection) => {
          writerConnection.run(
            "UPDATE workspace SET updated_at = ? WHERE id = ?",
            [2, "snapshot-workspace"],
          )
        })
        const after = connection.get<{ updated_at: number }>(
          "SELECT updated_at FROM workspace WHERE id = ?",
          ["snapshot-workspace"],
        )
        return { before, after }
      })

      expect(observed).toEqual({
        before: { updated_at: 1 },
        after: { updated_at: 1 },
      })
    } finally {
      writer.close()
      reader.close()
    }
  })

  it("enforces read-only SQL inside a read scope", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })

    try {
      database.read((connection) => {
        expect(() =>
          connection.get(
            `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
             VALUES ('read-write', '/tmp/read-write', 1, 1)
             RETURNING id`,
          ),
        ).toThrow()
        expect(() => connection.get("PRAGMA query_only = OFF")).toThrow()
      })

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

  it("restores query-only and authorizer guards after a read failure", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })

    try {
      expect(() =>
        database.read((connection) =>
          connection.get(
            `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
             VALUES ('denied-read-write', '/tmp/denied-read-write', 1, 1)
             RETURNING id`,
          ),
        ),
      ).toThrow()

      database.transaction((connection) => {
        connection.run(
          `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
          ["restored-write", "/tmp/restored-write", 1, 1],
        )
      })
      expect(
        database.read((connection) =>
          connection.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM workspace",
          ),
        ),
      ).toEqual({ count: 1 })
    } finally {
      database.close()
    }
  })

  it("blocks every database scope re-entry from read", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })

    try {
      database.read(() => {
        expect(() => database.read(() => undefined)).toThrow(/read scope/i)
        expect(() => database.transaction(() => undefined)).toThrow(
          /read scope/i,
        )
        expect(() => database.close()).toThrow(/read scope/i)
      })

      expect(database.read(() => "still open")).toBe("still open")
    } finally {
      database.close()
    }
  })

  it("recovers after BEGIN IMMEDIATE fails to acquire the writer lock", () => {
    const path = temporaryDatabasePath()
    const contender = NexusStateDatabase.open({ path, busyTimeoutMs: 1 })
    const holder = new DatabaseSync(path, { timeout: 1_000 })
    let holderTransactionActive = false

    try {
      expect(contender.read((connection) => connection.pragma("busy_timeout"))).toBe(
        1,
      )
      holder.exec("BEGIN IMMEDIATE")
      holderTransactionActive = true

      expect(() => contender.transaction(() => undefined)).toThrow()

      holder.exec("ROLLBACK")
      holderTransactionActive = false

      contender.transaction((connection) => {
        connection.run(
          `INSERT INTO workspace (id, canonical_path, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
          ["recovered-workspace", "/tmp/recovered-workspace", 1, 1],
        )
      })
      expect(
        contender.read((connection) =>
          connection.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM workspace",
          ),
        ),
      ).toEqual({ count: 1 })
    } finally {
      if (holderTransactionActive) {
        holder.exec("ROLLBACK")
      }
      contender.close()
      holder.close()
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

  it("upgrades a clean version 3 database and reopens it cleanly", () => {
    const path = temporaryDatabasePath()
    const version3 = NexusStateDatabase.open({ path })
    version3.close()
    downgradeSchemaToVersion3(path)

    const upgraded = NexusStateDatabase.open({ path })
    try {
      expect(upgraded.read((connection) => connection.userVersion())).toBe(
        CURRENT_SCHEMA_VERSION,
      )
      expect(upgraded.integrityCheck()).toEqual({ ok: true })
    } finally {
      upgraded.close()
    }

    const reopened = NexusStateDatabase.open({ path })
    try {
      expect(reopened.integrityCheck()).toEqual({ ok: true })
    } finally {
      reopened.close()
    }
  })

  it("quarantines cross-session approvals while upgrading version 3", () => {
    const path = temporaryDatabasePath()
    const version3 = NexusStateDatabase.open({ path })
    seedTwoSessions(version3)
    version3.close()
    downgradeSchemaToVersion3(path)
    const rawDatabase = new DatabaseSync(path)
    try {
      rawDatabase
        .prepare(
        `INSERT INTO run
          (id, session_id, owner_id, lease_epoch, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
        )
        .run(
          "migration-run",
          "migration-session-2",
          "migration-owner",
          1,
          10,
        )
      rawDatabase
        .prepare(
        `INSERT INTO approval
          (id, session_id, run_id, tool_name, redacted_summary, dedupe_key,
           status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          "contaminated-approval",
          "migration-session-1",
          "migration-run",
          "shell",
          "Run tests",
          "contaminated-shell",
          20,
        )
    } finally {
      rawDatabase.close()
    }

    const upgraded = NexusStateDatabase.open({ path })
    try {
      expect(
        upgraded.read((connection) =>
          connection.get<{
            run_id: string | null
            status: string
            resolved_at: number
          }>(
            `SELECT run_id, status, resolved_at
             FROM approval
             WHERE id = ?`,
            ["contaminated-approval"],
          ),
        ),
      ).toEqual({
        run_id: null,
        status: "cancelled",
        resolved_at: 20,
      })
      expect(
        upgraded.read((connection) =>
          connection.get<{
            approval_id: string
            original_run_id: string
            approval_session_id: string
            run_session_id: string
            original_status: string
            reason: string
          }>(
            `SELECT approval_id, original_run_id, approval_session_id,
                    run_session_id, original_status, reason
             FROM approval_quarantine
             WHERE approval_id = ?`,
            ["contaminated-approval"],
          ),
        ),
      ).toEqual({
        approval_id: "contaminated-approval",
        original_run_id: "migration-run",
        approval_session_id: "migration-session-1",
        run_session_id: "migration-session-2",
        original_status: "pending",
        reason: "run_session_mismatch",
      })
      expect(upgraded.integrityCheck()).toEqual({ ok: true })
    } finally {
      upgraded.close()
    }

    const reopened = NexusStateDatabase.open({ path })
    try {
      expect(
        reopened.read((connection) =>
          connection.get<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM approval_quarantine
             WHERE approval_id = ?`,
            ["contaminated-approval"],
          ),
        ),
      ).toEqual({ count: 1 })
      expect(reopened.integrityCheck()).toEqual({ ok: true })
    } finally {
      reopened.close()
    }
  })

  it("settles legacy pending approvals while upgrading version 4", () => {
    const path = temporaryDatabasePath()
    const version4 = NexusStateDatabase.open({ path })
    seedTwoSessions(version4)
    version4.close()
    downgradeSchemaToVersion4(path)

    const rawDatabase = new DatabaseSync(path)
    try {
      rawDatabase
        .prepare(
          `INSERT INTO run
             (id, session_id, owner_id, lease_epoch, status, started_at,
              finished_at)
           VALUES (?, ?, ?, ?, 'completed', ?, ?)`,
        )
        .run(
          "legacy-terminal-run",
          "migration-session-1",
          "legacy-owner",
          1,
          10,
          20,
        )
      rawDatabase
        .prepare(
          `INSERT INTO approval
             (id, session_id, run_id, tool_name, redacted_summary, dedupe_key,
              status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          "legacy-pending-approval",
          "migration-session-1",
          "legacy-terminal-run",
          "shell",
          "Legacy pending action",
          "legacy-terminal-pending",
          15,
        )
    } finally {
      rawDatabase.close()
    }

    const upgraded = NexusStateDatabase.open({ path })
    try {
      expect(
        upgraded.read((connection) =>
          connection.get<{ status: string; resolved_at: number }>(
            "SELECT status, resolved_at FROM approval WHERE id = ?",
            ["legacy-pending-approval"],
          ),
        ),
      ).toEqual({ status: "cancelled", resolved_at: 20 })
      expect(upgraded.integrityCheck()).toEqual({ ok: true })
    } finally {
      upgraded.close()
    }
  })

  it("reports missing guards and cross-session approval corruption", () => {
    const database = NexusStateDatabase.open({ path: temporaryDatabasePath() })
    seedTwoSessions(database)
    database.transaction((connection) => {
      connection.exec(`
        DROP TRIGGER approval_run_session_insert;
        DROP TRIGGER approval_run_session_update;
        DROP TRIGGER run_session_update_with_approval;
      `)
      connection.run(
        `INSERT INTO run
          (id, session_id, owner_id, lease_epoch, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
        ["corrupt-run", "migration-session-2", "owner", 1, 10],
      )
      connection.run(
        `INSERT INTO approval
          (id, session_id, run_id, tool_name, redacted_summary, dedupe_key,
           status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [
          "corrupt-approval",
          "migration-session-1",
          "corrupt-run",
          "shell",
          "Run tests",
          "corrupt-shell",
          20,
        ],
      )
    })

    try {
      const result = database.integrityCheck()
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.messages.join("\n")).toMatch(
          /missing.*trigger|approval.*session/i,
        )
      }
    } finally {
      database.close()
    }
  })

  it("refuses to open when a required trigger was replaced by a no-op", () => {
    const path = temporaryDatabasePath()
    const database = NexusStateDatabase.open({ path })
    database.close()

    const rawDatabase = new DatabaseSync(path)
    try {
      rawDatabase.exec(`
        DROP TRIGGER approval_run_session_insert;
        CREATE TRIGGER approval_run_session_insert
        BEFORE INSERT ON approval
        WHEN 0
        BEGIN
          SELECT 1;
        END;
      `)
    } finally {
      rawDatabase.close()
    }

    expect(() => NexusStateDatabase.open({ path })).toThrow(
      /invalid.*trigger.*approval_run_session_insert/i,
    )
  })

  it("refuses a pending approval attached to an already-terminal run", () => {
    const path = temporaryDatabasePath()
    const database = NexusStateDatabase.open({ path })
    seedTwoSessions(database)
    database.close()

    const rawDatabase = new DatabaseSync(path)
    try {
      const trigger = rawDatabase
        .prepare(
          `SELECT sql
           FROM sqlite_schema
           WHERE type = 'trigger' AND name = ?`,
        )
        .get("approval_pending_run_insert") as { sql: string }
      rawDatabase.exec("DROP TRIGGER approval_pending_run_insert")
      rawDatabase
        .prepare(
          `INSERT INTO run
             (id, session_id, owner_id, lease_epoch, status, started_at,
              finished_at)
           VALUES (?, ?, ?, ?, 'completed', ?, ?)`,
        )
        .run(
          "terminal-run",
          "migration-session-1",
          "owner",
          1,
          10,
          20,
        )
      rawDatabase
        .prepare(
          `INSERT INTO approval
             (id, session_id, run_id, tool_name, redacted_summary, dedupe_key,
              status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          "terminal-run-pending-approval",
          "migration-session-1",
          "terminal-run",
          "shell",
          "Should not remain pending",
          "terminal-run-pending",
          20,
        )
      rawDatabase.exec(trigger.sql)
    } finally {
      rawDatabase.close()
    }

    expect(() => NexusStateDatabase.open({ path })).toThrow(
      /pending approval.*non-running run|terminal run.*pending approval/i,
    )
  })

  it("refuses a non-contiguous migration ledger", () => {
    const path = temporaryDatabasePath()
    const database = NexusStateDatabase.open({ path })
    database.close()

    const rawDatabase = new DatabaseSync(path)
    try {
      rawDatabase
        .prepare("DELETE FROM schema_migration WHERE version = ?")
        .run(2)
    } finally {
      rawDatabase.close()
    }

    expect(() => NexusStateDatabase.open({ path })).toThrow(
      /migration ledger.*contiguous|missing migration 2/i,
    )
  })

  it.each([CURRENT_SCHEMA_VERSION - 1, CURRENT_SCHEMA_VERSION + 100])(
    "refuses user_version %s when it disagrees with the migration ledger",
    (userVersion) => {
      const path = temporaryDatabasePath()
      const database = NexusStateDatabase.open({ path })
      database.close()

      const rawDatabase = new DatabaseSync(path)
      try {
        rawDatabase.exec(`PRAGMA user_version = ${userVersion}`)
      } finally {
        rawDatabase.close()
      }

      expect(() => NexusStateDatabase.open({ path })).toThrow(
        /user_version.*migration ledger|schema version.*mismatch/i,
      )
    },
  )

  it("refuses foreign-key corruption during the mandatory open gate", () => {
    const path = temporaryDatabasePath()
    const database = NexusStateDatabase.open({ path })
    database.close()

    const rawDatabase = new DatabaseSync(path)
    try {
      rawDatabase.exec("PRAGMA foreign_keys = OFF")
      rawDatabase
        .prepare(
          `INSERT INTO session
             (id, workspace_id, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run("orphan-on-disk", "missing-workspace", 1, 1)
    } finally {
      rawDatabase.close()
    }

    expect(() => NexusStateDatabase.open({ path })).toThrow(
      /foreign key violation/i,
    )
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
