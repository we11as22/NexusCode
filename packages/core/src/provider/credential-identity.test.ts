import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig, ProviderConfig } from "../types.js"
import {
  canonicalizeCredentialDestination,
  getEmbeddingCredentialIdentity,
  getProviderCredentialIdentity,
  mergeEmbeddingConfigSafely,
  mergeModelPresetSelection,
  mergeProviderConfigSafely,
  resolveEmbeddingCredential,
  resolveProviderCredential,
  selectProviderProfile,
} from "./credential-identity.js"

const ENV_KEYS = [
  "KILO_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "NEXUS_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
]

function model(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    provider: "openai-compatible",
    id: "test-model",
    baseUrl: "https://api.kilo.ai/api/openrouter",
    ...overrides,
  }
}

function embeddings(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    provider: "openai-compatible",
    model: "test-embedding",
    baseUrl: "https://api.openai.com/v1",
    ...overrides,
  }
}

describe("credential destination identity", () => {
  beforeEach(() => {
    for (const name of ENV_KEYS) vi.stubEnv(name, `${name.toLowerCase()}-secret`)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ["https://API.OPENAI.COM:443/v1/", "https://api.openai.com/v1"],
    ["https://api.openai.com./v1", "https://api.openai.com/v1"],
    ["http://127.0.0.1:80/v1/", "http://127.0.0.1/v1"],
    ["http://[::1]:8080/v1/", "http://[::1]:8080/v1"],
  ])("canonicalizes scheme, host, default port, and base path", (baseUrl, destination) => {
    expect(getProviderCredentialIdentity(model({
      provider: "openai",
      baseUrl,
    }))).toEqual({
      purpose: "chat",
      provider: "openai",
      destination,
    })
  })

  it.each([
    "https://api.openai.com/v1?api-version=leaky",
    "https://api.openai.com/v1#fragment",
  ])("rejects query strings and fragments in credential destinations: %s", (baseUrl) => {
    expect(() => canonicalizeCredentialDestination(baseUrl)).toThrow(
      /query string or fragment/,
    )
  })

  it("keeps tenant and base paths separate", () => {
    expect(getProviderCredentialIdentity(model({
      baseUrl: "https://gateway.test/tenant-a/v1",
    })).destination).not.toBe(getProviderCredentialIdentity(model({
      baseUrl: "https://gateway.test/tenant-b/v1",
    })).destination)
  })

  it.each([
    "https://api.openai.com.evil.test/v1",
    "https://api.openai.com@evil.test/v1",
    "https://evil@api.openai.com/v1",
    "https://api.openai.com/v1/tenant",
    "http://api.openai.com/v1",
  ])("does not release OPENAI_API_KEY to a spoofed or non-official destination: %s", (baseUrl) => {
    const config = model({ provider: "openai", baseUrl })
    expect(() => resolveProviderCredential(config)).toThrow(
      /Missing API key|must not include userinfo/,
    )
  })

  it("selects only the environment key bound to the exact official destination", () => {
    expect(resolveProviderCredential(model()).apiKey).toBe("kilo_api_key-secret")
    expect(resolveProviderCredential(model({
      id: "paid-model",
      baseUrl: "https://api.kilo.ai/api/organizations/tenant-a/inference",
    })).apiKey).toBe("kilo_api_key-secret")
    expect(resolveProviderCredential(model({
      baseUrl: "https://openrouter.ai/api/v1",
    })).apiKey).toBe("openrouter_api_key-secret")
    expect(resolveProviderCredential(model({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    })).apiKey).toBe("openai_api_key-secret")
  })

  it("allows named-provider env only at its official default destination", () => {
    expect(resolveProviderCredential(model({
      provider: "groq",
      baseUrl: undefined,
    })).apiKey).toBe("groq_api_key-secret")
    expect(() => resolveProviderCredential(model({
      provider: "groq",
      baseUrl: "https://proxy.test/openai/v1",
    }))).toThrow(/Missing API key/)
  })

  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080/v1",
    "http://127.4.3.2:8080/v1",
    "http://[::1]:8080/v1",
  ])("permits a keyless loopback destination: %s", (baseUrl) => {
    expect(resolveProviderCredential(model({ baseUrl })).source).toBe("local")
  })

  it("generates the Kilo sentinel only for a recognized free route", () => {
    vi.stubEnv("KILO_API_KEY", "")
    expect(resolveProviderCredential(model({
      id: "minimax/minimax-m2.5:free",
    }))).toMatchObject({ apiKey: "dummy", source: "kilo-free" })
    expect(() => resolveProviderCredential(model({
      id: "paid/model",
    }))).toThrow(/Missing API key/)
  })

  it("treats an explicit literal dummy as a real custom credential", () => {
    expect(resolveProviderCredential(model({
      baseUrl: "https://custom.test/v1",
      apiKey: "dummy",
    }))).toMatchObject({ apiKey: "dummy", source: "explicit" })
  })

  it("drops inherited credentials and provider fields on provider or destination changes", () => {
    const current = model({
      provider: "azure",
      id: "gpt",
      baseUrl: "https://tenant.openai.azure.com/openai",
      apiKey: "azure-secret",
      resourceName: "tenant",
      deploymentId: "deployment",
      apiVersion: "2025-01-01-preview",
      extra: { headers: { "x-tenant": "a" } },
    })

    expect(mergeProviderConfigSafely(current, {
      provider: "groq",
      id: "llama",
    })).toEqual({
      provider: "groq",
      id: "llama",
    })

    expect(mergeProviderConfigSafely(model({
      apiKey: "old-secret",
      extra: { headers: { tenant: "a" } },
    }), {
      baseUrl: "https://custom.test/v1",
    })).toEqual({
      provider: "openai-compatible",
      id: "test-model",
      baseUrl: "https://custom.test/v1",
    })
  })

  it("drops stale full-form provider extras on a destination-only change", () => {
    const current = model({
      apiKey: "old-secret",
      extra: {
        headers: {
          Authorization: "Bearer old",
          "X-Tenant": "old",
        },
      },
    })

    expect(mergeProviderConfigSafely(current, {
      ...current,
      baseUrl: "https://custom.test/v1",
    })).toEqual({
      provider: "openai-compatible",
      id: "test-model",
      baseUrl: "https://custom.test/v1",
    })
  })

  it("recognizes stale full-form values as inherited during a provider switch", () => {
    const current = model({
      apiKey: "kilo-secret",
      extra: { headers: { tenant: "old" } },
    })

    expect(mergeProviderConfigSafely(current, {
      ...current,
      provider: "groq",
      id: "llama",
    })).toEqual({
      provider: "groq",
      id: "llama",
    })
  })

  it("retains credential scope for model-id-only changes and accepts a new explicit key atomically", () => {
    expect(mergeProviderConfigSafely(model({ apiKey: "same-scope" }), {
      id: "new-model",
    }).apiKey).toBe("same-scope")

    expect(mergeProviderConfigSafely(model({ apiKey: "old-secret" }), {
      baseUrl: "https://custom.test/v1",
      apiKey: "new-secret",
    }).apiKey).toBe("new-secret")
  })

  it("never inherits the active profile credential into another profile at the same endpoint", () => {
    const active = model({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "profile-a-secret",
    })

    expect(selectProviderProfile(active, {
      id: "profile-b-model",
    }).apiKey).toBeUndefined()
    expect(selectProviderProfile(active, {
      id: "profile-b-model",
      apiKey: "profile-b-secret",
    }).apiKey).toBe("profile-b-secret")
  })

  it("isolates embeddings from chat credentials and destination changes", () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-chat-or-embedding")
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-other")
    expect(resolveEmbeddingCredential(embeddings()).apiKey).toBe("openai-chat-or-embedding")
    expect(getEmbeddingCredentialIdentity(embeddings())).toMatchObject({
      purpose: "embeddings",
      provider: "openai-compatible",
      destination: "https://api.openai.com/v1",
    })
    expect(() => resolveEmbeddingCredential(embeddings({
      baseUrl: "https://custom.test/v1",
    }))).toThrow(/Missing API key/)
    expect(mergeEmbeddingConfigSafely(embeddings({ apiKey: "old" }), {
      baseUrl: "https://custom.test/v1",
    }).apiKey).toBeUndefined()
  })

  it("builds Azure identity only from a strict resource label", () => {
    expect(getProviderCredentialIdentity(model({
      provider: "azure",
      baseUrl: undefined,
      resourceName: "Tenant-01",
    }))).toEqual({
      purpose: "chat",
      provider: "azure",
      destination: "https://tenant-01.openai.azure.com",
    })
  })

  it.each([
    "tenant/openai",
    "tenant?redirect=evil.test",
    "tenant.evil.test",
    "-tenant",
    "tenant-",
    "a".repeat(64),
  ])("rejects a malicious Azure resource name: %s", (resourceName) => {
    expect(() => getProviderCredentialIdentity(model({
      provider: "azure",
      baseUrl: undefined,
      resourceName,
    }))).toThrow(/Invalid Azure resource name/)
  })

  it.each([
    "us-east-1",
    "eu-central-2",
    "us-gov-west-1",
  ])("accepts a syntactically valid Bedrock region: %s", (region) => {
    expect(getProviderCredentialIdentity(model({
      provider: "bedrock",
      baseUrl: undefined,
      extra: { region },
    })).destination).toBe(`aws-bedrock://${region}`)
    expect(getEmbeddingCredentialIdentity(embeddings({
      provider: "bedrock",
      baseUrl: undefined,
      region,
    })).destination).toBe(`aws-bedrock://${region}`)
  })

  it.each([
    "https://evil.test",
    "us-east-1/path",
    "us-east-1?role=admin",
    "../us-east-1",
    "US-EAST-1",
  ])("rejects a malicious Bedrock region: %s", (region) => {
    expect(() => getProviderCredentialIdentity(model({
      provider: "bedrock",
      baseUrl: undefined,
      extra: { region },
    }))).toThrow(/Invalid AWS region/)
    expect(() => getEmbeddingCredentialIdentity(embeddings({
      provider: "bedrock",
      baseUrl: undefined,
      region,
    }))).toThrow(/Invalid AWS region/)
  })

  it("requires an explicit credential for remote Ollama chat and embeddings", () => {
    expect(() => resolveProviderCredential(model({
      provider: "ollama",
      baseUrl: "https://ollama.example.test/v1",
    }), {})).toThrow(/Missing API key/)
    expect(() => resolveEmbeddingCredential(embeddings({
      provider: "ollama",
      baseUrl: "https://ollama.example.test/v1",
    }), {})).toThrow(/Missing API key/)

    expect(resolveProviderCredential(model({
      provider: "ollama",
      baseUrl: "https://ollama.example.test/v1",
      apiKey: "remote-chat",
    }), {})).toMatchObject({ apiKey: "remote-chat", source: "explicit" })
    expect(resolveEmbeddingCredential(embeddings({
      provider: "ollama",
      baseUrl: "https://ollama.example.test/v1",
      apiKey: "remote-embedding",
    }), {})).toMatchObject({ apiKey: "remote-embedding", source: "explicit" })
  })

  it.each([
    "http://localhost:8080/v1",
    "https://localhost:11434/v1",
    "http://127.0.0.1:80/v1",
  ])("does not treat an arbitrary loopback service as keyless Ollama: %s", (baseUrl) => {
    expect(() => resolveProviderCredential(model({
      provider: "ollama",
      baseUrl,
    }), {})).toThrow(/Missing API key/)
    expect(() => resolveEmbeddingCredential(embeddings({
      provider: "ollama",
      baseUrl,
    }), {})).toThrow(/Missing API key/)
  })

  it("applies OpenRouter presets atomically and rejects an endpoint-less compatible preset", () => {
    expect(mergeModelPresetSelection(model({
      provider: "anthropic",
      baseUrl: undefined,
    }), "openrouter", "openai/gpt-4.1")).toMatchObject({
      provider: "openai-compatible",
      id: "openai/gpt-4.1",
      baseUrl: "https://openrouter.ai/api/v1",
    })
    expect(() => mergeModelPresetSelection(model({
      provider: "anthropic",
      baseUrl: undefined,
    }), "openai-compatible", "custom/model")).toThrow(
      /requires an explicit baseUrl/,
    )
    expect(mergeModelPresetSelection(model({
      baseUrl: "https://tenant.test/v1",
    }), "openai-compatible", "custom/model")).toMatchObject({
      provider: "openai-compatible",
      id: "custom/model",
      baseUrl: "https://tenant.test/v1",
    })
  })
})
