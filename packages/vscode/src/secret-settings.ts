import type { NexusSecretsPayload } from "@nexuscode/core"

export const AUTOCOMPLETE_API_KEY_SECRET = "nexuscode_autocomplete_api_key"

export interface InspectedLegacySetting {
  globalValue?: string
  workspaceValue?: string
  workspaceFolderValue?: string
}

export function selectLegacySetting(
  inspected: InspectedLegacySetting | undefined,
): string | undefined {
  if (!inspected) return undefined
  for (const value of [
    inspected.workspaceFolderValue,
    inspected.workspaceValue,
    inspected.globalValue,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

export function mergeLegacyNexusSecrets(
  existingRaw: string | undefined,
  legacy: Pick<NexusSecretsPayload, "model" | "embeddings">,
): string {
  let payload: NexusSecretsPayload = {}
  if (existingRaw?.trim()) {
    try {
      const parsed = JSON.parse(existingRaw) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as NexusSecretsPayload
      }
    } catch {
      // A malformed old payload must not prevent recovery from legacy settings.
    }
  }
  if (!payload.model && legacy.model?.trim()) payload.model = legacy.model.trim()
  if (!payload.embeddings && legacy.embeddings?.trim()) {
    payload.embeddings = legacy.embeddings.trim()
  }
  return JSON.stringify(payload)
}
