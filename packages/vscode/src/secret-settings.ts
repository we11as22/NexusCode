import {
  UnsupportedSecretsVersionError,
  type NexusSecretsPayload,
} from "@nexuscode/core"

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
  legacy: { model?: string; embeddings?: string },
): string {
  let payload: NexusSecretsPayload = {
    version: 2,
    credentials: {},
  }
  if (existingRaw?.trim()) {
    try {
      const parsed = JSON.parse(existingRaw) as Record<string, unknown>
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (
          parsed["version"] !== undefined &&
          parsed["version"] !== 1 &&
          parsed["version"] !== 2
        ) {
          throw new UnsupportedSecretsVersionError(parsed["version"])
        }
        if (parsed["version"] === 2) {
          payload = {
            ...(parsed as unknown as NexusSecretsPayload),
            version: 2,
            credentials:
              parsed["credentials"] &&
              typeof parsed["credentials"] === "object" &&
              !Array.isArray(parsed["credentials"])
                ? parsed["credentials"] as NexusSecretsPayload["credentials"]
                : {},
          }
        } else {
          const profiles: Record<string, string> = {}
          const rawProfiles = parsed["profiles"]
          if (rawProfiles && typeof rawProfiles === "object" && !Array.isArray(rawProfiles)) {
            for (const [name, value] of Object.entries(rawProfiles)) {
              if (typeof value === "string" && value.trim()) profiles[name] = value.trim()
            }
          }
          payload = {
            version: 2,
            credentials: {},
            legacyUnbound: {
              ...(typeof parsed["model"] === "string" && parsed["model"].trim()
                ? { model: parsed["model"].trim() }
                : {}),
              ...(typeof parsed["embeddings"] === "string" && parsed["embeddings"].trim()
                ? { embeddings: parsed["embeddings"].trim() }
                : {}),
              ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
            },
            ...(typeof parsed["qdrantApiKey"] === "string" && parsed["qdrantApiKey"].trim()
              ? { qdrantApiKey: parsed["qdrantApiKey"].trim() }
              : {}),
          }
        }
      }
    } catch (error) {
      if (error instanceof UnsupportedSecretsVersionError) throw error
      // A malformed old payload must not prevent recovery from legacy settings.
    }
  }
  const legacyUnbound = { ...(payload.legacyUnbound ?? {}) }
  if (!legacyUnbound.model && legacy.model?.trim()) {
    legacyUnbound.model = legacy.model.trim()
  }
  if (!legacyUnbound.embeddings && legacy.embeddings?.trim()) {
    legacyUnbound.embeddings = legacy.embeddings.trim()
  }
  payload.legacyUnbound = legacyUnbound
  if (Object.keys(legacyUnbound).length === 0) delete payload.legacyUnbound
  return JSON.stringify(payload)
}
