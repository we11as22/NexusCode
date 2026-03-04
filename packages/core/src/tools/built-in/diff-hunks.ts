import * as diff from "diff"

const MAX_DIFF_LINES = 200

export type DiffLine = { type: "add" | "remove" | "context"; lineNum: number; line: string }

/**
 * Build a line-by-line diff for UI display (red/green highlighting).
 * Caps at MAX_DIFF_LINES to avoid huge payloads.
 */
export function buildDiffHunks(oldContent: string, newContent: string): DiffLine[] {
  const changes = diff.diffLines(oldContent, newContent)
  const out: DiffLine[] = []
  let oldLineNum = 1
  let newLineNum = 1
  let total = 0

  for (const chunk of changes) {
    const lines = chunk.value.split(/\r?\n/)
    if (lines[lines.length - 1] === "") lines.pop()

    for (const line of lines) {
      if (total >= MAX_DIFF_LINES) return out
      if (chunk.added) {
        out.push({ type: "add", lineNum: newLineNum, line })
        newLineNum++
      } else if (chunk.removed) {
        out.push({ type: "remove", lineNum: oldLineNum, line })
        oldLineNum++
      } else {
        out.push({ type: "context", lineNum: oldLineNum, line })
        oldLineNum++
        newLineNum++
      }
      total++
    }
  }
  return out
}
