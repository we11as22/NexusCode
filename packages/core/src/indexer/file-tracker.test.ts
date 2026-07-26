import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { StorageCorruptionError } from "../storage/durable-fs.js"
import { FileTracker } from "./file-tracker.js"

describe("FileTracker durability", () => {
  it("merges independent updates from concurrent Nexus processes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nexus-tracker-"))
    const file = path.join(dir, "tracker.json")
    const first = new FileTracker(dir, file)
    const second = new FileTracker(dir, file)
    await Promise.all([first.load(), second.load()])

    first.upsertFile("src/one.ts", "hash-one", 1)
    await first.save()
    second.upsertFile("src/two.ts", "hash-two", 2)
    await second.save()

    const reloaded = new FileTracker(dir, file)
    await reloaded.load()
    expect(reloaded.listPaths().sort()).toEqual(["src/one.ts", "src/two.ts"])
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      "src/one.ts": { contentSha256: "hash-one", chunks: 1 },
      "src/two.ts": { contentSha256: "hash-two", chunks: 2 },
    })
  })

  it("reports corrupt state instead of silently replacing it with an empty tracker", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nexus-tracker-corrupt-"))
    const file = path.join(dir, "tracker.json")
    await writeFile(file, "{broken", "utf8")

    await expect(new FileTracker(dir, file).load()).rejects.toBeInstanceOf(
      StorageCorruptionError,
    )
  })
})
