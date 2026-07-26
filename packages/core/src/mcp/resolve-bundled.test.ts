import * as os from "node:os"
import * as path from "node:path"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveBundledMcpServers } from "./resolve-bundled.js"

const contextServer = { name: "context-mode", bundle: "context-mode" as const }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("resolveBundledMcpServers", () => {
  it("resolves the optional development source layout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-context-mode-"))
    const start = path.join(root, "sources", "claude-context-mode", "start.mjs")
    await mkdir(path.dirname(start), { recursive: true })
    await writeFile(start, "")

    expect(resolveBundledMcpServers([contextServer], {
      cwd: "/workspace",
      nexusRoot: root,
    })).toEqual([{
      name: "context-mode",
      command: "node",
      args: [start],
      env: { CLAUDE_PROJECT_DIR: "/workspace" },
      enabled: true,
    }])
  })

  it("accepts an absolute external bundle path without a Nexus checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-context-mode-external-"))
    const start = path.join(root, "start.mjs")
    await writeFile(start, "")
    vi.stubEnv("NEXUS_CONTEXT_MODE_PATH", start)

    expect(resolveBundledMcpServers([contextServer], {
      cwd: "/workspace",
      nexusRoot: null,
    })[0]?.args).toEqual([start])
  })

  it("omits an unavailable optional bundle without affecting normal MCP servers", () => {
    const regular = { name: "filesystem", command: "node", args: ["server.mjs"] }
    expect(resolveBundledMcpServers([contextServer, regular], {
      cwd: "/workspace",
      nexusRoot: null,
    })).toEqual([regular])
  })
})
