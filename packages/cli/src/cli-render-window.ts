export const CLI_RENDER_WINDOW_CAP = 200
export const CLI_RENDER_WINDOW_STEP = 50

export type CliRenderWindowAnchor = {
  key: string
  index: number
} | null

export type CliRenderItemState = {
  type: "static" | "transient"
}

/**
 * Ink can print completed rows to terminal scrollback with <Static>, keeping
 * the live Yoga tree shorter than the terminal. Only a contiguous prefix may
 * be frozen: extracting later completed rows around an active tool would
 * reorder its result above the still-live tool call.
 */
export function partitionCliRenderItems<T extends CliRenderItemState>(
  items: readonly T[],
): { staticPrefix: T[]; liveSuffix: T[] } {
  const firstTransient = items.findIndex((item) => item.type === "transient")
  const prefixEnd = firstTransient === -1 ? items.length : firstTransient
  return {
    staticPrefix: items.slice(0, prefixEnd),
    liveSuffix: items.slice(prefixEnd),
  }
}

export function shouldKeepLatestAssistantMessageLive(
  isLoading: boolean,
  messageKey: string,
  latestAssistantMessageKey: string | null,
): boolean {
  return isLoading && latestAssistantMessageKey === messageKey
}

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
