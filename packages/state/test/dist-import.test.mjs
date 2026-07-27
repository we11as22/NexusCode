import assert from "node:assert/strict"
import {
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"

test("the production entrypoint imports and opens an in-memory database", async () => {
  const { CURRENT_SCHEMA_VERSION, NexusStateDatabase } = await import(
    "../dist/index.js"
  )
  const database = NexusStateDatabase.open({
    path: ":memory:",
    processId: "dist-smoke",
  })

  try {
    database.transaction((connection) => {
      assert.deepEqual(Object.keys(connection), [])
      assert.equal(Reflect.get(connection, "connection"), undefined)
      assert.equal(Reflect.get(connection, "scope"), undefined)
    })
    assert.throws(
      () =>
        database.transaction((connection) => {
          connection.exec("PRAGMA ignore_check_constraints = ON")
        }),
      /not authorized|not allowed/i,
    )
    assert.throws(
      () =>
        database.transaction((connection) => {
          connection.exec("ATTACH DATABASE ':memory:' AS escaped")
        }),
      /not authorized|not allowed/i,
    )
    database.read((connection) => {
      assert.deepEqual(Object.keys(connection), [])
      assert.equal(Reflect.get(connection, "connection"), undefined)
      assert.equal(Reflect.get(connection, "scope"), undefined)
    })
    assert.throws(
      () => database.read(async () => "too late"),
      /synchronous/i,
    )
    assert.equal(
      database.read((connection) => connection.userVersion()),
      CURRENT_SCHEMA_VERSION,
    )
    assert.deepEqual(database.integrityCheck(), { ok: true })
  } finally {
    database.close()
  }
})

test("the production build protects on-disk state files and default identities", async () => {
  const { NexusStateDatabase } = await import("../dist/index.js")
  const directory = mkdtempSync(join(tmpdir(), "nexus-state-dist-"))
  const path = join(directory, "state.sqlite")
  const first = NexusStateDatabase.open({ path })
  const second = NexusStateDatabase.open({ path })

  try {
    assert.notEqual(first.processId, second.processId)
    if (process.platform !== "win32") {
      assert.equal(lstatSync(directory).mode & 0o777, 0o700)
      for (const filename of [path, `${path}-wal`, `${path}-shm`]) {
        assert.equal(lstatSync(filename).isFile(), true)
        assert.equal(lstatSync(filename).mode & 0o777, 0o600)
      }
    }
  } finally {
    second.close()
    first.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the production build rejects symbolic database paths", async () => {
  const { NexusStateDatabase } = await import("../dist/index.js")
  const directory = mkdtempSync(join(tmpdir(), "nexus-state-dist-link-"))
  const target = join(directory, "target.sqlite")
  const path = join(directory, "state.sqlite")
  writeFileSync(target, "")
  symlinkSync(target, path)

  try {
    assert.throws(
      () => NexusStateDatabase.open({ path }),
      /symbolic link/i,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the production build rejects a user_version that diverges from its ledger", async () => {
  const { CURRENT_SCHEMA_VERSION, NexusStateDatabase } = await import(
    "../dist/index.js"
  )
  const directory = mkdtempSync(join(tmpdir(), "nexus-state-dist-version-"))
  const path = join(directory, "state.sqlite")
  NexusStateDatabase.open({ path }).close()
  const rawDatabase = new DatabaseSync(path)
  try {
    rawDatabase.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`)
  } finally {
    rawDatabase.close()
  }

  try {
    assert.throws(
      () => NexusStateDatabase.open({ path }),
      /user_version.*migration ledger/i,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
