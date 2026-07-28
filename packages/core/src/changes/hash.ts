import { createHash } from "node:crypto"
import * as path from "node:path"

import type {
  ChangeFileRecord,
  ChangeIdentity,
  ChangeSetState,
  FileStateRef,
} from "./types.js"

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PROPOSAL_HASH_VERSION = "nexus-change-proposal-v1"
const WORKSPACE_HASH_VERSION = "nexus-workspace-v1"

class LengthDelimitedHash {
  readonly #hash = createHash("sha256")

  field(name: string, value: string | Uint8Array): this {
    const nameBytes = Buffer.from(name, "utf8")
    const valueBytes =
      typeof value === "string"
        ? Buffer.from(value, "utf8")
        : Buffer.from(value)
    const header = Buffer.allocUnsafe(8)
    header.writeUInt32BE(nameBytes.byteLength, 0)
    header.writeUInt32BE(valueBytes.byteLength, 4)
    this.#hash.update(header)
    this.#hash.update(nameBytes)
    this.#hash.update(valueBytes)
    return this
  }

  digest(): string {
    return this.#hash.digest("hex")
  }
}

function requireIdentityField(name: string, value: string): string {
  if (!value || value.includes("\0")) {
    throw new Error(`Change identity ${name} must be a non-empty NUL-free string`)
  }
  return value
}

export function normalizeChangePath(value: string): string {
  if (!value || value.includes("\0")) {
    throw new Error("Change path must be a non-empty NUL-free relative path")
  }
  const slashPath = value.replaceAll("\\", "/")
  if (path.posix.isAbsolute(slashPath)) {
    throw new Error(`Change path must be relative: ${value}`)
  }
  const normalized = path.posix.normalize(slashPath)
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.endsWith("/")
  ) {
    throw new Error(`Change path escapes or does not identify a file: ${value}`)
  }
  return normalized
}

export function hashFileContent(
  content: string | Uint8Array,
): { hash: string; byteLength: number } {
  const bytes =
    typeof content === "string"
      ? Buffer.from(content, "utf8")
      : Buffer.from(content)
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  }
}

export function hashWorkspaceIdentity(canonicalPath: string): string {
  if (!canonicalPath || canonicalPath.includes("\0")) {
    throw new Error("Canonical workspace path must be non-empty and NUL-free")
  }
  return new LengthDelimitedHash()
    .field("version", WORKSPACE_HASH_VERSION)
    .field("canonicalPath", canonicalPath)
    .digest()
}

export function sameChangeIdentity(
  left: ChangeIdentity,
  right: ChangeIdentity,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.messageId === right.messageId &&
    left.partId === right.partId &&
    left.toolCallId === right.toolCallId
  )
}

function validateFileState(
  label: string,
  state: FileStateRef,
): void {
  if (!state.exists) {
    if (
      state.hash !== null ||
      state.blob !== null ||
      state.byteLength !== 0 ||
      state.mode !== null
    ) {
      throw new Error(`${label} absent file state contains content metadata`)
    }
    return
  }
  if (!SHA256_PATTERN.test(state.hash) || !SHA256_PATTERN.test(state.blob)) {
    throw new Error(`${label} existing file state requires SHA-256 hash/blob ids`)
  }
  if (state.hash !== state.blob) {
    throw new Error(`${label} file blob must be addressed by its content hash`)
  }
  if (!Number.isSafeInteger(state.byteLength) || state.byteLength < 0) {
    throw new Error(`${label} file byte length must be a non-negative safe integer`)
  }
  if (
    state.mode !== null &&
    (
      !Number.isSafeInteger(state.mode) ||
      state.mode < 0 ||
      state.mode > 0o7777
    )
  ) {
    throw new Error(`${label} file mode is invalid`)
  }
}

function validateFileOperation(file: ChangeFileRecord): void {
  validateFileState("applyBase", file.applyBase)
  if (file.targetBase) validateFileState("targetBase", file.targetBase)
  switch (file.operation) {
    case "create":
      if (
        file.before.exists ||
        !file.after.exists ||
        file.oldPath !== undefined ||
        file.targetBase !== undefined
      ) {
        throw new Error(
          "Create change requires absent earliest before and existing after",
        )
      }
      break
    case "modify":
      if (
        !file.before.exists ||
        !file.applyBase.exists ||
        !file.after.exists ||
        file.oldPath !== undefined ||
        file.targetBase !== undefined
      ) {
        throw new Error("Modify change requires existing before and after")
      }
      break
    case "delete":
      if (
        !file.before.exists ||
        !file.applyBase.exists ||
        file.after.exists ||
        file.oldPath !== undefined ||
        file.targetBase !== undefined
      ) {
        throw new Error("Delete change requires existing before and absent after")
      }
      break
    case "rename":
      if (
        !file.before.exists ||
        !file.applyBase.exists ||
        !file.after.exists ||
        !file.oldPath ||
        !file.targetBase ||
        file.targetBase.exists
      ) {
        throw new Error("Rename change requires oldPath and existing before/after")
      }
      break
  }
}

function canonicalFiles(files: readonly ChangeFileRecord[]): Array<{
  file: ChangeFileRecord
  path: string
  oldPath?: string
}> {
  if (files.length === 0) {
    throw new Error("Change proposal must contain at least one file")
  }
  const normalized = files.map((file) => ({
    file,
    path: normalizeChangePath(file.path),
    ...(file.oldPath
      ? { oldPath: normalizeChangePath(file.oldPath) }
      : {}),
  }))
  normalized.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    (left.oldPath ?? "").localeCompare(right.oldPath ?? ""),
  )
  const seen = new Set<string>()
  for (const item of normalized) {
    if (item.oldPath && item.oldPath === item.path) {
      throw new Error("Rename source and destination must differ")
    }
    for (const candidate of [item.path, item.oldPath].filter(
      (value): value is string => value !== undefined,
    )) {
      if (seen.has(candidate)) {
        throw new Error(`Duplicate or colliding canonical change path: ${candidate}`)
      }
      seen.add(candidate)
    }
  }
  return normalized
}

function addState(
  hash: LengthDelimitedHash,
  prefix: string,
  state: FileStateRef,
): void {
  validateFileState(prefix, state)
  hash
    .field(`${prefix}.exists`, state.exists ? "1" : "0")
    .field(`${prefix}.hash`, state.hash ?? "")
    .field(`${prefix}.blob`, state.blob ?? "")
    .field(`${prefix}.byteLength`, String(state.byteLength))
    .field(`${prefix}.mode`, state.mode === null ? "" : String(state.mode))
}

export function hashChangeProposal(
  identity: ChangeIdentity,
  files: readonly ChangeFileRecord[],
): string {
  const hash = new LengthDelimitedHash()
    .field("version", PROPOSAL_HASH_VERSION)
  for (const key of [
    "workspaceId",
    "sessionId",
    "turnId",
    "runId",
    "messageId",
    "partId",
    "toolCallId",
  ] as const) {
    hash.field(
      `identity.${key}`,
      requireIdentityField(key, identity[key]),
    )
  }

  const normalized = canonicalFiles(files)
  hash.field("fileCount", String(normalized.length))
  normalized.forEach(({ file, path: filePath, oldPath }, fileIndex) => {
    validateFileOperation(file)
    const prefix = `file.${fileIndex}`
    hash
      .field(`${prefix}.path`, filePath)
      .field(`${prefix}.oldPath`, oldPath ?? "")
      .field(`${prefix}.operation`, file.operation)
      .field(`${prefix}.binary`, file.binary ? "1" : "0")
    addState(hash, `${prefix}.before`, file.before)
    addState(hash, `${prefix}.applyBase`, file.applyBase)
    if (file.targetBase) {
      hash.field(`${prefix}.hasTargetBase`, "1")
      addState(hash, `${prefix}.targetBase`, file.targetBase)
    } else {
      hash.field(`${prefix}.hasTargetBase`, "0")
    }
    addState(hash, `${prefix}.after`, file.after)
    hash.field(`${prefix}.hunkCount`, String(file.hunks.length))
    file.hunks.forEach((hunk, hunkIndex) => {
      for (const [name, value] of [
        ["oldStart", hunk.oldStart],
        ["oldLines", hunk.oldLines],
        ["newStart", hunk.newStart],
        ["newLines", hunk.newLines],
      ] as const) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error(`Change hunk ${name} must be a non-negative safe integer`)
        }
      }
      const hunkPrefix = `${prefix}.hunk.${hunkIndex}`
      hash
        .field(`${hunkPrefix}.oldStart`, String(hunk.oldStart))
        .field(`${hunkPrefix}.oldLines`, String(hunk.oldLines))
        .field(`${hunkPrefix}.newStart`, String(hunk.newStart))
        .field(`${hunkPrefix}.newLines`, String(hunk.newLines))
        .field(`${hunkPrefix}.patch`, hunk.patch)
    })
    hash
      .field(`${prefix}.omission.reason`, file.omission?.reason ?? "")
      .field(`${prefix}.omission.detail`, file.omission?.detail ?? "")
  })
  return hash.digest()
}

const ALLOWED_TRANSITIONS: Readonly<Record<ChangeSetState, readonly ChangeSetState[]>> = {
  proposed: ["approved", "rejected"],
  approved: ["applying", "conflicted"],
  applying: ["approved", "applied", "conflicted"],
  applied: ["accepted", "reverting", "conflicted"],
  rejected: [],
  accepted: [],
  reverting: ["applied", "reverted", "conflicted"],
  reverted: ["applying"],
  conflicted: [],
}

export function assertChangeSetTransition(
  from: ChangeSetState,
  to: ChangeSetState,
): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Illegal change-set transition: ${from} -> ${to}`)
  }
}
