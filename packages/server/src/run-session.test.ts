import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  NexusConfigSchema,
  grantWorkspaceAuthority,
  type NexusConfig,
} from "@nexuscode/core"

import {
  applyProfileForRun,
  applyPresetForRun,
  assertSupportedRemoteConfigOverride,
  loadServerWorkspaceConfig,
  resolveServerNexusRoot,
  settleRuntimeDependency,
} from "./run-session.js"

describe("server runtime dependency loading", () => {
  it("resolves bundled integration assets from the repository root", () => {
    expect(
      resolveServerNexusRoot("/workspace/NexusCode/packages/server/src"),
    ).toBe("/workspace/NexusCode")
    expect(
      resolveServerNexusRoot("/workspace/NexusCode/packages/server/dist"),
    ).toBe("/workspace/NexusCode")
  })

  it("hydrates only server-owned exact workspace grants", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-server-authority-"))
    const workspace = join(root, "workspace")
    const storePath = join(root, "host", "authority.json")
    try {
      await mkdir(workspace, { recursive: true })
      await grantWorkspaceAuthority(
        workspace,
        { kind: "command", value: "pnpm test" },
        { storePath },
      )

      const config = await loadServerWorkspaceConfig(workspace, {
        loadEnv: false,
        globalConfigPath: false,
        authorityStoreOptions: { storePath },
      })

      expect(config.permissions.allowedCommands).toEqual(["pnpm test"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("returns successful values without leaving the timeout active", async () => {
    vi.useFakeTimers()
    const diagnostic = vi.fn()

    await expect(
      settleRuntimeDependency("rules", Promise.resolve("loaded"), 2_000, "", diagnostic),
    ).resolves.toBe("loaded")

    await vi.advanceTimersByTimeAsync(2_000)
    expect(diagnostic).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("falls back and reports a timeout without blocking server startup", async () => {
    vi.useFakeTimers()
    const diagnostic = vi.fn()
    const never = new Promise<string>(() => undefined)
    const result = settleRuntimeDependency("rules", never, 2_000, "", diagnostic)

    await vi.advanceTimersByTimeAsync(2_000)

    await expect(result).resolves.toBe("")
    expect(diagnostic).toHaveBeenCalledWith(
      "[rules runtime] loading timed out after 2000ms; continuing without it",
    )
    vi.useRealTimers()
  })

  it("falls back and reports loader failures", async () => {
    const diagnostic = vi.fn()

    await expect(
      settleRuntimeDependency(
        "skills",
        Promise.reject(new Error("broken manifest")),
        2_000,
        [],
        diagnostic,
      ),
    ).resolves.toEqual([])
    expect(diagnostic).toHaveBeenCalledWith(
      "[skills runtime] broken manifest; continuing without it",
    )
  })
})

describe("server remote override boundary", () => {
  it("accepts only the protocol-v1 preset selector", () => {
    expect(() => assertSupportedRemoteConfigOverride({
      presetName: "review",
    })).not.toThrow()
    expect(() => assertSupportedRemoteConfigOverride({
      model: "openai/gpt-4.1",
      temperature: 0.2,
    })).toThrow(/Remote protocol v2.*model, temperature/)
  })
})

describe("server preset model selection", () => {
  it("freezes an explicit protocol-v2 profile into the turn config", () => {
    const base = NexusConfigSchema.parse({
      model: { provider: "anthropic", id: "claude-default" },
      profiles: {
        primary: {
          provider: "openai",
          id: "gpt-profile",
          temperature: 0.1,
        },
      },
    }) as NexusConfig

    expect(applyProfileForRun(base, "primary")).toMatchObject({
      model: {
        provider: "openai",
        id: "gpt-profile",
        temperature: 0.1,
      },
    })
    expect(() => applyProfileForRun(base, "missing")).toThrow(
      /unknown model profile/i,
    )
  })

  it("binds OpenRouter provider and endpoint atomically", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-server-preset-"))
    try {
      await mkdir(join(cwd, ".nexus"), { recursive: true })
      await writeFile(join(cwd, ".nexus", "agent-configs.json"), JSON.stringify([
        {
          name: "router",
          vector: false,
          skills: [],
          mcpServers: [],
          rulesFiles: [],
          modelProvider: "openrouter",
          modelId: "openai/gpt-4.1",
        },
      ]))
      const base = NexusConfigSchema.parse({
        model: { provider: "anthropic", id: "claude" },
      }) as NexusConfig

      await expect(applyPresetForRun(base, cwd, "router")).resolves.toMatchObject({
        model: {
          provider: "openai-compatible",
          id: "openai/gpt-4.1",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("rejects a generic compatible preset without an explicit endpoint", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-server-preset-"))
    try {
      await mkdir(join(cwd, ".nexus"), { recursive: true })
      await writeFile(join(cwd, ".nexus", "agent-configs.json"), JSON.stringify([
        {
          name: "incomplete",
          vector: false,
          skills: [],
          mcpServers: [],
          rulesFiles: [],
          modelProvider: "openai-compatible",
          modelId: "custom/model",
        },
      ]))
      const base = NexusConfigSchema.parse({
        model: { provider: "anthropic", id: "claude" },
      }) as NexusConfig

      await expect(applyPresetForRun(base, cwd, "incomplete")).rejects.toThrow(
        /requires an explicit baseUrl/,
      )
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
