import { describe, expect, it } from "vitest"
import type { NexusConfig } from "../types.js"
import {
  applySecretsToConfig,
  finalizeConfigCredentials,
  getSecretsPayloadFromConfig,
  ProfileCredentialCollisionError,
  persistSecretsFromConfig,
  SecretsCorruptionError,
  stripSecretsFromConfig,
  type NexusSecretsStore,
} from "./secrets.js"

function memoryStore(initial?: unknown): NexusSecretsStore & { value: string | undefined } {
  return {
    value: initial === undefined ? undefined : JSON.stringify(initial),
    async getSecret() {
      return this.value
    },
    async setSecret(_key, value) {
      this.value = value || undefined
    },
  }
}

function config(overrides: Partial<NexusConfig> = {}): Record<string, unknown> {
  return {
    model: {
      provider: "openai",
      id: "gpt-test",
      baseUrl: "https://api.openai.com/v1",
    },
    profiles: {},
    ...overrides,
  }
}

describe("bound secrets v2", () => {
  it("keeps raw profiles secretless and resolves only the final selected profile", async () => {
    const store = memoryStore()
    await persistSecretsFromConfig(config({
      profiles: {
        work: {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "profile-secret",
        },
      },
    }), store)

    const raw = config({
      model: {
        provider: "anthropic",
        id: "claude",
        baseUrl: "https://api.anthropic.com/v1",
      },
      profiles: {
        work: {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://api.anthropic.com/v1",
        },
      },
    })
    const runtime = await finalizeConfigCredentials(raw, store, {
      profileName: "work",
    })

    expect((raw.model as { apiKey?: string }).apiKey).toBeUndefined()
    expect((raw.profiles as Record<string, { apiKey?: string }>).work?.apiKey).toBeUndefined()
    expect((runtime.model as { apiKey?: string }).apiKey).toBe("profile-secret")
    expect((runtime.profiles as Record<string, { apiKey?: string }>).work?.apiKey).toBeUndefined()
  })

  it("resolves a stored credential after the final destination override", async () => {
    const store = memoryStore()
    await persistSecretsFromConfig(config({
      model: {
        provider: "openai-compatible",
        id: "first",
        baseUrl: "https://tenant-a.test/v1",
        apiKey: "tenant-a",
      },
    }), store)
    await persistSecretsFromConfig(config({
      model: {
        provider: "openai-compatible",
        id: "second",
        baseUrl: "https://tenant-b.test/v1",
        apiKey: "tenant-b",
      },
    }), store)

    const runtime = await finalizeConfigCredentials(config({
      model: {
        provider: "openai-compatible",
        id: "selected-after-host-overrides",
        baseUrl: "https://tenant-b.test/v1",
      },
    }), store)

    expect((runtime.model as { apiKey?: string }).apiKey).toBe("tenant-b")
  })

  it("applies a stored credential only to an exact purpose/provider/destination match", async () => {
    const source = config({
      model: {
        provider: "openai",
        id: "gpt-test",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-secret",
      },
      embeddings: {
        provider: "openai-compatible",
        model: "embed",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "embedding-secret",
      },
    })
    const store = memoryStore()
    await persistSecretsFromConfig(source, store)

    const matching = config({
      embeddings: {
        provider: "openai-compatible",
        model: "embed",
        baseUrl: "https://api.openai.com/v1",
      },
    })
    await applySecretsToConfig(matching, store)
    expect((matching.model as { apiKey?: string }).apiKey).toBe("openai-secret")
    expect((matching.embeddings as { apiKey?: string }).apiKey).toBe("embedding-secret")

    const mismatched = config({
      model: {
        provider: "openai",
        id: "gpt-test",
        baseUrl: "https://proxy.test/v1",
      },
      embeddings: {
        provider: "openai-compatible",
        model: "embed",
        baseUrl: "https://proxy.test/v1",
      },
    })
    await applySecretsToConfig(mismatched, store)
    expect((mismatched.model as { apiKey?: string }).apiKey).toBeUndefined()
    expect((mismatched.embeddings as { apiKey?: string }).apiKey).toBeUndefined()
  })

  it("uses an explicit immutable scoped environment before secure-store fallback", async () => {
    const store = memoryStore()
    await persistSecretsFromConfig(config({
      model: {
        provider: "openai",
        id: "gpt",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "stored-model-secret",
      },
      embeddings: {
        provider: "openai",
        model: "embed",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "stored-embedding-secret",
      },
    }), store)

    const runtime = await finalizeConfigCredentials(config({
      model: {
        provider: "openai",
        id: "gpt",
        baseUrl: "https://api.openai.com/v1",
      },
      embeddings: {
        provider: "openai",
        model: "embed",
        baseUrl: "https://api.openai.com/v1",
      },
    }), store, {
      environment: Object.freeze({
        OPENAI_API_KEY: "scoped-environment-secret",
      }),
    })

    expect((runtime.model as { apiKey?: string }).apiKey).toBe(
      "scoped-environment-secret",
    )
    expect((runtime.embeddings as { apiKey?: string }).apiKey).toBe(
      "scoped-environment-secret",
    )
  })

  it("reads legacy unbound secrets without sending or destructively migrating them", async () => {
    const store = memoryStore({
      model: "legacy-model",
      embeddings: "legacy-embeddings",
      profiles: { work: "legacy-profile" },
      qdrantApiKey: "qdrant",
    })
    const target = config({
      profiles: {
        work: {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://api.anthropic.com/v1",
        },
      },
      vectorDb: {
        enabled: true,
        url: "https://qdrant.test",
        collection: "nexus",
        autoStart: false,
      },
    })
    const original = store.value

    await applySecretsToConfig(target, store)
    expect((target.model as { apiKey?: string }).apiKey).toBeUndefined()
    expect((target.profiles as Record<string, { apiKey?: string }>).work?.apiKey).toBeUndefined()
    expect((target.vectorDb as { apiKey?: string }).apiKey).toBe("qdrant")
    expect(store.value).toBe(original)

    await applySecretsToConfig(target, store)
    expect(store.value).toBe(original)
  })

  it("preserves unrelated bound credentials when persisting a new selection", async () => {
    const store = memoryStore()
    await persistSecretsFromConfig(config({
      model: {
        provider: "openai",
        id: "gpt",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-secret",
      },
    }), store)
    await persistSecretsFromConfig(config({
      model: {
        provider: "groq",
        id: "llama",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: "groq-secret",
      },
    }), store)

    const payload = JSON.parse(store.value ?? "{}") as {
      credentials: Record<string, { secret: string }>
    }
    expect(Object.values(payload.credentials).map((entry) => entry.secret).sort()).toEqual([
      "groq-secret",
      "openai-secret",
    ])
  })

  it("binds profile secrets to each resolved profile destination without materializing raw profiles", async () => {
    const store = memoryStore()
    await persistSecretsFromConfig(config({
      profiles: {
        work: {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "profile-secret",
        },
      },
    }), store)

    const target = config({
      profiles: {
        work: {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://proxy.test/anthropic",
        },
      },
    })
    const runtime = await finalizeConfigCredentials(target, store, {
      profileName: "work",
    })
    expect((target.profiles as Record<string, { apiKey?: string }>).work?.apiKey).toBeUndefined()
    expect((runtime.model as { apiKey?: string }).apiKey).toBeUndefined()
  })

  it("keeps distinct profile credentials at the same endpoint separate", async () => {
    const store = memoryStore()
    await persistSecretsFromConfig(config({
      profiles: {
        first: {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "first-secret",
        },
        second: {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "second-secret",
        },
      },
    }), store)

    const target = config({
      profiles: {
        first: {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://api.anthropic.com/v1",
        },
        second: {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://api.anthropic.com/v1",
        },
      },
    })
    const first = await finalizeConfigCredentials({
      ...target,
      model: {
        ...(target.profiles as Record<string, Record<string, unknown>>).first,
      },
    }, store, { profileName: "first" })
    const second = await finalizeConfigCredentials({
      ...target,
      model: {
        ...(target.profiles as Record<string, Record<string, unknown>>).second,
      },
    }, store, { profileName: "second" })

    expect((first.model as { apiKey?: string }).apiKey).toBe("first-secret")
    expect((second.model as { apiKey?: string }).apiKey).toBe("second-secret")
    expect((target.profiles as Record<string, { apiKey?: string }>).first?.apiKey).toBeUndefined()
    expect((target.profiles as Record<string, { apiKey?: string }>).second?.apiKey).toBeUndefined()
  })

  it("treats blank redacted values as unchanged and supports explicit tombstones", async () => {
    const storedModel = {
      provider: "openai" as const,
      id: "gpt",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "model-secret",
    }
    const storedEmbedding = {
      provider: "openai" as const,
      model: "embed",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "embedding-secret",
    }
    const store = memoryStore()
    await persistSecretsFromConfig(config({
      model: storedModel,
      embeddings: storedEmbedding,
      profiles: {
        work: {
          provider: "anthropic",
          id: "claude",
          apiKey: "profile-secret",
        },
      },
      vectorDb: {
        enabled: true,
        url: "https://qdrant.test",
        collection: "nexus",
        autoStart: false,
        apiKey: "qdrant-secret",
      },
    }), store)

    await persistSecretsFromConfig(config({
      model: { ...storedModel, apiKey: "   " },
      embeddings: { ...storedEmbedding, apiKey: "" },
    }), store)
    expect((await finalizeConfigCredentials(config({
      model: { ...storedModel, apiKey: undefined },
      embeddings: { ...storedEmbedding, apiKey: undefined },
    }), store)).model).toMatchObject({ apiKey: "model-secret" })

    await persistSecretsFromConfig(config({
      model: { ...storedModel, apiKey: undefined },
      embeddings: { ...storedEmbedding, apiKey: undefined },
      profiles: {},
    }), store, {
      remove: {
        model: true,
        embeddings: true,
        profileNames: ["work"],
        qdrant: true,
      },
    })

    const payload = JSON.parse(store.value ?? "{}") as {
      credentials?: Record<string, unknown>
      profileCredentials?: Record<string, unknown>
      qdrantApiKey?: string
    }
    expect(payload.credentials ?? {}).toEqual({})
    expect(payload.profileCredentials ?? {}).toEqual({})
    expect(payload.qdrantApiKey).toBeUndefined()
  })

  it("does not resurrect a deleted profile credential", async () => {
    const store = memoryStore()
    await persistSecretsFromConfig(config({
      profiles: {
        deleted: {
          provider: "anthropic",
          id: "claude",
          apiKey: "old-profile-secret",
        },
      },
    }), store)
    await persistSecretsFromConfig(config({ profiles: {} }), store, {
      remove: { profileNames: ["deleted"] },
    })

    const runtime = await finalizeConfigCredentials(config({
      model: { provider: "anthropic", id: "claude" },
    }), store, { profileName: "deleted" })
    expect((runtime.model as { apiKey?: string }).apiKey).toBeUndefined()
  })

  it("removes only the old profile identity when a named profile is rebound", async () => {
    const oldProfile = {
      provider: "openai-compatible" as const,
      id: "old",
      baseUrl: "https://tenant-a.test/v1",
    }
    const store = memoryStore()
    await persistSecretsFromConfig(config({
      profiles: {
        work: {
          ...oldProfile,
          apiKey: "tenant-a-secret",
        },
      },
    }), store)

    await persistSecretsFromConfig(config({
      profiles: {
        work: {
          provider: "openai-compatible",
          id: "new",
          baseUrl: "https://tenant-b.test/v1",
        },
      },
    }), store, {
      remove: {
        profileBindings: [{ name: "work", model: oldProfile }],
      },
    })

    const oldSelection = config({
      model: oldProfile,
    })
    const runtime = await finalizeConfigCredentials(oldSelection, store, {
      profileName: "work",
    })
    expect((runtime.model as { apiKey?: string }).apiKey).toBeUndefined()
  })

  it("fails closed on an unknown payload version and never rewrites it", async () => {
    const original = JSON.stringify({
      version: 99,
      credentials: {
        malicious: {
          purpose: "chat",
          provider: "openai",
          destination: "https://api.openai.com/v1",
          secret: "must-not-be-used",
        },
      },
    })
    const store = memoryStore()
    store.value = original

    await expect(finalizeConfigCredentials(config(), store)).rejects.toThrow(
      /Unsupported secrets payload version/,
    )
    await expect(persistSecretsFromConfig(config({
      model: {
        provider: "openai",
        id: "gpt",
        apiKey: "new",
      },
    }), store)).rejects.toThrow(/Unsupported secrets payload version/)
    expect(store.value).toBe(original)
  })

  it("fails closed on corrupt payload bytes and never rewrites them", async () => {
    const store = memoryStore()
    store.value = "{\"version\":2,\"credentials\":"
    const original = store.value

    await expect(finalizeConfigCredentials(config(), store)).rejects.toBeInstanceOf(
      SecretsCorruptionError,
    )
    await expect(persistSecretsFromConfig(config({
      model: {
        provider: "openai",
        id: "gpt",
        apiKey: "replacement",
      },
    }), store)).rejects.toBeInstanceOf(SecretsCorruptionError)
    expect(store.value).toBe(original)
  })

  it("rejects malformed v2 entries instead of silently dropping them", async () => {
    const store = memoryStore({
      version: 2,
      credentials: {
        wrong_key: {
          purpose: "chat",
          provider: "openai",
          destination: "https://api.openai.com/v1",
          secret: "must-not-be-dropped",
        },
      },
    })
    const original = store.value

    await expect(finalizeConfigCredentials(config(), store)).rejects.toMatchObject({
      name: "SecretsCorruptionError",
      reason: "credential-key-mismatch",
    })
    expect(store.value).toBe(original)
  })

  it("canonicalizes profile names and rejects canonical collisions", async () => {
    const store = memoryStore()
    await persistSecretsFromConfig(config({
      profiles: {
        " work ": {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "canonical-secret",
        },
      },
    }), store)

    const payload = JSON.parse(store.value ?? "{}") as {
      profileCredentials?: Record<string, unknown>
    }
    expect(Object.keys(payload.profileCredentials ?? {})).toEqual(["work"])
    const runtime = await finalizeConfigCredentials(config({
      model: {
        provider: "anthropic",
        id: "claude",
        baseUrl: "https://api.anthropic.com/v1",
      },
    }), store, { profileName: " work " })
    expect((runtime.model as { apiKey?: string }).apiKey).toBe(
      "canonical-secret",
    )

    expect(() => getSecretsPayloadFromConfig(config({
      profiles: {
        work: {
          provider: "anthropic",
          id: "claude",
          apiKey: "first",
        },
        " work ": {
          provider: "anthropic",
          id: "claude",
          apiKey: "second",
        },
      },
    }))).toThrow(ProfileCredentialCollisionError)
  })

  it("rejects canonical profile collisions already present in storage", async () => {
    const bound = {
      purpose: "chat",
      provider: "anthropic",
      destination: "https://api.anthropic.com/v1",
      secret: "secret",
    }
    const store = memoryStore({
      version: 2,
      credentials: {},
      profileCredentials: {
        work: bound,
        " work ": bound,
      },
    })
    const original = store.value

    await expect(finalizeConfigCredentials(config(), store)).rejects.toMatchObject({
      name: "SecretsCorruptionError",
      reason: "profile-name-collision",
    })
    expect(store.value).toBe(original)
  })

  it("serializes concurrent read-modify-write updates for one store", async () => {
    const store: NexusSecretsStore & { value?: string } = {
      value: undefined,
      async getSecret() {
        await new Promise((resolve) => setTimeout(resolve, 15))
        return this.value
      },
      async setSecret(_key, value) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        this.value = value || undefined
      },
    }

    await Promise.all([
      persistSecretsFromConfig(config({
        model: {
          provider: "openai",
          id: "gpt",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "openai-secret",
        },
      }), store),
      persistSecretsFromConfig(config({
        model: {
          provider: "groq",
          id: "llama",
          baseUrl: "https://api.groq.com/openai/v1",
          apiKey: "groq-secret",
        },
      }), store),
    ])

    const payload = JSON.parse(store.value ?? "{}") as {
      credentials: Record<string, { secret: string }>
    }
    expect(
      Object.values(payload.credentials).map((entry) => entry.secret).sort(),
    ).toEqual(["groq-secret", "openai-secret"])
  })

  it("recursively strips known provider credentials and auth headers", () => {
    const stripped = stripSecretsFromConfig(config({
      model: {
        provider: "bedrock",
        id: "model",
        apiKey: "top-level",
        extra: {
          region: "us-east-1",
          accessKeyId: "aws-id",
          secretAccessKey: "aws-secret",
          nested: {
            sessionToken: "aws-session",
            headers: {
              Authorization: "Bearer leaked",
              Cookie: "session=leaked",
              "X-Trace": "safe",
            },
          },
        },
      },
    }))

    expect(stripped.model).toEqual({
      provider: "bedrock",
      id: "model",
      extra: {
        region: "us-east-1",
        nested: { headers: { "X-Trace": "safe" } },
      },
    })
  })

  it("preserves empty top-level credential sections after sanitizing", () => {
    const stripped = stripSecretsFromConfig(config({
      profiles: {},
    }))

    expect(stripped.profiles).toEqual({})
  })

  it("builds a v2 payload without losing the credential identity", () => {
    const payload = getSecretsPayloadFromConfig(config({
      model: {
        provider: "openai",
        id: "gpt",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "secret",
      },
    }))
    expect(payload.version).toBe(2)
    expect(Object.values(payload.credentials)).toEqual([{
      purpose: "chat",
      provider: "openai",
      destination: "https://api.openai.com/v1",
      secret: "secret",
    }])
  })
})
