export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  content: string
}

export interface DiffFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed"
  hunks: DiffHunk[]
  oldPath?: string
}

export interface DiffResult {
  files: DiffFile[]
  raw: string
}

export type ReviewTarget =
  | { kind: "uncommitted" }
  | { kind: "branch"; base?: string }
  | { kind: "commit"; ref: string }

export interface ReviewRequest {
  target: ReviewTarget
  guidance?: string
}
