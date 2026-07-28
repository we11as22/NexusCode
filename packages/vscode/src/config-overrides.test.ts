import { describe, expect, it } from "vitest"
import {
  NexusConfigSchema,
  finalizeConfigCredentials,
  persistSecretsFromConfig,
  selectProviderProfile,
  stripSecretsFromConfig,
  type NexusConfig,
  type NexusSecretsStore,
} from "@nexuscode/core"
import {
  applyExplicitConfigOverrides,
  applyRepositoryAgentPreset,
  getCredentialRemovalsForConfigPatch,
  mergeConfigPatchSafely,
  partitionConfigPatchForPersistence,
  type ExplicitSettingReader,
} from "./config-overrides.js"

function config(overrides: Record<string, unknown> = {}): NexusConfig {
  return NexusConfigSchema.parse(overrides) as NexusConfig
}

function reader(values: Record<string, unknown>): ExplicitSettingReader {
  return <T>(key: string) => values[key] as T | undefined
}

describe("applyExplicitConfigOverrides", () => {
  it("does not let VS Code contribution defaults overwrite nexus.yaml", () => {
    const target = config({
      model: { provider: "google", id: "gemini-custom", temperature: 0.7 },
      indexing: { enabled: false },
    })
    const before = structuredClone(target)

    applyExplicitConfigOverrides(target, reader({}))

    expect(target).toEqual(before)
  })

  it("migrates a discontinued Kilo model stored in VS Code settings", () => {
    const target = config()

    applyExplicitConfigOverrides(target, reader({
      model: "minimax/minimax-m2.5:free",
    }))

    expect(target.model).toMatchObject({
      provider: "openai-compatible",
      id: "kilo-auto/free",
      baseUrl: "https://api.kilo.ai/api/openrouter",
    })
  })

  it("merges explicit model, permissions, indexing, vector and local embedding settings", () => {
    const target = config()

    applyExplicitConfigOverrides(target, reader({
      provider: "openrouter",
      model: "openai/gpt-4.1",
      temperature: 5,
      enableCheckpoints: false,
      autoApproveRead: false,
      autoApproveMcp: true,
      enableIndexing: true,
      enableVectorIndex: true,
      embeddingBatchSize: 12.9,
      embeddingConcurrency: 3.8,
      enableVectorDb: true,
      vectorDbUrl: " http://qdrant.internal:6333 ",
      vectorDbAutoStart: false,
      embeddingsProvider: "local",
      embeddingsDimensions: 256.9,
    }))

    expect(target.model).toMatchObject({
      provider: "openai-compatible",
      id: "openai/gpt-4.1",
      baseUrl: "https://openrouter.ai/api/v1",
      temperature: 2,
    })
    expect(target.checkpoint.enabled).toBe(false)
    expect(target.permissions.autoApproveRead).toBe(false)
    expect(target.permissions.autoApproveMcp).toBe(true)
    expect(target.indexing).toMatchObject({
      enabled: true,
      vector: true,
      embeddingBatchSize: 12,
      embeddingConcurrency: 3,
    })
    expect(target.vectorDb).toMatchObject({
      enabled: true,
      url: "http://qdrant.internal:6333",
      autoStart: false,
    })
    expect(target.embeddings).toEqual({
      provider: "local",
      model: "feature-hashing-v1",
      dimensions: 256,
    })
  })

  it("rejects invalid provider and numeric overrides without corrupting valid config", () => {
    const target = config({
      model: { provider: "anthropic", id: "claude-custom", temperature: 0.4 },
      embeddings: { provider: "mistral", model: "mistral-embed" },
      indexing: { embeddingConcurrency: 4 },
    })

    applyExplicitConfigOverrides(target, reader({
      provider: "made-up-provider",
      embeddingsProvider: "made-up-embeddings",
      temperature: Number.NaN,
      contextWindow: 0,
      embeddingConcurrency: -3,
      embeddingsDimensions: Number.POSITIVE_INFINITY,
      toolClassifyThreshold: 0,
    }))

    expect(target.model).toMatchObject({
      provider: "anthropic",
      id: "claude-custom",
      temperature: 0.4,
    })
    expect(target.embeddings).toEqual({
      provider: "mistral",
      model: "mistral-embed",
    })
    expect(target.indexing.embeddingConcurrency).toBe(4)
  })

  it("never reads API keys from plaintext VS Code settings", () => {
    const target = config({
      model: { provider: "anthropic", id: "claude-custom" },
      embeddings: { provider: "mistral", model: "mistral-embed" },
    })

    applyExplicitConfigOverrides(target, reader({
      apiKey: "plaintext-model-secret",
      embeddingsApiKey: "plaintext-embeddings-secret",
    }))

    expect(target.model.apiKey).toBeUndefined()
    expect(target.embeddings?.apiKey).toBeUndefined()
  })

  it("drops an inherited credential and old base URL when the provider changes", () => {
    const target = config({
      model: {
        provider: "openai-compatible",
        id: "old-model",
        baseUrl: "https://api.kilo.ai/api/openrouter",
        apiKey: "kilo-secret",
      },
    })

    applyExplicitConfigOverrides(target, reader({
      provider: "groq",
      model: "llama",
    }))

    expect(target.model).toEqual({
      provider: "groq",
      id: "llama",
      reasoningEffort: "auto",
      reasoningHistoryMode: "auto",
    })
  })

  it("retains the credential for a model-id-only override", () => {
    const target = config({
      model: {
        provider: "openai",
        id: "old-model",
        apiKey: "same-scope",
      },
    })

    applyExplicitConfigOverrides(target, reader({ model: "new-model" }))

    expect(target.model.apiKey).toBe("same-scope")
  })

  it("accepts endpoint and auto-approval authority only from the host settings scope", () => {
    const target = config({
      model: {
        provider: "anthropic",
        id: "claude",
        baseUrl: "https://api.anthropic.com/v1",
      },
      embeddings: {
        provider: "mistral",
        model: "mistral-embed",
        baseUrl: "https://api.mistral.ai/v1",
      },
      vectorDb: {
        enabled: false,
        url: "http://127.0.0.1:6333",
        autoStart: false,
      },
    })

    applyExplicitConfigOverrides(
      target,
      reader({
        provider: "openai-compatible",
        baseUrl: "https://repository-model.test/v1",
        model: "safe-project-model-choice",
        autoApproveCommand: true,
        embeddingsProvider: "openai-compatible",
        embeddingsBaseUrl: "https://repository-embeddings.test/v1",
        vectorDbUrl: "https://repository-vector.test",
        vectorDbAutoStart: true,
      }),
      reader({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        autoApproveCommand: false,
        embeddingsProvider: "google",
        embeddingsBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
        vectorDbUrl: "http://localhost:6333",
        vectorDbAutoStart: false,
      }),
    )

    expect(target.model).toMatchObject({
      provider: "openai",
      id: "safe-project-model-choice",
      baseUrl: "https://api.openai.com/v1",
    })
    expect(target.permissions.autoApproveCommand).toBe(false)
    expect(target.embeddings).toMatchObject({
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    })
    expect(target.vectorDb).toMatchObject({
      url: "http://localhost:6333",
      autoStart: false,
    })
  })

  it("does not let a repository setting implicitly enable vector autostart", () => {
    const target = config()

    applyExplicitConfigOverrides(
      target,
      reader({ enableVectorDb: true }),
      reader({}),
    )

    expect(target.vectorDb).toMatchObject({
      enabled: true,
      autoStart: false,
    })
  })

  it("replaces sensitive sections during save instead of deep-merging stale credentials", () => {
    const current = config({
      model: {
        provider: "openai-compatible",
        id: "old",
        baseUrl: "https://api.kilo.ai/api/openrouter",
        apiKey: "kilo-secret",
      },
      embeddings: {
        provider: "openai",
        model: "old-embedding",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "embedding-secret",
      },
    })

    const next = mergeConfigPatchSafely(current, {
      model: {
        ...current.model,
        provider: "groq",
        id: "llama",
      },
      embeddings: {
        ...current.embeddings!,
        provider: "mistral",
        model: "mistral-embed",
      },
    })

    expect(next.model.apiKey).toBeUndefined()
    expect(next.model.baseUrl).toBeUndefined()
    expect(next.embeddings?.apiKey).toBeUndefined()
    expect(next.embeddings?.baseUrl).toBeUndefined()
  })

  it("treats profiles as a replacement map and removes omitted profiles", () => {
    const current = config({
      profiles: {
        keep: {
          provider: "openai",
          id: "old",
          baseUrl: "https://api.openai.com/v1",
          temperature: 0.2,
        },
        remove: {
          provider: "anthropic",
          id: "claude",
        },
      },
    })

    const next = mergeConfigPatchSafely(current, {
      profiles: {
        keep: {
          id: "new",
        },
      },
    })

    expect(next.profiles).toEqual({
      keep: {
        provider: "openai",
        id: "new",
        baseUrl: "https://api.openai.com/v1",
        temperature: 0.2,
      },
    })
  })

  it("drops stale profile credentials and extras when a redacted profile changes endpoint", () => {
    const current = config({
      profiles: {
        work: {
          provider: "openai-compatible",
          id: "old",
          baseUrl: "https://tenant-a.test/v1",
          apiKey: "must-not-survive",
          extra: {
            headers: {
              Authorization: "Bearer old",
              "X-Tenant": "old",
            },
          },
        },
      },
    })

    const next = mergeConfigPatchSafely(current, {
      profiles: {
        work: {
          ...current.profiles.work,
          id: "new",
          baseUrl: "https://tenant-b.test/v1",
          apiKey: undefined,
        },
      },
    })

    expect(next.profiles.work).toEqual({
      provider: "openai-compatible",
      id: "new",
      baseUrl: "https://tenant-b.test/v1",
    })
  })

  it("identifies model, embedding, changed-profile and deleted-profile tombstones", () => {
    const current = config({
      model: {
        provider: "openai-compatible",
        id: "old",
        baseUrl: "https://tenant-a.test/v1",
      },
      embeddings: {
        provider: "openai-compatible",
        model: "embed",
        baseUrl: "https://tenant-a.test/v1",
      },
      profiles: {
        changed: {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://api.anthropic.com/v1",
        },
        deleted: {
          provider: "openai",
          id: "gpt",
        },
      },
    })
    const patch: Partial<NexusConfig> = {
      model: {
        provider: "openai-compatible",
        id: "new",
        baseUrl: "https://tenant-b.test/v1",
      },
      embeddings: {
        provider: "openai-compatible",
        model: "embed",
        baseUrl: "https://tenant-b.test/v1",
      },
      profiles: {
        changed: {
          provider: "anthropic",
          id: "claude",
          baseUrl: "https://proxy.test/anthropic",
        },
      },
    }
    const next = mergeConfigPatchSafely(current, patch)

    expect(getCredentialRemovalsForConfigPatch(current, next, patch)).toEqual({
      model: current.model,
      embeddings: current.embeddings,
      profileBindings: [
        {
          name: "changed",
          model: {
            provider: "anthropic",
            id: "claude",
            baseUrl: "https://api.anthropic.com/v1",
            reasoningEffort: "auto",
            reasoningHistoryMode: "auto",
          },
        },
      ],
      profileNames: ["deleted"],
    })
  })

  it("removes an inherited profile binding when the base endpoint changes", () => {
    const current = config({
      model: {
        provider: "openai-compatible",
        id: "base-old",
        baseUrl: "https://tenant-a.test/v1",
      },
      profiles: {
        inherited: {
          id: "profile-model",
        },
      },
    })
    const patch: Partial<NexusConfig> = {
      model: {
        provider: "openai-compatible",
        id: "base-new",
        baseUrl: "https://tenant-b.test/v1",
      },
    }
    const next = mergeConfigPatchSafely(current, patch)
    const removal = getCredentialRemovalsForConfigPatch(
      current,
      next,
      patch,
    )

    expect(removal.profileBindings).toHaveLength(1)
    expect(removal.profileBindings?.[0]).toMatchObject({
      name: "inherited",
      model: {
        provider: "openai-compatible",
        id: "profile-model",
        baseUrl: "https://tenant-a.test/v1",
      },
    })
  })

  it("persists a redacted profile endpoint change without resurrecting its old key on reload", async () => {
    const store: NexusSecretsStore & { value?: string } = {
      value: undefined,
      async getSecret() {
        return this.value
      },
      async setSecret(_key, value) {
        this.value = value || undefined
      },
    }
    const withSecret = config({
      profiles: {
        work: {
          provider: "openai-compatible",
          id: "old",
          baseUrl: "https://tenant-a.test/v1",
          apiKey: "tenant-a-secret",
        },
      },
    })
    await persistSecretsFromConfig(
      withSecret as unknown as Record<string, unknown>,
      store,
    )
    const current = stripSecretsFromConfig(
      withSecret as unknown as Record<string, unknown>,
    ) as unknown as NexusConfig
    const patch: Partial<NexusConfig> = {
      profiles: {
        work: {
          ...current.profiles.work,
          id: "new",
          baseUrl: "https://tenant-b.test/v1",
        },
      },
    }
    const next = mergeConfigPatchSafely(current, patch)
    await persistSecretsFromConfig(
      next as unknown as Record<string, unknown>,
      store,
      {
        remove: getCredentialRemovalsForConfigPatch(current, next, patch),
      },
    )
    const reloaded = stripSecretsFromConfig(
      next as unknown as Record<string, unknown>,
    ) as unknown as NexusConfig
    const selected = {
      ...reloaded,
      model: selectProviderProfile(
        reloaded.model,
        reloaded.profiles.work!,
      ),
    }
    const runtime = await finalizeConfigCredentials(
      selected as unknown as Record<string, unknown>,
      store,
      { profileName: "work" },
    ) as unknown as NexusConfig

    expect(runtime.model).toMatchObject({
      baseUrl: "https://tenant-b.test/v1",
      id: "new",
    })
    expect(runtime.model.apiKey).toBeUndefined()
    expect(runtime.profiles.work?.apiKey).toBeUndefined()
  })

  it("keeps a replacement key when a named profile changes endpoint", async () => {
    const store: NexusSecretsStore & { value?: string } = {
      value: undefined,
      async getSecret() {
        return this.value
      },
      async setSecret(_key, value) {
        this.value = value || undefined
      },
    }
    const withSecret = config({
      profiles: {
        work: {
          provider: "openai-compatible",
          id: "old",
          baseUrl: "https://tenant-a.test/v1",
          apiKey: "tenant-a-secret",
        },
      },
    })
    await persistSecretsFromConfig(
      withSecret as unknown as Record<string, unknown>,
      store,
    )
    const current = stripSecretsFromConfig(
      withSecret as unknown as Record<string, unknown>,
    ) as unknown as NexusConfig
    const patch: Partial<NexusConfig> = {
      profiles: {
        work: {
          provider: "openai-compatible",
          id: "new",
          baseUrl: "https://tenant-b.test/v1",
          apiKey: "tenant-b-secret",
        },
      },
    }
    const next = mergeConfigPatchSafely(current, patch)
    await persistSecretsFromConfig(
      next as unknown as Record<string, unknown>,
      store,
      {
        remove: getCredentialRemovalsForConfigPatch(current, next, patch),
      },
    )
    const reloaded = stripSecretsFromConfig(
      next as unknown as Record<string, unknown>,
    ) as unknown as NexusConfig
    const selected = {
      ...reloaded,
      model: selectProviderProfile(
        reloaded.model,
        reloaded.profiles.work!,
      ),
    }
    const runtime = await finalizeConfigCredentials(
      selected as unknown as Record<string, unknown>,
      store,
      { profileName: "work" },
    ) as unknown as NexusConfig

    expect(runtime.model.apiKey).toBe("tenant-b-secret")
  })
})

describe("applyRepositoryAgentPreset", () => {
  it("cannot retarget the host endpoint or select unapproved external content", () => {
    const target = config({
      model: {
        provider: "openai-compatible",
        id: "trusted-model",
        baseUrl: "https://api.kilo.ai/api/openrouter",
        apiKey: "trusted-key",
      },
      indexing: { vector: false },
      skills: ["/host-approved/skill"],
      rules: { files: ["/host-approved/rule.md"] },
      mcp: {
        servers: [{
          name: "host-approved",
          command: "node",
          args: ["server.js"],
          enabled: true,
        }],
      },
    })

    const selected = applyRepositoryAgentPreset(
      target,
      {
        vector: true,
        skills: [
          ".nexus/skills/local",
          "/tmp/unapproved-skill",
          "/host-approved/skill",
        ],
        mcpServers: ["host-approved", "repository-only"],
        rulesFiles: [
          "NEXUS.md",
          "/tmp/unapproved-rule.md",
          "/host-approved/rule.md",
        ],
        modelProvider: "groq",
        modelId: "repository-model",
      },
      process.cwd(),
    )

    expect(selected.model).toEqual(target.model)
    expect(selected.indexing.vector).toBe(true)
    expect(selected.skills).toEqual([
      ".nexus/skills/local",
      "/host-approved/skill",
    ])
    expect(selected.rules.files).toEqual([
      "NEXUS.md",
      "/host-approved/rule.md",
    ])
    expect(selected.mcp.servers.map((server) => server.name)).toEqual([
      "host-approved",
    ])
  })

  it("can change only the model id inside the already trusted provider scope", () => {
    const target = config({
      model: {
        provider: "openai-compatible",
        id: "old",
        baseUrl: "https://api.kilo.ai/api/openrouter",
        apiKey: "trusted-key",
      },
    })

    const selected = applyRepositoryAgentPreset(
      target,
      {
        vector: false,
        skills: [],
        mcpServers: [],
        rulesFiles: [],
        modelProvider: "openai-compatible",
        modelId: "new",
      },
      process.cwd(),
    )

    expect(selected.model).toEqual({
      ...target.model,
      id: "new",
    })
    expect(selected.rules.files).toEqual([
      "NEXUS.md",
      "AGENTS.md",
      "CLAUDE.md",
    ])
  })
})

describe("partitionConfigPatchForPersistence", () => {
  it("writes only changed fields and keeps authority out of the project layer", () => {
    const current = config({
      permissions: {
        autoApproveRead: true,
        autoApproveWrite: false,
        denyCommandPatterns: [],
      },
      plugins: {
        trusted: [],
        blocked: [],
      },
    })
    const patch = {
      permissions: {
        ...current.permissions,
        autoApproveWrite: true,
        denyCommandPatterns: ["rm:**"],
      },
      modes: {
        ...current.modes,
        agent: {
          autoApprove: ["read"] as const,
          customInstructions: "Project instructions",
        },
      },
      plugins: {
        ...current.plugins,
        trusted: ["content-bound-plugin"],
        blocked: ["blocked-by-project"],
      },
      mcp: {
        servers: [{
          name: "trusted-host-server",
          command: "node",
          args: ["server.js"],
          enabled: true,
        }],
      },
      skillsConfig: [
        { path: ".nexus/skills/one", enabled: true },
        { path: ".nexus/skills/two", enabled: false },
      ],
      profiles: {
        work: { provider: "openai" as const, id: "gpt" },
      },
    } as Partial<NexusConfig>

    const result = partitionConfigPatchForPersistence(current, patch)

    expect(result.globalPatch).toEqual({
      permissions: { autoApproveWrite: true },
      modes: { agent: { autoApprove: ["read"] } },
      plugins: { trusted: ["content-bound-plugin"] },
      mcp: {
        servers: [{
          name: "trusted-host-server",
          command: "node",
          args: ["server.js"],
          enabled: true,
        }],
      },
      profiles: {
        work: { provider: "openai", id: "gpt" },
      },
    })
    expect(result.projectPatch).toEqual({
      permissions: { denyCommandPatterns: ["rm:**"] },
      modes: { agent: { customInstructions: "Project instructions" } },
      plugins: { blocked: ["blocked-by-project"] },
      skills: [
        ".nexus/skills/one",
        { path: ".nexus/skills/two", enabled: false },
      ],
    })
  })

  it("does not materialize an unchanged effective config", () => {
    const current = config()
    const result = partitionConfigPatchForPersistence(current, {
      model: { ...current.model },
      indexing: { ...current.indexing },
      permissions: { ...current.permissions },
      mcp: { servers: [...current.mcp.servers] },
    })

    expect(result).toEqual({
      projectPatch: {},
      globalPatch: {},
    })
  })

  it("persists profile deletion as an explicit host-owned patch", () => {
    const current = config({
      profiles: {
        keep: { provider: "openai", id: "keep" },
        remove: { provider: "anthropic", id: "remove" },
      },
    })

    const result = partitionConfigPatchForPersistence(current, {
      profiles: {
        keep: { provider: "openai", id: "keep" },
      },
    })

    expect(result).toEqual({
      projectPatch: {},
      globalPatch: {
        profiles: {
          remove: undefined,
        },
      },
    })
  })

  it("does not mutate the incoming patch while normalizing skills", () => {
    const current = config()
    const patch = {
      skillsConfig: [{ path: "skill-a", enabled: false }],
    } as Partial<NexusConfig>
    const before = structuredClone(patch)

    partitionConfigPatchForPersistence(current, patch)

    expect(patch).toEqual(before)
  })
})
