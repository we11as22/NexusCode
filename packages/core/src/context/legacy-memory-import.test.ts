import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { OrchestrationRuntime } from "../orchestration/runtime.js"
import { filterPromptMemoryCandidates } from "../orchestration/memory-selection.js"
import type { NexusConfig } from "../types.js"
import { importLegacyMemoryFiles } from "./legacy-memory-import.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("legacy markdown memory import", () => {
  it("is idempotent, records provenance, and never expands instruction includes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-memory-import-"))
    roots.push(root)
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    const memoryDir = path.join(root, "legacy-memory")
    await mkdir(cwd)
    await mkdir(memoryDir)
    const outside = path.join(root, "outside-secret.md")
    await writeFile(outside, "SHOULD_NOT_BE_IMPORTED", "utf8")
    await writeFile(
      path.join(memoryDir, "architecture.md"),
      `Use Qdrant for vectors.\n@${outside}\n`,
      "utf8",
    )
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    const config = {
      memory: { autoMemoryEnabled: true, autoMemoryDirectory: memoryDir },
    } as NexusConfig

    const first = await importLegacyMemoryFiles({ cwd, config, runtime, homeDir })
    const second = await importLegacyMemoryFiles({ cwd, config, runtime, homeDir })
    const memories = await runtime.listMemories()

    expect(first).toMatchObject({ imported: 1, unchanged: 0 })
    expect(second).toMatchObject({ imported: 0, unchanged: 1 })
    expect(memories).toHaveLength(1)
    expect(memories[0]).toMatchObject({
      scope: "project",
      source: { type: "legacy_file" },
      author: { type: "external" },
      trust: "external",
    })
    expect(memories[0]?.content).toContain(`@${outside}`)
    expect(memories[0]?.content).not.toContain("SHOULD_NOT_BE_IMPORTED")
  })

  it("bounds files before persistence and never follows a nested memory symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-memory-import-"))
    roots.push(root)
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    const memoryDir = path.join(root, "legacy-memory")
    const outsideDir = path.join(root, "outside")
    await mkdir(cwd)
    await mkdir(memoryDir)
    await mkdir(outsideDir)
    await writeFile(path.join(memoryDir, "large.md"), "x".repeat(48_000))
    await writeFile(path.join(outsideDir, "secret.md"), "OUTSIDE_SECRET")
    await symlink(outsideDir, path.join(memoryDir, "escape"))
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    const config = {
      memory: { autoMemoryEnabled: true, autoMemoryDirectory: memoryDir },
    } as NexusConfig

    const result = await importLegacyMemoryFiles({
      cwd,
      config,
      runtime,
      homeDir,
    })
    const memories = await runtime.listMemories()

    expect(result.truncated).toBe(true)
    expect(memories).toHaveLength(1)
    expect(memories[0]?.content.length).toBeLessThanOrEqual(24_000)
    expect(memories[0]?.content).not.toContain("OUTSIDE_SECRET")
  })

  it("removes stale canonical projections when their source is deleted or disabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-memory-import-"))
    roots.push(root)
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    const memoryDir = path.join(root, "legacy-memory")
    await mkdir(cwd)
    await mkdir(memoryDir)
    const source = path.join(memoryDir, "fact.md")
    await writeFile(source, "A projected fact")
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    const enabled = {
      memory: { autoMemoryEnabled: true, autoMemoryDirectory: memoryDir },
    } as NexusConfig

    await importLegacyMemoryFiles({ cwd, config: enabled, runtime, homeDir })
    await unlink(source)
    const afterDelete = await importLegacyMemoryFiles({
      cwd,
      config: enabled,
      runtime,
      homeDir,
    })
    expect(afterDelete.removed).toBe(1)
    expect(await runtime.listMemories()).toHaveLength(0)

    await writeFile(source, "Another projected fact")
    await importLegacyMemoryFiles({ cwd, config: enabled, runtime, homeDir })
    const disabled = {
      memory: { autoMemoryEnabled: false, autoMemoryDirectory: memoryDir },
    } as NexusConfig
    const afterDisable = await importLegacyMemoryFiles({
      cwd,
      config: disabled,
      runtime,
      homeDir,
    })
    expect(afterDisable.removed).toBe(1)
    expect(await runtime.listMemories()).toHaveLength(0)
  })

  it("imports team files with an exact durable session binding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-memory-import-"))
    roots.push(root)
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, ".nexus")
    await mkdir(cwd)
    const runtime = new OrchestrationRuntime(cwd, { homeDir })
    await runtime.createTeam({
      teamName: "core",
      description: "Core team",
      sessionId: "session-a",
    })
    const teamMemory = path.join(
      homeDir,
      "teams",
      encodeURIComponent("core"),
      "memory",
    )
    await mkdir(teamMemory, { recursive: true })
    await writeFile(path.join(teamMemory, "decision.md"), "Use protocol v2.")

    await importLegacyMemoryFiles({
      cwd,
      config: { memory: { autoMemoryEnabled: false } } as NexusConfig,
      runtime,
      homeDir,
    })
    const memories = await runtime.listMemories()

    expect(memories).toMatchObject([
      {
        scope: "team",
        trust: "external",
        metadata: { teamName: "core", legacyMemoryType: "team" },
      },
    ])
    expect(
      filterPromptMemoryCandidates(memories, {
        sessionId: "session-a",
        includeTeam: true,
        teamNames: await runtime.listTeamNamesForSession("session-a"),
      }),
    ).toHaveLength(1)
    expect(
      filterPromptMemoryCandidates(memories, {
        sessionId: "session-b",
        includeTeam: true,
        teamNames: [],
      }),
    ).toHaveLength(0)
  })
})
