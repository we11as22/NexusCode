import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  clearToolSpillsForSession,
  getToolOutputSpill,
  inheritSpillRegistryForMergedToolPart,
  registerToolOutputSpill,
} from "./tool-output-registry.js"
import {
  cleanupExpiredToolOutputArtifacts,
  truncateOutput,
  type ToolOutputMaintenanceOptions,
} from "./truncate.js"
import { SessionStore } from "../session/storage.js"

const createdRoots: string[] = []
const previousDataHome = process.env.NEXUS_DATA_HOME

afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.NEXUS_DATA_HOME
  else process.env.NEXUS_DATA_HOME = previousDataHome
  await Promise.all(
    createdRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  )
})

async function useTempDataHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nexus-truncate-"))
  createdRoots.push(root)
  process.env.NEXUS_DATA_HOME = root
  return root
}

describe("large tool output storage", () => {
  it("isolates output paths by session and uses private permissions", async () => {
    const root = await useTempDataHome()
    const first = await truncateOutput("a".repeat(256), {
      cwd: root,
      sessionId: "session/../../one",
      maxBytes: 32,
    })
    const second = await truncateOutput("b".repeat(256), {
      cwd: root,
      sessionId: "session-two",
      maxBytes: 32,
    })

    expect(first.truncated).toBe(true)
    expect(second.truncated).toBe(true)
    if (!first.truncated || !second.truncated) throw new Error("expected spills")
    expect(first.absolutePath).toBeTruthy()
    expect(second.absolutePath).toBeTruthy()
    expect(dirname(first.absolutePath!)).not.toBe(dirname(second.absolutePath!))
    expect(relative(root, first.absolutePath!)).not.toMatch(/^\.\.(?:\/|$)/)
    expect(relative(root, second.absolutePath!)).not.toMatch(/^\.\.(?:\/|$)/)
    expect((await stat(first.absolutePath!)).mode & 0o777).toBe(0o600)
    expect((await stat(dirname(first.absolutePath!))).mode & 0o777).toBe(0o700)
  })

  it("uses exclusive unique files during concurrent spills", async () => {
    const root = await useTempDataHome()
    const values = Array.from({ length: 24 }, (_, index) =>
      `${index}:`.padEnd(512, String(index % 10)),
    )
    const results = await Promise.all(
      values.map((value) =>
        truncateOutput(value, {
          cwd: root,
          sessionId: "shared-session",
          maxBytes: 16,
        }),
      ),
    )
    const paths = results.map((result) =>
      result.truncated ? result.absolutePath : undefined,
    )

    expect(paths.every(Boolean)).toBe(true)
    expect(new Set(paths).size).toBe(values.length)
    await Promise.all(
      paths.map(async (path, index) => {
        expect(await readFile(path!, "utf8")).toBe(values[index])
      }),
    )
  })

  it("never expires an artifact merely because its active owner produces another spill", async () => {
    const root = await useTempDataHome()
    const expired = await truncateOutput("old".repeat(128), {
      cwd: root,
      sessionId: "retention-session",
      maxBytes: 16,
    })
    if (!expired.truncated || !expired.absolutePath) {
      throw new Error("expected an expired artifact")
    }
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
    await utimes(expired.absolutePath, old, old)

    await truncateOutput("new".repeat(128), {
      cwd: root,
      sessionId: "retention-session",
      maxBytes: 16,
    })

    await expect(access(expired.absolutePath)).resolves.toBeUndefined()
  })

  it("retention preserves an abandoned-owner artifact still referenced by a live parent", async () => {
    const root = await useTempDataHome()
    const inherited = await truncateOutput("referenced".repeat(128), {
      cwd: root,
      sessionId: "worker-session",
      maxBytes: 16,
    })
    if (
      !inherited.truncated ||
      !inherited.absolutePath ||
      !inherited.artifactId
    ) {
      throw new Error("expected a persisted artifact")
    }
    registerToolOutputSpill({
      cwd: root,
      sessionId: "parent-session",
      ownerSessionId: "worker-session",
      partId: "merged-part",
      absolutePath: inherited.absolutePath,
      artifactId: inherited.artifactId,
      toolName: "Read",
    })
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
    await utimes(inherited.absolutePath, old, old)

    try {
      const result = await cleanupExpiredToolOutputArtifacts(root)

      expect(result.removedArtifacts).toBe(0)
      await expect(access(inherited.absolutePath)).resolves.toBeUndefined()
    } finally {
      clearToolSpillsForSession("parent-session")
    }
  })

  it("retention never removes artifacts owned by a durable session", async () => {
    const root = await useTempDataHome()
    const sessionHomeDir = join(root, "session-home")
    const store = new SessionStore({ homeDir: sessionHomeDir })
    await store.saveSession({
      id: "session-durable",
      cwd: root,
      ts: Date.now(),
      todo: "",
      messages: [],
    }, { expectedRevision: 0 })
    const artifact = await truncateOutput("durable".repeat(128), {
      cwd: root,
      sessionId: "session-durable",
      maxBytes: 16,
    })
    if (!artifact.truncated || !artifact.absolutePath) {
      throw new Error("expected a persisted artifact")
    }
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
    await utimes(artifact.absolutePath, old, old)

    const result = await cleanupExpiredToolOutputArtifacts(root, {
      sessionHomeDir,
    } as ToolOutputMaintenanceOptions)

    expect(result.removedArtifacts).toBe(0)
    await expect(access(artifact.absolutePath)).resolves.toBeUndefined()
  })

  it("bounded maintenance removes artifacts from abandoned session directories", async () => {
    const root = await useTempDataHome()
    const abandoned = await truncateOutput("old".repeat(128), {
      cwd: root,
      sessionId: "abandoned-session",
      maxBytes: 16,
    })
    const active = await truncateOutput("new".repeat(128), {
      cwd: root,
      sessionId: "active-session",
      maxBytes: 16,
    })
    if (
      !abandoned.truncated ||
      !abandoned.absolutePath ||
      !active.truncated ||
      !active.absolutePath
    ) {
      throw new Error("expected persisted artifacts")
    }
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
    await utimes(abandoned.absolutePath, old, old)
    const unrelated = join(dirname(abandoned.absolutePath), "keep.txt")
    await writeFile(unrelated, "user-owned marker", "utf8")
    await utimes(unrelated, old, old)

    const result = await cleanupExpiredToolOutputArtifacts(root)

    expect(result.removedArtifacts).toBe(1)
    await expect(access(abandoned.absolutePath)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(access(active.absolutePath)).resolves.toBeUndefined()
    await expect(access(unrelated)).resolves.toBeUndefined()
  })

  it("states when only a capped partial artifact was persisted", async () => {
    const root = await useTempDataHome()
    const result = await truncateOutput("0123456789".repeat(20), {
      cwd: root,
      sessionId: "partial-session",
      maxBytes: 16,
      maxFileBytes: 32,
    })

    expect(result.truncated).toBe(true)
    if (!result.truncated) throw new Error("expected a spill")
    expect(result.persisted).toBe("partial")
    expect(result.content).toMatch(/Partial output saved/i)
    expect(result.content).not.toMatch(/Full output saved/i)
    expect(Buffer.byteLength(await readFile(result.absolutePath!, "utf8"))).toBeLessThan(
      200,
    )
  })

  it("never cuts a persisted partial artifact inside a UTF-8 code point", async () => {
    const root = await useTempDataHome()
    const result = await truncateOutput("😀".repeat(40), {
      cwd: root,
      sessionId: "utf8-session",
      maxBytes: 4,
      maxFileBytes: 5,
    })

    expect(result.truncated).toBe(true)
    if (!result.truncated || !result.absolutePath) {
      throw new Error("expected a partial artifact")
    }
    const persisted = await readFile(result.absolutePath, "utf8")
    expect(persisted).toContain("😀")
    expect(persisted).not.toContain("�")
  })

  it("does not claim a durable artifact when persistence fails", async () => {
    const root = await useTempDataHome()
    const blocker = join(root, "not-a-directory")
    await writeFile(blocker, "blocked", "utf8")
    process.env.NEXUS_DATA_HOME = blocker

    const result = await truncateOutput("x".repeat(256), {
      cwd: root,
      sessionId: "failed-session",
      maxBytes: 16,
    })

    expect(result.truncated).toBe(true)
    if (!result.truncated) throw new Error("expected inline truncation")
    expect(result.persisted).toBe("none")
    expect(result.absolutePath).toBeUndefined()
    expect(result.content).toMatch(/could not save/i)
    expect(result.content).not.toMatch(/Full output saved/i)
  })

  it("rejects registry paths outside the owning session directory", async () => {
    const root = await useTempDataHome()
    const outside = join(root, "outside.out")
    await writeFile(outside, "secret", "utf8")

    expect(() =>
      registerToolOutputSpill({
        cwd: root,
        sessionId: "owner",
        partId: "part",
        absolutePath: outside,
        toolName: "Read",
      }),
    ).toThrow(/outside.*session/i)
    expect(getToolOutputSpill("owner", "part")).toBeUndefined()
  })

  it("rejects an artifact capability that does not match its owned file", async () => {
    const root = await useTempDataHome()
    const source = await truncateOutput("x".repeat(256), {
      cwd: root,
      sessionId: "owner",
      maxBytes: 16,
    })
    if (!source.truncated || !source.absolutePath) {
      throw new Error("expected a persisted spill")
    }
    const absolutePath = source.absolutePath

    expect(() =>
      registerToolOutputSpill({
        cwd: root,
        sessionId: "owner",
        partId: "part",
        absolutePath,
        artifactId: "artifact_00000000-0000-4000-8000-000000000000",
        toolName: "Read",
      }),
    ).toThrow(/does not match/i)
  })

  it("only inherits a spill from the declared subagent owner", async () => {
    const root = await useTempDataHome()
    const source = await truncateOutput("z".repeat(256), {
      cwd: root,
      sessionId: "subagent",
      maxBytes: 16,
    })
    expect(source.truncated).toBe(true)
    if (!source.truncated || !source.absolutePath) {
      throw new Error("expected a persisted spill")
    }
    registerToolOutputSpill({
      cwd: root,
      sessionId: "subagent",
      partId: "source-part",
      absolutePath: source.absolutePath,
      toolName: "Grep",
    })

    expect(
      inheritSpillRegistryForMergedToolPart({
        cwd: root,
        parentSessionId: "parent",
        newPartId: "merged-part",
        subagentSessionId: "subagent",
        sourcePartId: "source-part",
        toolName: "Grep",
      }),
    ).toBe(source.absolutePath)
    expect(getToolOutputSpill("parent", "merged-part")).toMatchObject({
      absolutePath: source.absolutePath,
      ownerSessionId: "subagent",
    })

    expect(
      inheritSpillRegistryForMergedToolPart({
        cwd: root,
        parentSessionId: "restarted-parent",
        newPartId: "restarted-merged-part",
        subagentSessionId: "subagent",
        sourcePartId: "not-in-live-registry",
        toolName: "Grep",
        outputArtifactId: source.artifactId,
        outputArtifactOwnerSessionId: "subagent",
      }),
    ).toBe(source.absolutePath)

    const differentOwnerPath = await truncateOutput("q".repeat(256), {
      cwd: root,
      sessionId: "different-subagent",
      maxBytes: 16,
    })
    if (!differentOwnerPath.truncated || !differentOwnerPath.absolutePath) {
      throw new Error("expected a persisted spill")
    }
    expect(() =>
      inheritSpillRegistryForMergedToolPart({
        cwd: root,
        parentSessionId: "parent",
        newPartId: "forged-part",
        subagentSessionId: "subagent",
        sourcePartId: "missing",
        toolName: "Grep",
        outputSpillPath: differentOwnerPath.absolutePath,
      }),
    ).toThrow(/outside.*session/i)
  })
})
