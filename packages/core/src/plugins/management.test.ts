import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createNexusRunServices } from "../agent/run-services.js"
import { createFakeHost, createFakeSession, createTestConfig } from "../test/fakes.js"
import {
  listPluginsTool,
  pluginInstallLocalTool,
  pluginTrustTool,
} from "../tools/built-in/orchestration-tools.js"
import type { ToolContext } from "../types.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; source: string; target: string; context: ToolContext }> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-plugin-install-"))
  roots.push(root)
  const source = path.join(root, "source")
  const target = path.join(root, ".nexus", "plugins", "demo")
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

  it("applies trust changes to the active run immediately", async () => {
    const { target, context } = await fixture()
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "demo" }), "utf8")

    await pluginTrustTool.execute({ name: "demo", trusted: true }, context)
    const listed = await listPluginsTool.execute({}, context)
    const plugins = (listed.metadata?.plugins ?? []) as Array<{ name: string; trusted?: boolean }>

    expect(plugins.find((plugin) => plugin.name === "demo")).toMatchObject({
      name: "demo",
      trusted: true,
    })
  })
})
