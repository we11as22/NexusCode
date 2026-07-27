import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  getWorkspaceTrustIdentity,
  hasExactWorkspaceTrust,
  type ProjectConfig,
} from "./config.js"

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((entry) =>
      rm(entry, { recursive: true, force: true }),
    ),
  )
})

function trustedProject(
  identity: ReturnType<typeof getWorkspaceTrustIdentity>,
): ProjectConfig {
  return {
    allowedTools: [],
    context: {},
    history: [],
    mcpContextUris: [],
    hasTrustDialogAccepted: true,
    trustIdentity: identity,
  }
}

describe("exact workspace trust identity", () => {
  it("does not inherit trust from a lexical or canonical ancestor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-trust-"))
    cleanup.push(root)
    const child = path.join(root, "child")
    await mkdir(child)
    const parentIdentity = getWorkspaceTrustIdentity(root)
    const childIdentity = getWorkspaceTrustIdentity(child)

    expect(
      hasExactWorkspaceTrust(
        {
          [parentIdentity.canonicalPath]: trustedProject(parentIdentity),
        },
        childIdentity,
      ),
    ).toBe(false)
  })

  it("canonicalizes symlinks and invalidates trust when a directory is replaced", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-trust-identity-"))
    cleanup.push(root)
    const workspace = path.join(root, "workspace")
    const link = path.join(root, "workspace-link")
    await mkdir(workspace)
    await symlink(workspace, link)

    const original = getWorkspaceTrustIdentity(link)
    expect(original.canonicalPath).toBe(await realpath(workspace))
    expect(
      hasExactWorkspaceTrust(
        { [original.canonicalPath]: trustedProject(original) },
        getWorkspaceTrustIdentity(workspace),
      ),
    ).toBe(true)

    await rm(workspace, { recursive: true })
    await mkdir(workspace)
    const replacement = getWorkspaceTrustIdentity(workspace)
    expect(
      hasExactWorkspaceTrust(
        { [original.canonicalPath]: trustedProject(original) },
        replacement,
      ),
    ).toBe(false)
  })
})
