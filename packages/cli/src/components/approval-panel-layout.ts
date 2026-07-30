import stringWidth from "string-width"

const MAX_APPROVAL_DIFF_LINES = 18
const MIN_APPROVAL_DIFF_LINES = 2
const APPROVAL_NON_DIFF_ROWS = 11

/**
 * Reserve room for the prompt, choices, footer and separators so Ink's live
 * approval surface stays below the viewport and does not clear the terminal.
 */
export function computeApprovalDiffLineLimit(
  terminalRows: number,
  optionCount: number,
): number {
  return Math.max(
    MIN_APPROVAL_DIFF_LINES,
    Math.min(
      MAX_APPROVAL_DIFF_LINES,
      terminalRows - optionCount - APPROVAL_NON_DIFF_ROWS,
    ),
  )
}

/** Keep a diff row on one terminal line, including wide Unicode glyphs. */
export function truncateToDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth === 1) return "…"

  let result = ""
  for (const char of text) {
    if (stringWidth(result + char) > maxWidth - 1) break
    result += char
  }
  return `${result}…`
}
