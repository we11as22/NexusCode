import { realpathSync } from "node:fs"
import { realpath } from "node:fs/promises"
import type {
  WorkspaceRuntime,
  WorkspaceRuntimeFactory,
  WorkspaceRuntimeHandle,
} from "./types.js"

interface RuntimeEntry {
  readonly canonicalDirectory: string
  readonly creation: Promise<WorkspaceRuntime>
  runtime?: WorkspaceRuntime
  references: number
  closing?: Promise<void>
}

export class WorkspaceRuntimeRegistry {
  readonly #factory: WorkspaceRuntimeFactory
  readonly #entries = new Map<string, RuntimeEntry>()
  #closingAll: Promise<void> | undefined
  #closed = false

  constructor(factory: WorkspaceRuntimeFactory) {
    this.#factory = factory
  }

  async acquire(directory: string): Promise<WorkspaceRuntimeHandle> {
    if (this.#closed) {
      throw new Error("Workspace runtime registry is closed")
    }
    const canonicalDirectory = await realpath(directory)
    if (this.#closed) {
      throw new Error("Workspace runtime registry is closed")
    }
    return this.#acquireCanonical(canonicalDirectory)
  }

  peek(directory: string): WorkspaceRuntime | undefined {
    let canonicalDirectory: string
    try {
      canonicalDirectory = realpathSync(directory)
    } catch {
      return undefined
    }
    const entry = this.#entries.get(canonicalDirectory)
    return entry && !entry.closing ? entry.runtime : undefined
  }

  async close(directory: string): Promise<boolean> {
    const canonicalDirectory = await realpath(directory)
    const entry = this.#entries.get(canonicalDirectory)
    if (!entry) return false
    await this.#closeEntry(entry)
    return true
  }

  closeAll(): Promise<void> {
    if (this.#closingAll) return this.#closingAll
    this.#closed = true
    this.#closingAll = (async () => {
      const entries = [...this.#entries.values()]
      const results = await Promise.allSettled(
        entries.map((entry) => this.#closeEntry(entry)),
      )
      const errors = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason)
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to close all workspace runtimes")
      }
    })()
    return this.#closingAll
  }

  async #acquireCanonical(
    canonicalDirectory: string,
  ): Promise<WorkspaceRuntimeHandle> {
    while (true) {
      if (this.#closed) {
        throw new Error("Workspace runtime registry is closed")
      }
      let entry = this.#entries.get(canonicalDirectory)
      if (entry?.closing) {
        await entry.closing
        continue
      }
      if (!entry) {
        const creation = Promise.resolve().then(() =>
          this.#factory.create(canonicalDirectory),
        )
        entry = {
          canonicalDirectory,
          creation,
          references: 0,
        }
        this.#entries.set(canonicalDirectory, entry)
      }

      let runtime: WorkspaceRuntime
      try {
        runtime = entry.runtime ?? (await entry.creation)
        let validationError: Error | undefined
        if (runtime.canonicalDirectory !== canonicalDirectory) {
          validationError = new Error(
            `Workspace runtime factory returned a different canonical directory: ` +
              `expected ${canonicalDirectory}, received ${runtime.canonicalDirectory}`,
          )
        } else if (runtime.closed) {
          validationError = new Error(
            `Workspace runtime factory returned an already closed runtime for ${canonicalDirectory}`,
          )
        }
        if (validationError) {
          try {
            await runtime.close()
          } catch (closeError) {
            throw new AggregateError(
              [validationError, closeError],
              `${validationError.message}; cleanup also failed`,
            )
          }
          throw validationError
        }
        entry.runtime = runtime
      } catch (error) {
        if (this.#entries.get(canonicalDirectory) === entry) {
          this.#entries.delete(canonicalDirectory)
        }
        throw error
      }

      if (this.#closed) {
        await entry.closing
        throw new Error("Workspace runtime registry is closed")
      }
      if (entry.closing || this.#entries.get(canonicalDirectory) !== entry) {
        await entry.closing
        continue
      }

      entry.references += 1
      let released = false
      const handle: WorkspaceRuntimeHandle = {
        canonicalDirectory,
        runtime,
        get released() {
          return released
        },
        release: async () => {
          if (released) return
          released = true
          if (this.#entries.get(canonicalDirectory) !== entry) return
          entry.references -= 1
          if (entry.references === 0) {
            await this.#closeEntry(entry)
          }
        },
      }
      return handle
    }
  }

  #closeEntry(entry: RuntimeEntry): Promise<void> {
    if (entry.closing) return entry.closing
    entry.closing = Promise.resolve()
      .then(async () => {
        const runtime = entry.runtime ?? (await entry.creation)
        entry.runtime = runtime
        await runtime.close()
      })
      .finally(() => {
        if (this.#entries.get(entry.canonicalDirectory) === entry) {
          this.#entries.delete(entry.canonicalDirectory)
        }
      })
    return entry.closing
  }
}
