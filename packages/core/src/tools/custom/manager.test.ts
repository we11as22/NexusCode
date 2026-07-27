import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createTestConfig } from "../../test/fakes.js"
import type { NexusConfig, ToolContext } from "../../types.js"
import {
  registerToolContributionSnapshot,
  WorkspaceToolContributionManager,
} from "./manager.js"
import { CustomToolTrustStore } from "./tree-trust.js"
import { validatePluginManifestFile } from "../../plugins/index.js"
import { grantPluginTrust } from "../../plugins/trust.js"
import { ToolRegistry } from "../registry.js"

const temporaryDirectories: string[] = []

async function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  )
}

async function createFixture(options: {
  callTimeoutMs?: number
  loadTimeoutMs?: number
} = {}): Promise<{
  workspace: string
  source: string
  runtimeRoot: string
  trustStore: CustomToolTrustStore
  manager: WorkspaceToolContributionManager
  config: NexusConfig
}> {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nexus-custom-tool-manager-"),
  )
  temporaryDirectories.push(workspace)
  const source = path.join(workspace, "custom-tools")
  const runtimeRoot = path.join(workspace, ".runtime")
  await mkdir(source)
  const trustStore = new CustomToolTrustStore({
    storePath: path.join(workspace, ".authority", "custom-tools.json"),
  })
  const manager = new WorkspaceToolContributionManager({
    runtimeRoot,
    trustStore,
    loadPlugins: async () => [],
    callTimeoutMs: options.callTimeoutMs ?? 1_000,
    loadTimeoutMs: options.loadTimeoutMs ?? 1_000,
  })
  const config = createTestConfig()
  config.tools.custom = [source]
  return {
    workspace,
    source,
    runtimeRoot,
    trustStore,
    manager,
    config,
  }
}

function toolContext(
  cwd: string,
  signal = new AbortController().signal,
): ToolContext {
  return {
    cwd,
    mode: "agent",
    signal,
  } as unknown as ToolContext
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe("WorkspaceToolContributionManager", () => {
  it("does not import repository code before exact-content trust", async () => {
    const fixture = await createFixture()
    const sentinel = path.join(fixture.workspace, "imported")
    await writeFile(
      path.join(fixture.source, "sentinel.js"),
      `
        import { writeFileSync } from "node:fs"
        writeFileSync(${JSON.stringify(sentinel)}, "imported")
        export default {
          name: "SentinelTool",
          description: "Proves that loading happens only after trust.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          async execute() { return { success: true, output: "ok" } }
        }
      `,
    )

    const untrusted = await fixture.manager.materialize(
      fixture.workspace,
      fixture.config,
    )

    expect(untrusted.tools).toEqual([])
    expect(untrusted.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "source-untrusted" }),
      ]),
    )
    expect(await exists(sentinel)).toBe(false)

    await fixture.trustStore.grant(fixture.source)
    const trusted = await fixture.manager.materialize(
      fixture.workspace,
      fixture.config,
    )

    expect(await exists(sentinel)).toBe(true)
    expect(trusted.tools.map((tool) => tool.name)).toEqual(["SentinelTool"])
    const tool = trusted.tools[0]!
    expect(tool.integration).toMatchObject({
      kind: "custom",
      fingerprint: expect.stringMatching(/^sha256:/),
      generation: trusted.generation,
    })
    expect(tool.modes).toEqual(["agent", "debug"])
    expect(tool.approval).toMatchObject({
      capability: "plugin",
      alwaysPrompt: true,
    })
    const inheritedRegistry = new ToolRegistry()
    registerToolContributionSnapshot(
      inheritedRegistry,
      trusted,
      "delegated generation",
    )
    expect(inheritedRegistry.get("SentinelTool")).toBe(tool)
    await expect(
      tool.execute({}, toolContext(fixture.workspace)),
    ).resolves.toMatchObject({ success: true, output: "ok" })

    await fixture.manager.close()
  })

  it("drops reserved, duplicate, invalid-name, and invalid-schema tools", async () => {
    const fixture = await createFixture()
    const modules: Record<string, string> = {
      "reserved.js": `
        export default {
          name: "Read",
          description: "Reserved.",
          inputSchema: { type: "object", properties: {} },
          async execute() { return "reserved" }
        }
      `,
      "duplicate-a.js": `
        export default {
          name: "Duplicated",
          description: "First.",
          inputSchema: { type: "object", properties: {} },
          async execute() { return "first" }
        }
      `,
      "duplicate-b.js": `
        export default {
          name: "Duplicated",
          description: "Second.",
          inputSchema: { type: "object", properties: {} },
          async execute() { return "second" }
        }
      `,
      "invalid-name.js": `
        export default {
          name: "not valid",
          description: "Invalid name.",
          inputSchema: { type: "object", properties: {} },
          async execute() { return "bad" }
        }
      `,
      "invalid-schema.js": `
        export default {
          name: "InvalidSchema",
          description: "Invalid schema.",
          inputSchema: { type: "array", items: { type: "string" } },
          async execute() { return "bad" }
        }
      `,
      "valid.js": `
        export default {
          name: "ValidCustomTool",
          description: "Valid.",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false
          },
          async execute(args) { return args.value }
        }
      `,
    }
    await Promise.all(
      Object.entries(modules).map(([name, content]) =>
        writeFile(path.join(fixture.source, name), content),
      ),
    )
    await fixture.trustStore.grant(fixture.source)

    const snapshot = await fixture.manager.materialize(
      fixture.workspace,
      fixture.config,
    )

    expect(snapshot.tools.map((tool) => tool.name)).toEqual([
      "ValidCustomTool",
    ])
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "reserved-name",
        "duplicate-name",
        "invalid-name",
        "invalid-schema",
      ]),
    )
    await expect(
      snapshot.tools[0]!.parameters.parseAsync({ value: 1 }),
    ).rejects.toBeDefined()

    await fixture.manager.close()
  })

  it("bundles TypeScript and supports default arrays plus named tool exports", async () => {
    const fixture = await createFixture()
    await writeFile(
      path.join(fixture.source, "typescript-tools.ts"),
      `
        type Input = { value: string }
        const schema = {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false
        } as const

        export default [
          {
            name: "FirstTypeScriptTool",
            description: "First TypeScript export.",
            inputSchema: schema,
            async execute(args: Input): Promise<string> {
              return "first:" + args.value
            }
          },
          {
            name: "SecondTypeScriptTool",
            description: "Second TypeScript export.",
            inputSchema: schema,
            async execute(args: Input): Promise<string> {
              return "second:" + args.value
            }
          }
        ]

        export const namedTool = {
          name: "NamedTypeScriptTool",
          description: "Named TypeScript export.",
          inputSchema: schema,
          async execute(args: Input): Promise<string> {
            return "named:" + args.value
          }
        }
      `,
    )
    await fixture.trustStore.grant(fixture.source)

    const snapshot = await fixture.manager.materialize(
      fixture.workspace,
      fixture.config,
    )

    expect(snapshot.tools.map((tool) => tool.name)).toEqual([
      "FirstTypeScriptTool",
      "NamedTypeScriptTool",
      "SecondTypeScriptTool",
    ])
    const named = snapshot.tools.find(
      (tool) => tool.name === "NamedTypeScriptTool",
    )!
    await expect(
      named.execute(
        { value: "ok" },
        toolContext(fixture.workspace),
      ),
    ).resolves.toMatchObject({ output: "named:ok" })
    await fixture.manager.close()
  })

  it("isolates worker crash, timeout, and caller abort from the host", async () => {
    const fixture = await createFixture({ callTimeoutMs: 80 })
    const modules: Record<string, string> = {
      "crash.js": `
        export default {
          name: "CrashWorker",
          description: "Crashes its isolated worker.",
          inputSchema: { type: "object", properties: {} },
          async execute() { process.exit(17) }
        }
      `,
      "hang.js": `
        export default {
          name: "HangWorker",
          description: "Never resolves.",
          inputSchema: { type: "object", properties: {} },
          async execute() { return new Promise(() => {}) }
        }
      `,
      "abort.js": `
        export default {
          name: "AbortWorker",
          description: "Waits for cancellation.",
          inputSchema: { type: "object", properties: {} },
          async execute() { return new Promise(() => {}) }
        }
      `,
    }
    await Promise.all(
      Object.entries(modules).map(([name, content]) =>
        writeFile(path.join(fixture.source, name), content),
      ),
    )
    await fixture.trustStore.grant(fixture.source)
    const snapshot = await fixture.manager.materialize(
      fixture.workspace,
      fixture.config,
    )
    const byName = new Map(snapshot.tools.map((tool) => [tool.name, tool]))

    await expect(
      byName.get("CrashWorker")!.execute(
        {},
        toolContext(fixture.workspace),
      ),
    ).rejects.toThrow(/worker.*(?:exit|closed)/i)
    await expect(
      byName.get("HangWorker")!.execute(
        {},
        toolContext(fixture.workspace),
      ),
    ).rejects.toThrow(/timed out/i)

    const controller = new AbortController()
    const aborted = byName.get("AbortWorker")!.execute(
      {},
      toolContext(fixture.workspace, controller.signal),
    )
    controller.abort()
    await expect(aborted).rejects.toThrow(/aborted/i)

    expect(process.exitCode).not.toBe(17)
    await fixture.manager.close()
  })

  it("rejects oversized invocation payloads before posting them to a worker", async () => {
    const fixture = await createFixture()
    await writeFile(
      path.join(fixture.source, "bounded.js"),
      `
        export default {
          name: "BoundedInputTool",
          description: "Accepts a JSON object.",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"]
          },
          async execute() { return "unexpected" }
        }
      `,
    )
    await fixture.trustStore.grant(fixture.source)
    const snapshot = await fixture.manager.materialize(
      fixture.workspace,
      fixture.config,
    )

    await expect(
      snapshot.tools[0]!.execute(
        { value: "x".repeat(1024 * 1024 + 1) },
        toolContext(fixture.workspace),
      ),
    ).rejects.toThrow(/input.*exceeded/i)
    await fixture.manager.close()
  })

  it("keeps immutable generations alive until workspace shutdown", async () => {
    const fixture = await createFixture()
    const entry = path.join(fixture.source, "version.js")
    const source = (version: string) => `
      export default {
        name: "VersionedTool",
        description: "Versioned.",
        inputSchema: { type: "object", properties: {} },
        async execute() { return ${JSON.stringify(version)} }
      }
    `
    await writeFile(entry, source("v1"))
    await fixture.trustStore.grant(fixture.source)

    const first = await fixture.manager.materialize(
      fixture.workspace,
      fixture.config,
    )
    const reused = await fixture.manager.materialize(
      fixture.workspace,
      fixture.config,
    )
    expect(reused).toBe(first)

    await writeFile(entry, source("v2"))
    const invalidated = await fixture.manager.materialize(
      fixture.workspace,
      fixture.config,
    )
    expect(invalidated.generation).not.toBe(first.generation)
    expect(invalidated.tools).toEqual([])
    await expect(
      first.tools[0]!.execute({}, toolContext(fixture.workspace)),
    ).resolves.toMatchObject({ output: "v1" })

    await fixture.trustStore.grant(fixture.source)
    const second = await fixture.manager.materialize(
      fixture.workspace,
      fixture.config,
    )
    expect(second.generation).not.toBe(first.generation)
    await expect(
      second.tools[0]!.execute({}, toolContext(fixture.workspace)),
    ).resolves.toMatchObject({ output: "v2" })

    await fixture.manager.close()
    await fixture.manager.close()
    await expect(
      first.tools[0]!.execute({}, toolContext(fixture.workspace)),
    ).rejects.toThrow(/closed/i)
    await expect(
      second.tools[0]!.execute({}, toolContext(fixture.workspace)),
    ).rejects.toThrow(/closed/i)
  })

  it("serializes concurrent materializations instead of sharing the wrong config", async () => {
    const fixture = await createFixture()
    const secondSource = path.join(fixture.workspace, "other-tools")
    await mkdir(secondSource)
    const moduleSource = (name: string) => `
      export default {
        name: ${JSON.stringify(name)},
        description: "Workspace-scoped.",
        inputSchema: { type: "object", properties: {} },
        async execute() { return ${JSON.stringify(name)} }
      }
    `
    await writeFile(
      path.join(fixture.source, "first.js"),
      moduleSource("FirstGenerationTool"),
    )
    await writeFile(
      path.join(secondSource, "second.js"),
      moduleSource("SecondGenerationTool"),
    )
    await fixture.trustStore.grant(fixture.source)
    await fixture.trustStore.grant(secondSource)
    const secondConfig = createTestConfig()
    secondConfig.tools.custom = [secondSource]

    const [first, second] = await Promise.all([
      fixture.manager.materialize(fixture.workspace, fixture.config),
      fixture.manager.materialize(fixture.workspace, secondConfig),
    ])

    expect(first.tools.map((tool) => tool.name)).toEqual([
      "FirstGenerationTool",
    ])
    expect(second.tools.map((tool) => tool.name)).toEqual([
      "SecondGenerationTool",
    ])
    expect(second.generation).not.toBe(first.generation)
    await fixture.manager.close()
  })

  it("loads executable plugin contributions only through exact plugin trust", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "nexus-plugin-tool-manager-"),
    )
    temporaryDirectories.push(workspace)
    const pluginRoot = path.join(
      workspace,
      ".nexus",
      "plugins",
      "example",
    )
    const toolDir = path.join(pluginRoot, "tools")
    const manifestPath = path.join(pluginRoot, "plugin.json")
    await mkdir(toolDir, { recursive: true })
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: "example",
        tools: ["tools/example.js"],
      }),
    )
    await writeFile(
      path.join(toolDir, "example.js"),
      `
        export default {
          name: "PluginExample",
          description: "Trusted plugin contribution.",
          inputSchema: { type: "object", properties: {} },
          async execute() { return "plugin-ok" }
        }
      `,
    )
    const validated = await validatePluginManifestFile(manifestPath)
    expect(validated.success).toBe(true)
    const pluginStorePath = path.join(
      workspace,
      ".authority",
      "plugins.json",
    )
    await grantPluginTrust(validated.plugin!, {
      storePath: pluginStorePath,
    })
    const manager = new WorkspaceToolContributionManager({
      runtimeRoot: path.join(workspace, ".runtime"),
      trustStore: new CustomToolTrustStore({
        storePath: path.join(workspace, ".authority", "custom.json"),
      }),
      pluginTrustOptions: { storePath: pluginStorePath },
    })
    const config = createTestConfig()

    const snapshot = await manager.materialize(workspace, config)

    expect(snapshot.tools.map((tool) => tool.name)).toEqual([
      "PluginExample",
    ])
    expect(snapshot.tools[0]!.integration).toMatchObject({
      kind: "plugin",
      pluginName: "example",
      generation: snapshot.generation,
    })
    await expect(
      snapshot.tools[0]!.execute({}, toolContext(workspace)),
    ).resolves.toMatchObject({ output: "plugin-ok" })
    await manager.close()
  })
})
