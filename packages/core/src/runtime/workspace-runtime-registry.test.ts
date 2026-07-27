import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ManagedWorkspaceRuntime,
  WorkspaceRuntimeRegistry,
  type SessionProtocolService,
  type WorkspaceRuntime,
  type WorkspaceRuntimeFactory,
} from "./index.js"

const temporaryDirectories: string[] = []

function temporaryWorkspace(): {
  root: string
  workspace: string
  alias: string
} {
  const root = mkdtempSync(join(tmpdir(), "nexus-runtime-registry-test-"))
  temporaryDirectories.push(root)
  const workspace = join(root, "workspace")
  const alias = join(root, "workspace-alias")
  mkdirSync(workspace)
  symlinkSync(workspace, alias, "dir")
  return { root, workspace, alias }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [
      error.message,
      ...error.errors.flatMap((nested) => errorMessages(nested)),
    ]
  }
  return [error instanceof Error ? error.message : String(error)]
}

async function expectRejectionContaining(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  let rejection: unknown
  try {
    await promise
  } catch (error) {
    rejection = error
  }
  expect(rejection).toBeDefined()
  expect(errorMessages(rejection)).toContain(message)
}

function fakeFactory(): {
  factory: WorkspaceRuntimeFactory
  create: ReturnType<typeof vi.fn>
  runtimes: WorkspaceRuntime[]
} {
  const runtimes: WorkspaceRuntime[] = []
  const create = vi.fn(async (canonicalDirectory: string) => {
    const runtime = new ManagedWorkspaceRuntime(canonicalDirectory, {
      identity: { workspace: canonicalDirectory },
    })
    runtimes.push(runtime)
    return runtime
  })
  return { factory: { create }, create, runtimes }
}

function protocolService(close: () => void | Promise<void>): SessionProtocolService {
  return {
    portVersion: 1,
    dispatch: async () => {
      throw new Error("not used by lifecycle tests")
    },
    snapshot: async () => {
      throw new Error("not used by lifecycle tests")
    },
    events: async function* () {
      // No events are used by lifecycle tests.
    },
    close,
  }
}

describe("WorkspaceRuntimeRegistry", () => {
  it("drains parallel work before integrations and closes state last", async () => {
    const order: string[] = []
    const runtime = new ManagedWorkspaceRuntime("/workspace", {
      protocol: protocolService(() => {
        order.push("protocol")
      }),
      sessions: {
        shutdown: async () => {
          await Promise.resolve()
          order.push("sessions")
        },
      },
      state: {
        close: () => {
          order.push("state")
        },
      },
      mcp: {
        close: () => {
          order.push("mcp")
        },
      },
      parallelAgents: {
        shutdown: async () => {
          await Promise.resolve()
          order.push("parallelAgents")
        },
      },
      plugins: {
        dispose: () => {
          order.push("plugins")
        },
      },
    })

    await runtime.close()

    expect(order).toEqual([
      "protocol",
      "sessions",
      "parallelAgents",
      "plugins",
      "mcp",
      "state",
    ])
  })

  it("does not drain sessions while protocol ingress is still open", async () => {
    const protocolClose = vi
      .fn()
      .mockRejectedValueOnce(new Error("protocol close failed"))
      .mockResolvedValueOnce(undefined)
    const sessionsShutdown = vi.fn()
    const stateClose = vi.fn()
    const runtime = new ManagedWorkspaceRuntime("/workspace", {
      protocol: protocolService(protocolClose),
      sessions: { shutdown: sessionsShutdown },
      state: { close: stateClose },
    })

    await expect(runtime.close()).rejects.toThrow("protocol close failed")
    expect(sessionsShutdown).not.toHaveBeenCalled()
    expect(stateClose).not.toHaveBeenCalled()

    await runtime.close()
    expect(protocolClose).toHaveBeenCalledTimes(2)
    expect(sessionsShutdown).toHaveBeenCalledOnce()
    expect(stateClose).toHaveBeenCalledOnce()
  })

  it("does not close integrations or state when parallel drain fails", async () => {
    const parallelShutdown = vi
      .fn()
      .mockRejectedValueOnce(new Error("parallel drain failed"))
      .mockResolvedValueOnce(undefined)
    const mcpClose = vi.fn()
    const stateClose = vi.fn()
    const runtime = new ManagedWorkspaceRuntime("/workspace", {
      parallelAgents: { shutdown: parallelShutdown },
      mcp: { close: mcpClose },
      state: { close: stateClose },
    })

    await expect(runtime.close()).rejects.toThrow("parallel drain failed")
    expect(mcpClose).not.toHaveBeenCalled()
    expect(stateClose).not.toHaveBeenCalled()

    await runtime.close()
    expect(parallelShutdown).toHaveBeenCalledTimes(2)
    expect(mcpClose).toHaveBeenCalledOnce()
    expect(stateClose).toHaveBeenCalledOnce()
  })

  it("does not close integrations or state when session drain fails", async () => {
    const stateClose = vi.fn()
    const mcpClose = vi.fn()
    const sessionsShutdown = vi
      .fn()
      .mockRejectedValueOnce(new Error("session drain failed"))
      .mockResolvedValueOnce(undefined)
    const runtime = new ManagedWorkspaceRuntime("/workspace", {
      sessions: { shutdown: sessionsShutdown },
      mcp: { close: mcpClose },
      state: { close: stateClose },
    })

    await expect(runtime.close()).rejects.toThrow("session drain failed")
    expect(runtime.closed).toBe(false)
    expect(mcpClose).not.toHaveBeenCalled()
    expect(stateClose).not.toHaveBeenCalled()

    await runtime.close()
    expect(sessionsShutdown).toHaveBeenCalledTimes(2)
    expect(mcpClose).toHaveBeenCalledTimes(1)
    expect(stateClose).toHaveBeenCalledTimes(1)
    expect(runtime.closed).toBe(true)
  })

  it("retries only failed workspace cleanup and closes state last", async () => {
    const order: string[] = []
    const sessionsShutdown = vi.fn(() => {
      order.push("sessions")
    })
    const pluginsClose = vi.fn(() => {
      order.push("plugins")
    })
    const mcpClose = vi
      .fn()
      .mockImplementationOnce(() => {
        order.push("mcp:failed")
        throw new Error("mcp cleanup failed")
      })
      .mockImplementationOnce(() => {
        order.push("mcp:retried")
      })
    const memoryClose = vi.fn(() => {
      order.push("memory")
    })
    const stateClose = vi.fn(() => {
      order.push("state")
    })
    const runtime = new ManagedWorkspaceRuntime("/workspace", {
      sessions: { shutdown: sessionsShutdown },
      plugins: { close: pluginsClose },
      mcp: { close: mcpClose },
      memory: { close: memoryClose },
      state: { close: stateClose },
    })

    await expectRejectionContaining(runtime.close(), "mcp cleanup failed")

    expect(runtime.closed).toBe(false)
    expect(order).toEqual([
      "sessions",
      "plugins",
      "mcp:failed",
      "memory",
    ])
    expect(stateClose).not.toHaveBeenCalled()

    await runtime.close()

    expect(runtime.closed).toBe(true)
    expect(order).toEqual([
      "sessions",
      "plugins",
      "mcp:failed",
      "memory",
      "mcp:retried",
      "state",
    ])
    expect(sessionsShutdown).toHaveBeenCalledTimes(1)
    expect(pluginsClose).toHaveBeenCalledTimes(1)
    expect(mcpClose).toHaveBeenCalledTimes(2)
    expect(memoryClose).toHaveBeenCalledTimes(1)
    expect(stateClose).toHaveBeenCalledTimes(1)
  })

  it("retries failed state cleanup without repeating completed services", async () => {
    const sessionsShutdown = vi.fn()
    const mcpClose = vi.fn()
    const stateClose = vi
      .fn()
      .mockRejectedValueOnce(new Error("state cleanup failed"))
      .mockResolvedValueOnce(undefined)
    const runtime = new ManagedWorkspaceRuntime("/workspace", {
      sessions: { shutdown: sessionsShutdown },
      mcp: { close: mcpClose },
      state: { close: stateClose },
    })

    await expectRejectionContaining(runtime.close(), "state cleanup failed")
    expect(runtime.closed).toBe(false)

    await runtime.close()

    expect(runtime.closed).toBe(true)
    expect(sessionsShutdown).toHaveBeenCalledTimes(1)
    expect(mcpClose).toHaveBeenCalledTimes(1)
    expect(stateClose).toHaveBeenCalledTimes(2)
  })

  it("reports every failed workspace cleanup in one attempt", async () => {
    const firstFailure = new Error("plugin cleanup failed")
    const secondFailure = new Error("memory cleanup failed")
    const stateClose = vi.fn()
    const runtime = new ManagedWorkspaceRuntime("/workspace", {
      plugins: { close: vi.fn().mockRejectedValue(firstFailure) },
      memory: { close: vi.fn().mockRejectedValue(secondFailure) },
      state: { close: stateClose },
    })

    let rejection: unknown
    try {
      await runtime.close()
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(AggregateError)
    expect((rejection as AggregateError).errors).toEqual([
      firstFailure,
      secondFailure,
    ])
    expect(runtime.closed).toBe(false)
    expect(stateClose).not.toHaveBeenCalled()
  })

  it("coalesces concurrent cleanup and exposes one fresh retry", async () => {
    let rejectCleanup: ((error: Error) => void) | undefined
    const cleanup = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectCleanup = reject
          }),
      )
      .mockResolvedValueOnce(undefined)
    const runtime = new ManagedWorkspaceRuntime("/workspace", {
      mcp: { close: cleanup },
    })

    const first = runtime.close()
    const second = runtime.close()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1))
    rejectCleanup?.(new Error("cleanup failed"))

    const results = await Promise.allSettled([first, second])
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ])
    expect(runtime.closed).toBe(false)

    await runtime.close()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(runtime.closed).toBe(true)
  })

  it("maps realpath aliases to the same retained runtime", async () => {
    const { workspace, alias } = temporaryWorkspace()
    const { factory, create } = fakeFactory()
    const registry = new WorkspaceRuntimeRegistry(factory)

    const first = await registry.acquire(workspace)
    const second = await registry.acquire(alias)

    expect(first.runtime).toBe(second.runtime)
    expect(create).toHaveBeenCalledTimes(1)
    expect(registry.peek(alias)).toBe(first.runtime)

    await first.release()
    expect(first.runtime.closed).toBe(false)
    await second.release()
    expect(first.runtime.closed).toBe(true)
  })

  it("coalesces concurrent factory creation", async () => {
    const { workspace } = temporaryWorkspace()
    const canonicalWorkspace = realpathSync(workspace)
    let resolveCreation: ((runtime: WorkspaceRuntime) => void) | undefined
    const create = vi.fn(
      (canonicalDirectory: string) =>
        new Promise<WorkspaceRuntime>((resolve) => {
          resolveCreation = resolve
          expect(canonicalDirectory).toBe(canonicalWorkspace)
        }),
    )
    const registry = new WorkspaceRuntimeRegistry({ create })

    const firstPromise = registry.acquire(workspace)
    const secondPromise = registry.acquire(workspace)
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    resolveCreation?.(new ManagedWorkspaceRuntime(canonicalWorkspace, {}))
    const [first, second] = await Promise.all([firstPromise, secondPromise])

    expect(first.runtime).toBe(second.runtime)
    await Promise.all([first.release(), second.release()])
  })

  it("does not resurrect an acquire that races with closeAll", async () => {
    const { workspace } = temporaryWorkspace()
    const canonicalWorkspace = realpathSync(workspace)
    let resolveFirst: ((runtime: WorkspaceRuntime) => void) | undefined
    const create = vi
      .fn<WorkspaceRuntimeFactory["create"]>()
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceRuntime>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValue(
        new ManagedWorkspaceRuntime(canonicalWorkspace, {}),
      )
    const registry = new WorkspaceRuntimeRegistry({ create })

    const acquire = registry.acquire(workspace)
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const closing = registry.closeAll()
    resolveFirst?.(new ManagedWorkspaceRuntime(canonicalWorkspace, {}))

    await closing
    await expect(acquire).rejects.toThrow(/registry is closed/i)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("does not cache a failed factory creation", async () => {
    const { workspace } = temporaryWorkspace()
    const runtime = new ManagedWorkspaceRuntime(realpathSync(workspace), {})
    const create = vi
      .fn<WorkspaceRuntimeFactory["create"]>()
      .mockRejectedValueOnce(new Error("initialization failed"))
      .mockResolvedValueOnce(runtime)
    const registry = new WorkspaceRuntimeRegistry({ create })

    await expect(registry.acquire(workspace)).rejects.toThrow(
      "initialization failed",
    )
    const handle = await registry.acquire(workspace)
    expect(handle.runtime).toBe(runtime)
    expect(create).toHaveBeenCalledTimes(2)
    await handle.release()
  })

  it("closes and evicts a runtime returned for another workspace", async () => {
    const { workspace } = temporaryWorkspace()
    const otherWorkspace = temporaryWorkspace().workspace
    const canonicalWorkspace = realpathSync(workspace)
    const mismatched = new ManagedWorkspaceRuntime(
      realpathSync(otherWorkspace),
      {},
    )
    const valid = new ManagedWorkspaceRuntime(canonicalWorkspace, {})
    const create = vi
      .fn<WorkspaceRuntimeFactory["create"]>()
      .mockResolvedValueOnce(mismatched)
      .mockResolvedValueOnce(valid)
    const registry = new WorkspaceRuntimeRegistry({ create })

    await expect(registry.acquire(workspace)).rejects.toThrow(
      /different canonical directory/i,
    )
    expect(mismatched.closed).toBe(true)

    const handle = await registry.acquire(workspace)
    expect(handle.runtime).toBe(valid)
    expect(create).toHaveBeenCalledTimes(2)
    await handle.release()
  })

  it("retains a mismatched factory runtime until failed cleanup is retried", async () => {
    const { workspace } = temporaryWorkspace()
    const otherWorkspace = temporaryWorkspace().workspace
    const canonicalWorkspace = realpathSync(workspace)
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("validation cleanup failed"))
      .mockResolvedValueOnce(undefined)
    const mismatched = new ManagedWorkspaceRuntime(
      realpathSync(otherWorkspace),
      { mcp: { close: cleanup } },
    )
    const valid = new ManagedWorkspaceRuntime(canonicalWorkspace, {})
    const create = vi
      .fn<WorkspaceRuntimeFactory["create"]>()
      .mockResolvedValueOnce(mismatched)
      .mockResolvedValueOnce(valid)
    const registry = new WorkspaceRuntimeRegistry({ create })

    await expectRejectionContaining(
      registry.acquire(workspace),
      "validation cleanup failed",
    )
    expect(mismatched.closed).toBe(false)

    await expect(registry.close(workspace)).resolves.toBe(true)
    expect(mismatched.closed).toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(2)

    const handle = await registry.acquire(workspace)
    expect(handle.runtime).toBe(valid)
    expect(create).toHaveBeenCalledTimes(2)
    await handle.release()
  })

  it("rejects and evicts a factory runtime that is already closed", async () => {
    const { workspace } = temporaryWorkspace()
    const canonicalWorkspace = realpathSync(workspace)
    const closed = new ManagedWorkspaceRuntime(canonicalWorkspace, {})
    await closed.close()
    const valid = new ManagedWorkspaceRuntime(canonicalWorkspace, {})
    const create = vi
      .fn<WorkspaceRuntimeFactory["create"]>()
      .mockResolvedValueOnce(closed)
      .mockResolvedValueOnce(valid)
    const registry = new WorkspaceRuntimeRegistry({ create })

    await expect(registry.acquire(workspace)).rejects.toThrow(
      /already closed/i,
    )

    const handle = await registry.acquire(workspace)
    expect(handle.runtime).toBe(valid)
    expect(create).toHaveBeenCalledTimes(2)
    await handle.release()
  })

  it("closes every runtime once and waits for asynchronous cleanup", async () => {
    const firstWorkspace = temporaryWorkspace().workspace
    const secondWorkspace = temporaryWorkspace().workspace
    const cleanupOrder: string[] = []
    const factory: WorkspaceRuntimeFactory = {
      create: async (canonicalDirectory) =>
        new ManagedWorkspaceRuntime(canonicalDirectory, {
          background: {
            close: async () => {
              await Promise.resolve()
              cleanupOrder.push(canonicalDirectory)
            },
          },
        }),
    }
    const registry = new WorkspaceRuntimeRegistry(factory)
    const first = await registry.acquire(firstWorkspace)
    const second = await registry.acquire(secondWorkspace)

    await Promise.all([registry.closeAll(), registry.closeAll()])

    expect(first.runtime.closed).toBe(true)
    expect(second.runtime.closed).toBe(true)
    expect(cleanupOrder.sort()).toEqual(
      [first.canonicalDirectory, second.canonicalDirectory].sort(),
    )
    await expect(registry.acquire(firstWorkspace)).rejects.toThrow(
      /registry is closed/i,
    )
    await Promise.all([first.release(), second.release()])
  })

  it("retains an open runtime after close failure and allows close retry", async () => {
    const { workspace } = temporaryWorkspace()
    const canonicalWorkspace = realpathSync(workspace)
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValueOnce(undefined)
    const runtime = new ManagedWorkspaceRuntime(canonicalWorkspace, {
      mcp: { close: cleanup },
    })
    const create = vi.fn(async () => runtime)
    const registry = new WorkspaceRuntimeRegistry({ create })
    const handle = await registry.acquire(workspace)

    await expectRejectionContaining(
      registry.close(workspace),
      "cleanup failed",
    )

    expect(runtime.closed).toBe(false)
    expect(registry.peek(workspace)).toBeUndefined()
    expect(create).toHaveBeenCalledTimes(1)

    await expect(registry.close(workspace)).resolves.toBe(true)

    expect(runtime.closed).toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(registry.peek(workspace)).toBeUndefined()
    await handle.release()
  })

  it("lets the last handle retry cleanup after its first release attempt fails", async () => {
    const { workspace } = temporaryWorkspace()
    const canonicalWorkspace = realpathSync(workspace)
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient cleanup failure"))
      .mockResolvedValueOnce(undefined)
    const runtime = new ManagedWorkspaceRuntime(canonicalWorkspace, {
      mcp: { close: cleanup },
    })
    const registry = new WorkspaceRuntimeRegistry({
      create: async () => runtime,
    })
    const handle = await registry.acquire(workspace)

    await expectRejectionContaining(
      handle.release(),
      "transient cleanup failure",
    )
    expect(handle.released).toBe(true)
    expect(runtime.closed).toBe(false)

    await expect(handle.release()).resolves.toBeUndefined()

    expect(runtime.closed).toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it("retries failed closeAll while remaining closed to new acquires", async () => {
    const firstWorkspace = temporaryWorkspace().workspace
    const secondWorkspace = temporaryWorkspace().workspace
    const firstCanonical = realpathSync(firstWorkspace)
    const secondCanonical = realpathSync(secondWorkspace)
    const retryingCleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error("first cleanup failed"))
      .mockResolvedValueOnce(undefined)
    const stableCleanup = vi.fn()
    const runtimes = new Map([
      [
        firstCanonical,
        new ManagedWorkspaceRuntime(firstCanonical, {
          mcp: { close: retryingCleanup },
        }),
      ],
      [
        secondCanonical,
        new ManagedWorkspaceRuntime(secondCanonical, {
          mcp: { close: stableCleanup },
        }),
      ],
    ])
    const create = vi.fn(async (canonicalDirectory: string) => {
      const runtime = runtimes.get(canonicalDirectory)
      if (!runtime) throw new Error("unexpected workspace")
      return runtime
    })
    const registry = new WorkspaceRuntimeRegistry({ create })
    const first = await registry.acquire(firstWorkspace)
    const second = await registry.acquire(secondWorkspace)

    await expectRejectionContaining(
      registry.closeAll(),
      "first cleanup failed",
    )

    expect(first.runtime.closed).toBe(false)
    expect(second.runtime.closed).toBe(true)
    await expect(registry.acquire(firstWorkspace)).rejects.toThrow(
      /registry is closed/i,
    )

    await expect(registry.closeAll()).resolves.toBeUndefined()

    expect(first.runtime.closed).toBe(true)
    expect(retryingCleanup).toHaveBeenCalledTimes(2)
    expect(stableCleanup).toHaveBeenCalledTimes(1)
    await Promise.all([first.release(), second.release()])
  })

  it("never shares workspace-owned services across directories", async () => {
    const firstWorkspace = temporaryWorkspace().workspace
    const secondWorkspace = temporaryWorkspace().workspace
    const { factory } = fakeFactory()
    const registry = new WorkspaceRuntimeRegistry(factory)

    const first = await registry.acquire(firstWorkspace)
    const second = await registry.acquire(secondWorkspace)

    expect(first.runtime).not.toBe(second.runtime)
    expect(first.runtime.services.identity).toEqual({
      workspace: first.canonicalDirectory,
    })
    expect(second.runtime.services.identity).toEqual({
      workspace: second.canonicalDirectory,
    })
    await Promise.all([first.release(), second.release()])
  })
})
