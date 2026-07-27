import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { NexusConfigSchema } from "../config/schema.js"
import type { NexusConfig, PluginManifestRecord } from "../types.js"
import { validatePluginManifestFile } from "./index.js"
import { loadPluginRuntimeRecords } from "./runtime.js"
import {
  PluginTrustStoreCorruptionError,
  evaluatePluginTrust,
  getPluginTrustStorePath,
  grantPluginTrust,
  listPluginTrustGrants,
  revokePluginTrust,
} from "./trust.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(name = "demo"): Promise<{
  workspace: string
  plugin: PluginManifestRecord
  pluginRoot: string
  storePath: string
}> {
  const workspace = await mkdtemp(path.join(tmpdir(), "nexus-plugin-trust-"))
  roots.push(workspace)
  const pluginRoot = path.join(workspace, ".nexus", "plugins", name)
  const manifestPath = path.join(pluginRoot, "plugin.json")
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(
    manifestPath,
    `${JSON.stringify({ name, hooks: ["after_tool:hook.sh"] })}\n`,
    "utf8",
  )
  await writeFile(path.join(pluginRoot, "hook.sh"), "#!/bin/sh\nexit 0\n", "utf8")
  const validated = await validatePluginManifestFile(manifestPath)
  expect(validated.success).toBe(true)
  return {
    workspace,
    plugin: validated.plugin!,
    pluginRoot,
    storePath: path.join(workspace, "host-authority", "plugin-trust.json"),
  }
}

function config(trusted: string[] = []): NexusConfig {
  return NexusConfigSchema.parse({ plugins: { trusted } }) as NexusConfig
}

describe("content-bound plugin trust", () => {
  it("does not let a same-name plugin inherit another root's grant", async () => {
    const first = await fixture("demo")
    const secondRoot = await mkdtemp(path.join(tmpdir(), "nexus-plugin-shadow-"))
    roots.push(secondRoot)
    const secondPluginRoot = path.join(secondRoot, ".nexus", "plugins", "demo")
    await mkdir(secondPluginRoot, { recursive: true })
    await writeFile(
      path.join(secondPluginRoot, "plugin.json"),
      `${JSON.stringify({ name: "demo" })}\n`,
      "utf8",
    )
    const second = await validatePluginManifestFile(path.join(secondPluginRoot, "plugin.json"))
    expect(second.success).toBe(true)

    await grantPluginTrust(first.plugin, { storePath: first.storePath })

    await expect(
      evaluatePluginTrust(second.plugin!, { storePath: first.storePath }),
    ).resolves.toMatchObject({
      trusted: false,
      reason: "not-granted",
    })
  })

  it("revokes a stale grant when the manifest name changes during grant resolution", async () => {
    const { plugin, pluginRoot, storePath } = await fixture("demo")
    await writeFile(
      plugin.sourcePath,
      `${JSON.stringify({ name: "replacement", hooks: ["after_tool:hook.sh"] })}\n`,
      "utf8",
    )

    // Simulate a manifest changing after the tool validated it but before the
    // trust store fingerprinted the tree.
    await grantPluginTrust(plugin, { storePath })
    const current = await validatePluginManifestFile(plugin.sourcePath)
    expect(current).toMatchObject({
      success: true,
      plugin: {
        name: "replacement",
        rootDir: pluginRoot,
      },
    })

    await expect(
      evaluatePluginTrust(current.plugin!, { storePath }),
    ).resolves.toMatchObject({
      trusted: false,
      reason: "identity-changed",
      revoked: true,
    })
    await expect(listPluginTrustGrants({ storePath })).resolves.toEqual([])
  })

  it("revokes a grant when plugin bytes change", async () => {
    const { plugin, pluginRoot, storePath } = await fixture()
    await grantPluginTrust(plugin, { storePath })
    await writeFile(path.join(pluginRoot, "hook.sh"), "#!/bin/sh\nexit 42\n", "utf8")

    await expect(evaluatePluginTrust(plugin, { storePath })).resolves.toMatchObject({
      trusted: false,
      reason: "content-changed",
      revoked: true,
    })
    await expect(listPluginTrustGrants({ storePath })).resolves.toEqual([])
  })

  it("revokes a grant when a symlink is introduced into the plugin tree", async () => {
    const { workspace, plugin, pluginRoot, storePath } = await fixture()
    await grantPluginTrust(plugin, { storePath })
    const outside = path.join(workspace, "outside.txt")
    await writeFile(outside, "outside", "utf8")
    await symlink(outside, path.join(pluginRoot, "late-link"))

    await expect(evaluatePluginTrust(plugin, { storePath })).resolves.toMatchObject({
      trusted: false,
      reason: "unsafe-plugin",
      revoked: true,
    })
    await expect(listPluginTrustGrants({ storePath })).resolves.toEqual([])
  })

  it("serializes concurrent grants and revocations without losing updates", async () => {
    const first = await fixture("first")
    const second = await fixture("second")
    const third = await fixture("third")
    const options = { storePath: first.storePath }
    await grantPluginTrust(first.plugin, options)

    await Promise.all([
      revokePluginTrust(first.plugin, options),
      grantPluginTrust(second.plugin, options),
      grantPluginTrust(third.plugin, options),
    ])

    const grants = await listPluginTrustGrants(options)
    expect(grants.map((grant) => grant.pluginName).sort()).toEqual(["second", "third"])
  })

  it("fails closed on a corrupt authority store", async () => {
    const { plugin, storePath } = await fixture()
    await mkdir(path.dirname(storePath), { recursive: true })
    await writeFile(storePath, "{not-json", { encoding: "utf8", mode: 0o600 })

    await expect(evaluatePluginTrust(plugin, { storePath })).resolves.toMatchObject({
      trusted: false,
      reason: "store-corrupt",
    })
    await expect(grantPluginTrust(plugin, { storePath })).rejects.toBeInstanceOf(
      PluginTrustStoreCorruptionError,
    )
  })

  it("keeps an unchanged exact plugin trusted and ignores name-only config authority", async () => {
    const { workspace, plugin, storePath } = await fixture()
    const nameOnly = await loadPluginRuntimeRecords(
      workspace,
      config(["demo"]),
      { storePath },
    )
    expect(nameOnly).toMatchObject([{ name: "demo", trusted: false }])

    const grant = await grantPluginTrust(plugin, { storePath })
    const evaluation = await evaluatePluginTrust(plugin, { storePath })
    expect(evaluation).toMatchObject({
      trusted: true,
      reason: "trusted",
      fingerprint: grant.fingerprint,
    })
    const records = await loadPluginRuntimeRecords(workspace, config(["demo"]), {
      storePath,
    })
    expect(records).toMatchObject([{ name: "demo", trusted: true }])

    const storeStats = await stat(getPluginTrustStorePath({ storePath }))
    const directoryStats = await stat(path.dirname(storePath))
    expect(storeStats.mode & 0o777).toBe(0o600)
    expect(directoryStats.mode & 0o777).toBe(0o700)
  })

  it("revokes an existing grant when the tree exceeds current safety limits", async () => {
    const { plugin, pluginRoot, storePath } = await fixture()
    await grantPluginTrust(plugin, { storePath })
    await writeFile(path.join(pluginRoot, "large.bin"), "12345", "utf8")

    await expect(
      evaluatePluginTrust(plugin, {
        storePath,
        limits: { maxFileBytes: 4 },
      }),
    ).resolves.toMatchObject({
      trusted: false,
      reason: "unsafe-plugin",
      revoked: true,
    })
  })

  it("rejects a permissive or symlinked trust-store file", async () => {
    const { workspace, plugin, storePath } = await fixture()
    await grantPluginTrust(plugin, { storePath })
    await chmod(storePath, 0o666)
    await expect(evaluatePluginTrust(plugin, { storePath })).resolves.toMatchObject({
      trusted: true,
      reason: "trusted",
    })
    expect((await stat(storePath)).mode & 0o777).toBe(0o600)

    const replacement = path.join(workspace, "replacement.json")
    await writeFile(replacement, JSON.stringify({ version: 1, grants: [] }), "utf8")
    await rm(storePath)
    await symlink(replacement, storePath)
    await expect(evaluatePluginTrust(plugin, { storePath })).resolves.toMatchObject({
      trusted: false,
      reason: "store-corrupt",
    })
  })
})
