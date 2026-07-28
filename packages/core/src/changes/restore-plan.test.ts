import { describe, expect, it } from "vitest"

import { hashChangeProposal, hashFileContent } from "./hash.js"
import { buildChangeSetRestorePlan } from "./restore-plan.js"
import type {
  ChangeFileRecord,
  ChangeIdentity,
  ChangeSetRecord,
  FileStateRef,
} from "./types.js"

const identity: ChangeIdentity = {
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  runId: "run-1",
  messageId: "message-1",
  partId: "part-1",
  toolCallId: "tool-1",
}

function ref(content: string): FileStateRef {
  const digest = hashFileContent(content)
  return {
    exists: true,
    hash: digest.hash,
    blob: digest.hash,
    byteLength: digest.byteLength,
    mode: 0o644,
  }
}

const absent: FileStateRef = {
  exists: false,
  hash: null,
  blob: null,
  byteLength: 0,
  mode: null,
}

function record(files: readonly ChangeFileRecord[]): ChangeSetRecord {
  return {
    schemaVersion: 1,
    id: "change-1",
    identity,
    proposalHash: hashChangeProposal(identity, files),
    approvedHash: hashChangeProposal(identity, files),
    state: "applied",
    files,
    revision: 3,
    createdAt: 100,
    updatedAt: 103,
  }
}

describe("buildChangeSetRestorePlan", () => {
  it("builds an exact path-selected revert without including sibling files", () => {
    const one: ChangeFileRecord = {
      path: "one.ts",
      operation: "modify",
      before: ref("one-before\n"),
      applyBase: ref("one-before\n"),
      after: ref("one-after\n"),
      hunks: [],
      binary: false,
    }
    const two: ChangeFileRecord = {
      path: "two.ts",
      operation: "modify",
      before: ref("two-before\n"),
      applyBase: ref("two-before\n"),
      after: ref("two-after\n"),
      hunks: [],
      binary: false,
    }

    expect(
      buildChangeSetRestorePlan(record([one, two]), {
        direction: "revert",
        paths: ["two.ts"],
      }),
    ).toEqual({
      changeSetId: "change-1",
      proposalHash: expect.any(String),
      direction: "revert",
      selectedPaths: ["two.ts"],
      mutations: [{
        changePath: "two.ts",
        mutationPath: "two.ts",
        operation: "modify",
        expected: two.after,
        target: two.before,
      }],
    })
  })

  it("keeps both sides of a rename in one indivisible selected item", () => {
    const renamed: ChangeFileRecord = {
      path: "new.ts",
      oldPath: "old.ts",
      operation: "rename",
      before: ref("old\n"),
      applyBase: ref("old\n"),
      targetBase: absent,
      after: ref("new\n"),
      hunks: [],
      binary: false,
    }

    expect(
      buildChangeSetRestorePlan(record([renamed]), {
        direction: "revert",
        paths: ["new.ts"],
      }).mutations,
    ).toEqual([
      {
        changePath: "new.ts",
        mutationPath: "new.ts",
        operation: "rename",
        expected: renamed.after,
        target: absent,
      },
      {
        changePath: "new.ts",
        mutationPath: "old.ts",
        operation: "rename",
        expected: absent,
        target: renamed.before,
      },
    ])
  })

  it("normalizes selections and rejects missing, duplicate, or unsafe paths", () => {
    const file: ChangeFileRecord = {
      path: "src/file.ts",
      operation: "modify",
      before: ref("before\n"),
      applyBase: ref("before\n"),
      after: ref("after\n"),
      hunks: [],
      binary: false,
    }
    const source = record([file])

    expect(
      buildChangeSetRestorePlan(source, {
        direction: "apply",
        paths: ["src\\file.ts"],
      }).selectedPaths,
    ).toEqual(["src/file.ts"])
    expect(() =>
      buildChangeSetRestorePlan(source, {
        direction: "apply",
        paths: ["missing.ts"],
      }),
    ).toThrow(/not part|unknown/i)
    expect(() =>
      buildChangeSetRestorePlan(source, {
        direction: "apply",
        paths: ["src/file.ts", "src\\file.ts"],
      }),
    ).toThrow(/duplicate/i)
    expect(() =>
      buildChangeSetRestorePlan(source, {
        direction: "apply",
        paths: ["../escape.ts"],
      }),
    ).toThrow(/path|escape|relative/i)
  })
})
