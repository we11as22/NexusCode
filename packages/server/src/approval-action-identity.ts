import type { ApprovalAction } from "@nexuscode/core"

/**
 * Security identity for an approval request. Replayed requests may repeat the
 * same authority, but they may not change it while reusing an approval id.
 */
export function approvalActionsMatch(
  left: ApprovalAction,
  right: ApprovalAction,
): boolean {
  return (
    left.type === right.type &&
    left.tool === right.tool &&
    left.description === right.description &&
    left.path === right.path &&
    left.content === right.content &&
    left.shortDescription === right.shortDescription &&
    left.warning === right.warning &&
    left.diff === right.diff &&
    left.diffStats?.added === right.diffStats?.added &&
    left.diffStats?.removed === right.diffStats?.removed
  )
}
