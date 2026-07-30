import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { execa } from "execa"
import { describe, expect, it } from "vitest"
import {
  buildReviewInstruction,
  parseReviewRequest,
  resolveReviewRequest,
} from "./review.js"

async function makeRepository(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-review-"))
  await execa("git", ["init", "--initial-branch=main"], { cwd })
  await execa("git", ["config", "user.name", "Nexus Test"], { cwd })
  await execa("git", ["config", "user.email", "nexus@example.test"], { cwd })
  await fs.writeFile(path.join(cwd, "baseline.txt"), "baseline\n")
  await execa("git", ["add", "baseline.txt"], { cwd })
  await execa("git", ["commit", "-m", "baseline"], { cwd })
  return cwd
}

describe("review request", () => {
  it("defaults to uncommitted changes without inventing guidance", () => {
    expect(parseReviewRequest("")).toEqual({
      target: { kind: "uncommitted" },
    })
  })

  it("parses explicit branch and commit targets", () => {
    expect(parseReviewRequest("branch origin/main focus on migrations")).toEqual({
      target: { kind: "branch", base: "origin/main" },
      guidance: "focus on migrations",
    })
    expect(parseReviewRequest("commit deadbeef check auth boundaries")).toEqual({
      target: { kind: "commit", ref: "deadbeef" },
      guidance: "check auth boundaries",
    })
  })

  it("treats free text as guidance for an uncommitted review", () => {
    expect(parseReviewRequest("focus on security and memory leaks")).toEqual({
      target: { kind: "uncommitted" },
      guidance: "focus on security and memory leaks",
    })
    expect(parseReviewRequest("uncommitted focus on tests")).toEqual({
      target: { kind: "uncommitted" },
      guidance: "focus on tests",
    })
  })

  it("treats an unresolved branch token as guidance, not an invented base", async () => {
    const cwd = await makeRepository()
    try {
      await expect(
        resolveReviewRequest(cwd, "branch focus on migrations"),
      ).resolves.toEqual({
        target: { kind: "branch" },
        guidance: "focus on migrations",
      })
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })

  it("resolves existing branch refs and bare commit targets", async () => {
    const cwd = await makeRepository()
    try {
      const sha = (await execa("git", ["rev-parse", "HEAD"], { cwd })).stdout
      await expect(
        resolveReviewRequest(cwd, "branch main focus on tests"),
      ).resolves.toEqual({
        target: { kind: "branch", base: "main" },
        guidance: "focus on tests",
      })
      await expect(resolveReviewRequest(cwd, sha)).resolves.toEqual({
        target: { kind: "commit", ref: sha },
      })
      await expect(
        resolveReviewRequest(cwd, "commit definitely-not-a-ref"),
      ).rejects.toThrow(/not found/i)
      await expect(
        resolveReviewRequest(cwd, "branch base=definitely-not-a-ref"),
      ).rejects.toThrow(/not found/i)
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })

  it("rejects flag-like or malformed explicit Git targets", () => {
    expect(() => parseReviewRequest("branch --output=/tmp/pwn")).toThrow(
      /revision/i,
    )
    expect(() => parseReviewRequest("commit HEAD;touch-pwned")).toThrow(
      /revision/i,
    )
  })

  it("builds a source-backed, read-only findings-first reviewer instruction", () => {
    const prompt = buildReviewInstruction({
      target: { kind: "branch", base: "main" },
      guidance: "pay special attention to cancellation",
    })

    expect(prompt).toContain("dedicated code reviewer")
    expect(prompt).toContain('operation: "diff"')
    expect(prompt).toContain('revision: "main"')
    expect(prompt).toContain("mergeBase: true")
    expect(prompt).toContain("Do not modify files")
    expect(prompt).toContain("P0")
    expect(prompt).toContain("P3")
    expect(prompt).toContain("smallest useful line range")
    expect(prompt).toContain("pay special attention to cancellation")
    expect(prompt).not.toContain("Kilo Code")
  })
})
