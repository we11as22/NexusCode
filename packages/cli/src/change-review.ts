export interface CliChangeReviewItem {
  readonly changeSetId: string
  readonly proposalHash: string
  readonly paths: readonly string[]
  readonly added: number
  readonly removed: number
}

export function resolveChangeReviewSelection(
  items: readonly CliChangeReviewItem[],
  selector: string,
): CliChangeReviewItem {
  const trimmed = selector.trim()
  if (!trimmed) {
    throw new Error("Specify the change number or change-set id shown by /changes.")
  }
  if (/^[1-9][0-9]*$/u.test(trimmed)) {
    const index = Number(trimmed) - 1
    const item = items[index]
    if (!item) throw new Error(`No pending change #${trimmed}.`)
    return item
  }
  const matches = items.filter((item) =>
    item.changeSetId.startsWith(trimmed),
  )
  if (matches.length === 0) {
    throw new Error(`No pending change matches "${trimmed}".`)
  }
  if (matches.length > 1) {
    throw new Error(`Change-set prefix "${trimmed}" is ambiguous.`)
  }
  return matches[0]!
}

export function formatChangeReview(
  items: readonly CliChangeReviewItem[],
  truncated = false,
): string {
  if (items.length === 0) {
    return "No applied Nexus changes are awaiting review."
  }
  const rows = items.map((item, index) => {
    const paths = item.paths.join(", ")
    return (
      `${index + 1}. ${item.changeSetId.slice(0, 12)} ` +
      `(+${item.added} -${item.removed}) ${paths}`
    )
  })
  return [
    "Applied Nexus changes awaiting review:",
    ...rows,
    truncated ? "The server response was truncated; review remaining changes after resolving these." : "",
    "Use /accept <number|id> to keep one change or /revert <number|id> to restore its exact prior bytes.",
  ].filter(Boolean).join("\n")
}
