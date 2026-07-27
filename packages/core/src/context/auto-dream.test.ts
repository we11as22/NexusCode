import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import type {
  LLMClient,
  LLMStreamEvent,
  StreamOptions,
} from "../provider/types.js"
import { createTestConfig } from "../test/fakes.js"
import { runAutoMemoryDreamIfDue } from "./auto-dream.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function fakeClient(
  events: (options: StreamOptions) => AsyncIterable<LLMStreamEvent>,
): LLMClient {
  return {
    providerName: "test",
    modelId: "test-model",
    stream: events,
    async generateStructured() {
      throw new Error("not used")
    },
    supportsStructuredOutput: () => false,
    getModel() {
      throw new Error("not used")
    },
  }
}

describe("auto-memory consolidation", () => {
  it("bounds model output and records completion only after a successful write", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "nexus-auto-dream-"))
    roots.push(workspace)
    const memory = path.join(workspace, ".nexus", "memory")
    await mkdir(memory, { recursive: true })
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
    await writeFile(
      path.join(memory, "facts.md"),
      `provider token ${secret}\n${"durable fact\n".repeat(100)}`,
    )
    let calls = 0
    let prompt = ""
    const client = fakeClient(async function* (options) {
      calls += 1
      prompt = JSON.stringify(options.messages)
      yield {
        type: "text_delta",
        delta: `${secret}\n${"x".repeat(256 * 1024)}`,
      }
      yield { type: "finish", finishReason: "stop" }
    })
    const config = createTestConfig({
      memory: {
        autoMemoryDirectory: memory,
        autoDreamEnabled: true,
        autoDreamMinIntervalMs: 1,
      },
    })

    await runAutoMemoryDreamIfDue({
      cwd: workspace,
      config,
      client,
      signal: new AbortController().signal,
    })
    await runAutoMemoryDreamIfDue({
      cwd: workspace,
      config,
      client,
      signal: new AbortController().signal,
    })

    const consolidated = await readFile(
      path.join(memory, "_nexus_consolidated_memory.md"),
      "utf8",
    )
    const stamp = await readFile(
      path.join(memory, ".nexus_last_auto_dream"),
      "utf8",
    )
    expect(calls).toBe(1)
    expect(prompt).not.toContain(secret)
    expect(consolidated).not.toContain(secret)
    expect(consolidated).toContain("[auto-dream output truncated]")
    expect(consolidated.length).toBeLessThanOrEqual(128 * 1024)
    expect(Number(stamp.trim())).toBeGreaterThan(0)
  })

  it("surfaces model failures without writing a success timestamp", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "nexus-auto-dream-"))
    roots.push(workspace)
    const memory = path.join(workspace, ".nexus", "memory")
    await mkdir(memory, { recursive: true })
    await writeFile(path.join(memory, "facts.md"), "durable fact\n".repeat(100))
    const client = fakeClient(async function* () {
      yield { type: "error", error: new Error("provider unavailable") }
    })
    const config = createTestConfig({
      memory: {
        autoMemoryDirectory: memory,
        autoDreamEnabled: true,
      },
    })

    await expect(
      runAutoMemoryDreamIfDue({
        cwd: workspace,
        config,
        client,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("provider unavailable")
    await expect(
      readFile(path.join(memory, ".nexus_last_auto_dream"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not create lock or output files through a symlinked memory root", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "nexus-auto-dream-"))
    const outside = await mkdtemp(path.join(tmpdir(), "nexus-auto-dream-outside-"))
    roots.push(workspace, outside)
    const configured = path.join(workspace, "memory-link")
    await writeFile(path.join(outside, "facts.md"), "durable fact\n".repeat(100))
    await symlink(outside, configured)
    const config = createTestConfig({
      memory: {
        autoMemoryDirectory: configured,
        autoDreamEnabled: true,
      },
    })

    await expect(
      runAutoMemoryDreamIfDue({
        cwd: workspace,
        config,
        client: fakeClient(async function* () {
          yield { type: "finish", finishReason: "stop" }
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("not a real directory")
    await expect(
      readFile(path.join(outside, ".nexus_last_auto_dream.lock"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })
})
