import { describe, expect, it } from "vitest"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
  VsCodeRemoteWorkspaceState,
  type WorkspaceMementoLike,
} from "./remote-workspace-state.js"

class MemoryMemento implements WorkspaceMementoLike {
  readonly values = new Map<string, unknown>()

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key)
    else this.values.set(key, value)
  }
}

describe("VS Code remote workspace state", () => {
  it("uses the extension storage filesystem for an atomic prepared-to-admitted transition", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "nexus-vscode-outbox-"),
    )
    try {
      const memento = new MemoryMemento()
      const state = new VsCodeRemoteWorkspaceState(
        memento,
        "https://nexus.example.test",
        "/workspace/project",
        rootDir,
      )
      await state.savePrepared("session-outbox", {
        version: 1,
        phase: "prepared",
        commandId: "command-outbox",
        inputId: "input-outbox",
        afterSequence: 3,
        input: [{ type: "text", text: "recover after reload" }],
        mode: "review",
      })
      await expect(
        state.loadPrepared("session-outbox"),
      ).resolves.toMatchObject({
        commandId: "command-outbox",
      })

      await state.save("session-outbox", {
        turnId: "turn-outbox",
        runId: "run-outbox",
        afterSequence: 4,
      })
      await expect(
        state.loadPrepared("session-outbox"),
      ).resolves.toBeUndefined()
      await expect(state.load("session-outbox")).resolves.toMatchObject({
        turnId: "turn-outbox",
        afterSequence: 4,
      })
      expect(
        [...memento.values.keys()].some((key) => key.includes(".cursor.")),
      ).toBe(false)
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true })
    }
  })

  it("persists the selected session and exact replay cursor", async () => {
    const memento = new MemoryMemento()
    const state = new VsCodeRemoteWorkspaceState(
      memento,
      "https://nexus.example.test/",
      "/workspace/project",
    )

    await state.setSelectedSessionId("session-1")
    await state.save("session-1", {
      turnId: "turn-1",
      runId: "run-1",
      afterSequence: 17,
    })

    const restored = new VsCodeRemoteWorkspaceState(
      memento,
      "https://nexus.example.test",
      "/workspace/project",
    )
    await expect(restored.getSelectedSessionId()).resolves.toBe("session-1")
    await expect(restored.load("session-1")).resolves.toEqual({
      turnId: "turn-1",
      runId: "run-1",
      afterSequence: 17,
    })

    await restored.clear("session-1")
    await expect(restored.load("session-1")).resolves.toBeUndefined()
  })

  it("isolates state by canonical server and workspace", async () => {
    const memento = new MemoryMemento()
    const first = new VsCodeRemoteWorkspaceState(
      memento,
      "https://one.example.test",
      "/workspace/one",
    )
    await first.setSelectedSessionId("session-private")
    await first.save("session-private", {
      turnId: "turn-private",
      runId: "run-private",
      afterSequence: 3,
    })

    for (const state of [
      new VsCodeRemoteWorkspaceState(
        memento,
        "https://two.example.test",
        "/workspace/one",
      ),
      new VsCodeRemoteWorkspaceState(
        memento,
        "https://one.example.test",
        "/workspace/two",
      ),
    ]) {
      await expect(state.getSelectedSessionId()).resolves.toBeUndefined()
      await expect(state.load("session-private")).resolves.toBeUndefined()
    }
  })

  it("ignores malformed persisted values instead of trusting them", async () => {
    const memento = new MemoryMemento()
    const state = new VsCodeRemoteWorkspaceState(
      memento,
      "https://nexus.example.test",
      "/workspace/project",
    )
    await state.setSelectedSessionId("session-safe")
    await state.save("session-safe", {
      turnId: "turn-safe",
      runId: "run-safe",
      afterSequence: 2,
    })

    for (const [key, value] of memento.values) {
      if (key.includes(".cursor.")) {
        memento.values.set(key, {
          ...(value as object),
          afterSequence: -1,
        })
      }
    }

    await expect(state.load("session-safe")).resolves.toBeUndefined()
  })
})
