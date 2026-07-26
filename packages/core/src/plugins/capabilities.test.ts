import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadSlashCommands } from "../commands/loader.js"
import { NexusConfigSchema } from "../config/schema.js"
import { loadAgentDefinitions } from "../orchestration/agents.js"
import { loadSkills } from "../skills/manager.js"
import type { NexusConfig } from "../types.js"
import {
  resolveConfiguredAndPluginMcpServers,
} from "./capabilities.js"
import { validatePluginManifestFile } from "./index.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; pluginRoot: string; manifestPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-plugin-"))
  roots.push(root)
  const pluginRoot = path.join(root, ".nexus", "plugins", "demo")
  const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json")
  await mkdir(path.dirname(manifestPath), { recursive: true })
  return { root, pluginRoot, manifestPath }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function config(trusted: string[] = []): NexusConfig {
  return NexusConfigSchema.parse({ plugins: { trusted } }) as NexusConfig
}

describe("trusted plugin capabilities", () => {
  it("loads Codex/OpenClaude-compatible defaults and inline capabilities only after trust", async () => {
    const { root, pluginRoot, manifestPath } = await fixture()
    await mkdir(path.join(pluginRoot, "commands"), { recursive: true })
    await mkdir(path.join(pluginRoot, "skills", "ship"), { recursive: true })
    await mkdir(path.join(pluginRoot, "agents"), { recursive: true })
    await writeFile(path.join(pluginRoot, "commands", "review.md"), "# Review\nReview this change.", "utf8")
    await writeFile(
      path.join(pluginRoot, "skills", "ship", "SKILL.md"),
      "---\nname: ship\ndescription: Ship safely\n---\nShip it.",
      "utf8",
    )
    await writeFile(
      path.join(pluginRoot, "agents", "reviewer.md"),
      "---\nname: Reviewer\nwhen_to_use: Review code\n---\nBe precise.",
      "utf8",
    )
    await writeJson(manifestPath, {
      name: "demo",
      commands: {
        explain: {
          content: "Explain $ARGUMENTS",
          description: "Explain a topic",
        },
      },
      mcpServers: {
        docs: { type: "http", url: "https://example.test/mcp" },
      },
    })

    expect((await loadSlashCommands(root, undefined, config())).filter((item) => item.scope === "plugin")).toEqual([])
    expect((await loadSkills([], root, undefined, undefined, config())).some((item) => item.name === "ship")).toBe(false)
    expect((await loadAgentDefinitions(root, undefined, config())).some((item) => item.agentType === "Reviewer")).toBe(false)
    await expect(resolveConfiguredAndPluginMcpServers(root, config())).resolves.toMatchObject({ servers: [] })

    const trusted = config(["demo"])
    const commands = await loadSlashCommands(root, undefined, trusted)
    expect(commands.map((item) => item.command)).toEqual(expect.arrayContaining([
      "plugin:demo:review",
      "plugin:demo:explain",
    ]))
    expect((await loadSkills([], root, undefined, undefined, trusted)).some((item) => item.name === "ship")).toBe(true)
    expect((await loadAgentDefinitions(root, undefined, trusted)).some((item) => item.agentType === "Reviewer")).toBe(true)
    await expect(resolveConfiguredAndPluginMcpServers(root, trusted)).resolves.toMatchObject({
      servers: [{ name: "docs", url: "https://example.test/mcp" }],
    })
  })

  it("isolates an invalid MCP sibling and gives explicit config precedence", async () => {
    const { root, pluginRoot, manifestPath } = await fixture()
    await writeJson(manifestPath, { name: "demo", mcpServers: "./mcp.json" })
    await writeJson(path.join(pluginRoot, "mcp.json"), {
      mcpServers: {
        valid: { command: "node", args: ["server.js"] },
        broken: { args: ["missing-command-and-url"] },
      },
    })
    const configured = NexusConfigSchema.parse({
      plugins: { trusted: ["demo"] },
      mcp: { servers: [{ name: "valid", url: "https://override.test/mcp", transport: "http" }] },
    }) as NexusConfig

    const result = await resolveConfiguredAndPluginMcpServers(root, configured)
    expect(result.servers).toEqual([
      { name: "valid", url: "https://override.test/mcp", transport: "http", enabled: true },
    ])
    expect(result.diagnostics.map((item) => item.serverName)).toEqual(expect.arrayContaining(["broken", "valid"]))
  })

  it("rejects a declared symlink that escapes the plugin root", async () => {
    const { root, pluginRoot, manifestPath } = await fixture()
    const outside = path.join(root, "outside")
    await mkdir(outside)
    await symlink(outside, path.join(pluginRoot, "skills"))
    await writeJson(manifestPath, { name: "demo", skills: "./skills" })

    const result = await validatePluginManifestFile(manifestPath)
    expect(result.success).toBe(false)
    expect(result.errors.join("\n")).toContain("symlink target escapes plugin root")
  })
})
