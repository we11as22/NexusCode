export interface GitCommandLimits {
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
}

export interface GitCommandResult {
  readonly argv: readonly string[]
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly timedOut: boolean
  readonly truncated: boolean
}

export type GitCommandFailureKind =
  | "timeout"
  | "output_limit"
  | "spawn"

export interface GitCommandRunnerPort {
  run(
    args: readonly string[],
    limits?: Partial<GitCommandLimits>,
  ): Promise<GitCommandResult>
}

export type GitIndexStatus =
  | "."
  | " "
  | "M"
  | "T"
  | "A"
  | "D"
  | "R"
  | "C"
  | "U"
  | "?"
  | "!"

export interface GitSubmoduleStatus {
  readonly isSubmodule: boolean
  readonly commitChanged: boolean
  readonly modified: boolean
  readonly untracked: boolean
}

export interface GitOrdinaryStatusEntry {
  readonly kind: "ordinary"
  readonly path: string
  readonly indexStatus: GitIndexStatus
  readonly worktreeStatus: GitIndexStatus
  readonly submodule: GitSubmoduleStatus
  readonly headMode: string
  readonly indexMode: string
  readonly worktreeMode: string
  readonly headOid: string
  readonly indexOid: string
}

export interface GitRenameStatusEntry {
  readonly kind: "rename"
  readonly path: string
  readonly originalPath: string
  readonly indexStatus: GitIndexStatus
  readonly worktreeStatus: GitIndexStatus
  readonly submodule: GitSubmoduleStatus
  readonly headMode: string
  readonly indexMode: string
  readonly worktreeMode: string
  readonly headOid: string
  readonly indexOid: string
  readonly score: {
    readonly kind: "rename" | "copy"
    readonly percent: number
  }
}

export interface GitUnmergedStatusEntry {
  readonly kind: "unmerged"
  readonly path: string
  readonly indexStatus: GitIndexStatus
  readonly worktreeStatus: GitIndexStatus
  readonly submodule: GitSubmoduleStatus
  readonly stage1Mode: string
  readonly stage2Mode: string
  readonly stage3Mode: string
  readonly worktreeMode: string
  readonly stage1Oid: string
  readonly stage2Oid: string
  readonly stage3Oid: string
}

export interface GitUntrackedStatusEntry {
  readonly kind: "untracked"
  readonly path: string
  readonly indexStatus: "?"
  readonly worktreeStatus: "?"
}

export interface GitIgnoredStatusEntry {
  readonly kind: "ignored"
  readonly path: string
  readonly indexStatus: "!"
  readonly worktreeStatus: "!"
}

export type GitStatusEntry =
  | GitOrdinaryStatusEntry
  | GitRenameStatusEntry
  | GitUnmergedStatusEntry
  | GitUntrackedStatusEntry
  | GitIgnoredStatusEntry

export type GitOperation =
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert"
  | "bisect"

export interface GitOmission {
  readonly reason:
    | "file_limit"
    | "byte_limit"
    | "binary"
    | "oversize"
    | "unsupported"
    | "unreadable"
  readonly path?: string
  readonly detail: string
}

export interface ParsedGitStatus {
  readonly oid?: string
  readonly branch?: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  readonly unborn: boolean
  readonly detached: boolean
  readonly entries: readonly GitStatusEntry[]
}

export interface GitStatusSnapshot extends ParsedGitStatus {
  readonly available: boolean
  readonly root?: string
  readonly operation?: GitOperation
  readonly omissions: readonly GitOmission[]
}

export type GitDiffScope =
  | "working"
  | "staged"
  | "combined"
  | "range"

export interface GitDiffRequest {
  readonly scope: GitDiffScope
  readonly from?: string
  readonly to?: string
  /**
   * Compare the merge-base of `from` and `to` with `to` (Git's `A...B`
   * semantics). This is the correct scope for reviewing a topic branch
   * without reporting unrelated commits added to its base after divergence.
   */
  readonly mergeBase?: boolean
  readonly paths?: readonly string[]
  readonly detail?: "summary" | "patch"
}

export interface GitFileDiff {
  readonly path: string
  readonly oldPath?: string
  readonly status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "unmerged"
  readonly staged: boolean
  readonly unstaged: boolean
  readonly binary: boolean
  readonly additions?: number
  readonly deletions?: number
  readonly patch?: string
  readonly omission?: GitOmission
}

export interface GitDiffResult {
  readonly available: boolean
  readonly root?: string
  readonly files: readonly GitFileDiff[]
  readonly additions: number
  readonly deletions: number
  readonly omissions: readonly GitOmission[]
}

export interface GitDiffLimits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxPatchBytesPerFile: number
  readonly maxTotalPatchBytes: number
}

export interface GitTextInspectRequest {
  readonly operation: "show" | "log" | "blame"
  readonly revision?: string
  readonly path?: string
  readonly limit?: number
}

export interface GitTextInspectResult {
  readonly argv: readonly string[]
  readonly output: string
  readonly exitCode: number
  readonly truncated: boolean
}
