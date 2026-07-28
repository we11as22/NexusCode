import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { hashChangeProposal, hashFileContent } from "./hash.js"
import {
  ChangeSetStoreConflictError,
  ChangeSetStorageCorruptionError,
  FileChangeSetStore,
} from "./file-store.js"
import type {
  ChangeFileRecord,
  ChangeIdentity,
  ChangeSetRecord,
} from "./types.js"

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-change-store-"))
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

function identity(
  suffix: string,
  workspaceId = "workspace-test",
): ChangeIdentity {
  return {
    workspaceId,
    sessionId: "session-1",
    turnId: `turn-${suffix}`,
    runId: `run-${suffix}`,
    messageId: `message-${suffix}`,
    partId: `part-${suffix}`,
    toolCallId: `tool-${suffix}`,
  }
}

function fileRecord(filePath = "src/file.ts"): ChangeFileRecord {
  const before = hashFileContent("before\n")
  const after = hashFileContent("after\n")
  return {
    path: filePath,
    operation: "modify",
    before: {
      exists: true,
      hash: before.hash,
      blob: before.hash,
      byteLength: before.byteLength,
      mode: 0o644,
    },
    applyBase: {
      exists: true,
      hash: before.hash,
      blob: before.hash,
      byteLength: before.byteLength,
      mode: 0o644,
    },
    after: {
      exists: true,
      hash: after.hash,
      blob: after.hash,
      byteLength: after.byteLength,
      mode: 0o644,
    },
    hunks: [],
    binary: false,
  }
}

function record(
  id: string,
  overrides: Partial<ChangeSetRecord> = {},
): ChangeSetRecord {
  const owner = identity(id)
  const files = [fileRecord(`src/${id}.ts`)]
  return {
    schemaVersion: 1,
    id,
    identity: owner,
    proposalHash: hashChangeProposal(owner, files),
    state: "proposed",
    files,
    revision: 0,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

describe("FileChangeSetStore", () => {
  it("persists records and content-addressed blobs across reopen", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-test", { rootDir })
    const content = Buffer.from("before\n")
    const contentHash = hashFileContent(content).hash
    await store.putBlob(contentHash, content)
    await store.insert(record("change-1"))

    const reopened = new FileChangeSetStore("workspace-test", { rootDir })
    await expect(reopened.get("change-1")).resolves.toEqual(record("change-1"))
    await expect(reopened.getBlob(contentHash)).resolves.toEqual(content)
    expect((await fs.stat(reopened.manifestPath)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(reopened.blobPath(contentHash))).mode & 0o777).toBe(0o600)
  })

  it("serializes concurrent inserts without losing either record", async () => {
    const rootDir = await makeRoot()
    const first = new FileChangeSetStore("workspace-test", { rootDir })
    const second = new FileChangeSetStore("workspace-test", { rootDir })

    await Promise.all([
      first.insert(record("change-a")),
      second.insert(record("change-b")),
    ])

    await expect(first.list({ workspaceId: "workspace-test" })).resolves.toEqual([
      record("change-a"),
      record("change-b"),
    ])
  })

  it("atomically rejects a second record for the same execution identity", async () => {
    const rootDir = await makeRoot()
    const firstStore = new FileChangeSetStore("workspace-test", { rootDir })
    const secondStore = new FileChangeSetStore("workspace-test", { rootDir })
    const first = record("change-first")
    const secondFiles = [fileRecord("src/second.ts")]
    const second = record("change-second", {
      identity: first.identity,
      files: secondFiles,
      proposalHash: hashChangeProposal(first.identity, secondFiles),
    })

    const results = await Promise.allSettled([
      firstStore.insert(first),
      secondStore.insert(second),
    ])

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1)
    await expect(
      firstStore.list({ workspaceId: "workspace-test" }),
    ).resolves.toHaveLength(1)
  })

  it("enforces compare-and-swap revisions and workspace ownership", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-test", { rootDir })
    const initial = record("change-1")
    await store.insert(initial)
    const approved: ChangeSetRecord = {
      ...initial,
      state: "approved",
      approvedHash: initial.proposalHash,
      revision: 1,
      updatedAt: 101,
    }

    await expect(store.replace({
      ...approved,
      revision: 8,
    }, 7)).rejects.toBeInstanceOf(
      ChangeSetStoreConflictError,
    )
    await expect(store.replace(approved, 0)).resolves.toBeUndefined()
    await expect(store.get(initial.id)).resolves.toEqual(approved)

    await expect(store.insert(record("other", {
      identity: identity("other", "another-workspace"),
    }))).rejects.toThrow(/workspace/i)
  })

  it("enforces immutable proposal ownership and legal state transitions", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-test", { rootDir })
    const initial = record("change-1")
    await store.insert(initial)

    await expect(store.replace({
      ...initial,
      state: "applied",
      approvedHash: initial.proposalHash,
      revision: 1,
      updatedAt: 101,
    }, 0)).rejects.toThrow(/transition/i)
    await expect(store.replace({
      ...initial,
      identity: {
        ...initial.identity,
        toolCallId: "different-tool",
      },
      revision: 1,
      updatedAt: 101,
    }, 0)).rejects.toThrow(/immutable|proposal|identity/i)
    await expect(store.replace({
      ...initial,
      state: "approved",
      revision: 1,
      updatedAt: 101,
    }, 0)).rejects.toThrow(/approval|approvedHash/i)
  })

  it("recovers a checksum-corrupt primary from the last verified backup", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-test", { rootDir })
    await store.insert(record("change-1"))
    await store.insert(record("change-2"))
    await fs.writeFile(store.manifestPath, '{"schemaVersion":1,"checksum":"bad"}\n')

    const reopened = new FileChangeSetStore("workspace-test", { rootDir })
    await expect(reopened.get("change-1")).resolves.toEqual(record("change-1"))
    await expect(reopened.get("change-2")).resolves.toBeUndefined()
  })

  it("fails closed when both primary and backup manifests are corrupt", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-test", { rootDir })
    await store.insert(record("change-1"))
    await store.insert(record("change-2"))
    await fs.writeFile(store.manifestPath, "{broken")
    await fs.writeFile(`${store.manifestPath}.bak`, "{also-broken")

    await expect(store.get("change-1")).rejects.toBeInstanceOf(
      ChangeSetStorageCorruptionError,
    )
  })

  it("rejects symlinked manifests and blob files", async () => {
    const rootDir = await makeRoot()
    const outside = path.join(rootDir, "outside")
    await fs.writeFile(outside, "outside")

    const manifestStore = new FileChangeSetStore("workspace-test", { rootDir })
    await manifestStore.insert(record("change-1"))
    await fs.rm(manifestStore.manifestPath)
    await fs.symlink(outside, manifestStore.manifestPath)
    await expect(manifestStore.get("change-1")).rejects.toThrow(/symbolic|regular/i)

    const otherStore = new FileChangeSetStore("workspace-blobs", { rootDir })
    const content = Buffer.from("blob")
    const contentHash = hashFileContent(content).hash
    await otherStore.putBlob(contentHash, content)
    const blobPath = otherStore.blobPath(contentHash)
    await fs.rm(blobPath)
    await fs.symlink(outside, blobPath)
    await expect(otherStore.getBlob(contentHash)).rejects.toThrow(/symbolic|regular/i)
  })

  it("deduplicates verified blobs and rejects hash/content mismatches", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-test", { rootDir })
    const content = Buffer.from("same")
    const contentHash = hashFileContent(content).hash

    await store.putBlob(contentHash, content)
    await store.putBlob(contentHash, content)
    await expect(store.getBlob(contentHash)).resolves.toEqual(content)
    await expect(
      store.putBlob(contentHash, Buffer.from("different")),
    ).rejects.toThrow(/hash|content/i)
  })

  it("bounds the number of retained records", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-test", {
      rootDir,
      maxRecords: 1,
    })
    await store.insert(record("change-1"))
    await expect(store.insert(record("change-2"))).rejects.toThrow(
      /record limit/i,
    )
  })

  it("bounds manifest and blob reads before allocating their contents", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-test", {
      rootDir,
      maxManifestBytes: 16 * 1_024,
      maxBlobBytes: 4,
    })
    await expect(
      store.putBlob(hashFileContent("oversize").hash, Buffer.from("oversize")),
    ).rejects.toThrow(/blob.*limit|too large/i)

    await store.insert(record("change-1"))
    await fs.copyFile(store.manifestPath, `${store.manifestPath}.bak`)
    await fs.appendFile(store.manifestPath, "x".repeat(20_000))
    await fs.appendFile(`${store.manifestPath}.bak`, "x".repeat(20_000))
    await expect(store.get("change-1")).rejects.toBeInstanceOf(
      ChangeSetStorageCorruptionError,
    )
  })

  it("retains coalesced apply-base blobs that compensation can require", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-test", { rootDir })
    const beforeContent = Buffer.from("before\n")
    const middleContent = Buffer.from("middle\n")
    const afterContent = Buffer.from("after\n")
    for (const content of [beforeContent, middleContent, afterContent]) {
      await store.putBlob(hashFileContent(content).hash, content)
    }
    const initial = record("change-coalesced")
    const middle = hashFileContent(middleContent)
    const coalescedFile: ChangeFileRecord = {
      ...initial.files[0]!,
      applyBase: {
        exists: true,
        hash: middle.hash,
        blob: middle.hash,
        byteLength: middle.byteLength,
        mode: 0o644,
      },
    }
    const coalesced: ChangeSetRecord = {
      ...initial,
      files: [coalescedFile],
      proposalHash: hashChangeProposal(initial.identity, [coalescedFile]),
    }
    await store.insert(coalesced)
    const oldTime = new Date(Date.now() - 60_000)
    await fs.utimes(store.blobPath(middle.hash), oldTime, oldTime)

    await expect(store.pruneOrphanBlobs(0)).resolves.toMatchObject({
      deleted: [],
    })
    await expect(store.getBlob(middle.hash)).resolves.toEqual(middleContent)
  })

  it("prunes only old unreferenced regular blobs after the grace period", async () => {
    const rootDir = await makeRoot()
    const store = new FileChangeSetStore("workspace-test", { rootDir })
    const oldContent = Buffer.from("old orphan")
    const oldHash = hashFileContent(oldContent).hash
    const recentContent = Buffer.from("recent orphan")
    const recentHash = hashFileContent(recentContent).hash
    await store.putBlob(oldHash, oldContent)
    await store.putBlob(recentHash, recentContent)
    const oldTime = new Date(Date.now() - 60_000)
    await fs.utimes(store.blobPath(oldHash), oldTime, oldTime)

    await expect(store.pruneOrphanBlobs(10_000)).resolves.toMatchObject({
      deleted: [oldHash],
      retained: 1,
      errors: [],
    })
    await expect(fs.lstat(store.blobPath(oldHash))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(store.getBlob(recentHash)).resolves.toEqual(recentContent)
  })
})
