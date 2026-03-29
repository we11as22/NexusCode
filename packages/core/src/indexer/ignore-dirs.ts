/**
 * Skip descending into heavy directories (aligned with Roo-Code list-files / scanner).
 * Complements .gitignore / .nexusignore — catches dirs even if ignore files omit them.
 */
const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  "__pycache__",
  "env",
  "venv",
  ".venv",
  "target",
  "dist",
  "out",
  "bundle",
  "vendor",
  "tmp",
  "temp",
  "deps",
  "pkg",
  "Pods",
  ".git",
  ".svn",
  ".hg",
])

/** True if this single path segment should not be traversed. */
export function shouldSkipDirectorySegment(segment: string): boolean {
  if (!segment || segment === "." || segment === "..") return false
  return IGNORED_DIR_NAMES.has(segment)
}
