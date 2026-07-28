import * as fs from "node:fs/promises"
import * as path from "node:path"

import { GitCommandRunner } from "./runner.js"
import {
  collectGitDiff,
  DEFAULT_GIT_DIFF_LIMITS,
} from "./diff.js"
import { parseGitStatusV2 } from "./status.js"
import type {
  GitCommandRunnerPort,
  GitDiffLimits,
  GitDiffRequest,
  GitDiffResult,
  GitOperation,
  GitStatusSnapshot,
  GitTextInspectRequest,
  GitTextInspectResult,
} from "./types.js"

const EMPTY_STATUS: Omit<GitStatusSnapshot, "available"> = {
  ahead: 0,
  behind: 0,
  unborn: false,
  detached: false,
  entries: [],
  omissions: [],
}

const OPERATION_MARKERS: readonly [string, GitOperation][] = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
]

const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@~^{}:+-]*$/

function validateRevision(revision: string | undefined): void {
  if (revision === undefined) return
  if (
    revision.length === 0 ||
    revision.length > 256 ||
    revision.startsWith("-") ||
    !REVISION_PATTERN.test(revision)
  ) {
    throw new TypeError("Git revision contains unsupported characters")
  }
}

function validatePathspec(pathspec: string | undefined): void {
  if (pathspec === undefined) return
  if (
    pathspec.length === 0 ||
    pathspec.length > 4_096 ||
    pathspec.startsWith("-") ||
    pathspec.includes("\0") ||
    pathspec.includes("\n") ||
    pathspec.includes("\r")
  ) {
    throw new TypeError("Git pathspec is invalid")
  }
}

async function detectOperation(gitDirectory: string): Promise<GitOperation | undefined> {
  for (const [marker, operation] of OPERATION_MARKERS) {
    try {
      await fs.lstat(path.join(gitDirectory, marker))
      return operation
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        return undefined
      }
    }
  }
  return undefined
}

export interface GitServiceOptions {
  runner?: GitCommandRunnerPort
  diffLimits?: Partial<GitDiffLimits>
}

export class GitService {
  readonly #runner: GitCommandRunnerPort
  readonly #diffLimits: GitDiffLimits

  constructor(cwd: string, options: GitServiceOptions = {}) {
    this.#runner = options.runner ?? new GitCommandRunner(cwd)
    this.#diffLimits = {
      ...DEFAULT_GIT_DIFF_LIMITS,
      ...options.diffLimits,
    }
    for (const [name, value] of Object.entries(this.#diffLimits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(
          `Git diff limit ${name} must be a positive safe integer`,
        )
      }
    }
  }

  async status(): Promise<GitStatusSnapshot> {
    const rootResult = await this.#runner.run([
      "rev-parse",
      "--show-toplevel",
    ])
    if (rootResult.exitCode !== 0) {
      return {
        available: false,
        ...EMPTY_STATUS,
      }
    }
    const unresolvedRoot = rootResult.stdout.toString("utf8").trim()
    if (!unresolvedRoot) {
      throw new Error("Git returned an empty repository root")
    }
    const root = await fs.realpath(unresolvedRoot)
    const statusResult = await this.#runner.run([
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--renames",
    ])
    if (statusResult.exitCode !== 0) {
      throw new Error(
        `Git status failed with exit code ${statusResult.exitCode}: ` +
        statusResult.stderr.toString("utf8").trim().slice(0, 1_024),
      )
    }
    const parsed = parseGitStatusV2(statusResult.stdout)

    const gitDirectoryResult = await this.#runner.run([
      "rev-parse",
      "--absolute-git-dir",
    ])
    const gitDirectory =
      gitDirectoryResult.exitCode === 0
        ? gitDirectoryResult.stdout.toString("utf8").trim()
        : ""
    const operation = gitDirectory
      ? await detectOperation(gitDirectory)
      : undefined

    return {
      available: true,
      root,
      ...parsed,
      ...(operation ? { operation } : {}),
      omissions: [],
    }
  }

  async diff(request: GitDiffRequest): Promise<GitDiffResult> {
    return collectGitDiff({
      runner: this.#runner,
      status: await this.status(),
      request,
      limits: this.#diffLimits,
    })
  }

  /**
   * Run one of the small, explicitly read-only textual inspection commands.
   *
   * Keeping argv construction inside the workspace Git boundary means callers
   * never need to quote a shell command and cannot smuggle flags through a
   * revision or pathspec.
   */
  async inspectText(
    request: GitTextInspectRequest,
  ): Promise<GitTextInspectResult> {
    validateRevision(request.revision)
    validatePathspec(request.path)
    if (
      request.limit !== undefined &&
      (
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 200
      )
    ) {
      throw new RangeError("Git log limit must be an integer from 1 to 200")
    }
    if (request.operation === "blame" && !request.path) {
      throw new TypeError("Git blame requires a path")
    }

    let argv: readonly string[]
    switch (request.operation) {
      case "show":
        argv = [
          "--no-optional-locks",
          "show",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--format=fuller",
          request.revision ?? "HEAD",
          ...(request.path ? ["--", request.path] : []),
        ]
        break
      case "log":
        argv = [
          "--no-optional-locks",
          "log",
          "--no-color",
          "--decorate=short",
          "-n",
          String(request.limit ?? 30),
          ...(request.revision ? [request.revision] : []),
          ...(request.path ? ["--", request.path] : []),
        ]
        break
      case "blame":
        argv = [
          "--no-optional-locks",
          "blame",
          "--no-color",
          ...(request.revision ? [request.revision] : []),
          "--",
          request.path!,
        ]
        break
    }

    const result = await this.#runner.run(argv)
    return {
      argv: result.argv,
      output: [result.stdout, result.stderr]
        .filter((value) => value.byteLength > 0)
        .map((value) => value.toString("utf8"))
        .join("\n")
        .trim(),
      exitCode: result.exitCode,
      truncated: result.truncated,
    }
  }
}
