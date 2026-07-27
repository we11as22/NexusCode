import { describe, expect, it } from "vitest"
import {
  AUTOCOMPLETE_API_KEY_SECRET,
  mergeLegacyNexusSecrets,
  selectLegacySetting,
} from "./secret-settings.js"

describe("VS Code secret settings", () => {
  it("uses the most specific non-empty legacy setting", () => {
    expect(selectLegacySetting({
      globalValue: " global ",
      workspaceValue: "workspace",
      workspaceFolderValue: " folder ",
    })).toBe("folder")
    expect(selectLegacySetting({ globalValue: "   " })).toBeUndefined()
  })

  it("migrates legacy model and embeddings keys without replacing secure values", () => {
    const migrated = mergeLegacyNexusSecrets(
      JSON.stringify({
        model: "secure-model",
        qdrantApiKey: "secure-qdrant",
        profiles: { review: "secure-profile" },
      }),
      {
        model: "legacy-model",
        embeddings: "legacy-embeddings",
      },
    )

    expect(JSON.parse(migrated)).toEqual({
      version: 2,
      credentials: {},
      legacyUnbound: {
        model: "secure-model",
        embeddings: "legacy-embeddings",
        profiles: { review: "secure-profile" },
      },
      qdrantApiKey: "secure-qdrant",
    })
  })

  it("recovers from a malformed old secure payload", () => {
    expect(JSON.parse(mergeLegacyNexusSecrets("{broken", {
      model: "legacy-model",
    }))).toEqual({
      version: 2,
      credentials: {},
      legacyUnbound: { model: "legacy-model" },
    })
  })

  it("preserves bound v2 credentials while quarantining newly discovered legacy keys", () => {
    const bound = {
      purpose: "chat",
      provider: "openai",
      destination: "https://api.openai.com/v1",
      secret: "bound",
    }
    const key = JSON.stringify(["chat", "openai", "https://api.openai.com/v1"])

    expect(JSON.parse(mergeLegacyNexusSecrets(JSON.stringify({
      version: 2,
      credentials: { [key]: bound },
      legacyUnbound: { model: "already-quarantined" },
    }), {
      model: "ignored-later-legacy",
      embeddings: "legacy-embeddings",
    }))).toEqual({
      version: 2,
      credentials: { [key]: bound },
      legacyUnbound: {
        model: "already-quarantined",
        embeddings: "legacy-embeddings",
      },
    })
  })

  it("uses a dedicated Secret Storage key for autocomplete", () => {
    expect(AUTOCOMPLETE_API_KEY_SECRET).toBe("nexuscode_autocomplete_api_key")
  })

  it("fails closed without rewriting an unknown secure payload version", () => {
    const raw = JSON.stringify({
      version: 99,
      credentials: { future: "opaque" },
    })
    expect(() => mergeLegacyNexusSecrets(raw, {
      model: "legacy-model",
    })).toThrow(/Unsupported secrets payload version/)
  })
})
