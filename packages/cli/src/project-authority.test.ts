import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  getPendingProjectAuthorityRequests,
  hydrateWorkspaceAuthority,
  loadConfig,
} from "@nexuscode/core"
import {
  approvePendingProjectAuthorityByFingerprint,
} from "./project-authority.js"

describe("CLI project authority approval", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    )
  })

  it("approves only the exact currently pending request for this workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-cli-project-authority-"))
    temporaryDirectories.push(root)
    const workspace = path.join(root, "workspace")
    const storePath = path.join(root, "host-data", "authority", "workspaces.json")
    await mkdir(path.join(workspace, ".nexus"), { recursive: true })
    await writeFile(
      path.join(workspace, ".nexus", "nexus.yaml"),
      [
        "model:",
        "  provider: openai-compatible",
        "  id: project-model",
        "  baseUrl: https://project.test/v1",
      ].join("\n"),
    )
    const before = await loadConfig(workspace, { globalConfigPath: false })
    const request = getPendingProjectAuthorityRequests(before)[0]
    expect(request).toBeDefined()

    await expect(
      approvePendingProjectAuthorityByFingerprint(
        workspace,
        request!.fingerprint,
        { storePath, globalConfigPath: false },
      ),
    ).resolves.toMatchObject({
      kind: "model-endpoint",
      fingerprint: request!.fingerprint,
    })

    const active = await loadConfig(workspace, { globalConfigPath: false })
    await hydrateWorkspaceAuthority(active, workspace, { storePath })
    expect(active.model.baseUrl).toBe("https://project.test/v1")
    expect(getPendingProjectAuthorityRequests(active)).toEqual([])
  })

  it("fails closed when stale content is no longer pending", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-cli-project-authority-"))
    temporaryDirectories.push(root)
    const workspace = path.join(root, "workspace")
    const storePath = path.join(root, "host-data", "authority", "workspaces.json")
    const configPath = path.join(workspace, ".nexus", "nexus.yaml")
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openai-compatible",
        "  id: project-model",
        "  baseUrl: https://first.test/v1",
      ].join("\n"),
    )
    const first = await loadConfig(workspace, { globalConfigPath: false })
    const staleFingerprint =
      getPendingProjectAuthorityRequests(first)[0]!.fingerprint
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openai-compatible",
        "  id: project-model",
        "  baseUrl: https://changed.test/v1",
      ].join("\n"),
    )

    await expect(
      approvePendingProjectAuthorityByFingerprint(
        workspace,
        staleFingerprint,
        { storePath, globalConfigPath: false },
      ),
    ).rejects.toThrow("no longer pending")
  })
})
