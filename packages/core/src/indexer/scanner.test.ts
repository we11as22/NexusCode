import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { collectIndexFiles } from "./scanner.js"

describe("index scanner boundaries", () => {
  it("distinguishes an exact file limit from an actually truncated scan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-scan-limit-"))
    await writeFile(path.join(root, "one.ts"), "export const one = 1")
    await writeFile(path.join(root, "two.ts"), "export const two = 2")

    const exact = await collectIndexFiles(root, [], {
      vectorIndexing: true,
      maxFiles: 2,
    })
    expect(exact.files).toHaveLength(2)
    expect(exact.truncated).toBe(false)

    await writeFile(path.join(root, "three.ts"), "export const three = 3")
    const truncated = await collectIndexFiles(root, [], {
      vectorIndexing: true,
      maxFiles: 2,
    })
    expect(truncated.files).toHaveLength(2)
    expect(truncated.truncated).toBe(true)
  })

  it("never follows a workspace symlink into files outside the project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-scan-root-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "nexus-scan-outside-"))
    await mkdir(path.join(outside, "src"))
    await writeFile(path.join(outside, "src", "secret.ts"), "export const secret = true")
    await symlink(path.join(outside, "src"), path.join(root, "linked-src"))

    const result = await collectIndexFiles(root, [], {
      vectorIndexing: true,
      maxFiles: 10,
    })

    expect(result.files).toEqual([])
  })
})
