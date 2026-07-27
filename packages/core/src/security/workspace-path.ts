import * as fs from "node:fs"
import * as path from "node:path"

export type WorkspacePathAuthorizationErrorCode =
  | "invalid_workspace_root"
  | "invalid_requested_path"
  | "path_outside_workspace"
  | "unresolvable_path"

/**
 * Raised when a host filesystem capability cannot be safely confined to its
 * workspace. Keeping this distinct from ordinary ENOENT/permission errors lets
 * adapters fail closed without treating a policy denial as a missing file.
 */
export class WorkspacePathAuthorizationError extends Error {
  override readonly name = "WorkspacePathAuthorizationError"

  constructor(
    readonly code: WorkspacePathAuthorizationErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  )
}

function canonicalizeExistingWorkspaceRoot(workspaceRoot: string): string {
  if (!workspaceRoot.trim() || workspaceRoot.includes("\0")) {
    throw new WorkspacePathAuthorizationError(
      "invalid_workspace_root",
      "Workspace root must be a non-empty path without NUL characters",
    )
  }

  let canonicalRoot: string
  try {
    canonicalRoot = fs.realpathSync.native(path.resolve(workspaceRoot))
  } catch {
    throw new WorkspacePathAuthorizationError(
      "invalid_workspace_root",
      `Workspace root cannot be resolved: ${workspaceRoot}`,
    )
  }

  try {
    if (!fs.statSync(canonicalRoot).isDirectory()) {
      throw new WorkspacePathAuthorizationError(
        "invalid_workspace_root",
        `Workspace root is not a directory: ${workspaceRoot}`,
      )
    }
  } catch (error) {
    if (error instanceof WorkspacePathAuthorizationError) throw error
    throw new WorkspacePathAuthorizationError(
      "invalid_workspace_root",
      `Workspace root cannot be inspected: ${workspaceRoot}`,
    )
  }

  return canonicalRoot
}

/**
 * Resolve an existing path, or a future path beneath its nearest existing
 * ancestor, through realpath. This removes already-existing symlink segments
 * before the containment check and also handles write targets that do not yet
 * exist.
 */
function canonicalizePotentialPath(absolutePath: string): string {
  let cursor = absolutePath
  const missingSegments: string[] = []

  for (;;) {
    try {
      fs.lstatSync(cursor)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new WorkspacePathAuthorizationError(
          "unresolvable_path",
          `Requested path cannot be safely inspected: ${absolutePath}`,
        )
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) {
        throw new WorkspacePathAuthorizationError(
          "unresolvable_path",
          `Requested path cannot be resolved: ${absolutePath}`,
        )
      }
      missingSegments.unshift(path.basename(cursor))
      cursor = parent
    }
  }

  let canonicalAncestor: string
  try {
    canonicalAncestor = fs.realpathSync.native(cursor)
  } catch {
    // A broken symlink is not a safe ancestor for a future operation.
    throw new WorkspacePathAuthorizationError(
      "unresolvable_path",
      `Requested path contains an unresolvable symlink: ${absolutePath}`,
    )
  }
  return path.resolve(canonicalAncestor, ...missingSegments)
}

/**
 * Resolve a host path and prove that its canonical target is the workspace
 * root or one of its descendants.
 *
 * The returned path is canonicalized rather than merely validated, so callers
 * do not subsequently operate through a known symlink alias.
 */
export function resolveAuthorizedWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
): string {
  if (!requestedPath.trim()) {
    throw new WorkspacePathAuthorizationError(
      "invalid_requested_path",
      "Requested path must not be empty",
    )
  }
  if (requestedPath.includes("\0")) {
    throw new WorkspacePathAuthorizationError(
      "invalid_requested_path",
      "Requested path cannot contain NUL characters",
    )
  }

  const canonicalRoot = canonicalizeExistingWorkspaceRoot(workspaceRoot)
  const absolutePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspaceRoot, requestedPath)
  const canonicalCandidate = canonicalizePotentialPath(absolutePath)

  if (!isWithinRoot(canonicalCandidate, canonicalRoot)) {
    throw new WorkspacePathAuthorizationError(
      "path_outside_workspace",
      `Requested path is outside the authorized workspace: ${requestedPath}`,
    )
  }

  return canonicalCandidate
}
