import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { NexusConfigSchema } from "../config/schema.js"
import {
  loadAutoMemoryMarkdown,
  resolveAutoMemoryDirectory,
} from "./auto-memory.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe("resolveAutoMemoryDirectory", () => {
  it("resolves a project-owned relative override against the workspace", () => {
    const workspace = path.resolve("/workspace/nexus-project")
    const config = NexusConfigSchema.parse({
      memory: {
        autoMemoryDirectory: ".nexus/memory",
      },
    })

    expect(
      resolveAutoMemoryDirectory(
        workspace,
        config as import("../types.js").NexusConfig,
      ),
    ).toBe(path.join(workspace, ".nexus", "memory"))
  })

  it("loads bounded project memory without following nested symlinks", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "nexus-auto-memory-"))
    const outside = await mkdtemp(path.join(tmpdir(), "nexus-auto-memory-outside-"))
    roots.push(workspace, outside)
    const memory = path.join(workspace, ".nexus", "memory")
    await mkdir(path.join(memory, "nested"), { recursive: true })
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
    await writeFile(
      path.join(memory, "project.md"),
      `PROJECT_FACT\nprovider=${secret}\n`,
    )
    await writeFile(path.join(memory, "nested", "detail.md"), "NESTED_FACT\n")
    await writeFile(path.join(outside, "secret.md"), "OUTSIDE_SECRET\n")
    await symlink(outside, path.join(memory, "escape"))
    const config = NexusConfigSchema.parse({
      memory: { autoMemoryDirectory: ".nexus/memory" },
    })

    const loaded = await loadAutoMemoryMarkdown(
      workspace,
      config as import("../types.js").NexusConfig,
    )

    expect(loaded).toContain("PROJECT_FACT")
    expect(loaded).toContain("NESTED_FACT")
    expect(loaded).not.toContain(secret)
    expect(loaded).toContain("[redacted]")
    expect(loaded).not.toContain("OUTSIDE_SECRET")
    expect(loaded).toContain("omitted by safety limits")
  })

  it("caps each memory file before reading it into the prompt", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "nexus-auto-memory-"))
    roots.push(workspace)
    const memory = path.join(workspace, ".nexus", "memory")
    await mkdir(memory, { recursive: true })
    await writeFile(path.join(memory, "large.md"), "x".repeat(256 * 1024))
    const config = NexusConfigSchema.parse({
      memory: { autoMemoryDirectory: ".nexus/memory" },
    })

    const loaded = await loadAutoMemoryMarkdown(
      workspace,
      config as import("../types.js").NexusConfig,
    )

    expect(loaded).toContain("[auto-memory file truncated]")
    expect(loaded.length).toBeLessThan(140 * 1024)
  })
})
