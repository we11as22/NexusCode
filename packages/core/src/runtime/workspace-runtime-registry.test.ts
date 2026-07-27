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

describe("WorkspaceRuntimeRegistry", () => {
  it("drains parallel work before integrations and closes state last", async () => {
    const order: string[] = []
    const runtime = new ManagedWorkspaceRuntime("/workspace", {
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

    expect(order).toEqual(["parallelAgents", "plugins", "mcp", "state"])
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
