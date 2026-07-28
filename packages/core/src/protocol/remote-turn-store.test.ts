import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  FileRemoteTurnRecoveryStore,
  type RemotePreparedTurnRecord,
} from "./remote-turn-store.js"

const temporaryDirectories: string[] = []

async function makeStore() {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "nexus-remote-turn-"),
  )
  temporaryDirectories.push(rootDir)
  return new FileRemoteTurnRecoveryStore({
    rootDir,
    namespace: "https://server.example|/workspace",
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe("FileRemoteTurnRecoveryStore", () => {
  it("atomically replaces a prepared command with its admitted cursor", async () => {
    const store = await makeStore()
    const prepared: RemotePreparedTurnRecord = {
      version: 1,
      phase: "prepared",
      commandId: "command-1",
      inputId: "input-1",
      afterSequence: 7,
      input: [{ type: "text", text: "continue safely" }],
      mode: "agent",
    }

    await store.savePrepared("session-1", prepared)
    await expect(store.loadPrepared("session-1")).resolves.toEqual(prepared)
    await expect(store.load("session-1")).resolves.toBeUndefined()

    await store.save("session-1", {
      turnId: "turn-1",
      runId: "run-1",
      afterSequence: 8,
    })
    await expect(store.loadPrepared("session-1")).resolves.toBeUndefined()
    await expect(store.load("session-1")).resolves.toEqual({
      turnId: "turn-1",
      runId: "run-1",
      afterSequence: 8,
    })
  })

  it("validates the complete prepared command before touching disk", async () => {
    const store = await makeStore()
    await expect(store.savePrepared("session-1", {
      version: 1,
      phase: "prepared",
      commandId: "--bad",
      inputId: "input-1",
      afterSequence: 0,
      input: [{ type: "text", text: "safe" }],
      mode: "agent",
    })).rejects.toThrow()
    await expect(store.loadPrepared("session-1")).resolves.toBeUndefined()
  })

  it("rejects cross-process-style ownership replacement and cursor regression", async () => {
    const store = await makeStore()
    await store.savePrepared("session-1", {
      version: 1,
      phase: "prepared",
      commandId: "command-1",
      inputId: "input-1",
      afterSequence: 2,
      input: [{ type: "text", text: "first" }],
      mode: "agent",
    })
    await expect(store.savePrepared("session-1", {
      version: 1,
      phase: "prepared",
      commandId: "command-2",
      inputId: "input-2",
      afterSequence: 2,
      input: [{ type: "text", text: "second" }],
      mode: "agent",
    })).rejects.toThrow(/already owns/i)

    await expect(store.save("session-1", {
      turnId: "turn-1",
      runId: "run-1",
      afterSequence: 1,
    })).rejects.toThrow(/prepared replay boundary/i)

    await store.save("session-1", {
      turnId: "turn-1",
      runId: "run-1",
      afterSequence: 4,
    })
    await expect(store.save("session-1", {
      turnId: "turn-1",
      runId: "run-1",
      afterSequence: 3,
    })).rejects.toThrow(/backwards/i)
  })
})
