export function artifactCapabilityFromToolMetadata(
  metadata: unknown,
): { artifactId: string; ownerSessionId: string } | undefined {
  const value = metadata as {
    outputArtifactId?: unknown
    outputArtifactOwnerSessionId?: unknown
  } | undefined
  return (
    typeof value?.outputArtifactId === "string" &&
    value.outputArtifactId.length > 0 &&
    typeof value.outputArtifactOwnerSessionId === "string" &&
    value.outputArtifactOwnerSessionId.length > 0
  )
    ? {
        artifactId: value.outputArtifactId,
        ownerSessionId: value.outputArtifactOwnerSessionId,
      }
    : undefined
}
