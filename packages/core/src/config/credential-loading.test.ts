import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getPendingProjectAuthorityRequests,
  loadConfig,
  mergeNexusConfigLayers,
} from "./index.js"

describe("credential-safe config loading", () => {
  let cwd: string | undefined

  afterEach(async () => {
    vi.unstubAllEnvs()
    if (cwd) await rm(cwd, { recursive: true, force: true })
  })

  it("resolves the Kilo selection without materializing unrelated ambient keys", async () => {
    cwd = await mkdtemp(join(tmpdir(), "nexus-config-credentials-"))
    await mkdir(join(cwd, ".nexus"), { recursive: true })
    await writeFile(join(cwd, ".nexus", "nexus.yaml"), [
      "model:",
      "  provider: openai-compatible",
      "  id: minimax/minimax-m2.5:free",
      "  baseUrl: https://api.kilo.ai/api/openrouter",
    ].join("\n"))
    vi.stubEnv("OPENAI_API_KEY", "openai-secret")
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-secret")
    vi.stubEnv("KILO_API_KEY", "kilo-secret")
    vi.stubEnv("NEXUS_API_KEY", "legacy-nexus-secret")

    const loaded = await loadConfig(cwd)

    expect(loaded.model).toMatchObject({
      provider: "openai-compatible",
      id: "minimax/minimax-m2.5:free",
      baseUrl: "https://api.kilo.ai/api/openrouter",
    })
    expect(loaded.model.apiKey).toBeUndefined()
  })

  it("does not let OPENAI_MODEL or OPENROUTER_MODEL retarget a Kilo gateway selection", async () => {
    cwd = await mkdtemp(join(tmpdir(), "nexus-config-kilo-model-"))
    await mkdir(join(cwd, ".nexus"), { recursive: true })
    await writeFile(join(cwd, ".nexus", "nexus.yaml"), [
      "model:",
      "  provider: openai-compatible",
      "  baseUrl: https://api.kilo.ai/api/openrouter",
    ].join("\n"))
    vi.stubEnv("OPENAI_MODEL", "openai-wrong")
    vi.stubEnv("OPENROUTER_MODEL", "openrouter-wrong")

    const loaded = await loadConfig(cwd)

    expect(loaded.model).toMatchObject({
      provider: "openai-compatible",
      id: "minimax/minimax-m2.5:free",
      baseUrl: "https://api.kilo.ai/api/openrouter",
    })
  })

  it("never consults secure storage while loading a non-secret config", async () => {
    cwd = await mkdtemp(join(tmpdir(), "nexus-config-two-phase-"))
    const getSecret = vi.fn(async () => JSON.stringify({
      version: 2,
      credentials: {},
    }))

    const loaded = await loadConfig(cwd, {
      secrets: {
        getSecret,
        async setSecret() {},
      },
    })

    expect(getSecret).not.toHaveBeenCalled()
    expect(loaded.model.apiKey).toBeUndefined()
  })

  it("can load remote metadata without consulting local env or file substitutions", async () => {
    cwd = await mkdtemp(join(tmpdir(), "nexus-config-remote-env-"))
    await writeFile(join(cwd, ".env"), "NEXUS_MODEL=openai/should-not-load\n")
    await writeFile(join(cwd, "provider-key.txt"), "file-provider-secret\n")
    await mkdir(join(cwd, ".nexus"), { recursive: true })
    await writeFile(join(cwd, ".nexus", "nexus.yaml"), [
      "model:",
      "  provider: openai-compatible",
      "  id: minimax/minimax-m2.5:free",
      "  baseUrl: https://api.kilo.ai/api/openrouter",
      "  apiKey: \"{env:OPENAI_API_KEY}\"",
      "  extra:",
      "    headers:",
      "      Authorization: \"Bearer {file:../provider-key.txt}\"",
    ].join("\n"))
    vi.stubEnv("NEXUS_MODEL", "openai/process-override-must-not-load")
    vi.stubEnv("OPENAI_API_KEY", "ambient-provider-secret")

    const loaded = await loadConfig(cwd, { loadEnv: false })

    expect(loaded.model).toMatchObject({
      provider: "openai-compatible",
      id: "minimax/minimax-m2.5:free",
      baseUrl: "https://api.kilo.ai/api/openrouter",
    })
    expect(loaded.model.apiKey).toBeUndefined()
    expect(loaded.model.extra).toBeUndefined()
    expect(process.env["NEXUS_MODEL"]).toBe(
      "openai/process-override-must-not-load",
    )
  })

  it("recursively sanitizes provider credentials loaded from YAML", async () => {
    cwd = await mkdtemp(join(tmpdir(), "nexus-config-sanitize-"))
    await mkdir(join(cwd, ".nexus"), { recursive: true })
    await writeFile(join(cwd, ".nexus", "nexus.yaml"), [
      "model:",
      "  provider: bedrock",
      "  id: amazon.nova-pro-v1:0",
      "  apiKey: top-level-leak",
      "  extra:",
      "    region: us-east-1",
      "    accessKeyId: aws-id-leak",
      "    secretAccessKey: aws-secret-leak",
      "    nested:",
      "      sessionToken: session-leak",
      "      headers:",
      "        Authorization: Bearer leaked",
      "        Cookie: session=leaked",
      "        X-Trace: safe",
    ].join("\n"))

    const loaded = await loadConfig(cwd)

    expect(loaded.model).toEqual({
      provider: "openai-compatible",
      id: "amazon.nova-pro-v1:0",
      baseUrl: "https://api.kilo.ai/api/openrouter",
      reasoningEffort: "auto",
      reasoningHistoryMode: "auto",
    })
    expect(getPendingProjectAuthorityRequests(loaded)).toEqual([
      expect.objectContaining({
        kind: "model-endpoint",
        payload: {
          model: {
            provider: "bedrock",
            extra: {
              region: "us-east-1",
              nested: { headers: { "X-Trace": "safe" } },
            },
          },
        },
      }),
    ])
    expect(
      JSON.stringify(getPendingProjectAuthorityRequests(loaded)),
    ).not.toMatch(
      /top-level-leak|aws-id-leak|aws-secret-leak|session-leak|Bearer leaked|session=leaked/u,
    )
  })

  it("keeps a project provider change pending without retargeting the trusted layer", () => {
    const merged = mergeNexusConfigLayers(
      {
        model: {
          provider: "openai-compatible",
          id: "old",
          baseUrl: "https://api.kilo.ai/api/openrouter",
          apiKey: "kilo-secret",
          extra: { headers: { tenant: "old" } },
        },
      },
      {
        model: {
          provider: "groq",
          id: "llama",
        },
      },
    )

    expect(merged.model).toEqual({
      provider: "openai-compatible",
      id: "llama",
      baseUrl: "https://api.kilo.ai/api/openrouter",
      apiKey: "kilo-secret",
      extra: { headers: { tenant: "old" } },
    })
    expect(merged.pendingProjectAuthority).toEqual([
      expect.objectContaining({
        kind: "model-endpoint",
        payload: { model: { provider: "groq" } },
      }),
    ])
  })

  it("keeps project profile definitions pending instead of shadowing host profiles", () => {
    const sameScope = mergeNexusConfigLayers(
      {
        profiles: {
          work: {
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "profile-secret",
            temperature: 0.2,
          },
        },
      },
      {
        profiles: {
          work: { id: "gpt-new" },
        },
      },
    )
    expect((sameScope.profiles as Record<string, unknown>).work).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "profile-secret",
      temperature: 0.2,
    })
    expect(sameScope.pendingProjectAuthority).toEqual([
      expect.objectContaining({
        kind: "profiles",
        payload: { profiles: { work: { id: "gpt-new" } } },
      }),
    ])
  })

  it("drops the old credential scope before applying NEXUS_MODEL and NEXUS_BASE_URL", async () => {
    cwd = await mkdtemp(join(tmpdir(), "nexus-config-env-selection-"))
    await mkdir(join(cwd, ".nexus"), { recursive: true })
    await writeFile(join(cwd, ".nexus", "nexus.yaml"), [
      "model:",
      "  provider: openai-compatible",
      "  id: old",
      "  baseUrl: https://api.kilo.ai/api/openrouter",
      "  apiKey: explicit-old-secret",
    ].join("\n"))
    vi.stubEnv("NEXUS_MODEL", "groq/llama")
    vi.stubEnv("NEXUS_BASE_URL", "https://proxy.test/openai/v1")
    vi.stubEnv("NEXUS_TEMPERATURE", "0.4")

    const loaded = await loadConfig(cwd)

    expect(loaded.model.provider).toBe("groq")
    expect(loaded.model.id).toBe("llama")
    expect(loaded.model.baseUrl).toBe("https://proxy.test/openai/v1")
    expect(loaded.model.temperature).toBe(0.4)
    expect(loaded.model.apiKey).toBeUndefined()
  })
})
