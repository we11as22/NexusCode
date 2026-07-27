import * as fs from "node:fs"
import * as path from "node:path"
import { resolveAuthorizedWorkspacePath } from "@nexuscode/core"

export class WebviewPathCapabilityError extends Error {
  override readonly name = "WebviewPathCapabilityError"
}

function requestKey(requestedPath: string): string {
  return path.normalize(path.resolve(requestedPath))
}

/**
 * Filesystem capabilities exposed to the webview.
 *
 * Workspace actions are confined through the shared canonical authorizer.
 * External/global skill files are allowed only after the host advertised the
 * exact path, and are re-resolved on use to detect symlink retargeting.
 */
export class WebviewPathCapabilities {
  private knownSkillPaths = new Map<string, string>()

  resolveWorkspacePath(workspace: string, requestedPath: string): string {
    try {
      return resolveAuthorizedWorkspacePath(workspace, requestedPath)
    } catch (error) {
      throw new WebviewPathCapabilityError(
        error instanceof Error
          ? error.message
          : "Path is outside the active workspace",
      )
    }
  }

  replaceKnownSkillPaths(paths: readonly string[]): void {
    const next = new Map<string, string>()
    for (const requestedPath of paths) {
      if (
        typeof requestedPath !== "string" ||
        !requestedPath.trim() ||
        requestedPath.includes("\0")
      ) {
        continue
      }
      try {
        const canonical = fs.realpathSync.native(path.resolve(requestedPath))
        const stat = fs.statSync(canonical)
        if (!stat.isFile()) continue
        next.set(requestKey(requestedPath), canonical)
      } catch {
        // A missing or unresolvable definition is not a usable capability.
      }
    }
    this.knownSkillPaths = next
  }

  resolveKnownSkillPath(requestedPath: string): string {
    const key = requestKey(requestedPath)
    const grantedCanonicalPath = this.knownSkillPaths.get(key)
    if (!grantedCanonicalPath) {
      throw new WebviewPathCapabilityError(
        "Skill path was not advertised by the extension host",
      )
    }

    let currentCanonicalPath: string
    try {
      currentCanonicalPath = fs.realpathSync.native(path.resolve(requestedPath))
    } catch {
      throw new WebviewPathCapabilityError(
        "Skill path is no longer available",
      )
    }
    if (currentCanonicalPath !== grantedCanonicalPath) {
      throw new WebviewPathCapabilityError(
        "Skill path changed after its capability was granted",
      )
    }
    return currentCanonicalPath
  }
}
