import { describe, expect, it } from "vitest"

import {
  assertChangeSetTransition,
  hashChangeProposal,
  hashFileContent,
  hashWorkspaceIdentity,
  normalizeChangePath,
} from "./hash.js"
import type {
  ChangeFileRecord,
  ChangeIdentity,
  FileStateRef,
} from "./types.js"

const identity: ChangeIdentity = {
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  runId: "run-1",
  messageId: "message-1",
  partId: "part-tool-1",
  toolCallId: "tool-1",
}

const before = hashFileContent("before\n")
const after = hashFileContent("after\n")

function file(
  path: string,
  overrides: Partial<ChangeFileRecord> = {},
): ChangeFileRecord {
  return {
    path,
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
    hunks: [{
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      patch: "@@ -1 +1 @@\n-before\n+after",
    }],
    binary: false,
    ...overrides,
  }
}

describe("change proposal hashing", () => {
  it("hashes exact bytes and canonical workspace identity", () => {
    expect(hashFileContent(Buffer.from([0, 1, 2]))).toEqual({
      hash: "ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc",
      byteLength: 3,
    })
    expect(hashWorkspaceIdentity("/workspace/project")).toBe(
      hashWorkspaceIdentity("/workspace/project"),
    )
    expect(hashWorkspaceIdentity("/workspace/project")).not.toBe(
      hashWorkspaceIdentity("/workspace/project-other"),
    )
  })

  it("is stable across file ordering and platform separators", () => {
    const first = hashChangeProposal(identity, [
      file("src/b.ts"),
      file("src\\a.ts"),
    ])
    const second = hashChangeProposal(identity, [
      file("src/a.ts"),
      file("src/b.ts"),
    ])

    expect(first).toBe(second)
    expect(normalizeChangePath("src\\nested\\file.ts")).toBe(
      "src/nested/file.ts",
    )
  })

  it.each([
    ["before existence", () => file("file.ts", {
      before: { exists: false, hash: null, blob: null, byteLength: 0, mode: null },
      applyBase: { exists: false, hash: null, blob: null, byteLength: 0, mode: null },
      operation: "create",
    })],
    ["before hash", () => file("file.ts", {
      before: {
        exists: true,
        hash: "0".repeat(64),
        blob: "0".repeat(64),
        byteLength: before.byteLength,
        mode: 0o644,
      },
    })],
    ["after mode", () => file("file.ts", {
      after: {
        exists: true,
        hash: after.hash,
        blob: after.hash,
        byteLength: after.byteLength,
        mode: 0o755,
      },
    })],
    ["operation", () => file("file.ts", {
      operation: "rename",
      oldPath: "old.ts",
      targetBase: {
        exists: false,
        hash: null,
        blob: null,
        byteLength: 0,
        mode: null,
      },
    })],
    ["hunk", () => file("file.ts", {
      hunks: [{
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 1,
        patch: "@@ -2 +2 @@\n-before\n+after",
      }],
    })],
    ["binary marker", () => file("file.ts", {
      binary: true,
      hunks: [],
    })],
    ["omission", () => file("file.ts", {
      omission: { reason: "oversize", detail: "not embedded" },
    })],
  ])("changes when %s changes", (_label, mutate) => {
    const baseline = hashChangeProposal(identity, [file("file.ts")])
    expect(hashChangeProposal(identity, [mutate()])).not.toBe(baseline)
  })

  it("uses length-delimited identity fields", () => {
    const first = hashChangeProposal(
      { ...identity, sessionId: "ab", turnId: "c" },
      [file("file.ts")],
    )
    const second = hashChangeProposal(
      { ...identity, sessionId: "a", turnId: "bc" },
      [file("file.ts")],
    )
    expect(first).not.toBe(second)
  })

  it.each([
    "../escape.ts",
    "/absolute.ts",
    ".",
    "",
    "safe/../../escape.ts",
    "nul\0path.ts",
  ])("rejects a non-canonical proposal path: %s", (path) => {
    expect(() => hashChangeProposal(identity, [file(path)])).toThrow(
      /path|relative|canonical|escape/i,
    )
  })

  it("rejects duplicate canonical paths and inconsistent file states", () => {
    expect(() =>
      hashChangeProposal(identity, [
        file("src\\same.ts"),
        file("src/same.ts"),
      ]),
    ).toThrow(/duplicate/i)

    expect(() =>
      hashChangeProposal(identity, [
        file("missing.ts", {
          before: {
            exists: false,
            hash: before.hash,
            blob: before.hash,
            byteLength: before.byteLength,
            mode: 0o644,
          } as unknown as FileStateRef,
        }),
      ]),
    ).toThrow(/absent|exist/i)
  })

  it("rejects collisions involving rename source paths", () => {
    expect(() =>
      hashChangeProposal(identity, [
        file("new.ts", {
          operation: "rename",
          oldPath: "old.ts",
          targetBase: {
            exists: false,
            hash: null,
            blob: null,
            byteLength: 0,
            mode: null,
          },
        }),
        file("old.ts"),
      ]),
    ).toThrow(/duplicate|collision/i)
  })
})

describe("change-set transition validation", () => {
  it.each([
    ["proposed", "approved"],
    ["proposed", "rejected"],
    ["approved", "applying"],
    ["applying", "approved"],
    ["applying", "applied"],
    ["applying", "conflicted"],
    ["applied", "accepted"],
    ["applied", "reverting"],
    ["reverting", "applied"],
    ["reverting", "reverted"],
    ["reverting", "conflicted"],
    ["reverted", "applying"],
  ] as const)("allows recovery-safe %s → %s", (from, to) => {
    expect(() => assertChangeSetTransition(from, to)).not.toThrow()
  })

  it.each([
    ["proposed", "applied"],
    ["approved", "reverted"],
    ["applied", "approved"],
    ["accepted", "reverting"],
    ["rejected", "approved"],
    ["reverted", "approved"],
    ["conflicted", "applied"],
  ] as const)("rejects illegal %s → %s", (from, to) => {
    expect(() => assertChangeSetTransition(from, to)).toThrow(
      /transition/i,
    )
  })
})
