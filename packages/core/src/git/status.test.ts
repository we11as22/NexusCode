import { describe, expect, it } from "vitest"

import { GitStatusParseError, parseGitStatusV2 } from "./status.js"

function statusOutput(...records: string[]): Buffer {
  return Buffer.from(`${records.join("\0")}\0`, "utf8")
}

describe("parseGitStatusV2", () => {
  it("parses branch headers and ordinary staged/unstaged entries", () => {
    const parsed = parseGitStatusV2(statusOutput(
      "# branch.oid 0123456789abcdef",
      "# branch.head feature/complete-status",
      "# branch.upstream origin/feature/complete-status",
      "# branch.ab +12 -3",
      "1 MM S.MU 100644 100755 100755 aaaaa bbbbb src/file with spaces.ts",
    ))

    expect(parsed).toMatchObject({
      oid: "0123456789abcdef",
      branch: "feature/complete-status",
      upstream: "origin/feature/complete-status",
      ahead: 12,
      behind: 3,
      unborn: false,
      detached: false,
      entries: [
        {
          kind: "ordinary",
          path: "src/file with spaces.ts",
          indexStatus: "M",
          worktreeStatus: "M",
          headMode: "100644",
          indexMode: "100755",
          worktreeMode: "100755",
          headOid: "aaaaa",
          indexOid: "bbbbb",
          submodule: {
            isSubmodule: true,
            commitChanged: false,
            modified: true,
            untracked: true,
          },
        },
      ],
    })
  })

  it("parses rename source paths and preserves newlines in NUL-delimited paths", () => {
    const parsed = parseGitStatusV2(statusOutput(
      "# branch.oid 0123456789abcdef",
      "# branch.head main",
      "2 R. N... 100644 100644 100644 aaaaa bbbbb R100 renamed\nfile.ts",
      "old file.ts",
      "? untracked\nfile.txt",
      "! ignored file.bin",
    ))

    expect(parsed.entries).toEqual([
      expect.objectContaining({
        kind: "rename",
        path: "renamed\nfile.ts",
        originalPath: "old file.ts",
        score: { kind: "rename", percent: 100 },
      }),
      expect.objectContaining({
        kind: "untracked",
        path: "untracked\nfile.txt",
      }),
      expect.objectContaining({
        kind: "ignored",
        path: "ignored file.bin",
      }),
    ])
  })

  it("parses unmerged stages, detached HEAD, and unborn branches", () => {
    const unmerged = parseGitStatusV2(statusOutput(
      "# branch.oid 0123456789abcdef",
      "# branch.head (detached)",
      "u UU N... 100644 100644 100644 100644 one two three conflicted.ts",
    ))
    expect(unmerged).toMatchObject({
      detached: true,
      unborn: false,
      entries: [
        {
          kind: "unmerged",
          path: "conflicted.ts",
          indexStatus: "U",
          worktreeStatus: "U",
          stage1Mode: "100644",
          stage2Mode: "100644",
          stage3Mode: "100644",
          worktreeMode: "100644",
          stage1Oid: "one",
          stage2Oid: "two",
          stage3Oid: "three",
        },
      ],
    })

    const unborn = parseGitStatusV2(statusOutput(
      "# branch.oid (initial)",
      "# branch.head new-repository",
    ))
    expect(unborn).toMatchObject({
      branch: "new-repository",
      unborn: true,
      detached: false,
      entries: [],
    })
    expect(unborn.oid).toBeUndefined()
  })

  it.each([
    ["missing rename source", statusOutput(
      "# branch.oid 0123456789abcdef",
      "2 R. N... 100644 100644 100644 aaaaa bbbbb R100 renamed.ts",
    )],
    ["truncated ordinary record", statusOutput(
      "# branch.oid 0123456789abcdef",
      "1 M. N... 100644",
    )],
    ["invalid ahead/behind header", statusOutput(
      "# branch.oid 0123456789abcdef",
      "# branch.ab +not-a-number -2",
    )],
    ["unknown record kind", statusOutput(
      "# branch.oid 0123456789abcdef",
      "x impossible",
    )],
  ])("rejects malformed status: %s", (_label, output) => {
    expect(() => parseGitStatusV2(output)).toThrow(GitStatusParseError)
  })
})
