import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { execa } from "execa"
import { afterEach, describe, expect, it } from "vitest"

import { GitService } from "./service.js"

const temporaryDirectories: string[] = []

async function makeRepository(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-git-diff-"))
  temporaryDirectories.push(directory)
  await execa("git", ["init", "--initial-branch=main"], { cwd: directory })
  await execa("git", ["config", "user.name", "Nexus Test"], { cwd: directory })
  await execa("git", ["config", "user.email", "nexus@example.test"], {
    cwd: directory,
  })
  return directory
}

async function commitAll(directory: string, message: string): Promise<string> {
  await execa("git", ["add", "-A"], { cwd: directory })
  await execa("git", ["commit", "-m", message], { cwd: directory })
  return (await execa("git", ["rev-parse", "HEAD"], { cwd: directory })).stdout
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe("GitService.diff", () => {
  it("reports combined staged, unstaged, renamed, deleted, and untracked changes", async () => {
    const repository = await makeRepository()
    await fs.writeFile(path.join(repository, "both.txt"), "before\n")
    await fs.writeFile(path.join(repository, "rename-me.txt"), "rename\n")
    await fs.writeFile(path.join(repository, "delete-me.txt"), "delete\n")
    await commitAll(repository, "baseline")

    await fs.writeFile(path.join(repository, "both.txt"), "staged\n")
    await execa("git", ["add", "--", "both.txt"], { cwd: repository })
    await fs.writeFile(path.join(repository, "both.txt"), "unstaged final\n")
    await fs.rename(
      path.join(repository, "rename-me.txt"),
      path.join(repository, "renamed file.txt"),
    )
    await fs.rm(path.join(repository, "delete-me.txt"))
    await execa(
      "git",
      [
        "add",
        "-A",
        "--",
        "rename-me.txt",
        "renamed file.txt",
        "delete-me.txt",
      ],
      { cwd: repository },
    )
    await fs.writeFile(path.join(repository, "untracked\nfile.txt"), "new\n")

    const result = await new GitService(repository).diff({
      scope: "combined",
      detail: "patch",
    })

    expect(result.available).toBe(true)
    expect(result.omissions).toEqual([])
    expect(result.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "both.txt",
        status: "modified",
        staged: true,
        unstaged: true,
        binary: false,
        patch: expect.stringContaining("+unstaged final"),
      }),
      expect.objectContaining({
        path: "renamed file.txt",
        oldPath: "rename-me.txt",
        status: "renamed",
        staged: true,
      }),
      expect.objectContaining({
        path: "delete-me.txt",
        status: "deleted",
      }),
      expect.objectContaining({
        path: "untracked\nfile.txt",
        status: "added",
        staged: false,
        unstaged: true,
        patch: expect.stringContaining("+new"),
      }),
    ]))
  })

  it("represents binary and oversize untracked files without claiming no changes", async () => {
    const repository = await makeRepository()
    await fs.writeFile(path.join(repository, "binary.bin"), Buffer.from([0, 1, 2, 3]))
    await fs.writeFile(path.join(repository, "oversize.txt"), "0123456789abcdef")

    const result = await new GitService(repository, {
      diffLimits: {
        maxFileBytes: 8,
        maxTotalPatchBytes: 1024,
        maxFiles: 20,
      },
    }).diff({
      scope: "combined",
      detail: "patch",
    })

    expect(result.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "binary.bin",
        status: "added",
        binary: true,
        omission: expect.objectContaining({ reason: "binary" }),
      }),
      expect.objectContaining({
        path: "oversize.txt",
        status: "added",
        binary: false,
        omission: expect.objectContaining({ reason: "oversize" }),
      }),
    ]))
    expect(result.files.find((file) => file.path === "binary.bin")).not.toHaveProperty("patch")
    expect(result.files.find((file) => file.path === "oversize.txt")).not.toHaveProperty("patch")
    expect(result.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "binary.bin", reason: "binary" }),
      expect.objectContaining({ path: "oversize.txt", reason: "oversize" }),
    ]))
  })

  it("shows files in an unborn repository and never invokes configured external diff helpers", async () => {
    const repository = await makeRepository()
    const marker = path.join(repository, "external-helper-ran")
    const helper = path.join(repository, "external-helper")
    await fs.writeFile(
      helper,
      `#!/bin/sh\ntouch '${marker.replaceAll("'", "'\\''")}'\n`,
      { mode: 0o700 },
    )
    await execa("git", ["config", "diff.external", helper], { cwd: repository })
    await fs.writeFile(path.join(repository, "first.txt"), "first\n")
    await execa("git", ["add", "--", "first.txt"], { cwd: repository })
    await fs.writeFile(path.join(repository, "first.txt"), "final\n")
    await fs.writeFile(path.join(repository, "second.txt"), "second\n")

    const result = await new GitService(repository).diff({
      scope: "combined",
      detail: "patch",
    })

    expect(result.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "first.txt",
        status: "added",
        patch: expect.stringContaining("+final"),
      }),
      expect.objectContaining({
        path: "second.txt",
        status: "added",
        patch: expect.stringContaining("+second"),
      }),
    ]))
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("returns a bounded range diff between two revisions", async () => {
    const repository = await makeRepository()
    await fs.writeFile(path.join(repository, "range.txt"), "one\n")
    const first = await commitAll(repository, "first")
    await fs.writeFile(path.join(repository, "range.txt"), "two\n")
    const second = await commitAll(repository, "second")

    const result = await new GitService(repository).diff({
      scope: "range",
      from: first,
      to: second,
      detail: "patch",
    })

    expect(result.files).toEqual([
      expect.objectContaining({
        path: "range.txt",
        status: "modified",
        staged: false,
        unstaged: false,
        patch: expect.stringContaining("+two"),
      }),
    ])
  })

  it("uses merge-base semantics for topic-branch review", async () => {
    const repository = await makeRepository()
    await fs.writeFile(path.join(repository, "shared.txt"), "baseline\n")
    await commitAll(repository, "baseline")
    await execa("git", ["switch", "-c", "topic"], { cwd: repository })
    await fs.writeFile(path.join(repository, "topic.txt"), "topic\n")
    await commitAll(repository, "topic change")
    await execa("git", ["switch", "main"], { cwd: repository })
    await fs.writeFile(path.join(repository, "main-only.txt"), "main\n")
    await commitAll(repository, "main change after divergence")
    await execa("git", ["switch", "topic"], { cwd: repository })

    const result = await new GitService(repository).diff({
      scope: "range",
      from: "main",
      to: "HEAD",
      mergeBase: true,
      detail: "patch",
    })

    expect(result.files.map((file) => file.path)).toEqual(["topic.txt"])
  })

  it("keeps staged and working-tree scopes distinct for the same file", async () => {
    const repository = await makeRepository()
    await fs.writeFile(path.join(repository, "layers.txt"), "before\n")
    await commitAll(repository, "baseline")
    await fs.writeFile(path.join(repository, "layers.txt"), "staged\n")
    await execa("git", ["add", "--", "layers.txt"], { cwd: repository })
    await fs.writeFile(path.join(repository, "layers.txt"), "working\n")

    const service = new GitService(repository)
    const [staged, working] = await Promise.all([
      service.diff({ scope: "staged", detail: "patch" }),
      service.diff({ scope: "working", detail: "patch" }),
    ])

    expect(staged.files).toEqual([
      expect.objectContaining({
        path: "layers.txt",
        staged: true,
        unstaged: true,
        patch: expect.stringContaining("+staged"),
      }),
    ])
    expect(staged.files[0]?.patch).not.toContain("+working")
    expect(working.files).toEqual([
      expect.objectContaining({
        path: "layers.txt",
        staged: true,
        unstaged: true,
        patch: expect.stringContaining("+working"),
      }),
    ])
    expect(working.files[0]?.patch).not.toContain("-before")
  })

  it("keeps conflicted files visible after a failed merge", async () => {
    const repository = await makeRepository()
    await fs.writeFile(path.join(repository, "conflict.txt"), "base\n")
    await commitAll(repository, "baseline")
    await execa("git", ["switch", "-c", "other"], { cwd: repository })
    await fs.writeFile(path.join(repository, "conflict.txt"), "other\n")
    await commitAll(repository, "other")
    await execa("git", ["switch", "main"], { cwd: repository })
    await fs.writeFile(path.join(repository, "conflict.txt"), "main\n")
    await commitAll(repository, "main")
    await execa("git", ["merge", "other"], {
      cwd: repository,
      reject: false,
    })

    const service = new GitService(repository)
    const status = await service.status()
    const result = await service.diff({
      scope: "combined",
      detail: "patch",
    })

    expect(status.operation).toBe("merge")
    expect(result.files).toEqual([
      expect.objectContaining({
        path: "conflict.txt",
        status: "unmerged",
        patch: expect.stringContaining("conflict.txt"),
      }),
    ])
  })

  it("does not follow an untracked symlink and discloses file/count byte caps", async () => {
    const repository = await makeRepository()
    const outside = path.join(repository, "..", `${path.basename(repository)}-secret`)
    await fs.writeFile(outside, "outside\n")
    temporaryDirectories.push(outside)
    await fs.symlink(outside, path.join(repository, "linked-secret"))
    await fs.writeFile(path.join(repository, "one.txt"), "one\n")
    await fs.writeFile(path.join(repository, "two.txt"), "two\n")

    const limited = await new GitService(repository, {
      diffLimits: {
        maxFiles: 2,
        maxFileBytes: 1024,
        maxPatchBytesPerFile: 1024,
        maxTotalPatchBytes: 32,
      },
    }).diff({
      scope: "combined",
      detail: "patch",
    })

    expect(limited.files).toHaveLength(2)
    expect(limited.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "file_limit" }),
      expect.objectContaining({
        path: "linked-secret",
        reason: "unsupported",
      }),
    ]))
    expect(limited.files.find((file) => file.path === "linked-secret")).not.toHaveProperty("patch")
  })
})
