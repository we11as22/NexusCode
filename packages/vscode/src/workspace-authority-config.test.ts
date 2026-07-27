import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  getPendingProjectAuthorityRequests,
  grantWorkspaceAuthority,
} from "@nexuscode/core"
import {
  approvePendingVsCodeProjectAuthority,
  loadVsCodeWorkspaceConfig,
} from "./workspace-authority-config.js"

describe("VS Code workspace authority hydration", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    )
  })

  it("combines exact host grants with project-only restrictions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-vscode-authority-"))
    temporaryDirectories.push(root)
    const workspace = path.join(root, "workspace")
    const nexusDirectory = path.join(workspace, ".nexus")
    const storePath = path.join(root, "host-data", "authority", "workspaces.json")
    await mkdir(nexusDirectory, { recursive: true })
    await writeFile(
      path.join(nexusDirectory, "settings.local.json"),
      JSON.stringify({
        permissions: {
          allow: ["project-must-not-grant:*"],
          allowedMcpTools: ["project__must_not_grant"],
          deny: ["dangerous:*"],
          ask: ["publish:*"],
        },
      }),
    )
    await grantWorkspaceAuthority(
      workspace,
      { kind: "command", value: "pnpm test" },
      { storePath },
    )
    await grantWorkspaceAuthority(
      workspace,
      { kind: "mcp-tool", value: "github__search" },
      { storePath },
    )

    const config = await loadVsCodeWorkspaceConfig(workspace, {
      loadEnv: false,
      globalConfigPath: false,
      hostAuthority: true,
      authorityStoreOptions: { storePath },
    })

    expect(config.permissions.allowedCommands).toEqual(["pnpm test"])
    expect(config.permissions.allowCommandPatterns).toEqual([])
    expect(config.permissions.allowedMcpTools).toEqual(["github__search"])
    expect(config.permissions.denyCommandPatterns).toEqual(["dangerous:*"])
    expect(config.permissions.askCommandPatterns).toEqual(["publish:*"])
  })

  it("does not import local grants into remote runtime metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-vscode-authority-"))
    temporaryDirectories.push(root)
    const workspace = path.join(root, "workspace")
    const storePath = path.join(root, "host-data", "authority", "workspaces.json")
    await mkdir(workspace)
    await grantWorkspaceAuthority(
      workspace,
      { kind: "command", value: "pnpm test" },
      { storePath },
    )

    const config = await loadVsCodeWorkspaceConfig(workspace, {
      loadEnv: false,
      globalConfigPath: false,
      hostAuthority: false,
      authorityStoreOptions: { storePath },
    })

    expect(config.permissions.allowedCommands).toEqual([])
  })

  it("approves a current exact request and activates it on the next host load", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-vscode-authority-"))
    temporaryDirectories.push(root)
    const workspace = path.join(root, "workspace")
    const storePath = path.join(root, "host-data", "authority", "workspaces.json")
    await mkdir(path.join(workspace, ".nexus"), { recursive: true })
    await writeFile(
      path.join(workspace, ".nexus", "nexus.yaml"),
      [
        "skillsUrls:",
        "  - https://project-skills.test",
      ].join("\n"),
    )
    const pendingConfig = await loadVsCodeWorkspaceConfig(workspace, {
      loadEnv: false,
      globalConfigPath: false,
      hostAuthority: false,
      authorityStoreOptions: { storePath },
    })
    const request = getPendingProjectAuthorityRequests(pendingConfig)[0]
    expect(request?.kind).toBe("remote-skills")

    await approvePendingVsCodeProjectAuthority(
      workspace,
      request!.fingerprint,
      {
        loadEnv: false,
        globalConfigPath: false,
        authorityStoreOptions: { storePath },
      },
    )

    const active = await loadVsCodeWorkspaceConfig(workspace, {
      loadEnv: false,
      globalConfigPath: false,
      hostAuthority: true,
      authorityStoreOptions: { storePath },
    })
    expect(active.skillsUrls).toEqual(["https://project-skills.test"])
    expect(getPendingProjectAuthorityRequests(active)).toEqual([])
  })
})
