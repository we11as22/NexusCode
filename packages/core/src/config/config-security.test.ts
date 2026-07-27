import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as yaml from "js-yaml"
import {
  ConfigSubstitutionError,
  ConfigValidationError,
  UnsafeConfigWriteError,
  finalizeConfigCredentials,
  getConfigEnvironment,
  getPendingProjectAuthorityRequests,
  getPendingProjectMcpServers,
  loadConfig,
  loadProjectSettings,
  mergeNexusConfigLayers,
  patchGlobalConfig,
  patchProjectConfig,
  writeConfig,
} from "./index.js"
import {
  approveWorkspaceProjectAuthority,
  hydrateWorkspaceAuthority,
} from "../security/workspace-authority.js"
import { NexusConfigSchema } from "./schema.js"

describe("layer-aware config loading", () => {
  let directory: string | undefined
  const originalNexusModel = process.env["NEXUS_MODEL"]
  const originalGroqApiKey = process.env["GROQ_API_KEY"]

  afterEach(async () => {
    if (originalNexusModel === undefined) {
      delete process.env["NEXUS_MODEL"]
    } else {
      process.env["NEXUS_MODEL"] = originalNexusModel
    }
    if (originalGroqApiKey === undefined) {
      delete process.env["GROQ_API_KEY"]
    } else {
      process.env["GROQ_API_KEY"] = originalGroqApiKey
    }
    delete process.env["NEXUS_CONFIG_PROJECT_MODEL"]
    delete process.env["NEXUS_CONFIG_GLOBAL_MODEL"]
    delete process.env["DO_NOT_MATERIALIZE"]
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it("keeps a project .env provider pending until host approval and then resolves its scoped credential", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-scoped-env-"))
    delete process.env["NEXUS_MODEL"]
    delete process.env["GROQ_API_KEY"]
    await writeFile(
      join(directory, ".env"),
      [
        "NEXUS_MODEL=groq/model-from-project-dotenv",
        "GROQ_API_KEY=scoped-project-secret",
      ].join("\n"),
    )

    const loaded = await loadConfig(directory, { globalConfigPath: false })

    expect(loaded.model).toMatchObject({
      provider: "openai-compatible",
      id: "model-from-project-dotenv",
    })
    const providerRequest = getPendingProjectAuthorityRequests(loaded).find(
      (request) => request.kind === "model-endpoint",
    )
    expect(providerRequest).toMatchObject({
      kind: "model-endpoint",
      payload: { model: { provider: "groq" } },
    })
    expect(getConfigEnvironment(loaded)?.["NEXUS_MODEL"]).toBe(
      "groq/model-from-project-dotenv",
    )
    const inactiveRuntime = await finalizeConfigCredentials(
      loaded as unknown as Record<string, unknown>,
      {
        async getSecret() {
          return undefined
        },
        async setSecret() {},
      },
    )
    expect((inactiveRuntime.model as { apiKey?: string }).apiKey).toBeUndefined()

    const storePath = join(directory, "host-data", "authority", "workspaces.json")
    await approveWorkspaceProjectAuthority(
      directory,
      providerRequest!,
      { storePath },
    )
    await hydrateWorkspaceAuthority(loaded, directory, { storePath })
    const approvedRuntime = await finalizeConfigCredentials(
      loaded as unknown as Record<string, unknown>,
      {
        async getSecret() {
          return undefined
        },
        async setSecret() {},
      },
    )
    expect((approvedRuntime.model as { apiKey?: string }).apiKey).toBe(
      "scoped-project-secret",
    )
    expect(process.env["NEXUS_MODEL"]).toBeUndefined()
    expect(process.env["GROQ_API_KEY"]).toBeUndefined()
  })

  it("rejects project {env:...} substitutions even when the variable exists", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-project-env-"))
    await mkdir(join(directory, ".nexus"), { recursive: true })
    await writeFile(
      join(directory, ".nexus", "nexus.yaml"),
      [
        "model:",
        "  provider: openai",
        "  id: \"{env:NEXUS_CONFIG_PROJECT_MODEL}\"",
      ].join("\n"),
    )
    process.env["NEXUS_CONFIG_PROJECT_MODEL"] = "must-not-resolve"

    await expect(
      loadConfig(directory, { globalConfigPath: false }),
    ).rejects.toMatchObject({
      name: "ConfigSubstitutionError",
      code: "project-env-forbidden",
    })
    delete process.env["NEXUS_CONFIG_PROJECT_MODEL"]
  })

  it("keeps global {env:...} support and reports a missing variable", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-global-env-"))
    const globalPath = join(directory, "global.yaml")
    process.env["NEXUS_CONFIG_GLOBAL_MODEL"] = "global-model"
    await writeFile(
      globalPath,
      [
        "model:",
        "  provider: openai",
        "  id: \"{env:NEXUS_CONFIG_GLOBAL_MODEL}\"",
      ].join("\n"),
    )

    const loaded = await loadConfig(directory, {
      globalConfigPath: globalPath,
    })
    expect(loaded.model.id).toBe("global-model")

    delete process.env["NEXUS_CONFIG_GLOBAL_MODEL"]
    await expect(
      loadConfig(directory, { globalConfigPath: globalPath }),
    ).rejects.toMatchObject({
      name: "ConfigSubstitutionError",
      code: "missing-env",
    })
  })

  it("allows project {file:...} only inside the canonical workspace", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-project-file-"))
    await mkdir(join(directory, ".nexus"), { recursive: true })
    await writeFile(join(directory, "model-id.txt"), "safe-model")
    await writeFile(
      join(directory, ".nexus", "nexus.yaml"),
      [
        "model:",
        "  provider: openai",
        "  id: \"{file:../model-id.txt}\"",
      ].join("\n"),
    )

    const loaded = await loadConfig(directory, { globalConfigPath: false })
    expect(loaded.model.id).toBe("safe-model")

    const outside = join(directory, "..", `${basename(directory)}-outside`)
    await writeFile(outside, "outside-model")
    await writeFile(
      join(directory, ".nexus", "nexus.yaml"),
      [
        "model:",
        "  provider: openai",
        `  id: "{file:../../${basename(outside)}}"`,
      ].join("\n"),
    )
    try {
      await expect(
        loadConfig(directory, { globalConfigPath: false }),
      ).rejects.toMatchObject({
        name: "ConfigSubstitutionError",
        code: "project-file-outside-workspace",
      })
    } finally {
      await rm(outside, { force: true })
    }
  })

  it("rejects an in-workspace symlink whose target escapes the workspace", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-project-symlink-"))
    await mkdir(join(directory, ".nexus"), { recursive: true })
    const outside = join(directory, "..", `${basename(directory)}-secret`)
    await writeFile(outside, "outside-model")
    await symlink(outside, join(directory, "linked-model.txt"))
    await writeFile(
      join(directory, ".nexus", "nexus.yaml"),
      [
        "model:",
        "  provider: openai",
        "  id: \"{file:../linked-model.txt}\"",
      ].join("\n"),
    )

    try {
      await expect(
        loadConfig(directory, { globalConfigPath: false }),
      ).rejects.toMatchObject({
        name: "ConfigSubstitutionError",
        code: "project-file-outside-workspace",
      })
    } finally {
      await rm(outside, { force: true })
    }
  })

  it("reports an unreadable or missing substitution instead of replacing it with empty text", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-missing-file-"))
    await mkdir(join(directory, ".nexus"), { recursive: true })
    await writeFile(
      join(directory, ".nexus", "nexus.yaml"),
      [
        "model:",
        "  provider: openai",
        "  id: \"{file:../missing-model.txt}\"",
      ].join("\n"),
    )

    await expect(
      loadConfig(directory, { globalConfigPath: false }),
    ).rejects.toBeInstanceOf(ConfigSubstitutionError)
  })

  it("reports schema-invalid config instead of silently replacing it with defaults", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-invalid-schema-"))
    await mkdir(join(directory, ".nexus"), { recursive: true })
    await writeFile(
      join(directory, ".nexus", "nexus.yaml"),
      [
        "model:",
        "  provider: definitely-not-a-provider",
        "  id: should-not-fall-back",
      ].join("\n"),
    )

    await expect(
      loadConfig(directory, { globalConfigPath: false }),
    ).rejects.toBeInstanceOf(ConfigValidationError)
  })
})

describe("raw-layer config writes", () => {
  let directory: string | undefined

  afterEach(async () => {
    delete process.env["DO_NOT_MATERIALIZE"]
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it("patches only the raw project layer without materializing substitutions or dropping unknown fields", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-raw-patch-"))
    await mkdir(join(directory, ".nexus"), { recursive: true })
    const configPath = join(directory, ".nexus", "nexus.yaml")
    await writeFile(
      configPath,
      [
        "x-nexus-extension:",
        "  nested: keep-me",
        "model:",
        "  provider: openai",
        "  id: \"{env:DO_NOT_MATERIALIZE}\"",
        "mcp:",
        "  servers:",
        "    - name: demo",
        "      command: node",
        "      env:",
        "        TOKEN: \"{file:../token.txt}\"",
      ].join("\n"),
    )
    process.env["DO_NOT_MATERIALIZE"] = "resolved-secret"
    await writeFile(join(directory, "token.txt"), "file-secret")

    await patchProjectConfig(
      { permissions: { autoApproveRead: false } },
      directory,
    )

    const raw = await readFile(configPath, "utf8")
    const parsed = yaml.load(raw) as Record<string, unknown>
    expect(parsed).toMatchObject({
      "x-nexus-extension": { nested: "keep-me" },
      model: {
        provider: "openai",
        id: "{env:DO_NOT_MATERIALIZE}",
      },
      permissions: { autoApproveRead: false },
      mcp: {
        servers: [{
          name: "demo",
          command: "node",
          env: { TOKEN: "{file:../token.txt}" },
        }],
      },
    })
    expect(raw).not.toContain("resolved-secret")
    expect(raw).not.toContain("file-secret")
    delete process.env["DO_NOT_MATERIALIZE"]
  })

  it("serializes concurrent raw-layer patches without losing either update", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-raw-rmw-"))

    await Promise.all([
      patchProjectConfig(
        { permissions: { autoApproveWrite: false } },
        directory,
      ),
      patchProjectConfig(
        { indexing: { enabled: false } },
        directory,
      ),
    ])

    const parsed = yaml.load(
      await readFile(join(directory, ".nexus", "nexus.yaml"), "utf8"),
    )
    expect(parsed).toMatchObject({
      permissions: { autoApproveWrite: false },
      indexing: { enabled: false },
    })
  })

  it("removes explicitly undefined project fields without dropping siblings", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-raw-delete-"))
    await mkdir(join(directory, ".nexus"), { recursive: true })
    const configPath = join(directory, ".nexus", "nexus.yaml")
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openai-compatible",
        "  id: old-model",
        "  baseUrl: https://old-endpoint.test/v1",
        "  temperature: 0.4",
      ].join("\n"),
    )

    await patchProjectConfig(
      { model: { id: "new-model", baseUrl: undefined } },
      directory,
    )

    expect(yaml.load(await readFile(configPath, "utf8"))).toEqual({
      model: {
        provider: "openai-compatible",
        id: "new-model",
        temperature: 0.4,
      },
    })
  })

  it("does not overwrite a malformed raw project layer", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-raw-corrupt-"))
    await mkdir(join(directory, ".nexus"), { recursive: true })
    const configPath = join(directory, ".nexus", "nexus.yaml")
    const original = "model: [unterminated"
    await writeFile(configPath, original)

    await expect(
      patchProjectConfig({ indexing: { enabled: false } }, directory),
    ).rejects.toMatchObject({ name: "ConfigFileError" })
    await expect(readFile(configPath, "utf8")).resolves.toBe(original)
  })

  it("refuses loaded effective configs even after spread or structuredClone", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-effective-write-"))
    const loaded = await loadConfig(directory, { globalConfigPath: false })

    expect(() => writeConfig(loaded, directory)).toThrow(
      UnsafeConfigWriteError,
    )
    expect(() => writeConfig({ ...loaded }, directory)).toThrow(
      UnsafeConfigWriteError,
    )
    expect(() => writeConfig(structuredClone(loaded), directory)).toThrow(
      UnsafeConfigWriteError,
    )
    const strippedLikeLegacyUi = {
      ...loaded,
    } as unknown as Record<string, unknown>
    delete strippedLikeLegacyUi["skillsConfig"]
    expect(() => writeConfig(
      strippedLikeLegacyUi as unknown as typeof loaded,
      directory,
    )).toThrow(UnsafeConfigWriteError)
  })
})

describe("host-owned global config patches", () => {
  let directory: string | undefined

  afterEach(async () => {
    delete process.env["DO_NOT_MATERIALIZE_GLOBAL"]
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it("atomically patches trusted authority/MCP without materializing raw substitutions or secrets", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-global-patch-"))
    const configPath = join(directory, "global.yaml")
    await writeFile(
      configPath,
      [
        "x-host-extension:",
        "  token: \"{env:DO_NOT_MATERIALIZE_GLOBAL}\"",
        "model:",
        "  provider: openai",
        "  id: gpt",
      ].join("\n"),
    )
    process.env["DO_NOT_MATERIALIZE_GLOBAL"] = "ambient-secret"

    await patchGlobalConfig({
      permissions: {
        autoApproveWrite: true,
        allowedCommands: ["trusted-command"],
        allowedMcpTools: ["trusted-mcp-tool"],
      },
      plugins: {
        trusted: ["trusted-plugin"],
      },
      mcp: {
        servers: [{
          name: "trusted-global-server",
          command: "node",
          args: ["server.js"],
        }],
      },
      profiles: {
        work: {
          provider: "openai",
          id: "gpt",
          apiKey: "must-not-be-written",
        },
      },
    }, { configPath })

    const raw = await readFile(configPath, "utf8")
    const parsed = yaml.load(raw) as Record<string, unknown>
    expect(parsed).toMatchObject({
      "x-host-extension": {
        token: "{env:DO_NOT_MATERIALIZE_GLOBAL}",
      },
      permissions: {
        autoApproveWrite: true,
        allowedCommands: ["trusted-command"],
        allowedMcpTools: ["trusted-mcp-tool"],
      },
      plugins: { trusted: ["trusted-plugin"] },
      mcp: {
        servers: [{
          name: "trusted-global-server",
          command: "node",
          args: ["server.js"],
        }],
      },
      profiles: {
        work: {
          provider: "openai",
          id: "gpt",
        },
      },
    })
    expect(raw).not.toContain("ambient-secret")
    expect(raw).not.toContain("must-not-be-written")

    const loaded = await loadConfig(directory, { globalConfigPath: configPath })
    expect(loaded.permissions.autoApproveWrite).toBe(true)
    expect(loaded.permissions.allowedCommands).toEqual(["trusted-command"])
    expect(loaded.plugins?.trusted).toEqual(["trusted-plugin"])
    expect(loaded.mcp.servers.map((server) => server.name)).toEqual([
      "trusted-global-server",
    ])
    delete process.env["DO_NOT_MATERIALIZE_GLOBAL"]
  })

  it("serializes concurrent global patches and quarantines malformed raw bytes", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-global-rmw-"))
    const configPath = join(directory, "global.yaml")

    await Promise.all([
      patchGlobalConfig(
        { permissions: { autoApproveRead: false } },
        { configPath },
      ),
      patchGlobalConfig(
        { plugins: { trusted: ["trusted-plugin"] } },
        { configPath },
      ),
    ])
    expect(yaml.load(await readFile(configPath, "utf8"))).toMatchObject({
      permissions: { autoApproveRead: false },
      plugins: { trusted: ["trusted-plugin"] },
    })

    const original = "permissions: [unterminated"
    await writeFile(configPath, original)
    await expect(
      patchGlobalConfig(
        { permissions: { autoApproveWrite: true } },
        { configPath },
      ),
    ).rejects.toMatchObject({ name: "ConfigFileError" })
    await expect(readFile(configPath, "utf8")).resolves.toBe(original)
  })

  it("removes explicitly undefined host fields without persisting credentials", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-global-delete-"))
    const configPath = join(directory, "global.yaml")
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openai-compatible",
        "  id: old-model",
        "  baseUrl: https://old-endpoint.test/v1",
        "  temperature: 0.4",
      ].join("\n"),
    )

    await patchGlobalConfig(
      {
        model: {
          id: "new-model",
          baseUrl: undefined,
          apiKey: "must-not-be-written",
        },
      },
      { configPath },
    )

    const raw = await readFile(configPath, "utf8")
    expect(yaml.load(raw)).toEqual({
      model: {
        provider: "openai-compatible",
        id: "new-model",
        temperature: 0.4,
      },
    })
    expect(raw).not.toContain("must-not-be-written")
  })

  it("rejects a resolved effective config as a global patch", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-global-effective-"))
    const configPath = join(directory, "global.yaml")
    const loaded = await loadConfig(directory, { globalConfigPath: false })

    await expect(
      patchGlobalConfig(
        loaded as unknown as Record<string, unknown>,
        { configPath },
      ),
    ).rejects.toBeInstanceOf(UnsafeConfigWriteError)
  })
})

describe("project authority boundaries", () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it("does not let the project layer grant tool or plugin authority", () => {
    const merged = mergeNexusConfigLayers(
      {
        permissions: {
          autoApproveRead: true,
          autoApproveWrite: false,
          allowedCommands: ["global-command"],
          allowCommandPatterns: ["global:*"],
          allowedMcpTools: ["global-mcp"],
          denyCommandPatterns: ["global-deny"],
          askCommandPatterns: ["global-ask"],
          rules: [{
            tool: "Bash",
            action: "allow",
            reason: "trusted global rule",
          }],
        },
        modes: {
          agent: { autoApprove: ["read"] },
        },
        plugins: {
          enabled: false,
          trusted: ["global-plugin"],
          blocked: ["global-blocked"],
          enableHooks: false,
        },
      },
      {
        permissions: {
          autoApproveRead: false,
          autoApproveWrite: true,
          autoApproveCommand: true,
          autoApproveMcp: true,
          autoApproveBrowser: true,
          autoApproveSkillLoad: true,
          autoApproveReadPatterns: ["**/*"],
          allowedCommands: ["project-command"],
          allowCommandPatterns: ["project:*"],
          allowedMcpTools: ["project-mcp"],
          denyCommandPatterns: ["project-deny"],
          askCommandPatterns: ["project-ask"],
          rules: [
            { tool: "Write", action: "allow", reason: "project grant" },
            {
              authority: "host",
              tool: "Bash",
              action: "deny",
              reason: "project restriction",
            },
          ],
        },
        modes: {
          agent: {
            autoApprove: ["write", "execute", "mcp"],
            customInstructions: "safe project data",
          },
        },
        plugins: {
          enabled: true,
          trusted: ["project-plugin"],
          blocked: ["project-blocked"],
          enableHooks: true,
        },
      },
    )

    expect(merged.permissions).toMatchObject({
      autoApproveRead: false,
      autoApproveWrite: false,
      allowedCommands: ["global-command"],
      allowCommandPatterns: ["global:*"],
      allowedMcpTools: ["global-mcp"],
      denyCommandPatterns: ["global-deny", "project-deny"],
      askCommandPatterns: ["global-ask", "project-ask"],
      rules: [
        {
          authority: "project",
          tool: "Bash",
          action: "deny",
          reason: "project restriction",
        },
        {
          authority: "host",
          tool: "Bash",
          action: "allow",
          reason: "trusted global rule",
        },
      ],
    })
    expect((merged.permissions as Record<string, unknown>)).not.toHaveProperty(
      "autoApproveCommand",
    )
    expect(merged.modes).toEqual({
      agent: {
        autoApprove: ["read"],
        customInstructions: "safe project data",
      },
    })
    expect(merged.plugins).toEqual({
      enabled: false,
      trusted: ["global-plugin"],
      blocked: ["global-blocked", "project-blocked"],
      enableHooks: false,
    })
  })

  it("keeps implicit vector autostart off and accepts an explicit project restriction", () => {
    const projectOnly = NexusConfigSchema.parse(
      mergeNexusConfigLayers(
        {},
        { vectorDb: { enabled: true } },
      ),
    )
    expect(projectOnly.vectorDb).toMatchObject({
      enabled: true,
      autoStart: false,
    })

    const restricted = NexusConfigSchema.parse(
      mergeNexusConfigLayers(
        {
          vectorDb: {
            enabled: true,
            url: "http://127.0.0.1:6333",
            autoStart: true,
          },
        },
        { vectorDb: { autoStart: false } },
      ),
    )
    expect(restricted.vectorDb?.autoStart).toBe(false)
    expect(
      restricted.pendingProjectAuthority?.some(
        (request) => request.kind === "vector-db-endpoint",
      ),
    ).not.toBe(true)
  })

  it("normalizes project OpenRouter aliases into exact pending endpoint requests", () => {
    const merged = NexusConfigSchema.parse(
      mergeNexusConfigLayers(
        {},
        {
          model: {
            provider: "openrouter",
            id: "openrouter/model",
          },
          profiles: {
            review: {
              provider: "openrouter",
              id: "openrouter/reviewer",
            },
          },
        },
      ),
    )

    expect(merged.model).toMatchObject({
      provider: "openai-compatible",
      id: "openrouter/model",
      baseUrl: "https://api.kilo.ai/api/openrouter",
    })
    expect(merged.pendingProjectAuthority).toEqual([
      expect.objectContaining({
        kind: "model-endpoint",
        payload: {
          model: {
            provider: "openai-compatible",
            baseUrl: "https://openrouter.ai/api/v1",
          },
        },
      }),
      expect.objectContaining({
        kind: "profiles",
        payload: {
          profiles: {
            review: {
              provider: "openai-compatible",
              id: "openrouter/reviewer",
              baseUrl: "https://openrouter.ai/api/v1",
            },
          },
        },
      }),
    ])
  })

  it("keeps project-enabled global Claude compatibility inactive until exact approval", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-claude-global-"))
    const storePath = join(
      directory,
      "host-data",
      "authority",
      "workspaces.json",
    )
    await mkdir(join(directory, ".nexus"), { recursive: true })
    await writeFile(
      join(directory, ".nexus", "nexus.yaml"),
      [
        "compatibility:",
        "  claude:",
        "    enabled: true",
      ].join("\n"),
    )

    const inactive = await loadConfig(directory, {
      globalConfigPath: false,
    })
    expect(inactive.compatibility?.claude).toMatchObject({
      enabled: true,
      includeGlobalDir: false,
    })
    const request = getPendingProjectAuthorityRequests(inactive).find(
      (entry) => entry.kind === "claude-global-directory",
    )
    expect(request).toBeDefined()

    await approveWorkspaceProjectAuthority(
      directory,
      request!,
      { storePath },
    )
    const approved = await loadConfig(directory, {
      globalConfigPath: false,
    })
    await hydrateWorkspaceAuthority(approved, directory, { storePath })
    expect(approved.compatibility?.claude?.includeGlobalDir).toBe(true)

    const globallyEnabled = NexusConfigSchema.parse(
      mergeNexusConfigLayers(
        {
          compatibility: {
            claude: { enabled: true },
          },
        },
        {
          compatibility: {
            claude: { enabled: true },
          },
        },
      ),
    )
    expect(globallyEnabled.compatibility.claude.includeGlobalDir).toBe(true)
    expect(
      globallyEnabled.pendingProjectAuthority?.some(
        (entry) => entry.kind === "claude-global-directory",
      ),
    ).not.toBe(true)
  })

  it("keeps project endpoints, external paths, and executable integrations inactive", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-project-endpoints-"))
    const globalPath = join(directory, "global.yaml")
    const storePath = join(directory, "host-data", "authority", "workspaces.json")
    await writeFile(
      globalPath,
      [
        "model:",
        "  provider: openai-compatible",
        "  id: trusted-model",
        "  baseUrl: https://trusted-model.test/v1",
        "embeddings:",
        "  provider: openai-compatible",
        "  model: trusted-embeddings",
        "  baseUrl: https://trusted-embeddings.test/v1",
        "vectorDb:",
        "  enabled: false",
        "  url: http://127.0.0.1:6333",
        "  autoStart: false",
        "profiles:",
        "  trusted:",
        "    provider: openai",
        "    id: trusted-profile",
        "skillsUrls:",
        "  - https://trusted-skills.test",
        "tools:",
        "  custom:",
        "    - /trusted/tools",
      ].join("\n"),
    )
    await mkdir(join(directory, ".nexus"), { recursive: true })
    await writeFile(
      join(directory, ".nexus", "nexus.yaml"),
      [
        "model:",
        "  provider: openai-compatible",
        "  id: project-model",
        "  baseUrl: https://project-model.test/v1",
        "  temperature: 0.25",
        "embeddings:",
        "  provider: openai-compatible",
        "  model: project-embeddings",
        "  baseUrl: https://project-embeddings.test/v1",
        "  dimensions: 768",
        "vectorDb:",
        "  enabled: true",
        "  url: https://project-vector.test",
        "  autoStart: true",
        "skills:",
        "  - .nexus/skills/safe",
        "  - ../outside-skill",
        "skillsUrls:",
        "  - https://project-skills.test",
        "rules:",
        "  files:",
        "    - AGENTS.md",
        "    - ../outside-rules.md",
        "memory:",
        "  autoMemoryDirectory: ../outside-memory",
        "tools:",
        "  custom:",
        "    - ../outside-tools",
        "profiles:",
        "  trusted:",
        "    id: shadowed-profile",
        "  project:",
        "    provider: openai-compatible",
        "    id: project-profile",
        "    baseUrl: https://project-profile.test/v1",
      ].join("\n"),
    )

    const inactive = await loadConfig(directory, {
      globalConfigPath: globalPath,
    })

    expect(inactive.model).toMatchObject({
      provider: "openai-compatible",
      id: "project-model",
      baseUrl: "https://trusted-model.test/v1",
      temperature: 0.25,
    })
    expect(inactive.embeddings).toMatchObject({
      provider: "openai-compatible",
      model: "trusted-embeddings",
      baseUrl: "https://trusted-embeddings.test/v1",
    })
    expect(inactive.vectorDb).toMatchObject({
      enabled: true,
      url: "http://127.0.0.1:6333",
      autoStart: false,
    })
    expect(inactive.skillsUrls).toEqual(["https://trusted-skills.test"])
    expect(inactive.tools.custom).toEqual(["/trusted/tools"])
    expect(inactive.profiles).toEqual({
      trusted: expect.objectContaining({
        provider: "openai",
        id: "trusted-profile",
      }),
    })
    expect(inactive.skills).toEqual([".nexus/skills/safe"])
    expect(inactive.rules.files).toEqual(["AGENTS.md"])
    expect(inactive.memory?.autoMemoryDirectory).toBeUndefined()

    const pending = getPendingProjectAuthorityRequests(inactive)
    expect(pending.map((request) => request.kind).sort()).toEqual([
      "custom-tools",
      "embeddings-endpoint",
      "external-memory-path",
      "external-rule-paths",
      "external-skill-paths",
      "model-endpoint",
      "profiles",
      "remote-skills",
      "vector-db-endpoint",
    ])
    expect(new Set(pending.map((request) => request.fingerprint)).size).toBe(
      pending.length,
    )

    for (const request of pending) {
      await approveWorkspaceProjectAuthority(
        directory,
        request,
        { storePath },
      )
    }
    const approved = await loadConfig(directory, {
      globalConfigPath: globalPath,
    })
    await hydrateWorkspaceAuthority(approved, directory, { storePath })

    expect(getPendingProjectAuthorityRequests(approved)).toEqual([])
    expect(approved.model.baseUrl).toBe("https://project-model.test/v1")
    expect(approved.embeddings).toMatchObject({
      provider: "openai-compatible",
      model: "project-embeddings",
      baseUrl: "https://project-embeddings.test/v1",
      dimensions: 768,
    })
    expect(approved.vectorDb).toMatchObject({
      enabled: true,
      url: "https://project-vector.test",
      autoStart: true,
    })
    expect(approved.skillsUrls).toEqual(["https://project-skills.test"])
    expect(approved.tools.custom).toEqual(["../outside-tools"])
    expect(approved.skills).toEqual([
      ".nexus/skills/safe",
      "../outside-skill",
    ])
    expect(approved.rules.files).toEqual([
      "AGENTS.md",
      "../outside-rules.md",
    ])
    expect(approved.memory?.autoMemoryDirectory).toBe("../outside-memory")
    expect(approved.profiles).toMatchObject({
      trusted: {
        provider: "openai",
        id: "shadowed-profile",
      },
      project: {
        provider: "openai-compatible",
        id: "project-profile",
        baseUrl: "https://project-profile.test/v1",
      },
    })
  })

  it("revokes an endpoint overlay when the requested content changes", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-endpoint-change-"))
    const globalPath = join(directory, "global.yaml")
    const storePath = join(directory, "host-data", "authority", "workspaces.json")
    await writeFile(
      globalPath,
      [
        "model:",
        "  provider: openai-compatible",
        "  id: trusted-model",
        "  baseUrl: https://trusted.test/v1",
      ].join("\n"),
    )
    await mkdir(join(directory, ".nexus"), { recursive: true })
    const projectPath = join(directory, ".nexus", "nexus.yaml")
    await writeFile(
      projectPath,
      [
        "model:",
        "  provider: openai-compatible",
        "  id: project-model",
        "  baseUrl: https://first-project.test/v1",
      ].join("\n"),
    )
    const first = await loadConfig(directory, { globalConfigPath: globalPath })
    const firstRequest = getPendingProjectAuthorityRequests(first).find(
      (request) => request.kind === "model-endpoint",
    )
    expect(firstRequest).toBeDefined()
    await approveWorkspaceProjectAuthority(
      directory,
      firstRequest!,
      { storePath },
    )

    const active = await loadConfig(directory, { globalConfigPath: globalPath })
    await hydrateWorkspaceAuthority(active, directory, { storePath })
    expect(active.model.baseUrl).toBe("https://first-project.test/v1")

    await writeFile(
      projectPath,
      [
        "model:",
        "  provider: openai-compatible",
        "  id: project-model",
        "  baseUrl: https://changed-project.test/v1",
      ].join("\n"),
    )
    const changed = await loadConfig(directory, { globalConfigPath: globalPath })
    await hydrateWorkspaceAuthority(changed, directory, { storePath })

    expect(changed.model.baseUrl).toBe("https://trusted.test/v1")
    expect(getPendingProjectAuthorityRequests(changed)).toEqual([
      expect.objectContaining({
        kind: "model-endpoint",
        fingerprint: expect.not.stringMatching(firstRequest!.fingerprint),
      }),
    ])
  })

  it("rejects non-HTTP project authority destinations before they can be approved", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-endpoint-scheme-"))
    await mkdir(join(directory, ".nexus"), { recursive: true })
    await writeFile(
      join(directory, ".nexus", "nexus.yaml"),
      [
        "model:",
        "  provider: openai-compatible",
        "  id: project-model",
        "  baseUrl: file:///tmp/fake-provider",
      ].join("\n"),
    )

    await expect(
      loadConfig(directory, { globalConfigPath: false }),
    ).rejects.toBeInstanceOf(ConfigValidationError)
  })

  it("keeps project MCP definitions pending instead of auto-starting them", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-project-mcp-"))
    const globalPath = join(directory, "global.yaml")
    await writeFile(
      globalPath,
      [
        "mcp:",
        "  servers:",
        "    - name: trusted-global",
        "      command: node",
      ].join("\n"),
    )
    await mkdir(join(directory, ".nexus"), { recursive: true })
    await writeFile(
      join(directory, ".nexus", "nexus.yaml"),
      [
        "mcp:",
        "  servers:",
        "    - name: pending-project",
        "      command: sh",
        "      args: ['-c', 'do-not-run']",
      ].join("\n"),
    )
    await writeFile(
      join(directory, ".nexus", "mcp-servers.json"),
      JSON.stringify({
        servers: [{
          name: "pending-project-json",
          command: "node",
          args: ["project-server.js"],
        }],
      }),
    )

    const loaded = await loadConfig(directory, {
      globalConfigPath: globalPath,
    })

    expect(loaded.mcp.servers.map((server) => server.name)).toEqual([
      "trusted-global",
    ])
    expect(getPendingProjectMcpServers(loaded)).toEqual([
      {
        source: "project",
        origin: "project-config",
        status: "pending",
        config: {
          name: "pending-project",
          command: "sh",
          args: ["-c", "do-not-run"],
          enabled: true,
        },
      },
      {
        source: "project",
        origin: "project-mcp-json",
        status: "pending",
        config: {
          name: "pending-project-json",
          command: "node",
          args: ["project-server.js"],
          enabled: true,
        },
      },
    ])
  })

  it("clears an exact pending MCP request after host promotion but resurfaces changed bytes", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-mcp-promotion-"))
    await mkdir(join(directory, ".nexus"), { recursive: true })
    const globalPath = join(directory, "global.yaml")
    const projectPath = join(directory, ".nexus", "nexus.yaml")
    await writeFile(
      globalPath,
      [
        "mcp:",
        "  servers:",
        "    - name: promoted",
        "      command: node",
        "      args: [server.js]",
      ].join("\n"),
    )
    await writeFile(
      projectPath,
      [
        "mcp:",
        "  servers:",
        "    - name: promoted",
        "      command: node",
        "      args: [server.js]",
      ].join("\n"),
    )

    const promoted = await loadConfig(directory, {
      globalConfigPath: globalPath,
    })
    expect(getPendingProjectMcpServers(promoted)).toEqual([])

    await writeFile(
      projectPath,
      [
        "mcp:",
        "  servers:",
        "    - name: promoted",
        "      command: node",
        "      args: [changed.js]",
      ].join("\n"),
    )
    const changed = await loadConfig(directory, {
      globalConfigPath: globalPath,
    })
    expect(getPendingProjectMcpServers(changed)).toEqual([
      expect.objectContaining({
        config: expect.objectContaining({
          name: "promoted",
          args: ["changed.js"],
        }),
      }),
    ])
  })

  it("does not turn project settings allowlists into effective grants", async () => {
    directory = await mkdtemp(join(tmpdir(), "nexus-config-settings-auth-"))
    await mkdir(join(directory, ".nexus"), { recursive: true })
    await writeFile(
      join(directory, ".nexus", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["project-only-allow"],
          allowedMcpTools: ["project-only-mcp"],
          deny: ["project-only-deny"],
          ask: ["project-only-ask"],
        },
      }),
    )

    const settings = loadProjectSettings(directory)

    expect(settings.permissions?.allow).not.toContain("project-only-allow")
    expect(settings.permissions?.allowedMcpTools).not.toContain(
      "project-only-mcp",
    )
    expect(settings.permissions?.deny).toContain("project-only-deny")
    expect(settings.permissions?.ask).toContain("project-only-ask")
  })
})
