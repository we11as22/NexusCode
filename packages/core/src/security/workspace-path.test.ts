import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  WorkspacePathAuthorizationError,
  resolveAuthorizedWorkspacePath,
} from "./workspace-path.js"

const tempDirectories: string[] = []

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-workspace-path-"),
  )
  tempDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe("resolveAuthorizedWorkspacePath", () => {
  it("accepts the canonical workspace root and existing or future descendants", () => {
    const parent = makeTempDirectory()
    const workspace = path.join(parent, "workspace")
    const existing = path.join(workspace, "packages", "core")
    fs.mkdirSync(existing, { recursive: true })

    const canonicalWorkspace = fs.realpathSync.native(workspace)
    expect(resolveAuthorizedWorkspacePath(workspace, workspace)).toBe(
      canonicalWorkspace,
    )
    expect(resolveAuthorizedWorkspacePath(workspace, existing)).toBe(
      fs.realpathSync.native(existing),
    )
    expect(
      resolveAuthorizedWorkspacePath(
        workspace,
        path.join(existing, "future", "file.ts"),
      ),
    ).toBe(path.join(fs.realpathSync.native(existing), "future", "file.ts"))
  })

  it("resolves relative paths against the workspace", () => {
    const workspace = makeTempDirectory()
    fs.mkdirSync(path.join(workspace, "src"))

    expect(resolveAuthorizedWorkspacePath(workspace, "src/index.ts")).toBe(
      path.join(fs.realpathSync.native(workspace), "src", "index.ts"),
    )
  })

  it("rejects traversal, absolute outsiders, and prefix-matching siblings", () => {
    const parent = makeTempDirectory()
    const workspace = path.join(parent, "project")
    const sibling = path.join(parent, "project-evil")
    fs.mkdirSync(workspace)
    fs.mkdirSync(sibling)

    for (const requested of [
      path.join(workspace, "..", "project-evil"),
      sibling,
      path.join(sibling, "file.ts"),
    ]) {
      expect(() =>
        resolveAuthorizedWorkspacePath(workspace, requested),
      ).toThrow(WorkspacePathAuthorizationError)
    }
  })

  it("rejects symlinks that resolve outside the workspace", () => {
    const parent = makeTempDirectory()
    const workspace = path.join(parent, "workspace")
    const outside = path.join(parent, "outside")
    fs.mkdirSync(workspace)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret")
    fs.symlinkSync(outside, path.join(workspace, "escape"), "dir")

    expect(() =>
      resolveAuthorizedWorkspacePath(
        workspace,
        path.join("escape", "secret.txt"),
      ),
    ).toThrow(/outside the authorized workspace/i)
    expect(() =>
      resolveAuthorizedWorkspacePath(
        workspace,
        path.join("escape", "future.txt"),
      ),
    ).toThrow(/outside the authorized workspace/i)
  })

  it("rejects empty, NUL-containing, missing-root, and non-directory roots", () => {
    const parent = makeTempDirectory()
    const fileRoot = path.join(parent, "file.txt")
    fs.writeFileSync(fileRoot, "not a directory")

    expect(() => resolveAuthorizedWorkspacePath(parent, "")).toThrow(
      /must not be empty/i,
    )
    expect(() =>
      resolveAuthorizedWorkspacePath(parent, "bad\0path"),
    ).toThrow(/NUL/i)
    expect(() =>
      resolveAuthorizedWorkspacePath(
        path.join(parent, "missing"),
        "file.ts",
      ),
    ).toThrow(/workspace root/i)
    expect(() =>
      resolveAuthorizedWorkspacePath(fileRoot, "child"),
    ).toThrow(/workspace root/i)
  })
})
