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
  type WorkspaceRuntime,
  type WorkspaceRuntimeFactory,
} from "@nexuscode/core"
import { ServerRuntimeRegistry } from "./runtime-registry.js"

const temporaryDirectories: string[] = []

function temporaryWorkspace(): {
  root: string
  workspace: string
  alias: string
} {
  const root = mkdtempSync(join(tmpdir(), "nexus-server-runtime-test-"))
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

describe("ServerRuntimeRegistry", () => {
  it("retains one runtime across requests and realpath aliases", async () => {
    const { workspace, alias } = temporaryWorkspace()
    const create = vi.fn(async (canonicalDirectory: string) =>
      new ManagedWorkspaceRuntime(canonicalDirectory, {}),
    )
    const registry = new ServerRuntimeRegistry({ create })

    const [first, second, third] = await Promise.all([
      registry.get(workspace),
      registry.get(alias),
      registry.get(workspace),
    ])

    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(first.closed).toBe(false)
    expect(create).toHaveBeenCalledTimes(1)

    await registry.close()
    expect(first.closed).toBe(true)
  })

  it("does not cache failed construction", async () => {
    const { workspace } = temporaryWorkspace()
    const valid = new ManagedWorkspaceRuntime(realpathSync(workspace), {})
    const create = vi
      .fn<WorkspaceRuntimeFactory["create"]>()
      .mockRejectedValueOnce(new Error("runtime unavailable"))
      .mockResolvedValueOnce(valid)
    const registry = new ServerRuntimeRegistry({ create })

    await expect(registry.get(workspace)).rejects.toThrow("runtime unavailable")
    await expect(registry.get(workspace)).resolves.toBe(valid)
    expect(create).toHaveBeenCalledTimes(2)

    await registry.close()
  })

  it("rejects new and racing requests once shutdown begins", async () => {
    const { workspace } = temporaryWorkspace()
    let resolveCreation: ((runtime: WorkspaceRuntime) => void) | undefined
    const create = vi.fn(
      (canonicalDirectory: string) =>
        new Promise<WorkspaceRuntime>((resolve) => {
          resolveCreation = resolve
          expect(canonicalDirectory).toBe(realpathSync(workspace))
        }),
    )
    const registry = new ServerRuntimeRegistry({ create })

    const pending = registry.get(workspace)
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const closing = registry.close()
    const runtime = new ManagedWorkspaceRuntime(realpathSync(workspace), {})
    resolveCreation?.(runtime)

    await closing
    await expect(pending).rejects.toThrow(/closed/i)
    await expect(registry.get(workspace)).rejects.toThrow(/closed/i)
    expect(runtime.closed).toBe(true)
  })

  it("coalesces close and retries a failed runtime drain", async () => {
    const { workspace } = temporaryWorkspace()
    const shutdown = vi
      .fn()
      .mockRejectedValueOnce(new Error("drain failed"))
      .mockResolvedValueOnce(undefined)
    const runtime = new ManagedWorkspaceRuntime(realpathSync(workspace), {
      sessions: { shutdown },
    })
    const registry = new ServerRuntimeRegistry({
      create: async () => runtime,
    })
    await registry.get(workspace)

    const first = registry.close()
    expect(registry.close()).toBe(first)
    await expect(first).rejects.toThrow(/failed to close all workspace runtimes/i)
    expect(runtime.closed).toBe(false)
    await expect(registry.get(workspace)).rejects.toThrow(/closed/i)

    await registry.close()
    expect(runtime.closed).toBe(true)
    expect(shutdown).toHaveBeenCalledTimes(2)
  })
})
