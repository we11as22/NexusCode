import { NexusConfigSchema } from "../config/schema.js"
import { Session } from "../session/index.js"
import type {
  AgentEvent,
  ApprovalAction,
  IHost,
  NexusConfig,
  PermissionResult,
} from "../types.js"

export interface FakeHost extends IHost {
  readonly files: Map<string, string>
  readonly approvals: ApprovalAction[]
  readonly events: AgentEvent[]
}
type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(overrides)) {
    const previous = merged[key]
    merged[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? deepMerge(previous, value)
        : value
  }

  return merged
}

export function createFakeHost(overrides: Partial<IHost> = {}): FakeHost {
  const files = new Map<string, string>()
  const approvals: ApprovalAction[] = []
  const events: AgentEvent[] = []
  const cwd = overrides.cwd ?? process.cwd()

  return {
    cwd,
    files,
    approvals,
    events,
    async resolvePath(requestedPath, access) {
      if (overrides.resolvePath) {
        return overrides.resolvePath(requestedPath, access)
      }
      return requestedPath.startsWith("/")
        ? requestedPath
        : `${cwd}/${requestedPath}`.replace(/\/+/g, "/")
    },
    async authorizeNetworkRequest(request) {
      if (overrides.authorizeNetworkRequest) {
        return overrides.authorizeNetworkRequest(request)
      }
      throw new Error(
        `Fake host network authorization stub was not configured: ${request.url}`,
      )
    },
    async readFile(path, options) {
      if (overrides.readFile) return overrides.readFile(path, options)
      const content = files.get(path)
      if (content === undefined) {
        const error = new Error(`File not found: ${path}`) as NodeJS.ErrnoException
        error.code = "ENOENT"
        throw error
      }
      if (
        typeof options?.maxBytes === "number" &&
        Number.isSafeInteger(options.maxBytes) &&
        options.maxBytes >= 0 &&
        Buffer.byteLength(content, "utf8") > options.maxBytes
      ) {
        throw new Error(
          `File exceeds the ${options.maxBytes}-byte fake-host read limit`,
        )
      }
      return content
    },
    async writeFile(path, content) {
      if (overrides.writeFile) return overrides.writeFile(path, content)
      files.set(path, content)
    },
    async deleteFile(path) {
      if (overrides.deleteFile) return overrides.deleteFile(path)
      files.delete(path)
    },
    async exists(path) {
      if (overrides.exists) return overrides.exists(path)
      return files.has(path)
    },
    async showDiff(path, before, after) {
      if (overrides.showDiff) return overrides.showDiff(path, before, after)
      return false
    },
    async runCommand(command, commandCwd, signal) {
      if (overrides.runCommand) {
        return overrides.runCommand(command, commandCwd, signal)
      }
      throw new Error(
        `Fake host command stub was not configured: ${command}`,
      )
    },
    async showApprovalDialog(action, signal): Promise<PermissionResult> {
      approvals.push(action)
      if (overrides.showApprovalDialog) {
        return overrides.showApprovalDialog(action, signal)
      }
      return { approved: false }
    },
    emit(event) {
      events.push(event)
      overrides.emit?.(event)
    },
    ...(overrides.addAllowedCommand
      ? { addAllowedCommand: overrides.addAllowedCommand }
      : {}),
    ...(overrides.addAllowedPattern
      ? { addAllowedPattern: overrides.addAllowedPattern }
      : {}),
    ...(overrides.addAllowedMcpTool
      ? { addAllowedMcpTool: overrides.addAllowedMcpTool }
      : {}),
    ...(overrides.resolveAtMention
      ? { resolveAtMention: overrides.resolveAtMention }
      : {}),
    ...(overrides.getProblems ? { getProblems: overrides.getProblems } : {}),
    ...(overrides.restoreCheckpoint
      ? { restoreCheckpoint: overrides.restoreCheckpoint }
      : {}),
    ...(overrides.getCheckpointEntries
      ? { getCheckpointEntries: overrides.getCheckpointEntries }
      : {}),
    ...(overrides.getCheckpointDiff
      ? { getCheckpointDiff: overrides.getCheckpointDiff }
      : {}),
    ...(overrides.notifyCheckpointEntriesUpdated
      ? {
          notifyCheckpointEntriesUpdated:
            overrides.notifyCheckpointEntriesUpdated,
        }
      : {}),
    ...(overrides.requestModeChange
      ? { requestModeChange: overrides.requestModeChange }
      : {}),
    ...(overrides.setWorkingDirectory
      ? { setWorkingDirectory: overrides.setWorkingDirectory }
      : {}),
    ...(overrides.queryLanguageServer
      ? { queryLanguageServer: overrides.queryLanguageServer }
      : {}),
    ...(overrides.requestMcpAuthentication
      ? { requestMcpAuthentication: overrides.requestMcpAuthentication }
      : {}),
    ...(overrides.openFileEdit
      ? { openFileEdit: overrides.openFileEdit }
      : {}),
    ...(overrides.saveFileEdit
      ? { saveFileEdit: overrides.saveFileEdit }
      : {}),
    ...(overrides.revertFileEdit
      ? { revertFileEdit: overrides.revertFileEdit }
      : {}),
  }
}

export function createFakeSession(cwd = process.cwd()): Session {
  return Session.createEphemeral(cwd)
}

export function createTestConfig(
  overrides: DeepPartial<NexusConfig> = {},
): NexusConfig {
  const defaults = NexusConfigSchema.parse({})
  return NexusConfigSchema.parse(
    deepMerge(
      defaults as unknown as Record<string, unknown>,
      overrides as Record<string, unknown>,
    ),
  ) as NexusConfig
}
