import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { getRuntimeDir } from "../../orchestration/runtime.js"
import {
  createResumedSubagentSession,
  loadSubagentTranscriptSnapshot,
} from "../parallel.js"

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-subagent-resume-"))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  )
})

describe("delegated agent transcript resume", () => {
  it("loads the complete bounded transcript from the owned runtime snapshot", async () => {
    const root = await temporaryRoot()
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, "home")
    const snapshotDir = path.join(getRuntimeDir(cwd, homeDir), "agent-runs")
    const snapshotFile = path.join(snapshotDir, "subagent_source.json")
    await fs.mkdir(snapshotDir, { recursive: true })
    await fs.writeFile(snapshotFile, JSON.stringify({
      schemaVersion: 1,
      subagentId: "subagent_source",
      sessionId: "worker_session",
      description: "Inspect auth",
      mode: "agent",
      success: true,
      output: "final summary",
      messages: [
        {
          id: "msg_user",
          ts: 1,
          role: "user",
          content: "Inspect the complete auth path",
        },
        {
          id: "msg_assistant",
          ts: 2,
          role: "assistant",
          content: [
            { type: "text", text: "I inspected it." },
            {
              type: "tool",
              id: "tool_1",
              tool: "Read",
              status: "completed",
              input: { path: "src/auth.ts" },
              output: "source",
            },
          ],
        },
      ],
    }))

    const snapshot = await loadSubagentTranscriptSnapshot({
      cwd,
      homeDir,
      snapshotFile,
      expectedSubagentId: "subagent_source",
    })

    expect(snapshot.sessionId).toBe("worker_session")
    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.messages[1]).toMatchObject({
      role: "assistant",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "tool", id: "tool_1" }),
      ]),
    })

    const resumed = createResumedSubagentSession(
      cwd,
      snapshot.messages,
      "Now verify the refresh-token path",
    )
    expect(resumed.messages).toHaveLength(3)
    expect(resumed.messages.slice(0, 2)).toEqual(snapshot.messages)
    expect(resumed.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Now verify the refresh-token path",
    })
    expect(snapshot.messages).toHaveLength(2)
  })

  it("rejects snapshot paths outside the workspace runtime and symbolic links", async () => {
    const root = await temporaryRoot()
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, "home")
    const outside = path.join(root, "outside.json")
    await fs.writeFile(outside, JSON.stringify({
      subagentId: "subagent_source",
      sessionId: "worker_session",
      messages: [],
    }))

    await expect(loadSubagentTranscriptSnapshot({
      cwd,
      homeDir,
      snapshotFile: outside,
      expectedSubagentId: "subagent_source",
    })).rejects.toThrow(/outside.*runtime/i)

    const snapshotDir = path.join(getRuntimeDir(cwd, homeDir), "agent-runs")
    await fs.mkdir(snapshotDir, { recursive: true })
    const linked = path.join(snapshotDir, "subagent_source.json")
    await fs.symlink(outside, linked)

    await expect(loadSubagentTranscriptSnapshot({
      cwd,
      homeDir,
      snapshotFile: linked,
      expectedSubagentId: "subagent_source",
    })).rejects.toThrow(/symbolic link/i)
  })

  it("rejects a mismatched or structurally invalid transcript", async () => {
    const root = await temporaryRoot()
    const cwd = path.join(root, "workspace")
    const homeDir = path.join(root, "home")
    const snapshotDir = path.join(getRuntimeDir(cwd, homeDir), "agent-runs")
    const snapshotFile = path.join(snapshotDir, "subagent_source.json")
    await fs.mkdir(snapshotDir, { recursive: true })
    await fs.writeFile(snapshotFile, JSON.stringify({
      subagentId: "subagent_other",
      sessionId: "worker_session",
      messages: [{ role: "assistant", content: 42 }],
    }))

    await expect(loadSubagentTranscriptSnapshot({
      cwd,
      homeDir,
      snapshotFile,
      expectedSubagentId: "subagent_source",
    })).rejects.toThrow(/does not match/i)
  })
})
