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
