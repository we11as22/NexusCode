import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { createNexusRunServices } from "../../agent/run-services.js"
import { truncateOutput } from "../../context/truncate.js"
import { Session } from "../../session/index.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type { ToolContext } from "../../types.js"
import { toolOutputReadTool } from "./tool-output-read.js"

const roots: string[] = []
const previousDataHome = process.env.NEXUS_DATA_HOME

afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.NEXUS_DATA_HOME
  else process.env.NEXUS_DATA_HOME = previousDataHome
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nexus-artifact-tool-"))
  const cwd = join(root, "workspace")
  const dataHome = join(root, "data")
  roots.push(root)
  await import("node:fs/promises").then((fs) =>
    fs.mkdir(cwd, { recursive: true }),
  )
  process.env.NEXUS_DATA_HOME = dataHome
  const session = createFakeSession(cwd)
  const context: ToolContext = {
    cwd,
    host: createFakeHost({ cwd }),
    session,
    config: createTestConfig(),
    services: createNexusRunServices(),
    mode: "agent",
    signal: new AbortController().signal,
  }
  return { root, cwd, dataHome, session, context }
}

describe("ToolOutputRead artifact capability", () => {
  it("returns only an opaque handle and reads bounded line slices", async () => {
    const { cwd, session, context } = await fixture()
    const source = Array.from(
      { length: 20 },
      (_, index) => `line-${index + 1}`,
    ).join("\n")
    const spill = await truncateOutput(source, {
      cwd,
      sessionId: session.id,
      maxBytes: 8,
    })
    expect(spill.truncated).toBe(true)
    if (!spill.truncated || !spill.artifactId || !spill.absolutePath) {
      throw new Error("expected artifact")
    }
    expect(spill.content).toContain("ToolOutputRead")
    expect(spill.content).toContain(spill.artifactId)
    expect(spill.content).not.toContain(spill.absolutePath)

    const result = await toolOutputReadTool.execute(
      {
        artifact_id: spill.artifactId,
        offset: 5,
        limit: 3,
      },
      context,
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain("      5|line-5")
    expect(result.output).toContain("      7|line-7")
    expect(result.output).not.toContain("line-8")
  })

  it("supports bounded literal search without regex execution", async () => {
    const { cwd, session, context } = await fixture()
    const spill = await truncateOutput(
      "alpha\nNeedle one\n.* is literal\nneedle two\nomega",
      {
        cwd,
        sessionId: session.id,
        maxBytes: 8,
      },
    )
    if (!spill.truncated || !spill.artifactId) {
      throw new Error("expected artifact")
    }

    const insensitive = await toolOutputReadTool.execute(
      {
        artifact_id: spill.artifactId,
        search: "needle",
        case_sensitive: false,
        limit: 10,
      },
      context,
    )
    const literal = await toolOutputReadTool.execute(
      {
        artifact_id: spill.artifactId,
        search: ".*",
        limit: 10,
      },
      context,
    )

    expect(insensitive.output).toContain("Needle one")
    expect(insensitive.output).toContain("needle two")
    expect(literal.output).toContain(".* is literal")
    expect(literal.output).not.toContain("Needle one")
  })

  it("rejects the same artifact id from another session or workspace", async () => {
    const { root, cwd, session, context } = await fixture()
    const spill = await truncateOutput("secret\n".repeat(20), {
      cwd,
      sessionId: session.id,
      maxBytes: 8,
    })
    if (!spill.truncated || !spill.artifactId) {
      throw new Error("expected artifact")
    }

    const otherSessionContext: ToolContext = {
      ...context,
      session: createFakeSession(cwd),
    }
    const otherWorkspace = join(root, "other-workspace")
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(otherWorkspace, { recursive: true }),
    )
    const otherWorkspaceContext: ToolContext = {
      ...context,
      cwd: otherWorkspace,
      host: createFakeHost({ cwd: otherWorkspace }),
      session: new Session(session.id, otherWorkspace, [], undefined, true),
    }

    await expect(
      toolOutputReadTool.execute(
        { artifact_id: spill.artifactId },
        otherSessionContext,
      ),
    ).resolves.toMatchObject({ success: false })
    await expect(
      toolOutputReadTool.execute(
        { artifact_id: spill.artifactId },
        otherWorkspaceContext,
      ),
    ).resolves.toMatchObject({ success: false })
  })

  it("rejects a symlink swapped in for an owned artifact", async () => {
    const { root, cwd, session, context } = await fixture()
    const spill = await truncateOutput("owned\n".repeat(20), {
      cwd,
      sessionId: session.id,
      maxBytes: 8,
    })
    if (!spill.truncated || !spill.artifactId || !spill.absolutePath) {
      throw new Error("expected artifact")
    }
    const outside = join(root, "outside.txt")
    await writeFile(outside, "outside secret", "utf8")
    await rm(spill.absolutePath)
    await symlink(outside, spill.absolutePath)

    const result = await toolOutputReadTool.execute(
      { artifact_id: spill.artifactId },
      context,
    )

    expect(result.success).toBe(false)
    expect(result.output).toMatch(/regular private file/i)
    expect(result.output).not.toContain("outside secret")
  })
})
