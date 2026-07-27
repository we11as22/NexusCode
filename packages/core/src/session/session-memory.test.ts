import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  appendCompactionSnippetToSessionMemory,
  getSessionMemoryFilePath,
  readSessionMemoryFile,
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

  it("returns empty only for a missing file and surfaces unreadable storage", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nexus-session-memory-"))
    roots.push(cwd)

    await expect(readSessionMemoryFile("missing", cwd, cwd)).resolves.toBe("")

    const memoryPath = getSessionMemoryFilePath("broken", cwd, cwd)
    await mkdir(memoryPath, { recursive: true })
    await expect(readSessionMemoryFile("broken", cwd, cwd)).rejects.toThrow()
  })

  it("rejects unsafe ids and oversized memory files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nexus-session-memory-"))
    roots.push(cwd)

    expect(() => getSessionMemoryFilePath("../outside", cwd, cwd)).toThrow("Unsafe session memory id")

    const memoryPath = getSessionMemoryFilePath("oversized", cwd, cwd)
    await mkdir(path.dirname(memoryPath), { recursive: true })
    await writeFile(memoryPath, Buffer.alloc(1_048_577, 0x61))
    await expect(readSessionMemoryFile("oversized", cwd, cwd)).rejects.toThrow("exceeds")
  })

  it("redacts credentials before compaction notes become durable memory", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "nexus-session-memory-"))
    roots.push(cwd)
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"

    await appendCompactionSnippetToSessionMemory(
      "session-secret",
      cwd,
      `Provider token: ${secret}`,
      48_000,
      cwd,
    )

    const persisted = await readFile(
      getSessionMemoryFilePath("session-secret", cwd, cwd),
      "utf8",
    )
    expect(persisted).not.toContain(secret)
    expect(persisted).toContain("[redacted]")
  })
})
