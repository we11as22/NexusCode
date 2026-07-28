import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  ChangeSetService,
  FileMutationConflictError,
  hashFileContent,
  type CapturedFileState,
  type HostFileMutation,
} from "@nexuscode/core"
import { NexusStateDatabase } from "@nexuscode/state"

import { SqliteChangeSetStore } from "./sqlite-change-set-store.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openDatabase(): {
  database: NexusStateDatabase
  path: string
} {
  const directory = mkdtempSync(
    join(tmpdir(), "nexus-sqlite-changes-"),
  )
  temporaryDirectories.push(directory)
  const path = join(directory, "state.sqlite")
  return {
    database: NexusStateDatabase.open({ path }),
    path,
  }
}

function memoryFiles(initial: Record<string, string>) {
  const files = new Map(
    Object.entries(initial).map(([path, content]) => [
      path,
      Buffer.from(content),
    ]),
  )
  return {
    async readFileState(path: string): Promise<CapturedFileState> {
      const content = files.get(path)
      return content
        ? { exists: true, content: Buffer.from(content), mode: 0o644 }
        : { exists: false, content: null, mode: null }
    },
    async applyFileMutation(mutation: HostFileMutation): Promise<void> {
      const current = files.get(mutation.path)
      if (mutation.expected.exists) {
        if (!current) throw new FileMutationConflictError(mutation.path)
        const digest = hashFileContent(current)
        if (
          digest.hash !== mutation.expected.hash ||
          digest.byteLength !== mutation.expected.byteLength
        ) {
          throw new FileMutationConflictError(mutation.path)
        }
      } else if (current) {
        throw new FileMutationConflictError(mutation.path)
      }
      if (mutation.next.exists) {
        files.set(mutation.path, Buffer.from(mutation.next.content))
      } else {
        files.delete(mutation.path)
      }
    },
    files,
  }
}

describe("SqliteChangeSetStore", () => {
  it("coalesces an exact concurrent tool replay across service instances", async () => {
    const opened = openDatabase()
    try {
      const port = memoryFiles({ "file.ts": "before" })
      const store = new SqliteChangeSetStore(
        opened.database,
        "workspace-hash",
      )
      const first = new ChangeSetService({
        workspaceId: "workspace-hash",
        store,
        files: port,
        idFactory: () => "change-first",
        now: () => 123,
      })
      const second = new ChangeSetService({
        workspaceId: "workspace-hash",
        store,
        files: port,
        idFactory: () => "change-second",
        now: () => 124,
      })
      const request = {
        identity: {
          workspaceId: "workspace-hash",
          sessionId: "session-1",
          turnId: "turn-1",
          runId: "run-1",
          messageId: "message-1",
          partId: "part-1",
          toolCallId: "call-1",
        },
        files: [{
          path: "file.ts",
          after: {
            exists: true as const,
            content: "after",
            mode: 0o644,
          },
          hunks: [],
          binary: false,
        }],
      }

      const results = await Promise.all([
        first.propose(request),
        second.propose(request),
      ])

      expect(results[0]!.id).toBe(results[1]!.id)
      await expect(
        store.list({
          workspaceId: "workspace-hash",
          sessionId: "session-1",
        }),
      ).resolves.toHaveLength(1)
    } finally {
      opened.database.close()
    }
  })

  it("persists exact proposals, blobs, and CAS revisions across reopen", async () => {
    const opened = openDatabase()
    const port = memoryFiles({ "file.ts": "before" })
    const store = new SqliteChangeSetStore(
      opened.database,
      "workspace-hash",
    )
    const service = new ChangeSetService({
      workspaceId: "workspace-hash",
      store,
      files: port,
      idFactory: () => "change-1",
      now: () => 123,
    })

    const proposed = await service.propose({
      identity: {
        workspaceId: "workspace-hash",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        messageId: "message-1",
        partId: "part-1",
        toolCallId: "call-1",
      },
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after", mode: 0o644 },
        hunks: [],
        binary: false,
      }],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    const applied = await service.apply(proposed.id)
    expect(applied.state).toBe("applied")
    expect(port.files.get("file.ts")?.toString("utf8")).toBe("after")

    opened.database.close()
    const reopened = NexusStateDatabase.open({ path: opened.path })
    try {
      const durable = await new SqliteChangeSetStore(
        reopened,
        "workspace-hash",
      ).get("change-1")
      expect(durable).toMatchObject({
        id: "change-1",
        proposalHash: proposed.proposalHash,
        state: "applied",
        revision: 3,
      })
    } finally {
      reopened.close()
    }
  })

  it("rejects stale compare-and-swap revisions", async () => {
    const opened = openDatabase()
    try {
      const port = memoryFiles({ "file.ts": "before" })
      const store = new SqliteChangeSetStore(
        opened.database,
        "workspace-hash",
      )
      const service = new ChangeSetService({
        workspaceId: "workspace-hash",
        store,
        files: port,
        idFactory: () => "change-1",
        now: () => 123,
      })
      const proposed = await service.propose({
        identity: {
          workspaceId: "workspace-hash",
          sessionId: "session-1",
          turnId: "turn-1",
          runId: "run-1",
          messageId: "message-1",
          partId: "part-1",
          toolCallId: "call-1",
        },
        files: [{
          path: "file.ts",
          after: { exists: true, content: "after", mode: 0o644 },
          hunks: [],
          binary: false,
        }],
      })
      const approved = await service.approve(
        proposed.id,
        proposed.proposalHash,
      )

      await expect(
        store.replace(
          { ...approved, revision: 2, state: "applying" },
          0,
        ),
      ).rejects.toThrow(/revision|conflict/i)
    } finally {
      opened.database.close()
    }
  })

  it("fails closed instead of returning a silently truncated change list", async () => {
    const opened = openDatabase()
    try {
      const port = memoryFiles({
        "first.ts": "before",
        "second.ts": "before",
      })
      let sequence = 0
      const store = new SqliteChangeSetStore(
        opened.database,
        "workspace-hash",
        { listLimit: 1 },
      )
      const service = new ChangeSetService({
        workspaceId: "workspace-hash",
        store,
        files: port,
        idFactory: () => `change-${++sequence}`,
        now: () => 123 + sequence,
      })
      for (const [turnId, filePath] of [
        ["turn-1", "first.ts"],
        ["turn-2", "second.ts"],
      ] as const) {
        await service.propose({
          identity: {
            workspaceId: "workspace-hash",
            sessionId: "session-1",
            turnId,
            runId: `run-${turnId}`,
            messageId: `message-${turnId}`,
            partId: `part-${turnId}`,
            toolCallId: `call-${turnId}`,
          },
          files: [{
            path: filePath,
            after: { exists: true, content: "after", mode: 0o644 },
            hunks: [],
            binary: false,
          }],
        })
      }

      await expect(
        store.list({
          workspaceId: "workspace-hash",
          sessionId: "session-1",
        }),
      ).rejects.toThrow(/limit|incomplete/i)
    } finally {
      opened.database.close()
    }
  })
})
