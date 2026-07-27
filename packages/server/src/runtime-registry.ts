import { realpath } from "node:fs/promises"
import {
  WorkspaceRuntimeRegistry,
  type WorkspaceRuntime,
  type WorkspaceRuntimeFactory,
  type WorkspaceRuntimeHandle,
} from "@nexuscode/core"

/**
 * Process-owned retention boundary for server workspaces.
 *
 * HTTP requests borrow a runtime through `get()` but never own its lifetime.
 * The server retains one registry handle per canonical workspace until process
 * shutdown, so a quiet connection cannot accidentally tear down sessions,
 * subagents, MCP transports, plugins, or memory services between requests.
 */
export class ServerRuntimeRegistry {
  readonly #registry: WorkspaceRuntimeRegistry
  readonly #retained = new Map<string, Promise<WorkspaceRuntimeHandle>>()
  #closed = false
  #closePromise: Promise<void> | undefined

  constructor(factory: WorkspaceRuntimeFactory) {
    this.#registry = new WorkspaceRuntimeRegistry(factory)
  }

  async get(directory: string): Promise<WorkspaceRuntime> {
    if (this.#closed) {
      throw new Error("Server runtime registry is closed")
    }
    const canonicalDirectory = await realpath(directory)
    if (this.#closed) {
      throw new Error("Server runtime registry is closed")
    }

    let retained = this.#retained.get(canonicalDirectory)
    if (!retained) {
      const acquisition = this.#registry.acquire(canonicalDirectory)
      const guarded = acquisition.catch((error) => {
        if (this.#retained.get(canonicalDirectory) === guarded) {
          this.#retained.delete(canonicalDirectory)
        }
        throw error
      })
      retained = guarded
      this.#retained.set(canonicalDirectory, retained)
    }

    const handle = await retained
    if (this.#closed) {
      throw new Error("Server runtime registry is closed")
    }
    return handle.runtime
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closed = true

    const attempt = this.#registry.closeAll()
    this.#closePromise = attempt.catch((error) => {
      this.#closePromise = undefined
      throw error
    })
    return this.#closePromise
  }
}
