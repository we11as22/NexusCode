import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { grantWorkspaceAuthority } from "@nexuscode/core"
import { loadCliWorkspaceConfig } from "./nexus-bootstrap.js"

describe("CLI workspace authority hydration", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    )
  })

  it("hydrates exact host grants while project settings can only restrict", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-cli-authority-"))
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
          deny: ["rm -rf:*"],
          ask: ["git push:*"],
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
      { kind: "command-pattern", value: "pnpm run:*" },
      { storePath },
    )
    await grantWorkspaceAuthority(
      workspace,
      { kind: "mcp-tool", value: "github__search" },
      { storePath },
    )

    const config = await loadCliWorkspaceConfig(workspace, {
      loadEnv: false,
      globalConfigPath: false,
      hostAuthority: true,
      authorityStoreOptions: { storePath },
    })

    expect(config.permissions.allowedCommands).toEqual(["pnpm test"])
    expect(config.permissions.allowCommandPatterns).toEqual(["pnpm run:*"])
    expect(config.permissions.allowedMcpTools).toEqual(["github__search"])
    expect(config.permissions.denyCommandPatterns).toEqual(["rm -rf:*"])
    expect(config.permissions.askCommandPatterns).toEqual(["git push:*"])
  })

  it("does not hydrate client-machine grants for a remote runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-cli-authority-"))
    temporaryDirectories.push(root)
    const workspace = path.join(root, "workspace")
    const storePath = path.join(root, "host-data", "authority", "workspaces.json")
    await mkdir(workspace)
    await grantWorkspaceAuthority(
      workspace,
      { kind: "command", value: "pnpm test" },
      { storePath },
    )

    const config = await loadCliWorkspaceConfig(workspace, {
      loadEnv: false,
      globalConfigPath: false,
      hostAuthority: false,
      authorityStoreOptions: { storePath },
    })

    expect(config.permissions.allowedCommands).toEqual([])
  })
})
