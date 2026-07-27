import { createHash } from "node:crypto"

import {
  canonicalProjectRoot,
  canonicalizeNexusServerBaseUrl,
} from "@nexuscode/core"

import type {
  VsCodeRemoteCursorRecord,
  VsCodeRemoteCursorStore,
} from "./remote-turn.js"

const REMOTE_STATE_VERSION = 1
const MAX_OPAQUE_ID_LENGTH = 512

export interface WorkspaceMementoLike {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): PromiseLike<void>
}

interface StoredSelectedSession {
  version: typeof REMOTE_STATE_VERSION
  sessionId: string
}

interface StoredRemoteCursor extends VsCodeRemoteCursorRecord {
  version: typeof REMOTE_STATE_VERSION
  sessionId: string
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_ID_LENGTH
  )
}

function isStoredSelectedSession(
  value: unknown,
): value is StoredSelectedSession {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<StoredSelectedSession>
  return (
    candidate.version === REMOTE_STATE_VERSION &&
    isOpaqueId(candidate.sessionId)
  )
}

function isStoredRemoteCursor(
  value: unknown,
  sessionId: string,
): value is StoredRemoteCursor {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<StoredRemoteCursor>
  return (
    candidate.version === REMOTE_STATE_VERSION &&
    candidate.sessionId === sessionId &&
    isOpaqueId(candidate.turnId) &&
    isOpaqueId(candidate.runId) &&
    Number.isSafeInteger(candidate.afterSequence) &&
    candidate.afterSequence! >= 0
  )
}

/**
 * Durable VS Code-side metadata for one canonical server/workspace pair.
 * Values are namespaced and validated before use; no server token is stored.
 */
export class VsCodeRemoteWorkspaceState
  implements VsCodeRemoteCursorStore
{
  private readonly namespace: string
  private readonly pendingWrites = new Map<string, Promise<void>>()

  constructor(
    private readonly memento: WorkspaceMementoLike,
    serverUrl: string,
    cwd: string,
  ) {
    const authority = [
      canonicalizeNexusServerBaseUrl(serverUrl),
      canonicalProjectRoot(cwd),
    ].join("\0")
    this.namespace = `nexuscode.remote.v${REMOTE_STATE_VERSION}.${digest(authority)}`
  }

  async getSelectedSessionId(): Promise<string | undefined> {
    const key = this.selectedSessionKey()
    await this.waitForPendingWrite(key)
    const stored = this.memento.get<unknown>(key)
    return isStoredSelectedSession(stored)
      ? stored.sessionId
      : undefined
  }

  async setSelectedSessionId(
    sessionId: string | undefined,
  ): Promise<void> {
    if (sessionId !== undefined && !isOpaqueId(sessionId)) {
      throw new TypeError("Remote session id is invalid")
    }
    const key = this.selectedSessionKey()
    await this.enqueueWrite(key, () =>
      this.memento.update(
        key,
        sessionId === undefined
          ? undefined
          : {
              version: REMOTE_STATE_VERSION,
              sessionId,
            } satisfies StoredSelectedSession,
      ),
    )
  }

  async load(
    sessionId: string,
  ): Promise<VsCodeRemoteCursorRecord | undefined> {
    if (!isOpaqueId(sessionId)) return undefined
    const key = this.cursorKey(sessionId)
    await this.waitForPendingWrite(key)
    const stored = this.memento.get<unknown>(key)
    if (!isStoredRemoteCursor(stored, sessionId)) return undefined
    return {
      turnId: stored.turnId,
      runId: stored.runId,
      afterSequence: stored.afterSequence,
    }
  }

  async save(
    sessionId: string,
    record: VsCodeRemoteCursorRecord,
  ): Promise<void> {
    if (
      !isOpaqueId(sessionId) ||
      !isOpaqueId(record.turnId) ||
      !isOpaqueId(record.runId) ||
      !Number.isSafeInteger(record.afterSequence) ||
      record.afterSequence < 0
    ) {
      throw new TypeError("Remote turn cursor is invalid")
    }
    const key = this.cursorKey(sessionId)
    await this.enqueueWrite(key, () =>
      this.memento.update(key, {
        version: REMOTE_STATE_VERSION,
        sessionId,
        turnId: record.turnId,
        runId: record.runId,
        afterSequence: record.afterSequence,
      } satisfies StoredRemoteCursor),
    )
  }

  async clear(sessionId: string): Promise<void> {
    if (!isOpaqueId(sessionId)) return
    const key = this.cursorKey(sessionId)
    await this.enqueueWrite(key, () =>
      this.memento.update(key, undefined),
    )
  }

  private selectedSessionKey(): string {
    return `${this.namespace}.selected-session`
  }

  private cursorKey(sessionId: string): string {
    return `${this.namespace}.cursor.${digest(sessionId)}`
  }

  private async waitForPendingWrite(key: string): Promise<void> {
    await this.pendingWrites.get(key)?.catch(() => undefined)
  }

  private async enqueueWrite(
    key: string,
    operation: () => PromiseLike<void>,
  ): Promise<void> {
    const previous = this.pendingWrites.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => operation())
      .then(() => undefined)
    this.pendingWrites.set(key, next)
    try {
      await next
    } finally {
      if (this.pendingWrites.get(key) === next) {
        this.pendingWrites.delete(key)
      }
    }
  }
}
