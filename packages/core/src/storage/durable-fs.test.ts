import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  FileLockTimeoutError,
  StorageCorruptionError,
  atomicWriteFile,
  atomicWriteJson,
  getFileLockPath,
  readJsonWithRecovery,
  withFileLock,
} from "./durable-fs.js"

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-durable-fs-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("atomicWriteFile", () => {
  it("replaces a file and retains the previous verified bytes as a backup", async () => {
    const root = await tempRoot()
    const target = path.join(root, "state.json")

    await atomicWriteFile(target, "one", { backup: true })
    await atomicWriteFile(target, "two", { backup: true })

    expect(await readFile(target, "utf8")).toBe("two")
    expect(await readFile(`${target}.bak`, "utf8")).toBe("one")
    expect((await stat(target)).mode & 0o777).toBe(0o600)
  })
})

describe("readJsonWithRecovery", () => {
  it("recovers a corrupt primary from its backup and reports the source", async () => {
    const root = await tempRoot()
    const target = path.join(root, "state.json")
    await writeFile(target, "{broken", "utf8")
    await writeFile(`${target}.bak`, JSON.stringify({ ok: true }), "utf8")

    const recovered = await readJsonWithRecovery<{ ok: boolean }>(target)
    expect(recovered.value).toEqual({ ok: true })
    expect(recovered.source).toBe("backup")
    expect(recovered.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "primary-corrupt",
      "recovered-from-backup",
    ])
  })

  it("does not silently turn two corrupt copies into fresh state", async () => {
    const root = await tempRoot()
    const target = path.join(root, "state.json")
    await writeFile(target, "{broken", "utf8")
    await writeFile(`${target}.bak`, "{also-broken", "utf8")

    await expect(readJsonWithRecovery(target)).rejects.toBeInstanceOf(StorageCorruptionError)
  })

  it("returns an explicit missing result when neither copy exists", async () => {
    const root = await tempRoot()
    const target = path.join(root, "missing.json")

    await expect(readJsonWithRecovery(target)).resolves.toEqual({
      value: undefined,
      source: "missing",
      diagnostics: [],
    })
  })
})

describe("withFileLock", () => {
  it("serializes competing callers in the same process", async () => {
    const root = await tempRoot()
    const target = path.join(root, "state.json")
    let active = 0
    let maxActive = 0
    const order: string[] = []

    const work = (name: string, delayMs: number) =>
      withFileLock(target, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        order.push(`${name}:start`)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        order.push(`${name}:end`)
        active -= 1
      })

    await Promise.all([work("first", 30), work("second", 1), work("third", 1)])

    expect(maxActive).toBe(1)
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
      "third:start",
      "third:end",
    ])
  })

  it("recovers a stale lock whose owner process is gone", async () => {
    const root = await tempRoot()
    const target = path.join(root, "state.json")
    const lockPath = getFileLockPath(target)
    await mkdir(lockPath)
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        hostname: hostname(),
        nonce: "dead-owner",
        createdAt: Date.now() - 60_000,
      }),
      "utf8",
    )
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    const result = await withFileLock(target, async () => "recovered", {
      staleMs: 10,
      timeoutMs: 1_000,
      retryMinMs: 1,
      retryMaxMs: 5,
    })

    expect(result).toBe("recovered")
  })

  it("times out instead of stealing a live lock", async () => {
    const root = await tempRoot()
    const target = path.join(root, "state.json")
    const lockPath = getFileLockPath(target)
    await mkdir(lockPath)
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        hostname: hostname(),
        nonce: "live-owner",
        createdAt: Date.now() - 60_000,
      }),
      "utf8",
    )
    await expect(
      withFileLock(target, async () => undefined, {
        timeoutMs: 30,
        retryMinMs: 2,
        retryMaxMs: 5,
        staleMs: 10,
      }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError)
  })

  it("removes its lock after a failed operation", async () => {
    const root = await tempRoot()
    const target = path.join(root, "state.json")

    await expect(
      withFileLock(target, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    await expect(withFileLock(target, async () => "next")).resolves.toBe("next")
  })
})

describe("atomicWriteJson", () => {
  it("writes stable newline-terminated JSON", async () => {
    const root = await tempRoot()
    const target = path.join(root, "record.json")

    await atomicWriteJson(target, { version: 1, value: "ok" })

    expect(await readFile(target, "utf8")).toBe('{\n  "version": 1,\n  "value": "ok"\n}\n')
  })
})
