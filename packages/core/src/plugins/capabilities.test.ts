import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  loadSlashCommands,
  renderSlashCommandPrompt,
  resolveSlashCommand,
} from "../commands/loader.js"
import { NexusConfigSchema } from "../config/schema.js"
import { loadAgentDefinitions } from "../orchestration/agents.js"
import { loadSkills } from "../skills/manager.js"
import type { NexusConfig } from "../types.js"
import {
  loadPluginMcpServers,
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

  it("resolves command shorthands only when they are unambiguous", () => {
    const commands = [
      {
        command: "plugin:alpha:review",
        scope: "plugin" as const,
        sourcePath: "/alpha/review.md",
        description: "Alpha review",
        prompt: "Review as alpha",
        pluginName: "alpha",
      },
      {
        command: "plugin:beta:review",
        scope: "plugin" as const,
        sourcePath: "/beta/review.md",
        description: "Beta review",
        prompt: "Review as beta",
        pluginName: "beta",
      },
      {
        command: "project:ship",
        scope: "project" as const,
        sourcePath: "/project/ship.md",
        description: "Ship",
        prompt: "Ship safely",
      },
    ]

    expect(resolveSlashCommand(commands, "project:ship")).toMatchObject({
      status: "resolved",
      command: { command: "project:ship" },
    })
    expect(resolveSlashCommand(commands, "ship")).toMatchObject({
      status: "resolved",
      command: { command: "project:ship" },
    })
    expect(resolveSlashCommand(commands, "review")).toEqual({
      status: "ambiguous",
      candidates: ["plugin:alpha:review", "plugin:beta:review"],
    })
    expect(resolveSlashCommand(commands, "missing")).toEqual({ status: "not-found" })
  })

  it("renders OpenClaude argument placeholders without reinterpreting inserted values", () => {
    const command = {
      command: "project:deploy",
      scope: "project" as const,
      sourcePath: "/project/deploy.md",
      description: "Deploy",
      prompt: "all=$ARGUMENTS first=$ARGUMENTS[0] second=$1 handlebars={{args}}",
    }
    expect(renderSlashCommandPrompt(command, '"$1" production')).toBe(
      'all="$1" production first=$1 second=production handlebars="$1" production',
    )
  })

  it("isolates an invalid MCP sibling and gives explicit config precedence", async () => {
    const { root, pluginRoot, manifestPath } = await fixture()
    await writeJson(manifestPath, { name: "demo", mcpServers: "./mcp.json" })
    await writeJson(path.join(pluginRoot, "mcp.json"), {
      mcpServers: {
        valid: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/server.js"],
          env: { PLUGIN_HOME: "${CODEX_PLUGIN_ROOT}" },
        },
        broken: { args: ["missing-command-and-url"] },
      },
    })
    const configured = NexusConfigSchema.parse({
      plugins: { trusted: ["demo"] },
      mcp: { servers: [{ name: "valid", url: "https://override.test/mcp", transport: "http" }] },
    }) as NexusConfig

    const contributed = await loadPluginMcpServers(root, configured)
    const canonicalPluginRoot = await realpath(pluginRoot)
    expect(contributed.servers.find((server) => server.name === "valid")).toMatchObject({
      args: [path.join(canonicalPluginRoot, "server.js")],
      env: { PLUGIN_HOME: canonicalPluginRoot },
      cwd: canonicalPluginRoot,
    })

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
