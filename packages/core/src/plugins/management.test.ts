import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { executeToolPipeline } from "../agent/tool-pipeline.js"
import { createNexusRunServices } from "../agent/run-services.js"
import { createFakeHost, createFakeSession, createTestConfig } from "../test/fakes.js"
import {
  listPluginsTool,
  pluginConfigureTool,
  pluginEnableTool,
  pluginInstallLocalTool,
  pluginRemoveTool,
  pluginTrustTool,
} from "../tools/built-in/orchestration-tools.js"
import type { ToolContext } from "../types.js"
import {
  getPluginTrustStorePath,
  listPluginTrustGrants,
} from "./trust.js"

const roots: string[] = []
const originalDataHome = process.env["NEXUS_DATA_HOME"]

afterEach(async () => {
  if (originalDataHome === undefined) delete process.env["NEXUS_DATA_HOME"]
  else process.env["NEXUS_DATA_HOME"] = originalDataHome
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; source: string; target: string; context: ToolContext }> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-plugin-install-"))
  roots.push(root)
  const source = path.join(root, "source")
  const target = path.join(root, ".nexus", "plugins", "demo")
  process.env["NEXUS_DATA_HOME"] = path.join(root, "host-data")
  await mkdir(source, { recursive: true })
  const context: ToolContext = {
    cwd: root,
    host: createFakeHost({ cwd: root }),
    session: createFakeSession(root),
    config: createTestConfig(),
    services: createNexusRunServices(),
    mode: "agent",
    signal: new AbortController().signal,
  }
  return { root, source, target, context }
}

describe("local plugin installation", () => {
  it("preserves the installed plugin when an overwrite candidate is invalid", async () => {
    const { source, target, context } = await fixture()
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "demo" }), "utf8")
    await writeFile(path.join(target, "keep.txt"), "stable", "utf8")
    await writeFile(
      path.join(source, "plugin.json"),
      JSON.stringify({ name: "demo", skills: "./missing" }),
      "utf8",
    )

    const result = await pluginInstallLocalTool.execute(
      { source_dir: source, name: "demo", overwrite: true },
      context,
    )

    expect(result.success).toBe(false)
    await expect(readFile(path.join(target, "keep.txt"), "utf8")).resolves.toBe("stable")
  })

  it.each([".", ".."])("rejects the reserved target directory name %s", async (name) => {
    const { root, source, context } = await fixture()
    const configPath = path.join(root, ".nexus", "nexus.yaml")
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, "other: preserved\n", "utf8")
    await writeFile(
      path.join(source, "plugin.json"),
      JSON.stringify({ name: "demo" }),
      "utf8",
    )

    const result = await pluginInstallLocalTool.execute(
      { source_dir: source, name, overwrite: true },
      context,
    )

    expect(result.success).toBe(false)
    expect(result.output).toMatch(/target.*name/i)
    await expect(readFile(configPath, "utf8"))
      .resolves.toBe("other: preserved\n")
  })

  it("rejects symbolic links instead of silently installing an incomplete plugin", async () => {
    const { source, context } = await fixture()
    await writeFile(
      path.join(source, "plugin.json"),
      JSON.stringify({ name: "demo" }),
      "utf8",
    )
    await writeFile(path.join(source, "real.txt"), "runtime-data", "utf8")
    await symlink("real.txt", path.join(source, "linked.txt"))

    const result = await pluginInstallLocalTool.execute(
      { source_dir: source, name: "demo" },
      context,
    )

    expect(result.success).toBe(false)
    expect(result.output).toMatch(/symbolic link/i)
  })

  it("grants trust to the exact installed plugin content without project-config authority", async () => {
    const { target, context } = await fixture()
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "demo" }), "utf8")

    const granted = await pluginTrustTool.execute(
      { name: "demo", trusted: true },
      context,
    )
    const listed = await listPluginsTool.execute({}, context)
    const plugins = (listed.metadata?.plugins ?? []) as Array<{ name: string; trusted?: boolean }>
    const grants = await listPluginTrustGrants()

    expect(granted.success).toBe(true)
    expect(granted.output).toContain("sha256:")
    expect(grants).toEqual([
      expect.objectContaining({
        pluginName: "demo",
        declaredRootPath: target,
        declaredSourcePath: path.join(target, "plugin.json"),
      }),
    ])
    expect(context.config.plugins?.trusted ?? []).not.toContain("demo")
    expect(plugins.find((plugin) => plugin.name === "demo")).toMatchObject({
      name: "demo",
      trusted: true,
    })
  })

  it("revokes the exact authority grant and immediately disables trusted runtime surfaces", async () => {
    const { target, context } = await fixture()
    const manifestPath = path.join(target, "plugin.json")
    await mkdir(target, { recursive: true })
    await writeFile(manifestPath, JSON.stringify({ name: "demo" }), "utf8")
    await pluginTrustTool.execute({ name: "demo", trusted: true }, context)

    const revoked = await pluginTrustTool.execute(
      { name: "demo", trusted: false },
      context,
    )
    const listed = await listPluginsTool.execute({}, context)
    const plugins = (listed.metadata?.plugins ?? []) as Array<{ name: string; trusted?: boolean }>

    expect(revoked).toMatchObject({ success: true })
    expect(revoked.output).toContain("revoked")
    await expect(listPluginTrustGrants()).resolves.toEqual([])
    expect(plugins.find((plugin) => plugin.name === "demo")).toMatchObject({
      name: "demo",
      trusted: false,
    })
  })

  it("revokes changed bytes and requires a new exact grant before the plugin becomes trusted again", async () => {
    const { target, context } = await fixture()
    await mkdir(target, { recursive: true })
    await writeFile(
      path.join(target, "plugin.json"),
      JSON.stringify({ name: "demo" }),
      "utf8",
    )
    await writeFile(path.join(target, "runtime.js"), "export const value = 1\n", "utf8")

    await pluginTrustTool.execute({ name: "demo", trusted: true }, context)
    const [firstGrant] = await listPluginTrustGrants()
    expect(firstGrant?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)

    await writeFile(path.join(target, "runtime.js"), "export const value = 2\n", "utf8")
    const changed = await listPluginsTool.execute({}, context)
    const changedPlugins = (changed.metadata?.plugins ?? []) as Array<{
      name: string
      trusted?: boolean
    }>

    expect(changedPlugins.find((plugin) => plugin.name === "demo")).toMatchObject({
      name: "demo",
      trusted: false,
    })
    await expect(listPluginTrustGrants()).resolves.toEqual([])

    const regranted = await pluginTrustTool.execute(
      { name: "demo", trusted: true },
      context,
    )
    const [secondGrant] = await listPluginTrustGrants()

    expect(regranted.success).toBe(true)
    expect(secondGrant?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(secondGrant?.fingerprint).not.toBe(firstGrant?.fingerprint)
  })

  it("fails closed without throwing when the host authority store is corrupt", async () => {
    const { target, context } = await fixture()
    await mkdir(target, { recursive: true })
    await writeFile(
      path.join(target, "plugin.json"),
      JSON.stringify({ name: "demo" }),
      "utf8",
    )
    const storePath = getPluginTrustStorePath()
    await mkdir(path.dirname(storePath), { recursive: true })
    await writeFile(storePath, "{not-json", { encoding: "utf8", mode: 0o600 })

    await expect(
      pluginTrustTool.execute({ name: "demo", trusted: true }, context),
    ).resolves.toMatchObject({
      success: false,
      output: expect.stringContaining("authority store"),
    })
  })

  it("rejects an unknown plugin instead of creating name-only trust", async () => {
    const { context } = await fixture()

    await expect(
      pluginTrustTool.execute({ name: "missing", trusted: true }, context),
    ).resolves.toMatchObject({
      success: false,
      output: "Plugin not found: missing",
    })
    await expect(listPluginTrustGrants()).resolves.toEqual([])
  })

  it("asks for explicit plugin approval before granting authority", async () => {
    const { target, context } = await fixture()
    await mkdir(target, { recursive: true })
    await writeFile(
      path.join(target, "plugin.json"),
      JSON.stringify({ name: "demo" }),
      "utf8",
    )

    const result = await executeToolPipeline(
      {
        callId: "plugin-trust-approval",
        messageId: "message",
        partId: "part_plugin-trust-approval",
        toolName: "PluginTrust",
        input: { name: "demo", trusted: true },
        origin: "native",
      },
      {
        tools: [pluginTrustTool],
        context,
        autoApproveActions: new Set(["read", "write", "execute"]),
        mode: "agent",
        mcpToolNames: new Set(),
        async hookRunner() {
          return []
        },
      },
    )

    expect(result).toMatchObject({ success: false, denied: true })
    expect(context.host).toMatchObject({
      approvals: [
        expect.objectContaining({
          type: "plugin",
          tool: "PluginTrust",
          description: "Trust exact installed plugin content: demo",
          content: "demo",
        }),
      ],
    })
    await expect(listPluginTrustGrants()).resolves.toEqual([])
  })

  it("does not overwrite a malformed project config while changing plugin state", async () => {
    const { root, context } = await fixture()
    const configPath = path.join(root, ".nexus", "nexus.yaml")
    const malformed = "plugins: [unterminated\n"
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, malformed, "utf8")

    await expect(
      pluginEnableTool.execute({ name: "demo", enabled: false }, context),
    ).rejects.toThrow(/malformed/)
    await expect(readFile(configPath, "utf8")).resolves.toBe(malformed)
  })

  it("serializes concurrent plugin config updates without losing either key", async () => {
    const { root, context } = await fixture()
    const configPath = path.join(root, ".nexus", "nexus.yaml")

    await Promise.all([
      pluginConfigureTool.execute({
        name: "demo",
        key: "channel",
        value: "beta",
      }, context),
      pluginConfigureTool.execute({
        name: "demo",
        key: "retries",
        value: 3,
      }, context),
    ])

    const saved = await readFile(configPath, "utf8")
    expect(saved).toContain("channel: beta")
    expect(saved).toContain("retries: 3")
  })

  it("removes plugin content, config, and exact trust as one successful lifecycle operation", async () => {
    const { root, target, context } = await fixture()
    const manifestPath = path.join(target, "plugin.json")
    const configPath = path.join(root, ".nexus", "nexus.yaml")
    await mkdir(target, { recursive: true })
    await writeFile(manifestPath, JSON.stringify({ name: "demo" }), "utf8")
    await writeFile(
      configPath,
      [
        "plugins:",
        "  blocked: [demo, keep]",
        "  trusted: [demo, keep]",
        "  options:",
        "    demo:",
        "      channel: beta",
        "    keep:",
        "      channel: stable",
        "other: preserved",
        "",
      ].join("\n"),
      "utf8",
    )
    await pluginTrustTool.execute({ name: "demo", trusted: true }, context)

    const result = await pluginRemoveTool.execute({ name: "demo" }, context)

    expect(result.success).toBe(true)
    await expect(access(target)).rejects.toThrow()
    await expect(listPluginTrustGrants()).resolves.toEqual([])
    const saved = await readFile(configPath, "utf8")
    expect(saved).toContain("other: preserved")
    expect(saved).toContain("keep")
    expect(saved).not.toContain("demo")
  })

  it("rolls plugin removal back when the authority store cannot revoke trust", async () => {
    const { root, target, context } = await fixture()
    const manifestPath = path.join(target, "plugin.json")
    const configPath = path.join(root, ".nexus", "nexus.yaml")
    await mkdir(target, { recursive: true })
    await writeFile(manifestPath, JSON.stringify({ name: "demo" }), "utf8")
    await writeFile(configPath, "plugins:\n  blocked: [demo]\n", "utf8")
    await pluginTrustTool.execute({ name: "demo", trusted: true }, context)
    await writeFile(getPluginTrustStorePath(), "{broken-json", "utf8")
    const beforeConfig = await readFile(configPath, "utf8")

    const result = await pluginRemoveTool.execute({ name: "demo" }, context)

    expect(result.success).toBe(false)
    await expect(readFile(manifestPath, "utf8"))
      .resolves.toBe(JSON.stringify({ name: "demo" }))
    await expect(readFile(configPath, "utf8")).resolves.toBe(beforeConfig)
  })

  it("preserves the plugin directory when its project config is malformed", async () => {
    const { root, target, context } = await fixture()
    const manifestPath = path.join(target, "plugin.json")
    const configPath = path.join(root, ".nexus", "nexus.yaml")
    await mkdir(target, { recursive: true })
    await writeFile(manifestPath, JSON.stringify({ name: "demo" }), "utf8")
    await writeFile(configPath, "plugins: [broken\n", "utf8")

    const result = await pluginRemoveTool.execute({ name: "demo" }, context)

    expect(result.success).toBe(false)
    await expect(readFile(manifestPath, "utf8"))
      .resolves.toBe(JSON.stringify({ name: "demo" }))
    await expect(readFile(configPath, "utf8"))
      .resolves.toBe("plugins: [broken\n")
  })
})
