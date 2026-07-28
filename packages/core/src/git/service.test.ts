import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { execa } from "execa"
import { afterEach, describe, expect, it } from "vitest"

import { GitService } from "./service.js"
import type {
  GitCommandRunnerPort,
  GitCommandResult,
} from "./types.js"

const temporaryDirectories: string[] = []

async function makeRepository(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-git-service-"))
  temporaryDirectories.push(directory)
  await execa("git", ["init", "--initial-branch=main"], { cwd: directory })
  await execa("git", ["config", "user.name", "Nexus Test"], { cwd: directory })
  await execa("git", ["config", "user.email", "nexus@example.test"], {
    cwd: directory,
  })
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe("GitService.status", () => {
  it("rejects non-positive or fractional diff limits at construction", () => {
    expect(() =>
      new GitService(".", {
        diffLimits: { maxFiles: 0 },
      }),
    ).toThrow(/limit|positive/i)
    expect(() =>
      new GitService(".", {
        diffLimits: { maxFileBytes: 1.5 },
      }),
    ).toThrow(/limit|integer/i)
  })

  it("distinguishes a non-repository from an unborn clean repository", async () => {
    const nonRepository = await fs.mkdtemp(
      path.join(os.tmpdir(), "nexus-not-git-"),
    )
    temporaryDirectories.push(nonRepository)

    await expect(new GitService(nonRepository).status()).resolves.toMatchObject({
      available: false,
      entries: [],
    })

    const repository = await makeRepository()
    await expect(new GitService(repository).status()).resolves.toMatchObject({
      available: true,
      root: await fs.realpath(repository),
      branch: "main",
      unborn: true,
      entries: [],
    })
  })

  it("returns staged, unstaged, untracked, and rename records exactly", async () => {
    const repository = await makeRepository()
    await fs.writeFile(path.join(repository, "tracked.txt"), "before\n")
    await fs.writeFile(path.join(repository, "rename-me.txt"), "rename\n")
    await execa("git", ["add", "--", "tracked.txt", "rename-me.txt"], {
      cwd: repository,
    })
    await execa("git", ["commit", "-m", "baseline"], { cwd: repository })

    await fs.writeFile(path.join(repository, "tracked.txt"), "staged\n")
    await execa("git", ["add", "--", "tracked.txt"], { cwd: repository })
    await fs.writeFile(path.join(repository, "tracked.txt"), "unstaged\n")
    await fs.rename(
      path.join(repository, "rename-me.txt"),
      path.join(repository, "renamed file.txt"),
    )
    await execa("git", ["add", "-A", "--", "rename-me.txt", "renamed file.txt"], {
      cwd: repository,
    })
    await fs.writeFile(path.join(repository, "untracked\nfile.txt"), "new\n")

    const status = await new GitService(repository).status()

    expect(status.available).toBe(true)
    expect(status.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "ordinary",
        path: "tracked.txt",
        indexStatus: "M",
        worktreeStatus: "M",
      }),
      expect.objectContaining({
        kind: "rename",
        path: "renamed file.txt",
        originalPath: "rename-me.txt",
      }),
      expect.objectContaining({
        kind: "untracked",
        path: "untracked\nfile.txt",
      }),
    ]))
  })
})

describe("GitService.inspectText", () => {
  it("constructs only bounded read-only argv and preserves path characters", async () => {
    const calls: readonly string[][] = []
    const mutableCalls = calls as string[][]
    const runner: GitCommandRunnerPort = {
      async run(argv): Promise<GitCommandResult> {
        mutableCalls.push([...argv])
        return {
          argv,
          exitCode: 0,
          stdout: Buffer.from("inspected"),
          stderr: Buffer.alloc(0),
          timedOut: false,
          truncated: false,
        }
      },
    }
    const service = new GitService(".", { runner })

    await expect(service.inspectText({
      operation: "blame",
      revision: "HEAD~2",
      path: "src/it's-safe.ts",
    })).resolves.toMatchObject({
      output: "inspected",
      exitCode: 0,
    })
    expect(calls).toEqual([[
      "--no-optional-locks",
      "blame",
      "--no-color",
      "HEAD~2",
      "--",
      "src/it's-safe.ts",
    ]])
  })

  it("rejects flag-like revisions and pathspecs at the service boundary", async () => {
    const runner: GitCommandRunnerPort = {
      async run() {
        throw new Error("runner should not be reached")
      },
    }
    const service = new GitService(".", { runner })

    await expect(service.inspectText({
      operation: "show",
      revision: "--help",
    })).rejects.toThrow(/revision/i)
    await expect(service.inspectText({
      operation: "blame",
      path: "-C",
    })).rejects.toThrow(/pathspec/i)
    await expect(service.inspectText({
      operation: "log",
      limit: 201,
    })).rejects.toThrow(/limit/i)
  })
})
