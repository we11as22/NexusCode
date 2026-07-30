import { describe, expect, it, vi } from "vitest"

import {
  hashFileContent,
  sameChangeIdentity,
} from "./hash.js"
import {
  ChangeSetApprovalError,
  ChangeSetConflictError,
  ChangeSetService,
  FileMutationConflictError,
  reapplyRevertedChangeSets,
  revertEffectiveChangeSetsAfter,
} from "./service.js"
import type {
  CapturedFileState,
  ChangeIdentity,
  ChangeSetFilePort,
  ChangeSetListQuery,
  ChangeSetRecord,
  ChangeSetStore,
  HostFileMutation,
} from "./types.js"

function absent(): CapturedFileState {
  return { exists: false, content: null, mode: null }
}

function present(
  content: string,
  mode: number | null = 0o644,
): CapturedFileState {
  return {
    exists: true,
    content: Buffer.from(content),
    mode,
  }
}

function stateHash(state: CapturedFileState): string | null {
  return state.exists ? hashFileContent(state.content).hash : null
}

function cloneCaptured(state: CapturedFileState): CapturedFileState {
  return state.exists
    ? {
        exists: true,
        content: Buffer.from(state.content),
        mode: state.mode,
      }
    : absent()
}

class MemoryChangeSetStore implements ChangeSetStore {
  readonly records = new Map<string, ChangeSetRecord>()
  readonly blobs = new Map<string, Buffer>()
  readonly transitions: string[] = []

  async putBlob(hash: string, content: Uint8Array): Promise<void> {
    const bytes = Buffer.from(content)
    if (hashFileContent(bytes).hash !== hash) throw new Error("bad blob hash")
    this.blobs.set(hash, bytes)
  }

  async getBlob(hash: string): Promise<Buffer> {
    const value = this.blobs.get(hash)
    if (!value) throw new Error(`missing blob ${hash}`)
    return Buffer.from(value)
  }

  async insert(record: ChangeSetRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error("duplicate")
    if (
      [...this.records.values()].some((candidate) =>
        sameChangeIdentity(candidate.identity, record.identity),
      )
    ) {
      throw new Error("duplicate identity")
    }
    this.records.set(record.id, structuredClone(record))
    this.transitions.push(record.state)
  }

  async get(id: string): Promise<ChangeSetRecord | undefined> {
    const record = this.records.get(id)
    return record ? structuredClone(record) : undefined
  }

  async list(query: ChangeSetListQuery): Promise<readonly ChangeSetRecord[]> {
    const states = query.states ? new Set(query.states) : undefined
    return [...this.records.values()]
      .filter(
        (record) =>
          record.identity.workspaceId === query.workspaceId &&
          (!query.sessionId || record.identity.sessionId === query.sessionId) &&
          (!query.turnId || record.identity.turnId === query.turnId) &&
          (!states || states.has(record.state)),
      )
      .map((record) => structuredClone(record))
  }

  async replace(
    record: ChangeSetRecord,
    expectedRevision: number,
  ): Promise<void> {
    const current = this.records.get(record.id)
    if (!current || current.revision !== expectedRevision) {
      throw new Error("revision conflict")
    }
    this.records.set(record.id, structuredClone(record))
    this.transitions.push(record.state)
  }
}

class MemoryFilePort implements ChangeSetFilePort {
  readonly files = new Map<string, CapturedFileState>()
  beforeApply?: (mutation: HostFileMutation) => void | Promise<void>
  afterApply?: (mutation: HostFileMutation) => void | Promise<void>
  hideModes = false

  set(filePath: string, state: CapturedFileState): void {
    this.files.set(filePath, cloneCaptured(state))
  }

  async readFileState(filePath: string): Promise<CapturedFileState> {
    const captured = cloneCaptured(this.files.get(filePath) ?? absent())
    return captured.exists && this.hideModes
      ? { ...captured, mode: null }
      : captured
  }

  async applyFileMutation(mutation: HostFileMutation): Promise<void> {
    await this.beforeApply?.(mutation)
    const current = await this.readFileState(mutation.path)
    if (
      current.exists !== mutation.expected.exists ||
      stateHash(current) !== mutation.expected.hash
    ) {
      throw new FileMutationConflictError(mutation.path)
    }
    if (mutation.next.exists) {
      this.set(mutation.path, {
        exists: true,
        content: Buffer.from(mutation.next.content),
        mode: mutation.next.mode,
      })
    } else {
      this.set(mutation.path, absent())
    }
    await this.afterApply?.(mutation)
  }
}

function identity(
  tool: string,
  overrides: Partial<ChangeIdentity> = {},
): ChangeIdentity {
  return {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    messageId: "message-1",
    partId: `part-${tool}`,
    toolCallId: tool,
    ...overrides,
  }
}

function harness(files: Record<string, string> = { "file.ts": "before\n" }) {
  const store = new MemoryChangeSetStore()
  const port = new MemoryFilePort()
  for (const [filePath, content] of Object.entries(files)) {
    port.set(filePath, present(content))
  }
  let nextId = 0
  let now = 100
  const service = new ChangeSetService({
    workspaceId: "workspace-1",
    store,
    files: port,
    idFactory: () => `change-${++nextId}`,
    now: () => ++now,
  })
  return { store, port, service }
}

describe("ChangeSetService", () => {
  it("durably captures before/after blobs before approval", async () => {
    const { service, store } = harness()

    const proposed = await service.propose({
      identity: identity("write-1"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after\n", mode: 0o644 },
        hunks: [],
        binary: false,
      }],
    })

    expect(proposed.state).toBe("proposed")
    expect(store.transitions).toEqual(["proposed"])
    expect(proposed.files[0]).toMatchObject({
      path: "file.ts",
      operation: "modify",
      before: { exists: true, hash: expect.any(String) },
      applyBase: { exists: true, hash: expect.any(String) },
      after: { exists: true, hash: expect.any(String) },
    })
    await expect(
      store.getBlob(proposed.files[0]!.before.blob!),
    ).resolves.toEqual(Buffer.from("before\n"))
    await expect(
      store.getBlob(proposed.files[0]!.after.blob!),
    ).resolves.toEqual(Buffer.from("after\n"))
  })

  it("binds approval to the exact proposal hash and persists denial", async () => {
    const { service } = harness()
    const proposed = await service.propose({
      identity: identity("write-1"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after\n" },
        hunks: [],
        binary: false,
      }],
    })

    await expect(
      service.approve(proposed.id, "0".repeat(64)),
    ).rejects.toBeInstanceOf(ChangeSetApprovalError)
    await expect(service.reject(proposed.id, proposed.proposalHash)).resolves.toMatchObject({
      state: "rejected",
    })
  })

  it("treats an exact repeated tool identity as idempotent and rejects identity reuse", async () => {
    const { service } = harness()
    const request = {
      identity: identity("write-1"),
      files: [{
        path: "file.ts",
        after: { exists: true as const, content: "after\n" },
        hunks: [],
        binary: false,
      }],
    }

    const proposed = await service.propose(request)
    await service.approve(proposed.id, proposed.proposalHash)
    await service.apply(proposed.id)

    await expect(service.propose(request)).resolves.toMatchObject({
      id: proposed.id,
      state: "applied",
      proposalHash: proposed.proposalHash,
    })
    await expect(service.propose({
      ...request,
      files: [{
        ...request.files[0],
        after: { exists: true, content: "different\n" },
      }],
    })).rejects.toThrow(/identity|tool call|different/i)
  })

  it("admits one proposal for an exact tool replay across service instances", async () => {
    const store = new MemoryChangeSetStore()
    const port = new MemoryFilePort()
    port.set("file.ts", present("before\n"))
    const first = new ChangeSetService({
      workspaceId: "workspace-1",
      store,
      files: port,
      idFactory: () => "change-first",
      now: () => 101,
    })
    const second = new ChangeSetService({
      workspaceId: "workspace-1",
      store,
      files: port,
      idFactory: () => "change-second",
      now: () => 102,
    })
    const request = {
      identity: identity("replayed-write"),
      files: [{
        path: "file.ts",
        after: { exists: true as const, content: "after\n" },
        hunks: [],
        binary: false,
      }],
    }

    const results = await Promise.all([
      first.propose(request),
      second.propose(request),
    ])

    expect(results[0]!.id).toBe(results[1]!.id)
    expect(store.records.size).toBe(1)
  })

  it("journals applying before mutation and applied after durable bytes", async () => {
    const { service, store, port } = harness()
    const proposed = await service.propose({
      identity: identity("write-1"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after\n" },
        hunks: [],
        binary: false,
      }],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    const applied = await service.apply(proposed.id)

    expect(applied.state).toBe("applied")
    expect(store.transitions).toEqual([
      "proposed",
      "approved",
      "applying",
      "applied",
    ])
    await expect(port.readFileState("file.ts")).resolves.toEqual(
      present("after\n"),
    )
  })

  it("round-trips create, delete, and rename without touching unrelated paths", async () => {
    const { service, port } = harness({
      "delete.ts": "delete-me\n",
      "rename-from.ts": "rename-me\n",
      "unrelated.ts": "untouched\n",
    })
    const proposed = await service.propose({
      identity: identity("write-operations"),
      files: [
        {
          path: "created.ts",
          after: { exists: true, content: "created\n" },
          hunks: [],
          binary: false,
        },
        {
          path: "delete.ts",
          after: { exists: false },
          hunks: [],
          binary: false,
        },
        {
          path: "rename-to.ts",
          oldPath: "rename-from.ts",
          after: { exists: true, content: "renamed\n" },
          hunks: [],
          binary: false,
        },
      ],
    })

    expect(proposed.files.map((file) => file.operation)).toEqual([
      "create",
      "delete",
      "rename",
    ])
    await service.approve(proposed.id, proposed.proposalHash)
    await service.apply(proposed.id)
    await expect(port.readFileState("created.ts")).resolves.toEqual(
      present("created\n"),
    )
    await expect(port.readFileState("delete.ts")).resolves.toEqual(absent())
    await expect(port.readFileState("rename-from.ts")).resolves.toEqual(absent())
    await expect(port.readFileState("rename-to.ts")).resolves.toEqual(
      present("renamed\n"),
    )

    await service.revert(proposed.id)
    await expect(port.readFileState("created.ts")).resolves.toEqual(absent())
    await expect(port.readFileState("delete.ts")).resolves.toEqual(
      present("delete-me\n"),
    )
    await expect(port.readFileState("rename-from.ts")).resolves.toEqual(
      present("rename-me\n"),
    )
    await expect(port.readFileState("rename-to.ts")).resolves.toEqual(absent())
    await expect(port.readFileState("unrelated.ts")).resolves.toEqual(
      present("untouched\n"),
    )
  })

  it("finalizes an applied change only through explicit acceptance", async () => {
    const { service } = harness()
    const proposed = await service.propose({
      identity: identity("write-1"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after\n" },
        hunks: [],
        binary: false,
      }],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    await service.apply(proposed.id)

    await expect(service.accept(proposed.id)).resolves.toMatchObject({
      state: "accepted",
    })
    await expect(service.accept(proposed.id)).resolves.toMatchObject({
      state: "accepted",
      revision: 4,
    })
    await expect(service.revert(proposed.id)).rejects.toThrow(/accepted/i)
  })

  it("treats a repeated exact revert as an idempotent terminal retry", async () => {
    const { service } = harness()
    const proposed = await service.propose({
      identity: identity("write-1"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after\n" },
        hunks: [],
        binary: false,
      }],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    await service.apply(proposed.id)
    const reverted = await service.revert(proposed.id)

    await expect(service.revert(proposed.id)).resolves.toEqual(reverted)
    await expect(service.accept(proposed.id)).rejects.toThrow(/reverted/i)
  })

  it("recovers interrupted durable transitions before later review", async () => {
    const { service, store, port } = harness()
    const proposed = await service.propose({
      identity: identity("write-1"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after\n" },
        hunks: [],
        binary: false,
      }],
    })
    const approved = await service.approve(
      proposed.id,
      proposed.proposalHash,
    )
    store.records.set(approved.id, {
      ...approved,
      state: "applying",
      revision: approved.revision + 1,
      updatedAt: approved.updatedAt + 1,
    })

    await expect(service.recoverInterrupted()).resolves.toMatchObject([
      { id: approved.id, state: "approved" },
    ])
    await expect(port.readFileState("file.ts")).resolves.toEqual(
      present("before\n"),
    )
  })

  it("preflights every file and preserves all bytes on drift", async () => {
    const { service, port } = harness({
      "one.ts": "one-before\n",
      "two.ts": "two-before\n",
    })
    const proposed = await service.propose({
      identity: identity("write-many"),
      files: [
        {
          path: "one.ts",
          after: { exists: true, content: "one-after\n" },
          hunks: [],
          binary: false,
        },
        {
          path: "two.ts",
          after: { exists: true, content: "two-after\n" },
          hunks: [],
          binary: false,
        },
      ],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    port.set("two.ts", present("manual\n"))

    await expect(service.apply(proposed.id)).rejects.toBeInstanceOf(
      ChangeSetConflictError,
    )
    await expect(port.readFileState("one.ts")).resolves.toEqual(
      present("one-before\n"),
    )
    await expect(port.readFileState("two.ts")).resolves.toEqual(
      present("manual\n"),
    )
    await expect(service.get(proposed.id)).resolves.toMatchObject({
      state: "conflicted",
    })
  })

  it("compensates a partial multi-file apply and returns it to approved", async () => {
    const { service, port } = harness({
      "one.ts": "one-before\n",
      "two.ts": "two-before\n",
    })
    const proposed = await service.propose({
      identity: identity("write-many"),
      files: [
        {
          path: "one.ts",
          after: { exists: true, content: "one-after\n" },
          hunks: [],
          binary: false,
        },
        {
          path: "two.ts",
          after: { exists: true, content: "two-after\n" },
          hunks: [],
          binary: false,
        },
      ],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    let calls = 0
    port.beforeApply = () => {
      calls += 1
      if (calls === 2) throw new Error("second write failed")
    }

    await expect(service.apply(proposed.id)).rejects.toThrow(
      "second write failed",
    )
    await expect(service.get(proposed.id)).resolves.toMatchObject({
      state: "approved",
      failure: { code: "apply_interrupted" },
    })
    await expect(port.readFileState("one.ts")).resolves.toEqual(
      present("one-before\n"),
    )
    await expect(port.readFileState("two.ts")).resolves.toEqual(
      present("two-before\n"),
    )
  })

  it("retains a durable conflict when partial-apply compensation cannot run", async () => {
    const { service, port } = harness({
      "one.ts": "one-before\n",
      "two.ts": "two-before\n",
    })
    const proposed = await service.propose({
      identity: identity("write-many"),
      files: [
        {
          path: "one.ts",
          after: { exists: true, content: "one-after\n" },
          hunks: [],
          binary: false,
        },
        {
          path: "two.ts",
          after: { exists: true, content: "two-after\n" },
          hunks: [],
          binary: false,
        },
      ],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    let calls = 0
    port.beforeApply = () => {
      calls += 1
      if (calls >= 2) throw new Error("write path unavailable")
    }

    await expect(service.apply(proposed.id)).rejects.toBeInstanceOf(
      ChangeSetConflictError,
    )
    await expect(service.get(proposed.id)).resolves.toMatchObject({
      state: "conflicted",
      failure: { code: "apply_partial" },
    })
    await expect(port.readFileState("one.ts")).resolves.toEqual(
      present("one-after\n"),
    )
    await expect(port.readFileState("two.ts")).resolves.toEqual(
      present("two-before\n"),
    )
  })

  it("gives a hunk-derived proposal a distinct exact approval hash", async () => {
    const { service } = harness()
    const first = await service.propose({
      identity: identity("write-hunks-a"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after\n" },
        hunks: [{
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          patch: "@@ -1 +1 @@\n-before\n+after",
        }],
        binary: false,
      }],
    })
    const selected = await service.propose({
      identity: identity("write-hunks-b", {
        messageId: "message-2",
        partId: "part-write-hunks-b",
      }),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "partially-after\n" },
        hunks: [{
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          patch: "@@ -1 +1 @@\n-before\n+partially-after",
        }],
        binary: false,
      }],
    })

    expect(selected.proposalHash).not.toBe(first.proposalHash)
    await expect(
      service.approve(selected.id, first.proposalHash),
    ).rejects.toBeInstanceOf(ChangeSetApprovalError)
  })

  it("recovers a crash after the bytes reached the intended after-state", async () => {
    const { service, port } = harness()
    const proposed = await service.propose({
      identity: identity("write-1"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after\n" },
        hunks: [],
        binary: false,
      }],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    let injected = false
    port.afterApply = () => {
      if (!injected) {
        injected = true
        throw new Error("crash after write")
      }
    }

    await expect(service.apply(proposed.id)).resolves.toMatchObject({
      state: "applied",
    })
  })

  it("returns an interrupted pre-write apply to approved for an explicit retry", async () => {
    const { service, port } = harness()
    const proposed = await service.propose({
      identity: identity("write-1"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after\n" },
        hunks: [],
        binary: false,
      }],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    port.beforeApply = () => {
      throw new Error("crash before write")
    }

    await expect(service.apply(proposed.id)).rejects.toThrow("crash before write")
    await expect(service.get(proposed.id)).resolves.toMatchObject({
      state: "approved",
    })
  })

  it("coalesces repeated same-turn edits to the earliest before-state", async () => {
    const { service, port } = harness()
    const first = await service.propose({
      identity: identity("write-1"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "middle\n" },
        hunks: [],
        binary: false,
      }],
    })
    await service.approve(first.id, first.proposalHash)
    await service.apply(first.id)

    const second = await service.propose({
      identity: identity("write-2"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after\n" },
        hunks: [],
        binary: false,
      }],
    })
    expect(second.supersedes).toBe(first.id)
    expect(second.files[0]?.before.hash).toBe(first.files[0]?.before.hash)
    expect(second.files[0]?.applyBase.hash).toBe(first.files[0]?.after.hash)
    await service.approve(second.id, second.proposalHash)
    await service.apply(second.id)

    await expect(service.listEffectiveApplied({
      sessionId: "session-1",
      turnId: "turn-1",
    })).resolves.toEqual([
      expect.objectContaining({ id: second.id }),
    ])
    await expect(service.revert(second.id)).resolves.toMatchObject({
      state: "reverted",
    })
    await expect(port.readFileState("file.ts")).resolves.toEqual(
      present("before\n"),
    )
    await expect(service.reapply(second.id)).resolves.toMatchObject({
      state: "applied",
    })
    await expect(port.readFileState("file.ts")).resolves.toEqual(
      present("after\n"),
    )
  })

  it("coalesces a same-turn edit of a newly created file as one reversible create", async () => {
    const { service, port } = harness({})
    const created = await service.propose({
      identity: identity("write-create"),
      files: [{
        path: "created.ts",
        after: { exists: true, content: "initial\n" },
        hunks: [],
        binary: false,
      }],
    })
    await service.approve(created.id, created.proposalHash)
    await service.apply(created.id)

    const edited = await service.propose({
      identity: identity("edit-created", {
        messageId: "message-2",
        partId: "part-edit-created",
      }),
      files: [{
        path: "created.ts",
        after: { exists: true, content: "final\n" },
        hunks: [],
        binary: false,
      }],
    })

    expect(edited).toMatchObject({
      supersedes: created.id,
      files: [{
        path: "created.ts",
        operation: "create",
        before: { exists: false },
        applyBase: { exists: true },
        after: { exists: true },
      }],
    })
    await service.approve(edited.id, edited.proposalHash)
    await service.apply(edited.id)
    await expect(port.readFileState("created.ts")).resolves.toEqual(
      present("final\n"),
    )

    await service.revert(edited.id)
    await expect(port.readFileState("created.ts")).resolves.toEqual(absent())
  })

  it("reverts an exact created file when the host cannot report POSIX mode", async () => {
    const { service, port } = harness({})
    const proposed = await service.propose({
      identity: identity("write-mode-unknown"),
      files: [{
        path: "created.txt",
        after: { exists: true, content: "PLAN_OK" },
        hunks: [],
        binary: false,
      }],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    await service.apply(proposed.id)

    port.hideModes = true
    await expect(port.readFileState("created.txt")).resolves.toMatchObject({
      exists: true,
      content: Buffer.from("PLAN_OK"),
      mode: null,
    })
    await expect(service.revert(proposed.id)).resolves.toMatchObject({
      state: "reverted",
    })
    await expect(port.readFileState("created.txt")).resolves.toEqual(absent())
  })

  it("refuses undo after a later manual edit and retains a durable conflict", async () => {
    const { service, port } = harness()
    const proposed = await service.propose({
      identity: identity("write-1"),
      files: [{
        path: "file.ts",
        after: { exists: true, content: "after\n" },
        hunks: [],
        binary: false,
      }],
    })
    await service.approve(proposed.id, proposed.proposalHash)
    await service.apply(proposed.id)
    port.set("file.ts", present("manual\n"))

    await expect(service.revert(proposed.id)).rejects.toBeInstanceOf(
      ChangeSetConflictError,
    )
    await expect(port.readFileState("file.ts")).resolves.toEqual(
      present("manual\n"),
    )
    await expect(service.get(proposed.id)).resolves.toMatchObject({
      state: "conflicted",
    })
  })

  it("serializes competing proposals on one path so only one stale base applies", async () => {
    const { service } = harness()
    const [first, second] = await Promise.all([
      service.propose({
        identity: identity("write-1"),
        files: [{
          path: "file.ts",
          after: { exists: true, content: "one\n" },
          hunks: [],
          binary: false,
        }],
      }),
      service.propose({
        identity: identity("write-2", { messageId: "message-2" }),
        files: [{
          path: "file.ts",
          after: { exists: true, content: "two\n" },
          hunks: [],
          binary: false,
        }],
      }),
    ])
    await service.approve(first.id, first.proposalHash)
    await service.approve(second.id, second.proposalHash)

    const results = await Promise.allSettled([
      service.apply(first.id),
      service.apply(second.id),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  })

  it("reverts only post-checkpoint effective changes and can compensate the batch", async () => {
    const { service, port } = harness({
      "before.ts": "before\n",
      "after-a.ts": "a0\n",
      "after-b.ts": "b0\n",
    })
    const applied: ChangeSetRecord[] = []
    for (const [tool, filePath, content] of [
      ["before", "before.ts", "changed-before\n"],
      ["after-a", "after-a.ts", "a1\n"],
      ["after-b", "after-b.ts", "b1\n"],
    ] as const) {
      const proposed = await service.propose({
        identity: identity(tool, {
          turnId: `turn-${tool}`,
          messageId: `message-${tool}`,
          partId: `part-${tool}`,
        }),
        files: [{
          path: filePath,
          after: { exists: true, content },
          hunks: [],
          binary: false,
        }],
      })
      await service.approve(proposed.id, proposed.proposalHash)
      applied.push(await service.apply(proposed.id))
    }
    const cutoff = applied[1]!.createdAt

    const result = await revertEffectiveChangeSetsAfter({
      service,
      sessionId: "session-1",
      createdAtOrAfter: cutoff,
    })

    expect(result.status).toBe("reverted")
    if (result.status !== "reverted") return
    expect(result.reverted.map((record) => record.id)).toEqual([
      applied[2]!.id,
      applied[1]!.id,
    ])
    await expect(port.readFileState("before.ts")).resolves.toEqual(
      present("changed-before\n"),
    )
    await expect(port.readFileState("after-a.ts")).resolves.toEqual(
      present("a0\n"),
    )
    await expect(port.readFileState("after-b.ts")).resolves.toEqual(
      present("b0\n"),
    )

    const compensation = await reapplyRevertedChangeSets({
      service,
      reverted: result.reverted,
    })
    expect(compensation).toEqual({
      stillReverted: [],
      conflicts: [],
    })
    await expect(port.readFileState("after-a.ts")).resolves.toEqual(
      present("a1\n"),
    )
    await expect(port.readFileState("after-b.ts")).resolves.toEqual(
      present("b1\n"),
    )

    const revertedAgain = [
      await service.revert(applied[2]!.id),
      await service.revert(applied[1]!.id),
    ]
    const actualReapply = service.reapply.bind(service)
    const failedId = applied[2]!.id
    const reapply = vi.spyOn(service, "reapply").mockImplementation(
      async (id) => {
        if (id !== failedId) return actualReapply(id)
        const record = await service.get(id)
        if (!record) throw new Error(`missing change set ${id}`)
        return { ...record, state: "conflicted" }
      },
    )
    const incomplete = await reapplyRevertedChangeSets({
      service,
      reverted: revertedAgain,
    })
    reapply.mockRestore()

    expect(incomplete).toEqual({
      stillReverted: [
        expect.objectContaining({ id: failedId }),
      ],
      conflicts: [{
        changeSetId: failedId,
        paths: ["after-b.ts"],
        message:
          `Failed to compensate checkpoint restore: ` +
          `change set ${failedId} recovered to conflicted`,
      }],
    })

    await service.reapply(failedId)
    const actualRevert = service.revert.bind(service)
    const revert = vi.spyOn(service, "revert").mockImplementation(
      async (id) => {
        if (id !== failedId) return actualRevert(id)
        const record = await service.get(id)
        if (!record) throw new Error(`missing change set ${id}`)
        return { ...record, state: "conflicted" }
      },
    )
    const failedBatch = await revertEffectiveChangeSetsAfter({
      service,
      sessionId: "session-1",
      createdAtOrAfter: cutoff,
    })
    revert.mockRestore()

    expect(failedBatch).toEqual({
      status: "conflicted",
      reverted: [],
      conflicts: [{
        changeSetId: failedId,
        paths: ["after-b.ts"],
        message: `change set ${failedId} recovered to conflicted`,
      }],
    })
  })
})
