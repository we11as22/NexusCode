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
      model: "secure-model",
      embeddings: "legacy-embeddings",
      qdrantApiKey: "secure-qdrant",
      profiles: { review: "secure-profile" },
    })
  })

  it("recovers from a malformed old secure payload", () => {
    expect(JSON.parse(mergeLegacyNexusSecrets("{broken", {
      model: "legacy-model",
    }))).toEqual({ model: "legacy-model" })
  })

  it("uses a dedicated Secret Storage key for autocomplete", () => {
    expect(AUTOCOMPLETE_API_KEY_SECRET).toBe("nexuscode_autocomplete_api_key")
  })
})
