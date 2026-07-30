export const CLI_RENDER_WINDOW_CAP = 200
export const CLI_RENDER_WINDOW_STEP = 50

export type CliRenderWindowAnchor = {
  key: string
  index: number
} | null

/**
 * Keeps Stock Ink from mounting and repainting an unbounded transcript.
 *
 * The anchor advances only after cap + step rows are mounted, rather than on
 * every append. This mirrors OpenClaude's non-virtualized transcript policy:
 * the durable session remains complete while the live React tree stays
 * bounded and stable. The stored index is a fallback for timeline groups
 * whose derived key changes while tool results arrive.
 */
export function computeCliRenderWindowStart(
  keys: readonly string[],
  anchorRef: { current: CliRenderWindowAnchor },
  cap = CLI_RENDER_WINDOW_CAP,
  step = CLI_RENDER_WINDOW_STEP,
): number {
  const anchor = anchorRef.current
  const keyedIndex = anchor ? keys.indexOf(anchor.key) : -1
  let start =
    keyedIndex >= 0
      ? keyedIndex
      : anchor
        ? Math.min(anchor.index, Math.max(0, keys.length - cap))
        : 0

  if (keys.length - start > cap + step) {
    start = Math.max(0, keys.length - cap)
  }

  const firstKey = keys[start]
  if (firstKey !== undefined) {
    if (anchor?.key !== firstKey || anchor.index !== start) {
      anchorRef.current = { key: firstKey, index: start }
    }
  } else if (anchor) {
    anchorRef.current = null
  }

  return start
}
