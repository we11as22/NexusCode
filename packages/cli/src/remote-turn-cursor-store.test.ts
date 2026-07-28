import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createCliRemoteTurnCursorStore } from "./remote-turn-cursor-store.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  )
})

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-cursor-"))
  roots.push(root)
  return root
}

describe("CLI remote turn cursor store", () => {
  it("atomically persists and clears an exact turn cursor", async () => {
    const rootDir = await temporaryRoot()
    const store = createCliRemoteTurnCursorStore({
      rootDir,
      serverUrl: "http://127.0.0.1:4097",
      cwd: rootDir,
    })

    await store.save("session-one", {
      turnId: "turn-one",
      runId: "run-one",
      afterSequence: 42,
    })

    await expect(store.load("session-one")).resolves.toEqual({
      turnId: "turn-one",
      runId: "run-one",
      afterSequence: 42,
    })
    await store.clear("session-one")
    await expect(store.load("session-one")).resolves.toBeUndefined()
  })

  it("atomically promotes a fully persisted pre-POST command to a cursor", async () => {
    const rootDir = await temporaryRoot()
    const store = createCliRemoteTurnCursorStore({
      rootDir,
      serverUrl: "http://127.0.0.1:4097",
      cwd: rootDir,
    })
    await store.savePrepared("session-outbox", {
      version: 1,
      phase: "prepared",
      commandId: "command-outbox",
      inputId: "input-outbox",
      afterSequence: 12,
      input: [{ type: "text", text: "persist before POST" }],
      mode: "agent",
    })
    await expect(store.loadPrepared("session-outbox")).resolves.toMatchObject({
      commandId: "command-outbox",
      afterSequence: 12,
    })

    await store.save("session-outbox", {
      turnId: "turn-outbox",
      runId: "run-outbox",
      afterSequence: 12,
    })
    await expect(store.loadPrepared("session-outbox")).resolves.toBeUndefined()
    await expect(store.load("session-outbox")).resolves.toMatchObject({
      turnId: "turn-outbox",
      runId: "run-outbox",
    })
  })

  it("fails closed on a symlinked cursor entry", async () => {
    const rootDir = await temporaryRoot()
    const target = path.join(rootDir, "target.json")
    await fs.writeFile(
      target,
      JSON.stringify({
        turnId: "turn-forged",
        runId: "run-forged",
        afterSequence: 10,
      }),
    )
    const store = createCliRemoteTurnCursorStore({
      rootDir,
      serverUrl: "http://127.0.0.1:4097",
      cwd: rootDir,
    })
    await store.save("session-forged", {
      turnId: "turn-original",
      runId: "run-original",
      afterSequence: 1,
    })
    const cursorDir = path.join(
      rootDir,
      "data",
      "remote-turn-recovery",
    )
    const [entryName] = await fs.readdir(cursorDir)
    if (!entryName) throw new Error("cursor entry was not created")
    const entryPath = path.join(cursorDir, entryName)
    await fs.unlink(entryPath)
    await fs.symlink(target, entryPath)

    await expect(store.load("session-forged")).rejects.toThrow(/symlink/i)
  })
})
