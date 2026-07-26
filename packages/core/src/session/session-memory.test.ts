import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  appendCompactionSnippetToSessionMemory,
  getSessionMemoryFilePath,
} from "./session-memory.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("durable session memory", () => {
  it("serializes concurrent compaction appends without losing either update", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nexus-session-memory-"))
    roots.push(cwd)

    await Promise.all([
      appendCompactionSnippetToSessionMemory("session-1", cwd, "FIRST_UNIQUE_FACT", 48_000, cwd),
      appendCompactionSnippetToSessionMemory("session-1", cwd, "SECOND_UNIQUE_FACT", 48_000, cwd),
    ])

    const persisted = await readFile(getSessionMemoryFilePath("session-1", cwd, cwd), "utf8")
    expect(persisted).toContain("FIRST_UNIQUE_FACT")
    expect(persisted).toContain("SECOND_UNIQUE_FACT")
  })
})
