/** Metadata from {@link truncateOutput} / tool execution for disk-spilled tool results. */
export function spillPathFromToolMetadata(metadata: unknown): string | undefined {
  const m = metadata as { outputSpillAbsolutePath?: string } | undefined
  return typeof m?.outputSpillAbsolutePath === "string" && m.outputSpillAbsolutePath.length > 0
    ? m.outputSpillAbsolutePath
    : undefined
}
