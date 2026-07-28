import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { CheckpointTracker } from "./tracker.js"

const roots: string[] = []

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  )
})

describe("CheckpointTracker safety", () => {
  it("never renames nested Git metadata and refuses blanket workspace restore", async () => {
    const workspace = await makeDirectory("nexus-checkpoint-workspace-")
    const homeDir = await makeDirectory("nexus-checkpoint-home-")
    const nestedGit = path.join(workspace, "nested", ".git")
    await fs.mkdir(nestedGit, { recursive: true })
    await fs.writeFile(path.join(nestedGit, "config"), "nested-marker\n")
    await fs.writeFile(path.join(workspace, "nested", "owned.ts"), "nested\n")
    await fs.writeFile(path.join(workspace, "main.ts"), "before\n")

    const tracker = new CheckpointTracker(
      "session-1",
      workspace,
      { homeDir },
    )
    await expect(tracker.init()).resolves.toBe(true)
    const hash = await tracker.commitForMessage(
      "message-1",
      "safe checkpoint",
    )

    await expect(
      fs.readFile(path.join(nestedGit, "config"), "utf8"),
    ).resolves.toBe("nested-marker\n")
    await fs.writeFile(path.join(workspace, "main.ts"), "manual-later\n")
    await fs.writeFile(path.join(workspace, "unrelated.txt"), "preserve\n")
    await fs.writeFile(path.join(workspace, "nested", "owned.ts"), "nested-later\n")

    await expect(tracker.resetHead(hash)).rejects.toThrow(
      /blanket checkpoint restore is disabled/i,
    )
    await expect(
      fs.readFile(path.join(workspace, "main.ts"), "utf8"),
    ).resolves.toBe("manual-later\n")
    await expect(
      fs.readFile(path.join(workspace, "unrelated.txt"), "utf8"),
    ).resolves.toBe("preserve\n")
    await expect(
      fs.readFile(path.join(workspace, "nested", "owned.ts"), "utf8"),
    ).resolves.toBe("nested-later\n")
    await expect(
      fs.readFile(path.join(nestedGit, "config"), "utf8"),
    ).resolves.toBe("nested-marker\n")
  })
})
