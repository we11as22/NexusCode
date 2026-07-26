import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { OrchestrationRuntime } from "../orchestration/runtime.js"
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
})
