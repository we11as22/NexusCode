import * as diff from "diff"

const MAX_DIFF_LINES = 200

export type DiffLine = { type: "add" | "remove" | "context"; lineNum: number; line: string }

/**
 * Build a line-by-line diff for UI display (red/green highlighting).
 * Omits unchanged (context) lines so the CLI/webview show only deltas, not the whole file.
 * Caps changed lines at MAX_DIFF_LINES — does not affect `addedLines`/`removedLines` in tool metadata
 * (those come from full `diff.diffLines` in the tool execute()).
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
      if (chunk.added) {
        if (total >= MAX_DIFF_LINES) return out
        out.push({ type: "add", lineNum: newLineNum, line })
        newLineNum++
        total++
      } else if (chunk.removed) {
        if (total >= MAX_DIFF_LINES) return out
        out.push({ type: "remove", lineNum: oldLineNum, line })
        oldLineNum++
        total++
      } else {
        oldLineNum++
        newLineNum++
      }
    }
  }
  return out
}
