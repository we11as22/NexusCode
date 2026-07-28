import { describe, expect, it, vi } from "vitest"

import { createFakeHost } from "../test/fakes.js"
import { parseMentions } from "./mentions.js"

describe("@mention context resolution", () => {
  it("routes file reads through the host workspace authority", async () => {
    const resolvePath = vi.fn(async () => "/workspace/src/example.ts")
    const readFile = vi.fn(async () => "export const value = 1\n")
    const host = createFakeHost({
      cwd: "/workspace",
      resolvePath,
      readFile,
    })

    const result = await parseMentions(
      "inspect @file:src/example.ts",
      "/workspace",
      host,
    )

    expect(resolvePath).toHaveBeenCalledWith("src/example.ts", "read")
    expect(readFile).toHaveBeenCalledWith(
      "/workspace/src/example.ts",
      { maxBytes: 512 * 1024 },
    )
    expect(result.text).toBe("inspect [file context below]")
    expect(result.contextBlocks.join("\n")).toContain(
      "export const value = 1",
    )
  })

  it("does not read a file when the host rejects its path", async () => {
    const readFile = vi.fn()
    const host = createFakeHost({
      cwd: "/workspace",
      resolvePath: async () => {
        throw new Error("outside workspace")
      },
      readFile,
    })

    const result = await parseMentions(
      "@file:../../secret.txt",
      "/workspace",
      host,
    )

    expect(readFile).not.toHaveBeenCalled()
    expect(result.contextBlocks.join("\n")).toContain('error="unavailable"')
  })

  it("defers URL and Git I/O to permission-aware tools", async () => {
    const authorizeNetworkRequest = vi.fn()
    const runCommand = vi.fn()
    const host = createFakeHost({
      cwd: "/workspace",
      authorizeNetworkRequest,
      runCommand,
    })

    const result = await parseMentions(
      "read @url:https://example.com/docs and @git",
      "/workspace",
      host,
    )

    expect(authorizeNetworkRequest).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
    expect(result.contextBlocks.join("\n")).toContain(
      "not fetched during prompt construction",
    )
    expect(result.contextBlocks.join("\n")).toContain(
      "permission-aware GitInspect",
    )
  })
})
