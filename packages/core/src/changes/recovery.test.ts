import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { FileChangeSetStore } from "./file-store.js"
import { hashFileContent } from "./hash.js"
import {
  ChangeSetService,
  FileMutationConflictError,
} from "./service.js"
import type {
  CapturedFileState,
  ChangeIdentity,
  ChangeSetFilePort,
  ChangeSetRecord,
  HostFileMutation,
} from "./types.js"

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-change-recovery-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  )
})

function missing(): CapturedFileState {
  return { exists: false, content: null, mode: null }
}

function existing(content: string): CapturedFileState {
  return {
    exists: true,
    content: Buffer.from(content),
    mode: 0o644,
  }
}

function cloneState(state: CapturedFileState): CapturedFileState {
  return state.exists
    ? {
        exists: true,
        content: Buffer.from(state.content),
        mode: state.mode,
      }
    : missing()
}

class RestartableFilePort implements ChangeSetFilePort {
  readonly states = new Map<string, CapturedFileState>()

  set(filePath: string, state: CapturedFileState): void {
    this.states.set(filePath, cloneState(state))
  }

  async readFileState(filePath: string): Promise<CapturedFileState> {
    return cloneState(this.states.get(filePath) ?? missing())
  }

  async applyFileMutation(mutation: HostFileMutation): Promise<void> {
    const current = await this.readFileState(mutation.path)
    const hash = current.exists ? hashFileContent(current.content).hash : null
    if (
      current.exists !== mutation.expected.exists ||
      hash !== mutation.expected.hash
    ) {
      throw new FileMutationConflictError(mutation.path)
    }
    this.set(
      mutation.path,
      mutation.next.exists
        ? {
            exists: true,
            content: Buffer.from(mutation.next.content),
            mode: mutation.next.mode,
          }
        : missing(),
    )
  }
}

const owner: ChangeIdentity = {
  workspaceId: "workspace-recovery",
  sessionId: "session-1",
  turnId: "turn-1",
  runId: "run-1",
  messageId: "message-1",
  partId: "part-1",
  toolCallId: "tool-1",
}

async function preparedHarness() {
  const rootDir = await makeRoot()
  const store = new FileChangeSetStore("workspace-recovery", { rootDir })
  const files = new RestartableFilePort()
  files.set("file.ts", existing("before\n"))
  let id = 0
  let now = 100
  const service = () =>
    new ChangeSetService({
      workspaceId: "workspace-recovery",
      store: new FileChangeSetStore("workspace-recovery", { rootDir }),
      files,
      idFactory: () => `change-${++id}`,
      now: () => ++now,
    })
  const first = service()
  const proposed = await first.propose({
    identity: owner,
    files: [{
      path: "file.ts",
      after: { exists: true, content: "after\n" },
      hunks: [],
      binary: false,
    }],
  })
  const approved = await first.approve(proposed.id, proposed.proposalHash)
  return { store, files, service, approved }
}

async function forceTransition(
  store: FileChangeSetStore,
  record: ChangeSetRecord,
  state: "applying" | "reverting",
): Promise<ChangeSetRecord> {
  const next: ChangeSetRecord = {
    ...record,
    state,
    revision: record.revision + 1,
    updatedAt: record.updatedAt + 1,
  }
  await store.replace(next, record.revision)
  return next
}

describe("ChangeSetService restart recovery", () => {
  it("marks applying as applied when all intended bytes are already present", async () => {
    const { store, files, service, approved } = await preparedHarness()
    await forceTransition(store, approved, "applying")
    files.set("file.ts", existing("after\n"))

    await expect(service().recover(approved.id)).resolves.toMatchObject({
      state: "applied",
    })
  })

  it("returns applying to approved when no intended bytes were written", async () => {
    const { store, service, approved } = await preparedHarness()
    await forceTransition(store, approved, "applying")

    await expect(service().recover(approved.id)).resolves.toMatchObject({
      state: "approved",
    })
  })

  it("retains an ambiguous applying state as a durable conflict", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-recovery", { rootDir })
    const files = new RestartableFilePort()
    files.set("one.ts", existing("one-before\n"))
    files.set("two.ts", existing("two-before\n"))
    let now = 100
    const service = new ChangeSetService({
      workspaceId: "workspace-recovery",
      store,
      files,
      idFactory: () => "change-many",
      now: () => ++now,
    })
    const proposed = await service.propose({
      identity: owner,
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
    const approved = await service.approve(proposed.id, proposed.proposalHash)
    await forceTransition(store, approved, "applying")
    files.set("one.ts", existing("manual-third-state\n"))

    await expect(service.recover(proposed.id)).resolves.toMatchObject({
      state: "conflicted",
      failure: { code: "recovery_ambiguous" },
    })
    await expect(files.readFileState("two.ts")).resolves.toEqual(
      existing("two-before\n"),
    )
  })

  it("safely compensates an unambiguous partial apply after restart", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-recovery", { rootDir })
    const files = new RestartableFilePort()
    files.set("one.ts", existing("one-before\n"))
    files.set("two.ts", existing("two-before\n"))
    let now = 100
    const createService = () => new ChangeSetService({
      workspaceId: "workspace-recovery",
      store: new FileChangeSetStore("workspace-recovery", { rootDir }),
      files,
      idFactory: () => "change-partial",
      now: () => ++now,
    })
    const proposed = await createService().propose({
      identity: owner,
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
    const approved = await createService().approve(
      proposed.id,
      proposed.proposalHash,
    )
    await forceTransition(store, approved, "applying")
    files.set("one.ts", existing("one-after\n"))

    await expect(createService().recover(proposed.id)).resolves.toMatchObject({
      state: "approved",
      failure: { code: "apply_recovered_partial" },
    })
    await expect(files.readFileState("one.ts")).resolves.toEqual(
      existing("one-before\n"),
    )
    await expect(files.readFileState("two.ts")).resolves.toEqual(
      existing("two-before\n"),
    )
  })

  it("marks reverting as reverted when the before-state already reached disk", async () => {
    const { store, files, service, approved } = await preparedHarness()
    const applying = await forceTransition(store, approved, "applying")
    files.set("file.ts", existing("after\n"))
    const applied = await service().recover(applying.id)
    const reverting = await forceTransition(store, applied, "reverting")
    files.set("file.ts", existing("before\n"))

    await expect(service().recover(reverting.id)).resolves.toMatchObject({
      state: "reverted",
    })
  })

  it("reapplies a reverted change for surrounding-transaction compensation", async () => {
    const { files, service, approved } = await preparedHarness()
    const applied = await service().apply(approved.id)
    expect(applied.state).toBe("applied")
    expect(await files.readFileState("file.ts")).toEqual(
      existing("after\n"),
    )

    const reverted = await service().revert(applied.id)
    expect(reverted.state).toBe("reverted")
    expect(await files.readFileState("file.ts")).toEqual(
      existing("before\n"),
    )

    await expect(service().reapply(reverted.id)).resolves.toMatchObject({
      state: "applied",
      failure: undefined,
    })
    expect(await files.readFileState("file.ts")).toEqual(
      existing("after\n"),
    )
  })
})
