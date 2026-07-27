import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  CustomToolTrustStore,
  UnsafeCustomToolSourceError,
} from "./tree-trust.js"

const temporaryDirectories: string[] = []

async function createFixture(): Promise<{
  root: string
  source: string
  storePath: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), "nexus-custom-tool-trust-"))
  temporaryDirectories.push(root)
  const source = path.join(root, "tools")
  await mkdir(source)
  return {
    root,
    source,
    storePath: path.join(root, "authority", "custom-tools.json"),
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe("CustomToolTrustStore", () => {
  it("rejects a positional store path instead of silently using global state", () => {
    expect(
      () =>
        new CustomToolTrustStore(
          "/tmp/custom-tool-trust.json" as never,
        ),
    ).toThrow(/options must be an object/)
  })

  it("invalidates an exact-content grant after source mutation", async () => {
    const fixture = await createFixture()
    const entry = path.join(fixture.source, "hello.js")
    await writeFile(entry, "export default 1\n")
    const store = new CustomToolTrustStore({ storePath: fixture.storePath })

    const grant = await store.grant(fixture.source)
    expect(await store.evaluate(fixture.source)).toMatchObject({
      trusted: true,
      fingerprint: grant.fingerprint,
    })

    await writeFile(entry, "export default 2\n")

    expect(await store.evaluate(fixture.source)).toMatchObject({
      trusted: false,
      reason: "content-changed",
    })
  })

  it("rejects a symbolic link before a grant can be created", async () => {
    const fixture = await createFixture()
    const outside = path.join(fixture.root, "outside.js")
    await writeFile(outside, "export default 1\n")
    await symlink(outside, path.join(fixture.source, "linked.js"))
    const store = new CustomToolTrustStore({ storePath: fixture.storePath })

    await expect(store.grant(fixture.source)).rejects.toBeInstanceOf(
      UnsafeCustomToolSourceError,
    )
  })

  it("rejects a tree that exceeds configured byte bounds", async () => {
    const fixture = await createFixture()
    await writeFile(path.join(fixture.source, "large.js"), "x".repeat(65))
    const store = new CustomToolTrustStore({
      storePath: fixture.storePath,
      limits: {
        maxFileBytes: 64,
        maxTotalBytes: 64,
      },
    })

    await expect(store.grant(fixture.source)).rejects.toThrow(
      /exceeds 64 bytes/,
    )
  })
})
