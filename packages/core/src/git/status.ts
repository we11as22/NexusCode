import type {
  GitIndexStatus,
  GitStatusEntry,
  GitSubmoduleStatus,
  ParsedGitStatus,
} from "./types.js"

const INDEX_STATUS = new Set<GitIndexStatus>([
  ".",
  " ",
  "M",
  "T",
  "A",
  "D",
  "R",
  "C",
  "U",
  "?",
  "!",
])

export class GitStatusParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitStatusParseError"
  }
}

function parseStatuses(value: string): [GitIndexStatus, GitIndexStatus] {
  if (value.length !== 2) {
    throw new GitStatusParseError(`Invalid Git XY status: ${value}`)
  }
  const indexStatus = value[0] as GitIndexStatus
  const worktreeStatus = value[1] as GitIndexStatus
  if (!INDEX_STATUS.has(indexStatus) || !INDEX_STATUS.has(worktreeStatus)) {
    throw new GitStatusParseError(`Unsupported Git XY status: ${value}`)
  }
  return [indexStatus, worktreeStatus]
}

function parseSubmodule(value: string): GitSubmoduleStatus {
  if (value === "N...") {
    return {
      isSubmodule: false,
      commitChanged: false,
      modified: false,
      untracked: false,
    }
  }
  if (
    value.length !== 4 ||
    value[0] !== "S" ||
    ![".", "C"].includes(value[1] ?? "") ||
    ![".", "M"].includes(value[2] ?? "") ||
    ![".", "U"].includes(value[3] ?? "")
  ) {
    throw new GitStatusParseError(`Invalid Git submodule status: ${value}`)
  }
  return {
    isSubmodule: true,
    commitChanged: value[1] === "C",
    modified: value[2] === "M",
    untracked: value[3] === "U",
  }
}

function splitFixedFields(
  record: string,
  fixedFieldCount: number,
): { fields: string[]; remainder: string } {
  const fields: string[] = []
  let offset = 0
  for (let index = 0; index < fixedFieldCount; index++) {
    const separator = record.indexOf(" ", offset)
    if (separator < 0) {
      throw new GitStatusParseError(
        `Truncated Git status record ${record.slice(0, 32)}`,
      )
    }
    fields.push(record.slice(offset, separator))
    offset = separator + 1
  }
  const remainder = record.slice(offset)
  if (!remainder) {
    throw new GitStatusParseError("Git status record is missing a path")
  }
  return { fields, remainder }
}

function parseOrdinary(record: string): GitStatusEntry {
  const { fields, remainder: filePath } = splitFixedFields(record, 8)
  const [marker, xy, submodule, headMode, indexMode, worktreeMode, headOid, indexOid] =
    fields
  if (marker !== "1") {
    throw new GitStatusParseError("Invalid ordinary Git status marker")
  }
  const [indexStatus, worktreeStatus] = parseStatuses(xy!)
  return {
    kind: "ordinary",
    path: filePath,
    indexStatus,
    worktreeStatus,
    submodule: parseSubmodule(submodule!),
    headMode: headMode!,
    indexMode: indexMode!,
    worktreeMode: worktreeMode!,
    headOid: headOid!,
    indexOid: indexOid!,
  }
}

function parseRename(
  record: string,
  originalPath: string | undefined,
): GitStatusEntry {
  if (originalPath === undefined) {
    throw new GitStatusParseError("Rename record is missing its source path")
  }
  const { fields, remainder: filePath } = splitFixedFields(record, 9)
  const [
    marker,
    xy,
    submodule,
    headMode,
    indexMode,
    worktreeMode,
    headOid,
    indexOid,
    rawScore,
  ] = fields
  if (marker !== "2") {
    throw new GitStatusParseError("Invalid rename Git status marker")
  }
  const scoreMatch = rawScore!.match(/^([RC])(\d{1,3})$/)
  const percent = scoreMatch ? Number(scoreMatch[2]) : Number.NaN
  if (!scoreMatch || !Number.isInteger(percent) || percent > 100) {
    throw new GitStatusParseError(`Invalid Git rename score: ${rawScore}`)
  }
  const [indexStatus, worktreeStatus] = parseStatuses(xy!)
  return {
    kind: "rename",
    path: filePath,
    originalPath,
    indexStatus,
    worktreeStatus,
    submodule: parseSubmodule(submodule!),
    headMode: headMode!,
    indexMode: indexMode!,
    worktreeMode: worktreeMode!,
    headOid: headOid!,
    indexOid: indexOid!,
    score: {
      kind: scoreMatch[1] === "R" ? "rename" : "copy",
      percent,
    },
  }
}

function parseUnmerged(record: string): GitStatusEntry {
  const { fields, remainder: filePath } = splitFixedFields(record, 10)
  const [
    marker,
    xy,
    submodule,
    stage1Mode,
    stage2Mode,
    stage3Mode,
    worktreeMode,
    stage1Oid,
    stage2Oid,
    stage3Oid,
  ] = fields
  if (marker !== "u") {
    throw new GitStatusParseError("Invalid unmerged Git status marker")
  }
  const [indexStatus, worktreeStatus] = parseStatuses(xy!)
  return {
    kind: "unmerged",
    path: filePath,
    indexStatus,
    worktreeStatus,
    submodule: parseSubmodule(submodule!),
    stage1Mode: stage1Mode!,
    stage2Mode: stage2Mode!,
    stage3Mode: stage3Mode!,
    worktreeMode: worktreeMode!,
    stage1Oid: stage1Oid!,
    stage2Oid: stage2Oid!,
    stage3Oid: stage3Oid!,
  }
}

function parseAheadBehind(
  value: string,
): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+) -(\d+)$/)
  if (!match) {
    throw new GitStatusParseError(`Invalid branch.ab header: ${value}`)
  }
  const ahead = Number(match[1])
  const behind = Number(match[2])
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    throw new GitStatusParseError(`Unsafe branch.ab header: ${value}`)
  }
  return { ahead, behind }
}

export function parseGitStatusV2(output: Uint8Array): ParsedGitStatus {
  const tokens = Buffer.from(output).toString("utf8").split("\0")
  if (tokens.at(-1) === "") tokens.pop()

  let oid: string | undefined
  let branch: string | undefined
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  let unborn = false
  let detached = false
  const entries: GitStatusEntry[] = []

  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index]!
    if (!record) {
      throw new GitStatusParseError("Unexpected empty Git status record")
    }
    if (record.startsWith("# ")) {
      const separator = record.indexOf(" ", 2)
      if (separator < 0) {
        throw new GitStatusParseError(`Malformed Git status header: ${record}`)
      }
      const name = record.slice(2, separator)
      const value = record.slice(separator + 1)
      switch (name) {
        case "branch.oid":
          if (value === "(initial)") {
            unborn = true
            oid = undefined
          } else if (value) {
            oid = value
          } else {
            throw new GitStatusParseError("branch.oid cannot be empty")
          }
          break
        case "branch.head":
          if (value === "(detached)") {
            detached = true
            branch = undefined
          } else if (value) {
            branch = value
          } else {
            throw new GitStatusParseError("branch.head cannot be empty")
          }
          break
        case "branch.upstream":
          if (!value) {
            throw new GitStatusParseError("branch.upstream cannot be empty")
          }
          upstream = value
          break
        case "branch.ab": {
          const counts = parseAheadBehind(value)
          ahead = counts.ahead
          behind = counts.behind
          break
        }
        default:
          // Porcelain v2 explicitly permits callers to ignore future headers.
          break
      }
      continue
    }
    if (record.startsWith("1 ")) {
      entries.push(parseOrdinary(record))
      continue
    }
    if (record.startsWith("2 ")) {
      entries.push(parseRename(record, tokens[++index]))
      continue
    }
    if (record.startsWith("u ")) {
      entries.push(parseUnmerged(record))
      continue
    }
    if (record.startsWith("? ")) {
      const filePath = record.slice(2)
      if (!filePath) {
        throw new GitStatusParseError("Untracked record is missing a path")
      }
      entries.push({
        kind: "untracked",
        path: filePath,
        indexStatus: "?",
        worktreeStatus: "?",
      })
      continue
    }
    if (record.startsWith("! ")) {
      const filePath = record.slice(2)
      if (!filePath) {
        throw new GitStatusParseError("Ignored record is missing a path")
      }
      entries.push({
        kind: "ignored",
        path: filePath,
        indexStatus: "!",
        worktreeStatus: "!",
      })
      continue
    }
    throw new GitStatusParseError(
      `Unsupported Git status record: ${record.slice(0, 32)}`,
    )
  }

  return {
    ...(oid ? { oid } : {}),
    ...(branch ? { branch } : {}),
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    unborn,
    detached,
    entries,
  }
}
