/** Plan markdown/text lives under this tree; edits here should not require user write approval. */
export function isNexusPlansPath(filePath: string): boolean {
  return filePath.replace(/\\/g, "/").includes(".nexus/plans")
}
