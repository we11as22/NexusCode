import * as fs from "node:fs/promises"
import * as path from "node:path"

import { createTwoFilesPatch } from "diff"

import { GitCommandExecutionError } from "./runner.js"
import type {
  GitCommandRunnerPort,
  GitDiffLimits,
  GitDiffRequest,
  GitDiffResult,
  GitFileDiff,
  GitIndexStatus,
  GitOmission,
  GitStatusEntry,
  GitStatusSnapshot,
} from "./types.js"

export const DEFAULT_GIT_DIFF_LIMITS: GitDiffLimits = Object.freeze({
  maxFiles: 200,
  maxFileBytes: 1024 * 1024,
  maxPatchBytesPerFile: 2 * 1024 * 1024,
  maxTotalPatchBytes: 8 * 1024 * 1024,
})

interface DiffCandidate {
  path: string
  oldPath?: string
  status: GitFileDiff["status"]
  staged: boolean
  unstaged: boolean
  untracked?: boolean
}

function changed(status: GitIndexStatus): boolean {
  return status !== "." && status !== " "
}

function statusForOrdinary(
  entry: Exclude<
    GitStatusEntry,
    { kind: "rename" | "unmerged" | "untracked" | "ignored" }
  >,
  scope: GitDiffRequest["scope"],
): GitFileDiff["status"] {
  const relevant =
    scope === "staged"
      ? entry.indexStatus
      : scope === "working"
        ? entry.worktreeStatus
        : entry.worktreeStatus === "D"
          ? "D"
          : entry.indexStatus
  if (relevant === "A") return "added"
  if (relevant === "D") return "deleted"
  return "modified"
}

function statusCandidates(
  snapshot: GitStatusSnapshot,
  request: GitDiffRequest,
): DiffCandidate[] {
  const selectedPaths = request.paths
    ? new Set(request.paths)
    : undefined
  const candidates: DiffCandidate[] = []
  for (const entry of snapshot.entries) {
    if (entry.kind === "ignored") continue
    if (
      selectedPaths &&
      !selectedPaths.has(entry.path) &&
      (
        entry.kind !== "rename" ||
        !selectedPaths.has(entry.originalPath)
      )
    ) {
      continue
    }
    const staged =
      entry.kind !== "untracked" &&
      changed(entry.indexStatus)
    const unstaged =
      entry.kind === "untracked" ||
      changed(entry.worktreeStatus)
    if (request.scope === "staged" && !staged) continue
    if (request.scope === "working" && !unstaged) continue
    if (entry.kind === "untracked") {
      if (request.scope !== "staged") {
        candidates.push({
          path: entry.path,
          status: "added",
          staged: false,
          unstaged: true,
          untracked: true,
        })
      }
      continue
    }
    if (entry.kind === "unmerged") {
      candidates.push({
        path: entry.path,
        status: "unmerged",
        staged,
        unstaged,
      })
      continue
    }
    if (entry.kind === "rename") {
      candidates.push({
        path: entry.path,
        oldPath: entry.originalPath,
        status:
          entry.score.kind === "copy"
            ? "copied"
            : "renamed",
        staged,
        unstaged,
      })
      continue
    }
    candidates.push({
      path: entry.path,
      status: snapshot.unborn
        ? "added"
        : statusForOrdinary(entry, request.scope),
      staged,
      unstaged,
    })
  }
  return candidates
}

function parseRangeCandidates(output: Uint8Array): DiffCandidate[] {
  const tokens = Buffer.from(output).toString("utf8").split("\0")
  if (tokens.at(-1) === "") tokens.pop()
  const candidates: DiffCandidate[] = []
  for (let index = 0; index < tokens.length;) {
    const rawStatus = tokens[index++]
    const firstPath = tokens[index++]
    if (!rawStatus || firstPath === undefined) {
      throw new Error("Git range diff returned a truncated name-status record")
    }
    if (/^[RC]\d{1,3}$/.test(rawStatus)) {
      const secondPath = tokens[index++]
      if (secondPath === undefined) {
        throw new Error("Git range rename record is missing its destination")
      }
      candidates.push({
        path: secondPath,
        oldPath: firstPath,
        status: rawStatus.startsWith("R") ? "renamed" : "copied",
        staged: false,
        unstaged: false,
      })
      continue
    }
    const status: GitFileDiff["status"] =
      rawStatus === "A"
        ? "added"
        : rawStatus === "D"
          ? "deleted"
          : rawStatus === "U"
            ? "unmerged"
            : "modified"
    candidates.push({
      path: firstPath,
      status,
      staged: false,
      unstaged: false,
    })
  }
  return candidates
}

function pathWithinRoot(root: string, relativePath: string): string | undefined {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    return undefined
  }
  const absolutePath = path.resolve(root, relativePath)
  const fromRoot = path.relative(root, absolutePath)
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(fromRoot)
  ) {
    return undefined
  }
  return absolutePath
}

function omission(
  reason: GitOmission["reason"],
  detail: string,
  filePath?: string,
): GitOmission {
  return {
    reason,
    ...(filePath ? { path: filePath } : {}),
    detail,
  }
}

async function readBoundedRegularFile(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<
  | { kind: "text"; content: string }
  | { kind: "binary" }
  | { kind: "omitted"; omission: GitOmission }
> {
  const absolutePath = pathWithinRoot(root, relativePath)
  if (!absolutePath) {
    return {
      kind: "omitted",
      omission: omission(
        "unsupported",
        "Git returned a path outside the repository root",
        relativePath,
      ),
    }
  }
  let info
  try {
    info = await fs.lstat(absolutePath)
  } catch (error) {
    return {
      kind: "omitted",
      omission: omission(
        "unreadable",
        error instanceof Error ? error.message : String(error),
        relativePath,
      ),
    }
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return {
      kind: "omitted",
      omission: omission(
        "unsupported",
        "Only regular, non-symlink untracked files are read for diffs",
        relativePath,
      ),
    }
  }
  if (info.size > maxBytes) {
    return {
      kind: "omitted",
      omission: omission(
        "oversize",
        `File is ${info.size} bytes; the per-file limit is ${maxBytes}`,
        relativePath,
      ),
    }
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  let handle
  try {
    handle = await fs.open(
      absolutePath,
      fs.constants.O_RDONLY | noFollow,
    )
    const afterOpen = await handle.stat()
    if (!afterOpen.isFile() || afterOpen.size > maxBytes) {
      return {
        kind: "omitted",
        omission: omission(
          afterOpen.size > maxBytes ? "oversize" : "unsupported",
          afterOpen.size > maxBytes
            ? `File grew beyond the ${maxBytes} byte limit`
            : "File is no longer a regular file",
          relativePath,
        ),
      }
    }
    const buffer = Buffer.alloc(afterOpen.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      )
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    if (offset !== buffer.length) {
      return {
        kind: "omitted",
        omission: omission(
          "unreadable",
          "File changed while it was being read",
          relativePath,
        ),
      }
    }
    if (buffer.includes(0)) return { kind: "binary" }
    return { kind: "text", content: buffer.toString("utf8") }
  } catch (error) {
    return {
      kind: "omitted",
      omission: omission(
        "unreadable",
        error instanceof Error ? error.message : String(error),
        relativePath,
      ),
    }
  } finally {
    await handle?.close().catch(() => {})
  }
}

function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  return { additions, deletions }
}

function isBinaryPatch(patch: string): boolean {
  return (
    patch.includes("GIT binary patch") ||
    /Binary files .* differ/.test(patch)
  )
}

function diffArguments(
  request: GitDiffRequest,
  candidate: DiffCandidate,
  unborn: boolean,
): string[] | undefined {
  if (candidate.untracked || unborn) return undefined
  const args = [
    "--no-optional-locks",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--submodule=short",
    "--no-color",
    "--find-renames",
  ]
  if (request.scope === "staged") {
    args.push("--cached")
  } else if (request.scope === "combined") {
    args.push("HEAD")
  } else if (request.scope === "range") {
    if (request.mergeBase) {
      args.push(`${request.from!}...${request.to!}`)
    } else {
      args.push(request.from!, request.to!)
    }
  }
  args.push("--")
  if (candidate.oldPath) args.push(candidate.oldPath)
  args.push(candidate.path)
  return args
}

async function trackedPatch(
  runner: GitCommandRunnerPort,
  request: GitDiffRequest,
  candidate: DiffCandidate,
  unborn: boolean,
  limits: GitDiffLimits,
): Promise<
  | { kind: "patch"; patch: string; binary: boolean }
  | { kind: "omitted"; omission: GitOmission }
> {
  const args = diffArguments(request, candidate, unborn)
  if (!args) {
    return {
      kind: "omitted",
      omission: omission(
        "unsupported",
        "The requested tracked diff cannot be produced for this repository state",
        candidate.path,
      ),
    }
  }
  try {
    const result = await runner.run(args, {
      maxStdoutBytes: limits.maxPatchBytesPerFile,
    })
    if (result.exitCode !== 0) {
      return {
        kind: "omitted",
        omission: omission(
          "unreadable",
          `Git diff exited with code ${result.exitCode}`,
          candidate.path,
        ),
      }
    }
    const patch = result.stdout.toString("utf8")
    return {
      kind: "patch",
      patch,
      binary: isBinaryPatch(patch),
    }
  } catch (error) {
    if (
      error instanceof GitCommandExecutionError &&
      error.kind === "output_limit"
    ) {
      return {
        kind: "omitted",
        omission: omission(
          "byte_limit",
          `Patch exceeded the ${limits.maxPatchBytesPerFile} byte per-file limit`,
          candidate.path,
        ),
      }
    }
    throw error
  }
}

async function candidatePatch(
  runner: GitCommandRunnerPort,
  root: string,
  request: GitDiffRequest,
  candidate: DiffCandidate,
  unborn: boolean,
  limits: GitDiffLimits,
): Promise<
  | { kind: "patch"; patch: string; binary: boolean }
  | { kind: "omitted"; omission: GitOmission }
> {
  if (candidate.untracked || unborn) {
    if (candidate.status === "deleted") {
      return { kind: "patch", patch: "", binary: false }
    }
    const file = await readBoundedRegularFile(
      root,
      candidate.path,
      limits.maxFileBytes,
    )
    if (file.kind === "omitted") return file
    if (file.kind === "binary") {
      return {
        kind: "omitted",
        omission: omission(
          "binary",
          "Binary file content is not embedded in a text diff",
          candidate.path,
        ),
      }
    }
    const patch = createTwoFilesPatch(
      "/dev/null",
      `b/${candidate.path}`,
      "",
      file.content,
      "",
      "",
      { context: 3 },
    )
    if (Buffer.byteLength(patch) > limits.maxPatchBytesPerFile) {
      return {
        kind: "omitted",
        omission: omission(
          "byte_limit",
          `Patch exceeded the ${limits.maxPatchBytesPerFile} byte per-file limit`,
          candidate.path,
        ),
      }
    }
    return { kind: "patch", patch, binary: false }
  }
  return trackedPatch(runner, request, candidate, unborn, limits)
}

async function rangeCandidates(
  runner: GitCommandRunnerPort,
  request: GitDiffRequest,
): Promise<DiffCandidate[]> {
  if (!request.from || !request.to) {
    throw new Error("Range diffs require both from and to revisions")
  }
  const args = [
    "--no-optional-locks",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-status",
    "-z",
    "--find-renames",
    ...(request.mergeBase
      ? [`${request.from}...${request.to}`]
      : [request.from, request.to]),
    "--",
    ...(request.paths ?? []),
  ]
  const result = await runner.run(args)
  if (result.exitCode !== 0) {
    throw new Error(
      `Git range inventory failed with exit code ${result.exitCode}`,
    )
  }
  return parseRangeCandidates(result.stdout)
}

export async function collectGitDiff(input: {
  runner: GitCommandRunnerPort
  status: GitStatusSnapshot
  request: GitDiffRequest
  limits: GitDiffLimits
}): Promise<GitDiffResult> {
  const { runner, status, request, limits } = input
  if (!status.available || !status.root) {
    return {
      available: false,
      files: [],
      additions: 0,
      deletions: 0,
      omissions: [],
    }
  }
  const allCandidates =
    request.scope === "range"
      ? await rangeCandidates(runner, request)
      : statusCandidates(status, request)
  const candidates = allCandidates.slice(0, limits.maxFiles)
  const omissions: GitOmission[] = []
  if (allCandidates.length > candidates.length) {
    omissions.push(omission(
      "file_limit",
      `${allCandidates.length - candidates.length} file(s) omitted after the ${limits.maxFiles} file limit`,
    ))
  }

  const files: GitFileDiff[] = []
  let additions = 0
  let deletions = 0
  let patchBytes = 0
  for (const candidate of candidates) {
    if (request.detail !== "patch") {
      files.push({
        path: candidate.path,
        ...(candidate.oldPath ? { oldPath: candidate.oldPath } : {}),
        status: candidate.status,
        staged: candidate.staged,
        unstaged: candidate.unstaged,
        binary: false,
      })
      continue
    }
    const detail = await candidatePatch(
      runner,
      status.root,
      request,
      candidate,
      status.unborn && request.scope !== "range",
      limits,
    )
    if (detail.kind === "omitted") {
      omissions.push(detail.omission)
      files.push({
        path: candidate.path,
        ...(candidate.oldPath ? { oldPath: candidate.oldPath } : {}),
        status: candidate.status,
        staged: candidate.staged,
        unstaged: candidate.unstaged,
        binary: detail.omission.reason === "binary",
        omission: detail.omission,
      })
      continue
    }
    const currentBytes = Buffer.byteLength(detail.patch)
    if (patchBytes + currentBytes > limits.maxTotalPatchBytes) {
      const itemOmission = omission(
        "byte_limit",
        `Aggregate patches exceeded the ${limits.maxTotalPatchBytes} byte limit`,
        candidate.path,
      )
      omissions.push(itemOmission)
      files.push({
        path: candidate.path,
        ...(candidate.oldPath ? { oldPath: candidate.oldPath } : {}),
        status: candidate.status,
        staged: candidate.staged,
        unstaged: candidate.unstaged,
        binary: detail.binary,
        omission: itemOmission,
      })
      continue
    }
    patchBytes += currentBytes
    const counts = countPatch(detail.patch)
    additions += counts.additions
    deletions += counts.deletions
    files.push({
      path: candidate.path,
      ...(candidate.oldPath ? { oldPath: candidate.oldPath } : {}),
      status: candidate.status,
      staged: candidate.staged,
      unstaged: candidate.unstaged,
      binary: detail.binary,
      additions: counts.additions,
      deletions: counts.deletions,
      ...(!detail.binary ? { patch: detail.patch } : {}),
      ...(detail.binary
        ? {
            omission: omission(
              "binary",
              "Binary patch content is not embedded",
              candidate.path,
            ),
          }
        : {}),
    })
    if (detail.binary) omissions.push(files.at(-1)!.omission!)
  }

  return {
    available: true,
    root: status.root,
    files,
    additions,
    deletions,
    omissions,
  }
}
