import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { hashFileContent } from "@nexuscode/core"

import { ServerHost } from "./host.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "nexus-server-host-"),
  )
  temporaryDirectories.push(directory)
  return directory
}

describe("ServerHost durable file mutations", () => {
  it("advertises question events supported by the session stream", async () => {
    const host = new ServerHost(await workspace(), () => {})

    expect(host.capabilities).toEqual({
      interactiveQuestions: true,
    })
  })

  it("atomically applies an exact compare-and-swap and preserves mode", async () => {
    const cwd = await workspace()
    const file = path.join(cwd, "file.ts")
    await fs.writeFile(file, "before", { mode: 0o640 })
    const host = new ServerHost(cwd, () => {})
    const captured = await host.readFileState("file.ts")
    if (!captured.exists) throw new Error("missing fixture")
    const digest = hashFileContent(captured.content)

    await host.applyFileMutation({
      path: "file.ts",
      expected: {
        exists: true,
        ...digest,
        blob: digest.hash,
        mode: captured.mode,
      },
      next: {
        exists: true,
        content: Buffer.from("after"),
        mode: captured.mode,
      },
    })

    await expect(fs.readFile(file, "utf8")).resolves.toBe("after")
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640)
  })

  it("does not overwrite bytes that drift after capture", async () => {
    const cwd = await workspace()
    const file = path.join(cwd, "file.ts")
    await fs.writeFile(file, "before")
    const host = new ServerHost(cwd, () => {})
    const captured = await host.readFileState("file.ts")
    if (!captured.exists) throw new Error("missing fixture")
    const digest = hashFileContent(captured.content)
    await fs.writeFile(file, "manual")

    await expect(host.applyFileMutation({
      path: "file.ts",
      expected: {
        exists: true,
        ...digest,
        blob: digest.hash,
        mode: captured.mode,
      },
      next: {
        exists: true,
        content: Buffer.from("agent"),
        mode: captured.mode,
      },
    })).rejects.toThrow(/precondition failed/i)
    await expect(fs.readFile(file, "utf8")).resolves.toBe("manual")
  })
})
