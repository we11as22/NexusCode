/**
 * Optional host-provided behavior (VS Code: ripgrep file list + globalStorage tracker).
 * Roo-Code parity: `listFiles` + `CacheManager` in extension storage vs core walk + ~/.nexus tracker.
 */

export type ListIndexAbsolutePathsFn = (
  root: string,
  maxList: number,
  signal: AbortSignal,
) => Promise<{ paths: string[]; limitReached: boolean }>

export interface CodebaseIndexerHostOptions {
  listAbsolutePaths?: ListIndexAbsolutePathsFn
  /** When set, `file-tracker.json` is stored at this path (e.g. `globalStorageUri`). */
  fileTrackerJsonPath?: string
}
