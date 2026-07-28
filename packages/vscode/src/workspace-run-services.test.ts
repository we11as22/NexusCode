import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WorkspaceRunServicesRegistry } from "./workspace-run-services.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

describe("VS Code workspace run services", () => {
  it("reuses one live service set for the exact canonical workspace", async () => {
    const workspace = await temporaryDirectory("nexus-vscode-services-")
    const aliasRoot = await temporaryDirectory("nexus-vscode-services-alias-")
    const alias = join(aliasRoot, "workspace-link")
    await symlink(workspace, alias, "dir")
    const registry = new WorkspaceRunServicesRegistry()

    const first = registry.get(workspace)
    const second = registry.get(alias)

    expect(second).toBe(first)
    expect(second.parallelAgentManager).toBe(first.parallelAgentManager)
    expect(second.backgroundProcesses).toBe(first.backgroundProcesses)
    expect(second.changeSets?.workspaceId).toMatch(/^[a-f0-9]{64}$/u)
    expect(second.changeSets?.store).toBeDefined()
    expect(second.git).toBeDefined()
    await registry.close()
  })

  it("isolates different workspaces and drains every service exactly once", async () => {
    const firstWorkspace = await temporaryDirectory(
      "nexus-vscode-services-first-",
    )
    const secondWorkspace = await temporaryDirectory(
      "nexus-vscode-services-second-",
    )
    const registry = new WorkspaceRunServicesRegistry()
    const first = registry.get(firstWorkspace)
    const second = registry.get(secondWorkspace)
    const firstShutdown = vi.spyOn(first.parallelAgentManager, "shutdown")
    const secondShutdown = vi.spyOn(second.parallelAgentManager, "shutdown")
    const firstBackgroundClose = vi.spyOn(first.backgroundProcesses, "close")
    const secondBackgroundClose = vi.spyOn(second.backgroundProcesses, "close")
    const firstWorkspaceTasksClose = vi.spyOn(first.workspaceTasks, "close")
    const secondWorkspaceTasksClose = vi.spyOn(second.workspaceTasks, "close")

    expect(second).not.toBe(first)
    await Promise.all([registry.close(), registry.close()])

    expect(firstShutdown).toHaveBeenCalledOnce()
    expect(secondShutdown).toHaveBeenCalledOnce()
    expect(firstBackgroundClose).toHaveBeenCalledOnce()
    expect(secondBackgroundClose).toHaveBeenCalledOnce()
    expect(firstWorkspaceTasksClose).toHaveBeenCalledOnce()
    expect(secondWorkspaceTasksClose).toHaveBeenCalledOnce()
    expect(() => registry.get(firstWorkspace)).toThrow(/closed/i)
  })
})
