import { mkdtemp, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { getIndexDir, getProjectHash } from "./multi-project.js"

describe("project index identity", () => {
  it("uses one tracker and Qdrant identity for symlinked workspace paths", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "nexus-project-id-"))
    const root = await mkdtemp(path.join(parent, "root-"))
    const alias = path.join(parent, "workspace-alias")
    await symlink(root, alias)

    expect(getProjectHash(alias)).toBe(getProjectHash(root))
    expect(getIndexDir(alias)).toBe(getIndexDir(root))
  })
})
