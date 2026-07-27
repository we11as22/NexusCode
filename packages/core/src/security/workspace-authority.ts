import crypto from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
} from "node:fs/promises"
import path from "node:path"

import { getNexusDataDir } from "../data-dir.js"
import {
  atomicWriteJson,
  withFileLock,
} from "../storage/durable-fs.js"
import {
  applyProjectAuthorityRequest,
  isValidPendingProjectAuthorityRequest,
  PROJECT_AUTHORITY_REQUEST_KINDS,
  type PendingProjectAuthorityRequest,
  type ProjectAuthorityRequestKind,
} from "../config/project-authority.js"

export const WORKSPACE_AUTHORITY_STORE_VERSION = 2 as const

const MAX_STORE_BYTES = 1_048_576
const MAX_WORKSPACES = 1_000
const MAX_GRANTS_PER_KIND = 1_000
const MAX_PROJECT_CONFIG_APPROVALS = 256
const MAX_COMMAND_CHARS = 16_384
const MAX_PATTERN_CHARS = 4_096
const MAX_MCP_TOOL_CHARS = 512

export type WorkspaceAuthorityGrant =
  | { kind: "command"; value: string }
  | { kind: "command-pattern"; value: string }
  | { kind: "mcp-tool"; value: string }

export interface WorkspaceAuthorityIdentity {
  canonicalPath: string
  device: string
  inode: string
  digest: string
}

export interface WorkspaceAuthorityGrants {
  commands: string[]
  commandPatterns: string[]
  mcpTools: string[]
}

export interface WorkspaceProjectAuthorityApproval {
  kind: ProjectAuthorityRequestKind
  fingerprint: string
}

export interface WorkspaceAuthorityRecord {
  version: typeof WORKSPACE_AUTHORITY_STORE_VERSION
  identity: WorkspaceAuthorityIdentity
  grants: WorkspaceAuthorityGrants
  projectConfigApprovals: WorkspaceProjectAuthorityApproval[]
  updatedAt: string
}

interface WorkspaceAuthorityStoreFile {
  version: typeof WORKSPACE_AUTHORITY_STORE_VERSION
  workspaces: Record<string, WorkspaceAuthorityRecord>
}

export interface WorkspaceAuthorityStoreOptions {
  /**
   * Override the complete store filename. Intended for an embedding host or a
   * temporary test directory; production defaults to the Nexus host data dir.
   */
  storePath?: string
}

export type WorkspaceAuthorityStoreErrorCode =
  | "invalid_workspace"
  | "invalid_grant"
  | "unsafe_store"
  | "corrupt_store"
  | "unsupported_version"
  | "store_too_large"

export class WorkspaceAuthorityStoreError extends Error {
  override readonly name = "WorkspaceAuthorityStoreError"

  constructor(
    readonly code: WorkspaceAuthorityStoreErrorCode,
    message: string,
  ) {
    super(message)
  }
}

type AuthorityConfig = {
  permissions: {
    allowedCommands: string[]
    allowCommandPatterns: string[]
    allowedMcpTools?: string[]
  }
  pendingProjectAuthority?: PendingProjectAuthorityRequest[]
}

function emptyStore(): WorkspaceAuthorityStoreFile {
  return {
    version: WORKSPACE_AUTHORITY_STORE_VERSION,
    workspaces: {},
  }
}

function digestIdentity(
  canonicalPath: string,
  device: string,
  inode: string,
  version: 1 | typeof WORKSPACE_AUTHORITY_STORE_VERSION =
    WORKSPACE_AUTHORITY_STORE_VERSION,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([
      "nexus-workspace-authority",
      version,
      canonicalPath,
      device,
      inode,
    ]))
    .digest("hex")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseStringArray(
  value: unknown,
  name: string,
  maxChars: number,
): string[] {
  if (!Array.isArray(value) || value.length > MAX_GRANTS_PER_KIND) {
    throw new WorkspaceAuthorityStoreError(
      "corrupt_store",
      `Workspace authority ${name} must be a bounded string array`,
    )
  }
  const result: string[] = []
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > maxChars ||
      item.includes("\0") ||
      /[\r\n]/u.test(item)
    ) {
      throw new WorkspaceAuthorityStoreError(
        "corrupt_store",
        `Workspace authority ${name} contains an invalid value`,
      )
    }
    if (!result.includes(item)) result.push(item)
  }
  return result.sort()
}

function parseIdentity(
  value: unknown,
  expectedDigest: string,
  storeVersion: 1 | typeof WORKSPACE_AUTHORITY_STORE_VERSION,
): WorkspaceAuthorityIdentity {
  if (!isPlainObject(value)) {
    throw new WorkspaceAuthorityStoreError(
      "corrupt_store",
      "Workspace authority identity is invalid",
    )
  }
  const { canonicalPath, device, inode, digest } = value
  if (
    typeof canonicalPath !== "string" ||
    canonicalPath.length === 0 ||
    canonicalPath.includes("\0") ||
    typeof device !== "string" ||
    device.length === 0 ||
    typeof inode !== "string" ||
    inode.length === 0 ||
    typeof digest !== "string" ||
    digest !== expectedDigest ||
    digestIdentity(canonicalPath, device, inode, storeVersion) !==
      expectedDigest
  ) {
    throw new WorkspaceAuthorityStoreError(
      "corrupt_store",
      "Workspace authority identity does not match its content-bound key",
    )
  }
  return {
    canonicalPath,
    device,
    inode,
    digest: storeVersion === WORKSPACE_AUTHORITY_STORE_VERSION
      ? digest
      : digestIdentity(canonicalPath, device, inode),
  }
}

function parseRecord(
  value: unknown,
  expectedDigest: string,
  storeVersion: 1 | typeof WORKSPACE_AUTHORITY_STORE_VERSION,
): WorkspaceAuthorityRecord {
  if (!isPlainObject(value)) {
    throw new WorkspaceAuthorityStoreError(
      "corrupt_store",
      "Workspace authority record is invalid",
    )
  }
  if (
    value.version !== storeVersion ||
    (value.version !== 1 &&
      value.version !== WORKSPACE_AUTHORITY_STORE_VERSION)
  ) {
    throw new WorkspaceAuthorityStoreError(
      "unsupported_version",
      "Workspace authority record version is unsupported",
    )
  }
  if (!isPlainObject(value.grants)) {
    throw new WorkspaceAuthorityStoreError(
      "corrupt_store",
      "Workspace authority grants are invalid",
    )
  }
  if (
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new WorkspaceAuthorityStoreError(
      "corrupt_store",
      "Workspace authority timestamp is invalid",
    )
  }
  return {
    version: WORKSPACE_AUTHORITY_STORE_VERSION,
    identity: parseIdentity(value.identity, expectedDigest, storeVersion),
    grants: {
      commands: parseStringArray(
        value.grants.commands,
        "commands",
        MAX_COMMAND_CHARS,
      ),
      commandPatterns: parseStringArray(
        value.grants.commandPatterns,
        "command patterns",
        MAX_PATTERN_CHARS,
      ),
      mcpTools: parseStringArray(
        value.grants.mcpTools,
        "MCP tools",
        MAX_MCP_TOOL_CHARS,
      ),
    },
    projectConfigApprovals:
      storeVersion === 1
        ? []
        : parseProjectConfigApprovals(value.projectConfigApprovals),
    updatedAt: value.updatedAt,
  }
}

function parseStore(value: unknown): WorkspaceAuthorityStoreFile {
  if (!isPlainObject(value)) {
    throw new WorkspaceAuthorityStoreError(
      "corrupt_store",
      "Workspace authority store must be an object",
    )
  }
  if (
    value.version !== 1 &&
    value.version !== WORKSPACE_AUTHORITY_STORE_VERSION
  ) {
    throw new WorkspaceAuthorityStoreError(
      "unsupported_version",
      "Workspace authority store version is unsupported",
    )
  }
  if (!isPlainObject(value.workspaces)) {
    throw new WorkspaceAuthorityStoreError(
      "corrupt_store",
      "Workspace authority workspace map is invalid",
    )
  }
  const storeVersion = value.version
  const entries = Object.entries(value.workspaces)
  if (entries.length > MAX_WORKSPACES) {
    throw new WorkspaceAuthorityStoreError(
      "store_too_large",
      "Workspace authority store contains too many workspaces",
    )
  }
  const workspaces: Record<string, WorkspaceAuthorityRecord> = {}
  for (const [digest, record] of entries) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) {
      throw new WorkspaceAuthorityStoreError(
        "corrupt_store",
        "Workspace authority store contains an invalid workspace key",
      )
    }
    const parsed = parseRecord(record, digest, storeVersion)
    workspaces[parsed.identity.digest] = parsed
  }
  return {
    version: WORKSPACE_AUTHORITY_STORE_VERSION,
    workspaces,
  }
}

function parseProjectConfigApprovals(
  value: unknown,
): WorkspaceProjectAuthorityApproval[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PROJECT_CONFIG_APPROVALS
  ) {
    throw new WorkspaceAuthorityStoreError(
      "corrupt_store",
      "Workspace project config approvals must be a bounded array",
    )
  }
  const approvals = new Map<string, WorkspaceProjectAuthorityApproval>()
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      throw new WorkspaceAuthorityStoreError(
        "corrupt_store",
        "Workspace project config approval is invalid",
      )
    }
    const kind = entry.kind
    const fingerprint = entry.fingerprint
    if (
      typeof kind !== "string" ||
      !(PROJECT_AUTHORITY_REQUEST_KINDS as readonly string[]).includes(kind) ||
      typeof fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(fingerprint)
    ) {
      throw new WorkspaceAuthorityStoreError(
        "corrupt_store",
        "Workspace project config approval has invalid content",
      )
    }
    const normalized = {
      kind: kind as ProjectAuthorityRequestKind,
      fingerprint,
    }
    approvals.set(`${normalized.kind}:${normalized.fingerprint}`, normalized)
  }
  return [...approvals.values()].sort((left, right) =>
    `${left.kind}:${left.fingerprint}`.localeCompare(
      `${right.kind}:${right.fingerprint}`,
    ))
}

function normalizeGrant(grant: WorkspaceAuthorityGrant): WorkspaceAuthorityGrant {
  if (!grant || typeof grant.value !== "string") {
    throw new WorkspaceAuthorityStoreError(
      "invalid_grant",
      "Workspace authority grant must contain a string value",
    )
  }
  let value: string
  let maxChars: number
  if (grant.kind === "command") {
    value = grant.value.trim().replace(/\s+/gu, " ")
    maxChars = MAX_COMMAND_CHARS
  } else if (grant.kind === "command-pattern") {
    value = grant.value.trim()
    maxChars = MAX_PATTERN_CHARS
  } else if (grant.kind === "mcp-tool") {
    value = grant.value.trim()
    maxChars = MAX_MCP_TOOL_CHARS
  } else {
    throw new WorkspaceAuthorityStoreError(
      "invalid_grant",
      "Workspace authority grant kind is unsupported",
    )
  }
  if (
    value.length === 0 ||
    value.length > maxChars ||
    value.includes("\0") ||
    /[\r\n]/u.test(value)
  ) {
    throw new WorkspaceAuthorityStoreError(
      "invalid_grant",
      "Workspace authority grant value is invalid",
    )
  }
  return { kind: grant.kind, value } as WorkspaceAuthorityGrant
}

function grantList(
  grants: WorkspaceAuthorityGrants,
  kind: WorkspaceAuthorityGrant["kind"],
): string[] {
  if (kind === "command") return grants.commands
  if (kind === "command-pattern") return grants.commandPatterns
  return grants.mcpTools
}

async function assertSafeStoreEntry(
  target: string,
  expected: "file" | "directory",
): Promise<boolean> {
  let entry: Awaited<ReturnType<typeof lstat>>
  try {
    entry = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
  const valid = expected === "file" ? entry.isFile() : entry.isDirectory()
  if (entry.isSymbolicLink() || !valid) {
    throw new WorkspaceAuthorityStoreError(
      "unsafe_store",
      `Workspace authority ${expected} is not a safe regular ${expected}: ${target}`,
    )
  }
  return true
}

function resolveStorePath(options: WorkspaceAuthorityStoreOptions): string {
  const configured =
    options.storePath ??
    path.join(getNexusDataDir(), "authority", "workspaces.json")
  if (!configured.trim() || configured.includes("\0")) {
    throw new WorkspaceAuthorityStoreError(
      "unsafe_store",
      "Workspace authority store path is invalid",
    )
  }
  return path.resolve(configured)
}

async function prepareStore(target: string): Promise<void> {
  const directory = path.dirname(target)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertSafeStoreEntry(directory, "directory")
  if (process.platform !== "win32") await chmod(directory, 0o700)
  await assertSafeStoreEntry(target, "file")
  await assertSafeStoreEntry(`${target}.lock`, "directory")
}

async function readStore(target: string): Promise<WorkspaceAuthorityStoreFile> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0
    handle = await open(target, fsConstants.O_RDONLY | noFollow)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return emptyStore()
    if (code === "ELOOP") {
      throw new WorkspaceAuthorityStoreError(
        "unsafe_store",
        "Workspace authority store cannot be a symbolic link",
      )
    }
    throw error
  }
  try {
    const entry = await handle.stat()
    if (!entry.isFile()) {
      throw new WorkspaceAuthorityStoreError(
        "unsafe_store",
        "Workspace authority store must be a regular file",
      )
    }
    if (
      process.platform !== "win32" &&
      (entry.mode & 0o077) !== 0
    ) {
      throw new WorkspaceAuthorityStoreError(
        "unsafe_store",
        "Workspace authority store permissions must be 0600",
      )
    }
    if (entry.size > MAX_STORE_BYTES) {
      throw new WorkspaceAuthorityStoreError(
        "store_too_large",
        "Workspace authority store exceeds its size limit",
      )
    }
    const raw = await handle.readFile("utf8")
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new WorkspaceAuthorityStoreError(
        "corrupt_store",
        "Workspace authority store contains invalid JSON",
      )
    }
    return parseStore(value)
  } finally {
    await handle.close()
  }
}

async function writeStore(
  target: string,
  store: WorkspaceAuthorityStoreFile,
): Promise<void> {
  await assertSafeStoreEntry(target, "file")
  await atomicWriteJson(target, store, { mode: 0o600 })
  await assertSafeStoreEntry(target, "file")
  if (process.platform !== "win32") await chmod(target, 0o600)
}

export function getWorkspaceAuthorityStorePath(
  options: WorkspaceAuthorityStoreOptions = {},
): string {
  return resolveStorePath(options)
}

export async function getWorkspaceAuthorityIdentity(
  workspacePath: string,
): Promise<WorkspaceAuthorityIdentity> {
  if (!workspacePath.trim() || workspacePath.includes("\0")) {
    throw new WorkspaceAuthorityStoreError(
      "invalid_workspace",
      "Workspace path must be a non-empty path without NUL characters",
    )
  }
  let canonicalPath: string
  try {
    canonicalPath = await realpath(path.resolve(workspacePath))
  } catch {
    throw new WorkspaceAuthorityStoreError(
      "invalid_workspace",
      `Workspace path cannot be resolved: ${workspacePath}`,
    )
  }
  let workspaceStat: Awaited<ReturnType<typeof stat>>
  try {
    workspaceStat = await stat(canonicalPath)
  } catch {
    throw new WorkspaceAuthorityStoreError(
      "invalid_workspace",
      `Workspace path cannot be inspected: ${workspacePath}`,
    )
  }
  if (!workspaceStat.isDirectory()) {
    throw new WorkspaceAuthorityStoreError(
      "invalid_workspace",
      `Workspace path is not a directory: ${workspacePath}`,
    )
  }
  const device = String(workspaceStat.dev)
  const inode = String(workspaceStat.ino)
  return {
    canonicalPath,
    device,
    inode,
    digest: digestIdentity(canonicalPath, device, inode),
  }
}

export async function loadWorkspaceAuthority(
  workspacePath: string,
  options: WorkspaceAuthorityStoreOptions = {},
): Promise<WorkspaceAuthorityRecord | null> {
  const identity = await getWorkspaceAuthorityIdentity(workspacePath)
  const target = resolveStorePath(options)
  await prepareStore(target)
  const store = await readStore(target)
  const record = store.workspaces[identity.digest]
  if (!record) return null
  if (
    record.identity.canonicalPath !== identity.canonicalPath ||
    record.identity.device !== identity.device ||
    record.identity.inode !== identity.inode
  ) {
    return null
  }
  return record
}

export async function grantWorkspaceAuthority(
  workspacePath: string,
  grant: WorkspaceAuthorityGrant,
  options: WorkspaceAuthorityStoreOptions = {},
): Promise<WorkspaceAuthorityRecord> {
  const identity = await getWorkspaceAuthorityIdentity(workspacePath)
  const normalized = normalizeGrant(grant)
  const target = resolveStorePath(options)
  await prepareStore(target)
  return withFileLock(target, async () => {
    await assertSafeStoreEntry(target, "file")
    const store = await readStore(target)
    const current = store.workspaces[identity.digest] ?? {
      version: WORKSPACE_AUTHORITY_STORE_VERSION,
      identity,
      grants: {
        commands: [],
        commandPatterns: [],
        mcpTools: [],
      },
      projectConfigApprovals: [],
      updatedAt: new Date(0).toISOString(),
    }
    const list = grantList(current.grants, normalized.kind)
    if (!list.includes(normalized.value)) {
      if (list.length >= MAX_GRANTS_PER_KIND) {
        throw new WorkspaceAuthorityStoreError(
          "store_too_large",
          "Workspace authority grant limit was reached",
        )
      }
      list.push(normalized.value)
      list.sort()
    }
    const next: WorkspaceAuthorityRecord = {
      ...current,
      identity,
      updatedAt: new Date().toISOString(),
    }
    store.workspaces[identity.digest] = next
    await writeStore(target, store)
    return next
  })
}

export async function revokeWorkspaceAuthority(
  workspacePath: string,
  grant?: WorkspaceAuthorityGrant,
  options: WorkspaceAuthorityStoreOptions = {},
): Promise<boolean> {
  const identity = await getWorkspaceAuthorityIdentity(workspacePath)
  const normalized = grant ? normalizeGrant(grant) : undefined
  const target = resolveStorePath(options)
  await prepareStore(target)
  return withFileLock(target, async () => {
    await assertSafeStoreEntry(target, "file")
    const store = await readStore(target)
    const current = store.workspaces[identity.digest]
    if (!current) return false
    if (!normalized) {
      delete store.workspaces[identity.digest]
      await writeStore(target, store)
      return true
    }
    const list = grantList(current.grants, normalized.kind)
    const index = list.indexOf(normalized.value)
    if (index < 0) return false
    list.splice(index, 1)
    if (
      current.grants.commands.length === 0 &&
      current.grants.commandPatterns.length === 0 &&
      current.grants.mcpTools.length === 0 &&
      current.projectConfigApprovals.length === 0
    ) {
      delete store.workspaces[identity.digest]
    } else {
      current.updatedAt = new Date().toISOString()
    }
    await writeStore(target, store)
    return true
  })
}

export async function listWorkspaceAuthorities(
  options: WorkspaceAuthorityStoreOptions = {},
): Promise<WorkspaceAuthorityRecord[]> {
  const target = resolveStorePath(options)
  await prepareStore(target)
  const store = await readStore(target)
  return Object.values(store.workspaces).sort((left, right) =>
    left.identity.canonicalPath.localeCompare(right.identity.canonicalPath)
  )
}

export async function approveWorkspaceProjectAuthority(
  workspacePath: string,
  request: PendingProjectAuthorityRequest,
  options: WorkspaceAuthorityStoreOptions = {},
): Promise<WorkspaceAuthorityRecord> {
  if (!isValidPendingProjectAuthorityRequest(request)) {
    throw new WorkspaceAuthorityStoreError(
      "invalid_grant",
      "Project config approval must match the exact normalized request content",
    )
  }
  const identity = await getWorkspaceAuthorityIdentity(workspacePath)
  const target = resolveStorePath(options)
  await prepareStore(target)
  return withFileLock(target, async () => {
    await assertSafeStoreEntry(target, "file")
    const store = await readStore(target)
    const current = store.workspaces[identity.digest] ?? {
      version: WORKSPACE_AUTHORITY_STORE_VERSION,
      identity,
      grants: {
        commands: [],
        commandPatterns: [],
        mcpTools: [],
      },
      projectConfigApprovals: [],
      updatedAt: new Date(0).toISOString(),
    }
    current.projectConfigApprovals =
      current.projectConfigApprovals.filter(
        (approval) => approval.kind !== request.kind,
      )
    if (
      current.projectConfigApprovals.length >=
      MAX_PROJECT_CONFIG_APPROVALS
    ) {
      throw new WorkspaceAuthorityStoreError(
        "store_too_large",
        "Workspace project config approval limit was reached",
      )
    }
    current.projectConfigApprovals.push({
      kind: request.kind,
      fingerprint: request.fingerprint,
    })
    current.projectConfigApprovals.sort((left, right) =>
      `${left.kind}:${left.fingerprint}`.localeCompare(
        `${right.kind}:${right.fingerprint}`,
      ))
    const next: WorkspaceAuthorityRecord = {
      ...current,
      version: WORKSPACE_AUTHORITY_STORE_VERSION,
      identity,
      updatedAt: new Date().toISOString(),
    }
    store.workspaces[identity.digest] = next
    await writeStore(target, store)
    return next
  })
}

export async function revokeWorkspaceProjectAuthority(
  workspacePath: string,
  approval: WorkspaceProjectAuthorityApproval,
  options: WorkspaceAuthorityStoreOptions = {},
): Promise<boolean> {
  if (
    !approval ||
    !(PROJECT_AUTHORITY_REQUEST_KINDS as readonly string[]).includes(
      approval.kind,
    ) ||
    !/^[a-f0-9]{64}$/u.test(approval.fingerprint)
  ) {
    throw new WorkspaceAuthorityStoreError(
      "invalid_grant",
      "Workspace project config approval is invalid",
    )
  }
  const identity = await getWorkspaceAuthorityIdentity(workspacePath)
  const target = resolveStorePath(options)
  await prepareStore(target)
  return withFileLock(target, async () => {
    await assertSafeStoreEntry(target, "file")
    const store = await readStore(target)
    const current = store.workspaces[identity.digest]
    if (!current) return false
    const index = current.projectConfigApprovals.findIndex(
      (entry) =>
        entry.kind === approval.kind &&
        entry.fingerprint === approval.fingerprint,
    )
    if (index < 0) return false
    current.projectConfigApprovals.splice(index, 1)
    if (
      current.grants.commands.length === 0 &&
      current.grants.commandPatterns.length === 0 &&
      current.grants.mcpTools.length === 0 &&
      current.projectConfigApprovals.length === 0
    ) {
      delete store.workspaces[identity.digest]
    } else {
      current.updatedAt = new Date().toISOString()
    }
    await writeStore(target, store)
    return true
  })
}

/**
 * Add host-owned grants to a loaded config in place. Mutation is intentional:
 * loadConfig attaches non-enumerable credential-environment provenance which
 * must survive authority hydration.
 */
export function applyWorkspaceAuthorityGrants<T extends AuthorityConfig>(
  config: T,
  authority: WorkspaceAuthorityRecord | null,
): T {
  if (!authority) return config
  config.permissions.allowedCommands = [
    ...new Set([
      ...config.permissions.allowedCommands,
      ...authority.grants.commands,
    ]),
  ]
  config.permissions.allowCommandPatterns = [
    ...new Set([
      ...config.permissions.allowCommandPatterns,
      ...authority.grants.commandPatterns,
    ]),
  ]
  config.permissions.allowedMcpTools = [
    ...new Set([
      ...(config.permissions.allowedMcpTools ?? []),
      ...authority.grants.mcpTools,
    ]),
  ]
  const approvals = new Set(
    authority.projectConfigApprovals.map(
      (approval) => `${approval.kind}:${approval.fingerprint}`,
    ),
  )
  const pending = config.pendingProjectAuthority ?? []
  const remaining: PendingProjectAuthorityRequest[] = []
  for (const request of pending) {
    if (!approvals.has(`${request.kind}:${request.fingerprint}`)) {
      remaining.push(request)
      continue
    }
    applyProjectAuthorityRequest(
      config as unknown as import("../types.js").NexusConfig,
      request,
    )
  }
  config.pendingProjectAuthority = remaining
  return config
}

export async function hydrateWorkspaceAuthority<T extends AuthorityConfig>(
  config: T,
  workspacePath: string,
  options: WorkspaceAuthorityStoreOptions = {},
): Promise<T> {
  return applyWorkspaceAuthorityGrants(
    config,
    await loadWorkspaceAuthority(workspacePath, options),
  )
}
