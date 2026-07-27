import crypto from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  applyWorkspaceAuthorityGrants,
  approveWorkspaceProjectAuthority,
  grantWorkspaceAuthority,
  listWorkspaceAuthorities,
  loadWorkspaceAuthority,
  revokeWorkspaceAuthority,
  WorkspaceAuthorityStoreError,
} from "./workspace-authority.js"
import {
  createPendingProjectAuthorityRequest,
} from "../config/project-authority.js"

describe("workspace authority identity", () => {
  const temporaryDirectories: string[] = []

  async function makeFixture(): Promise<{
    root: string
    workspace: string
    storePath: string
  }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-authority-"))
    temporaryDirectories.push(root)
    const workspace = path.join(root, "workspace")
    await mkdir(workspace)
    return {
      root,
      workspace,
      storePath: path.join(root, "host-data", "authority", "workspaces.json"),
    }
  }

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    )
  })

  it("binds a persisted grant to the canonical directory identity", async () => {
    const { root, workspace, storePath } = await makeFixture()
    const alias = path.join(root, "workspace-link")
    await symlink(workspace, alias, "dir")

    await grantWorkspaceAuthority(
      workspace,
      { kind: "command", value: "  pnpm   test  " },
      { storePath },
    )

    const throughAlias = await loadWorkspaceAuthority(alias, { storePath })
    expect(throughAlias?.grants.commands).toEqual(["pnpm test"])
    expect(throughAlias?.identity.canonicalPath).toBe(await realpath(workspace))

    await rename(workspace, path.join(root, "original-workspace"))
    await mkdir(workspace)

    await expect(loadWorkspaceAuthority(workspace, { storePath })).resolves.toBeNull()
  })

  it("keeps host grants outside the repository with private permissions", async () => {
    const { workspace, storePath } = await makeFixture()

    await grantWorkspaceAuthority(
      workspace,
      { kind: "mcp-tool", value: "github__search" },
      { storePath },
    )

    expect(await lstat(storePath).then((entry) => entry.isFile())).toBe(true)
    expect((await stat(storePath)).mode & 0o777).toBe(0o600)
    await expect(lstat(path.join(workspace, ".nexus"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(JSON.parse(await readFile(storePath, "utf8"))).toMatchObject({
      version: 2,
    })
  })

  it("serializes concurrent grants without losing updates", async () => {
    const { workspace, storePath } = await makeFixture()

    await Promise.all([
      grantWorkspaceAuthority(
        workspace,
        { kind: "command", value: "pnpm test" },
        { storePath },
      ),
      grantWorkspaceAuthority(
        workspace,
        { kind: "command-pattern", value: "pnpm run:*" },
        { storePath },
      ),
      grantWorkspaceAuthority(
        workspace,
        { kind: "mcp-tool", value: "github__search" },
        { storePath },
      ),
    ])

    await expect(loadWorkspaceAuthority(workspace, { storePath })).resolves.toMatchObject({
      grants: {
        commands: ["pnpm test"],
        commandPatterns: ["pnpm run:*"],
        mcpTools: ["github__search"],
      },
    })
    await expect(listWorkspaceAuthorities({ storePath })).resolves.toHaveLength(1)
  })

  it("revokes one grant or the complete exact-workspace record", async () => {
    const { workspace, storePath } = await makeFixture()
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

    await expect(
      revokeWorkspaceAuthority(
        workspace,
        { kind: "command", value: "pnpm test" },
        { storePath },
      ),
    ).resolves.toBe(true)
    await expect(loadWorkspaceAuthority(workspace, { storePath })).resolves.toMatchObject({
      grants: {
        commands: [],
        mcpTools: ["github__search"],
      },
    })
    await expect(
      revokeWorkspaceAuthority(workspace, undefined, { storePath }),
    ).resolves.toBe(true)
    await expect(loadWorkspaceAuthority(workspace, { storePath })).resolves.toBeNull()
  })

  it("fails closed on corruption instead of replacing the authority store", async () => {
    const { workspace, storePath } = await makeFixture()
    await mkdir(path.dirname(storePath), { recursive: true })
    await writeFile(storePath, '{"version":1,"workspaces":', { mode: 0o600 })
    if (process.platform !== "win32") await chmod(storePath, 0o600)
    const original = await readFile(storePath, "utf8")

    await expect(
      grantWorkspaceAuthority(
        workspace,
        { kind: "command", value: "pnpm test" },
        { storePath },
      ),
    ).rejects.toMatchObject({
      name: "WorkspaceAuthorityStoreError",
      code: "corrupt_store",
    } satisfies Partial<WorkspaceAuthorityStoreError>)
    expect(await readFile(storePath, "utf8")).toBe(original)
  })

  it("rejects symbolic-link and overly broad-permission stores", async () => {
    const first = await makeFixture()
    const target = path.join(first.root, "attacker.json")
    await writeFile(target, JSON.stringify({ version: 1, workspaces: {} }), {
      mode: 0o600,
    })
    await mkdir(path.dirname(first.storePath), { recursive: true })
    await symlink(target, first.storePath)

    await expect(
      loadWorkspaceAuthority(first.workspace, { storePath: first.storePath }),
    ).rejects.toMatchObject({
      name: "WorkspaceAuthorityStoreError",
      code: "unsafe_store",
    })

    if (process.platform !== "win32") {
      const second = await makeFixture()
      await mkdir(path.dirname(second.storePath), { recursive: true })
      await writeFile(
        second.storePath,
        JSON.stringify({ version: 1, workspaces: {} }),
        { mode: 0o644 },
      )
      await chmod(second.storePath, 0o644)
      await expect(
        loadWorkspaceAuthority(second.workspace, { storePath: second.storePath }),
      ).rejects.toMatchObject({
        name: "WorkspaceAuthorityStoreError",
        code: "unsafe_store",
      })
    }
  })

  it("hydrates grants without replacing the loaded config object", async () => {
    const { workspace, storePath } = await makeFixture()
    await grantWorkspaceAuthority(
      workspace,
      { kind: "command", value: "pnpm test" },
      { storePath },
    )
    const authority = await loadWorkspaceAuthority(workspace, { storePath })
    const config = {
      permissions: {
        allowedCommands: ["git status"],
        allowCommandPatterns: [],
        allowedMcpTools: [],
      },
    }

    expect(applyWorkspaceAuthorityGrants(config, authority)).toBe(config)
    expect(config.permissions.allowedCommands).toEqual([
      "git status",
      "pnpm test",
    ])
  })

  it("migrates a v1 grant store and persists bounded project config approvals as v2", async () => {
    const { workspace, storePath } = await makeFixture()
    const identity = await import("./workspace-authority.js").then(
      ({ getWorkspaceAuthorityIdentity }) =>
        getWorkspaceAuthorityIdentity(workspace),
    )
    const legacyDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify([
        "nexus-workspace-authority",
        1,
        identity.canonicalPath,
        identity.device,
        identity.inode,
      ]))
      .digest("hex")
    const legacyIdentity = { ...identity, digest: legacyDigest }
    await mkdir(path.dirname(storePath), { recursive: true })
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        workspaces: {
          [legacyDigest]: {
            version: 1,
            identity: legacyIdentity,
            grants: {
              commands: ["pnpm test"],
              commandPatterns: [],
              mcpTools: [],
            },
            updatedAt: new Date(0).toISOString(),
          },
        },
      }),
      { mode: 0o600 },
    )
    if (process.platform !== "win32") await chmod(storePath, 0o600)
    const request = createPendingProjectAuthorityRequest(
      "model-endpoint",
      { model: { provider: "openai-compatible", baseUrl: "https://api.test/v1" } },
    )

    const record = await approveWorkspaceProjectAuthority(
      workspace,
      request,
      { storePath },
    )

    expect(record.grants.commands).toEqual(["pnpm test"])
    expect(record.projectConfigApprovals).toEqual([
      {
        kind: "model-endpoint",
        fingerprint: request.fingerprint,
      },
    ])
    expect(JSON.parse(await readFile(storePath, "utf8"))).toMatchObject({
      version: 2,
      workspaces: {
        [identity.digest]: {
          version: 2,
          projectConfigApprovals: [
            {
              kind: "model-endpoint",
              fingerprint: request.fingerprint,
            },
          ],
        },
      },
    })
  })

  it("rejects a forged content fingerprint instead of granting it", async () => {
    const { workspace, storePath } = await makeFixture()
    const request = {
      ...createPendingProjectAuthorityRequest(
        "remote-skills",
        { skillsUrls: ["https://skills.test"] },
      ),
      fingerprint: "0".repeat(64),
    }

    await expect(
      approveWorkspaceProjectAuthority(workspace, request, { storePath }),
    ).rejects.toMatchObject({
      name: "WorkspaceAuthorityStoreError",
      code: "invalid_grant",
    })
    await expect(loadWorkspaceAuthority(workspace, { storePath })).resolves.toBeNull()
  })

  it("replaces an older approval of the same config surface", async () => {
    const { workspace, storePath } = await makeFixture()
    const first = createPendingProjectAuthorityRequest(
      "model-endpoint",
      { model: { provider: "openai", baseUrl: "https://first.test/v1" } },
    )
    const changed = createPendingProjectAuthorityRequest(
      "model-endpoint",
      { model: { provider: "openai", baseUrl: "https://changed.test/v1" } },
    )
    await approveWorkspaceProjectAuthority(workspace, first, { storePath })

    const record = await approveWorkspaceProjectAuthority(
      workspace,
      changed,
      { storePath },
    )

    expect(record.projectConfigApprovals).toEqual([
      {
        kind: "model-endpoint",
        fingerprint: changed.fingerprint,
      },
    ])
  })
})
