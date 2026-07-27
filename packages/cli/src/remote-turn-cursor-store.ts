import { constants, promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import {
  canonicalProjectRoot,
  canonicalizeNexusServerBaseUrl,
} from '@nexuscode/core'
import type {
  RemoteTurnCursorRecord,
  RemoteTurnCursorStore,
} from './remote-turn.js'

const MAX_CURSOR_FILE_BYTES = 16 * 1024

export interface CliRemoteTurnCursorStoreOptions {
  rootDir: string
  serverUrl: string
  cwd: string
}

function parseCursorRecord(value: unknown): RemoteTurnCursorRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Remote turn cursor is not an object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(',') !== 'afterSequence,runId,turnId') {
    throw new Error('Remote turn cursor has unexpected fields')
  }
  if (
    typeof record.turnId !== 'string' ||
    record.turnId.length < 1 ||
    record.turnId.length > 256 ||
    typeof record.runId !== 'string' ||
    record.runId.length < 1 ||
    record.runId.length > 256 ||
    !Number.isSafeInteger(record.afterSequence) ||
    Number(record.afterSequence) < 0
  ) {
    throw new Error('Remote turn cursor is invalid')
  }
  return {
    turnId: record.turnId,
    runId: record.runId,
    afterSequence: Number(record.afterSequence),
  }
}

export function createCliRemoteTurnCursorStore(
  options: CliRemoteTurnCursorStoreOptions,
): RemoteTurnCursorStore {
  const rootDir = path.resolve(options.rootDir)
  const cursorDir = path.join(rootDir, 'data', 'remote-turn-cursors')
  const namespace = [
    canonicalizeNexusServerBaseUrl(options.serverUrl),
    canonicalProjectRoot(options.cwd),
  ].join('\0')
  const queues = new Map<string, Promise<void>>()

  const entryPath = (sessionId: string): string => {
    if (!sessionId || sessionId.length > 4096 || sessionId.includes('\0')) {
      throw new Error('Remote session id is invalid')
    }
    const digest = createHash('sha256')
      .update(namespace)
      .update('\0')
      .update(sessionId)
      .digest('hex')
    return path.join(cursorDir, `${digest}.json`)
  }

  const ensureCursorDirectory = async (): Promise<void> => {
    await fs.mkdir(cursorDir, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(cursorDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Remote turn cursor directory must not be a symlink')
    }
    await fs.chmod(cursorDir, 0o700)
  }

  const serialized = async <T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = queues.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => next)
    queues.set(sessionId, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (queues.get(sessionId) === queued) queues.delete(sessionId)
    }
  }

  return {
    load(sessionId) {
      return serialized(sessionId, async () => {
        const filePath = entryPath(sessionId)
        let handle
        try {
          handle = await fs.open(
            filePath,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          )
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            (error as { code?: string }).code === 'ENOENT'
          ) {
            return undefined
          }
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            (error as { code?: string }).code === 'ELOOP'
          ) {
            throw new Error('Remote turn cursor entry must not be a symlink')
          }
          throw error
        }
        try {
          const stat = await handle.stat()
          if (!stat.isFile()) {
            throw new Error('Remote turn cursor entry is not a regular file')
          }
          if (stat.size > MAX_CURSOR_FILE_BYTES) {
            throw new Error('Remote turn cursor entry exceeds its size limit')
          }
          const raw = await handle.readFile({ encoding: 'utf8' })
          return parseCursorRecord(JSON.parse(raw))
        } finally {
          await handle.close()
        }
      })
    },

    save(sessionId, record) {
      return serialized(sessionId, async () => {
        const parsed = parseCursorRecord(record)
        await ensureCursorDirectory()
        const filePath = entryPath(sessionId)
        const temporaryPath = path.join(
          cursorDir,
          `.${path.basename(filePath)}.${randomUUID()}.tmp`,
        )
        let handle
        try {
          handle = await fs.open(
            temporaryPath,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          )
          await handle.writeFile(`${JSON.stringify(parsed)}\n`, 'utf8')
          await handle.sync()
          await handle.close()
          handle = undefined
          await fs.rename(temporaryPath, filePath)
          await fs.chmod(filePath, 0o600)
        } finally {
          await handle?.close().catch(() => undefined)
          await fs.unlink(temporaryPath).catch(() => undefined)
        }
      })
    },

    clear(sessionId) {
      return serialized(sessionId, async () => {
        const filePath = entryPath(sessionId)
        await fs.unlink(filePath).catch((error: unknown) => {
          if (
            !error ||
            typeof error !== 'object' ||
            !('code' in error) ||
            (error as { code?: string }).code !== 'ENOENT'
          ) {
            throw error
          }
        })
      })
    },
  }
}
