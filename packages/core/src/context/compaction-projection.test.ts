import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { OrchestrationRuntime } from "../orchestration/runtime.js"
import { readSessionMemoryFile } from "../session/session-memory.js"
import type { ISession, NexusConfig, SessionMessage } from "../types.js"
import { projectPersistedCompactionSummary } from "./compaction-projection.js"

const temporaryDirectories: string[] = []

async function createTemporaryWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-compaction-"))
  temporaryDirectories.push(directory)
  return directory
}

function createSession(summary: SessionMessage): ISession {
  return {
    id: "session-projection",
    messages: [summary],
  } as ISession
}

function createRuntime(upsertMemoryByTitle = vi.fn()): OrchestrationRuntime {
  return { upsertMemoryByTitle } as unknown as OrchestrationRuntime
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe("projectPersistedCompactionSummary", () => {
  it("projects the exact persisted summary into structured and session memory", async () => {
    const cwd = await createTemporaryWorkspace()
    const upsertMemoryByTitle = vi.fn().mockResolvedValue(undefined)
    const summary: SessionMessage = {
      id: "summary-1",
      role: "assistant",
      summary: true,
      ts: 1,
      content: `
## Durable Instructions and Preferences
- Always use pnpm for this project.

## Pending Work
- Verify durable replay after an interrupted write.
`,
    }

    const result = await projectPersistedCompactionSummary({
      session: createSession(summary),
      summaryMessageId: summary.id,
      cwd,
      config: {
        memory: {
          sessionMemoryEnabled: true,
          sessionMemoryMaxChars: 48_000,
        },
      } as NexusConfig,
      orchestrationRuntime: createRuntime(upsertMemoryByTitle),
      sessionMemoryHomeDir: cwd,
    })

    expect(result).toEqual({
      memoryRecords: 2,
      sessionMemoryUpdated: true,
      diagnostics: [],
    })
    expect(upsertMemoryByTitle).toHaveBeenCalledTimes(2)
    expect(
      upsertMemoryByTitle.mock.calls.every(
        ([memory]) =>
          memory.scope === "session" &&
          memory.metadata?.sessionId === "session-projection",
      ),
    ).toBe(true)
    expect(
      await readSessionMemoryFile("session-projection", cwd, cwd),
    ).toContain("Verify durable replay")
  })

  it("honors disabled session memory while retaining structured projection", async () => {
    const cwd = await createTemporaryWorkspace()
    const upsertMemoryByTitle = vi.fn().mockResolvedValue(undefined)
    const summary: SessionMessage = {
      id: "summary-disabled",
      role: "assistant",
      summary: true,
      ts: 1,
      content: `
## Pending Work
- Validate the disabled session-memory path.
`,
    }

    const result = await projectPersistedCompactionSummary({
      session: createSession(summary),
      summaryMessageId: summary.id,
      cwd,
      config: {
        memory: {
          sessionMemoryEnabled: false,
        },
      } as NexusConfig,
      orchestrationRuntime: createRuntime(upsertMemoryByTitle),
      sessionMemoryHomeDir: cwd,
    })

    expect(result).toEqual({
      memoryRecords: 1,
      sessionMemoryUpdated: false,
      diagnostics: [],
    })
    expect(upsertMemoryByTitle).toHaveBeenCalledTimes(1)
    await expect(
      readSessionMemoryFile("session-projection", cwd, cwd),
    ).resolves.toBe("")
  })

  it("reports a missing durable summary instead of projecting another message", async () => {
    const cwd = await createTemporaryWorkspace()
    const upsertMemoryByTitle = vi.fn()
    const result = await projectPersistedCompactionSummary({
      session: createSession({
        id: "different-summary",
        role: "assistant",
        summary: true,
        ts: 1,
        content: "## Pending Work\n- Keep the exact summary identity durable.",
      }),
      summaryMessageId: "missing-summary",
      cwd,
      config: {} as NexusConfig,
      orchestrationRuntime: createRuntime(upsertMemoryByTitle),
      sessionMemoryHomeDir: cwd,
    })

    expect(result.memoryRecords).toBe(0)
    expect(result.sessionMemoryUpdated).toBe(false)
    expect(result.diagnostics).toEqual([
      "Persisted compaction summary missing-summary was not found",
    ])
    expect(upsertMemoryByTitle).not.toHaveBeenCalled()
  })
})
