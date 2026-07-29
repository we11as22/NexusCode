export type ScrollMetrics = {
  readonly scrollHeight: number
  readonly clientHeight: number
  readonly scrollTop: number
}

export const CHAT_BOTTOM_THRESHOLD_PX = 80

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(
    0,
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop,
  )
}

export function shouldFollowNewContent(
  metrics: ScrollMetrics,
  threshold = CHAT_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom(metrics) <= Math.max(0, threshold)
}
